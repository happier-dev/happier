import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';
import { serverFetch } from '@/sync/http/client';
import { invalidateAccountEncryptionModeCache } from './apiAccountEncryptionMode';
import {
  AccountEncryptionMigrateSuccessResponseSchema,
  AccountEncryptionMigrateAnyErrorResponseSchema,
  type AccountEncryptionMigrateRequest,
} from '@happier-dev/protocol';

export { AccountEncryptionMigrateRequestSchema, type AccountEncryptionMigrateRequest } from '@happier-dev/protocol';

export async function migrateAccountEncryptionMode(
  credentials: AuthCredentials,
  request: AccountEncryptionMigrateRequest,
): Promise<import('@happier-dev/protocol').AccountEncryptionMigrateSuccessResponse> {
  return await backoff(async () => {
    const response = await serverFetch(
      '/v1/account/encryption/migrate',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      },
      { includeAuth: false },
    );

    const data: unknown = await response.json().catch(() => null);
    const success = AccountEncryptionMigrateSuccessResponseSchema.safeParse(data);
    if (response.ok && success.success) {
      invalidateAccountEncryptionModeCache();
      return success.data;
    }

    const parsedError = AccountEncryptionMigrateAnyErrorResponseSchema.safeParse(data);
    if (parsedError.success) {
      const err = parsedError.data;
      if (err.error === 'not_found') {
        throw new HappyError('Encryption opt-out is not enabled on this server', false, {
          status: response.status,
          kind: 'config',
          code: err.error,
        });
      }
      if (err.error === 'invalid-params' && err.reason) {
        throw new HappyError('Failed to update encryption setting', false, {
          status: response.status,
          kind: 'server',
          code: err.reason,
        });
      }
      throw new HappyError('Failed to update encryption setting', false, {
        status: response.status,
        kind: 'server',
        code: err.error,
      });
    }

    if (response.status === 404) {
      throw new HappyError('Encryption opt-out is not enabled on this server', false, {
        status: response.status,
        kind: 'config',
      });
    }

    throw new HappyError('Failed to update encryption setting', false, { status: response.status, kind: 'server' });
  });
}
