import type { ConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { createConnectedServiceAccountModeCache } from './createConnectedServiceAccountModeCache';
import type { ConnectedServiceAccountMode } from './createConnectedServiceAccountModeCache';

export type { ConnectedServiceAccountMode } from './createConnectedServiceAccountModeCache';

const ACCOUNT_MODE_ERROR_BACKOFF_MS = 30_000;

const accountModeCache = createConnectedServiceAccountModeCache({
  errorTtlMs: ACCOUNT_MODE_ERROR_BACKOFF_MS,
});

export async function resolveConnectedServiceAccountMode(
  api: Partial<Pick<ConnectedServiceCredentialApi, 'getAccountEncryptionMode'>>,
  options?: Readonly<{ refresh?: boolean; signal?: AbortSignal }>,
): Promise<ConnectedServiceAccountMode> {
  if (options?.signal) return await api.getAccountEncryptionMode?.(options) ?? 'unknown';
  if (options?.refresh) return await accountModeCache.refresh(api);
  return await accountModeCache.resolve(api);
}

export function invalidateConnectedServiceAccountMode(
  api?: Partial<Pick<ConnectedServiceCredentialApi, 'getAccountEncryptionMode'>>,
): void {
  if (api) {
    accountModeCache.invalidate(api);
    return;
  }
  accountModeCache.clear();
}
