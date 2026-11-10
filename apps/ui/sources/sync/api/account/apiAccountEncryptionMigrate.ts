import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import { backoff } from '@/utils/timing/time';
import { createServerFetchAtEndpoint, createServerFetchForActiveServer, type ServerFetch } from '@/sync/http/client';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { invalidateAccountEncryptionModeCache } from './apiAccountEncryptionMode';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
  assertAccountEncryptionMigrationScopeCurrent,
  type AccountEncryptionMigrationScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';
import {
  AccountEncryptionMigrateSuccessResponseSchema,
  AccountEncryptionMigrateAnyErrorResponseSchema,
  type AccountEncryptionMigrateRequest,
} from '@happier-dev/protocol/account/encryptionMigrate';

export { AccountEncryptionMigrateRequestSchema, type AccountEncryptionMigrateRequest } from '@happier-dev/protocol/account/encryptionMigrate';

export type AccountEncryptionMigrationTarget = Readonly<{
  serverUrl: string;
  serverId: string;
  runtimeOrigin?: string | null;
  homeCarrier?: HomeCarrier;
}>;

export async function migrateAccountEncryptionMode(
  credentials: AuthCredentials,
  request: AccountEncryptionMigrateRequest,
  options: Readonly<{
    retry?: 'default' | 'none';
    request?: ServerFetch;
    target?: AccountEncryptionMigrationTarget;
    scope?: AccountEncryptionMigrationScope;
  }> = {},
): Promise<import('@happier-dev/protocol/account/encryptionMigrate').AccountEncryptionMigrateSuccessResponse> {
  if (options.scope) assertAccountEncryptionMigrationScopeCurrent(options.scope);
  const targetServerId = options.scope?.scope.serverId ?? options.target?.serverId
    ?? (!options.request ? getActiveServerSnapshot().serverId : undefined);
  const targetRequest = options.request ?? (options.target
      ? createServerFetchAtEndpoint({
          endpointUrl: options.target.serverUrl,
          ...(options.target.runtimeOrigin ? { runtimeOrigin: options.target.runtimeOrigin } : {}),
          ...(options.target.homeCarrier ? { homeCarrier: options.target.homeCarrier } : {}),
          credentials,
          serverId: options.target.serverId,
        })
      : createServerFetchForActiveServer());
  const migrateOnce = async () => {
    if (options.scope) assertAccountEncryptionMigrationScopeCurrent(options.scope);
    const response = await targetRequest(
      '/v1/account/encryption/migrate',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      },
      options.retry === 'none'
        ? { includeAuth: false, retry: 'none' }
        : { includeAuth: false },
    );
    // A POST acknowledgement is an external fact; the caller still gates
    // projection/adoption on the same captured scope after this returns.

    const data: unknown = await response.json().catch(() => null);
    const success = AccountEncryptionMigrateSuccessResponseSchema.safeParse(data);
    if (response.ok && success.success) {
      invalidateAccountEncryptionModeCache({ serverId: targetServerId });
      return success.data;
    }
    if (response.ok) {
      throw new HappyError(
        'This server returned an incompatible account encryption migration response',
        false,
        {
          status: response.status,
          kind: 'server',
          code:
            'account-encryption-migration-response-incompatible',
        },
      );
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
        throw new HappyError(err.reason === 'migration_inventory_changed'
          ? t('settingsAccount.encryptionInventoryChanged') : t('settingsAccount.encryptionUpdateFailed'), false, {
          status: response.status,
          kind: 'server',
          code: err.reason,
        });
      }
      const message = err.error === 'e2ee-required' ? t('settingsAccount.encryptionRequiredByHome')
        : err.error === 'plaintext-only' ? t('settingsAccount.encryptionPlainOnlyHome')
        : err.error === 'plugin_collections_not_empty' ? t('settingsAccount.encryptionPluginDataBlocks')
        : t('settingsAccount.encryptionUpdateFailed');
      throw new HappyError(message, false, {
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
  };
  if (options.retry === 'none') {
    return await migrateOnce();
  }
  return await backoff(migrateOnce);
}
