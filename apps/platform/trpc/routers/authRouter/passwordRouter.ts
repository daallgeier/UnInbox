import { z } from 'zod';
import { Argon2id } from 'oslo/password';
import {
  router,
  accountProcedure,
  publicRateLimitedProcedure
} from '../../trpc';
import { eq } from '@u22n/database/orm';
import { accounts } from '@u22n/database/schema';
import { typeIdGenerator, zodSchemas } from '@u22n/utils';
import { strongPasswordSchema } from '@u22n/utils/password';
import { TRPCError } from '@trpc/server';
import { createError, setCookie } from 'h3';
import { lucia } from '../../../utils/auth';
import { validateUsername } from './signupRouter';
import { createLuciaSessionCookie } from '../../../utils/session';
import { decodeHex } from 'oslo/encoding';
import { TOTPController } from 'oslo/otp';

export const passwordRouter = router({
  signUpWithPassword: publicRateLimitedProcedure.signUpWithPassword
    .input(
      z.object({
        username: zodSchemas.username(),
        password: strongPasswordSchema
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { username, password } = input;
      const { db } = ctx;

      const { accountId, publicId } = await db.transaction(async (tx) => {
        try {
          // making sure someone doesn't bypass the client side validation
          const { available, error } = await validateUsername(tx, username);
          if (!available) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: error || 'Username is not available'
            });
          }

          const passwordHash = await new Argon2id().hash(password);
          const publicId = typeIdGenerator('account');

          const newUser = await tx.insert(accounts).values({
            username,
            publicId,
            passwordHash
          });

          return { accountId: Number(newUser.insertId), publicId };
        } catch (err) {
          tx.rollback();
          console.error(err);
          throw err;
        }
      });

      const cookie = await createLuciaSessionCookie(ctx.event, {
        accountId,
        username,
        publicId
      });

      setCookie(ctx.event, cookie.name, cookie.value, cookie.attributes);
      await db
        .update(accounts)
        .set({ lastLoginAt: new Date() })
        .where(eq(accounts.id, accountId));

      return { success: true };
    }),

  signInWithPassword: publicRateLimitedProcedure.signInWithPassword
    .input(
      z.object({
        // we allow min length of 2 for username if we plan to provide them in the future
        username: zodSchemas.username(2),
        password: z.string().min(8),
        twoFactorCode: zodSchemas.nanoIdToken(),
        recoveryCode: z.string().optional()
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db } = ctx;

      if (
        !(input.password && input.twoFactorCode) &&
        !(input.password && input.recoveryCode) &&
        !(input.twoFactorCode && input.recoveryCode)
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'You need to provide 2 of the following: Password, 2FA Code, Recovery Code'
        });
      }

      const userResponse = await db.query.accounts.findFirst({
        where: eq(accounts.username, input.username),
        columns: {
          id: true,
          publicId: true,
          username: true,
          passwordHash: true,
          twoFactorSecret: true,
          recoveryCode: true
        }
      });

      if (!userResponse) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found'
        });
      }

      // verify password if provided
      let validPassword = false;
      if (input.password) {
        if (!userResponse.passwordHash) {
          throw new TRPCError({
            code: 'METHOD_NOT_SUPPORTED',
            message: 'Password sign-in is not enabled'
          });
        }

        validPassword = await new Argon2id().verify(
          userResponse.passwordHash,
          input.password
        );
        if (!validPassword) {
          throw createError({
            message: 'Incorrect username or password',
            statusCode: 400
          });
        }
      }

      // verify otp if provided
      let otpValid = false;
      if (input.twoFactorCode) {
        if (!userResponse.twoFactorSecret) {
          throw new TRPCError({
            code: 'METHOD_NOT_SUPPORTED',
            message: '2FA sign-in is not enabled'
          });
        }
        const secret = decodeHex(userResponse.twoFactorSecret);
        otpValid = await new TOTPController().verify(
          input.twoFactorCode,
          secret
        );
        if (!otpValid) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Invalid 2FA code'
          });
        }
      }

      // verify recovery code if provided
      let recoveryCodeValid = false;

      if (input.recoveryCode) {
        if (!userResponse.recoveryCode) {
          throw new TRPCError({
            code: 'METHOD_NOT_SUPPORTED',
            message: 'Recovery code sign-in is not enabled'
          });
        }

        const isRecoveryCodeValid = await new Argon2id().verify(
          userResponse.recoveryCode,
          input.recoveryCode
        );
        if (isRecoveryCodeValid) {
          // Remove the used recovery code from the database
          await db
            .update(accounts)
            .set({
              recoveryCode: null
            })
            .where(eq(accounts.id, userResponse.id));
          recoveryCodeValid = isRecoveryCodeValid;
        }

        if (!recoveryCodeValid) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Invalid recovery code'
          });
        }
      }

      if (
        (validPassword && otpValid) ||
        (validPassword && recoveryCodeValid) ||
        (otpValid && recoveryCodeValid)
      ) {
        const { id: accountId, username, publicId } = userResponse;

        const cookie = await createLuciaSessionCookie(ctx.event, {
          accountId,
          username,
          publicId
        });
        setCookie(ctx.event, cookie.name, cookie.value, cookie.attributes);

        await db
          .update(accounts)
          .set({ lastLoginAt: new Date() })
          .where(eq(accounts.id, userResponse.id));

        return { success: true };
      }
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Something went wrong, please contact support'
      });
    }),

  updateUserPassword: accountProcedure
    .input(
      z
        .object({
          oldPassword: z.string().min(8),
          newPassword: strongPasswordSchema,
          otp: zodSchemas.nanoIdToken(),
          invalidateAllSessions: z.boolean().default(false)
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { db, account } = ctx;
      const accountId = account.id;

      const accountData = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
        columns: {
          publicId: true,
          username: true,
          passwordHash: true,
          twoFactorSecret: true
        }
      });

      if (!accountData) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found'
        });
      }

      if (!accountData.passwordHash) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'Password sign-in is not enabled'
        });
      }

      const oldPasswordValid = await new Argon2id().verify(
        accountData.passwordHash,
        input.oldPassword
      );

      if (!oldPasswordValid) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Incorrect old password'
        });
      }

      if (!accountData.twoFactorSecret) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: '2FA is not enabled on this account, contact support'
        });
      }
      const secret = decodeHex(accountData.twoFactorSecret);
      const otpValid = await new TOTPController().verify(input.otp, secret);
      if (!otpValid) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Invalid 2FA code'
        });
      }

      const passwordHash = await new Argon2id().hash(input.newPassword);

      await db
        .update(accounts)
        .set({
          passwordHash
        })
        .where(eq(accounts.id, accountId));

      // Invalidate all sessions if requested
      if (input.invalidateAllSessions) {
        await lucia.invalidateUserSessions(accountId);
      }

      const cookie = await createLuciaSessionCookie(ctx.event, {
        accountId,
        username: accountData.username,
        publicId: accountData.publicId
      });

      setCookie(ctx.event, cookie.name, cookie.value, cookie.attributes);
      return { success: true };
    })
});
