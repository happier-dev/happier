import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { beginActiveAcpCatalogRefresh, commitActiveAcpCatalog, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliAcpCatalogStore } from './acpCatalogStore';
export { readActiveAcpCatalog } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

type RefreshInput = Readonly<{ credentials: StoredCredentials; signal?: AbortSignal; operationContext?: SavedSecretOperationContextV1 }>;
type CapturedAccount = Readonly<{ scopeKey: string; lifetimeToken: number }>;
const pending = new Map<string, Promise<AcpCatalogSnapshotV1>>();
const refreshAfterInFlight = new Set<string>();

function failure(error: unknown, signal?: AbortSignal): AcpCatalogSnapshotV1 {
  const reason = error instanceof Error && 'reason' in error && typeof error.reason === 'string' ? error.reason
    : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code
      : error instanceof Error && error.name === 'ZodError' ? 'invalid-stored-content' : 'unreachable';
  return { status: 'unavailable', reason: signal?.aborted ? 'cancelled'
    : reason === 'account_storage_currentness_unavailable' || reason === 'account_encryption_currentness_unavailable'
      ? 'encryption-material-unavailable' : reason };
}

function refresh(input: RefreshInput, captured?: CapturedAccount, afterChange = false): Promise<AcpCatalogSnapshotV1> {
  if (input.operationContext) return (async () => {
    const store = createCliAcpCatalogStore(input);
    let catalog: AcpCatalogSnapshotV1;
    if (!await store.publish({ status: 'loading' })) return { status: 'unavailable', reason: 'scope-retired' };
    try { catalog = await store.readCatalog(); } catch (error) { catalog = failure(error, input.signal); }
    if (!await input.operationContext!.isCurrent()) return { status: 'unavailable', reason: 'scope-retired' };
    if (!await store.publish(catalog)) return { status: 'unavailable', reason: 'source-stale' };
    return catalog;
  })();
  const scopeKey = captured?.scopeKey ?? resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = captured?.lifetimeToken ?? getActiveAccountSettingsSnapshotLifetimeToken();
  const current = () => getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey
    && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken;
  if (!current() || resolveAccountSettingsScopeKey(input.credentials) !== scopeKey) {
    return Promise.resolve({ status: 'unavailable', reason: 'scope-retired' });
  }
  const key = `${scopeKey}:${lifetimeToken}`;
  const existing = pending.get(key);
  if (existing) {
    if (afterChange) { beginActiveAcpCatalogRefresh({ scopeKey, lifetimeToken }); refreshAfterInFlight.add(key); }
    return existing;
  }
  beginActiveAcpCatalogRefresh({ scopeKey, lifetimeToken });
  let work!: Promise<AcpCatalogSnapshotV1>;
  work = (async () => {
    let requestInput: RefreshInput = afterChange ? { credentials: input.credentials } : input;
    while (true) {
      let catalog: AcpCatalogSnapshotV1;
      try { catalog = await createCliAcpCatalogStore(requestInput).readCatalog(); }
      catch (error) { catalog = failure(error, requestInput.signal); }
      if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
      if (refreshAfterInFlight.delete(key)) { requestInput = { credentials: input.credentials }; continue; }
      // A synchronous consumer wake must not join a request that already chose to finish.
      if (pending.get(key) === work) pending.delete(key);
      if (!commitActiveAcpCatalog({ scopeKey, lifetimeToken, catalog })) return { status: 'unavailable', reason: 'source-stale' };
      if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
      // Publication retains the canonical object for an unchanged row. Return
      // that observation so consumers do not mistake deduplication for staleness.
      return getActiveAccountSettingsSnapshot()?.acpCatalog ?? { status: 'unavailable', reason: 'source-stale' };
    }
  })().finally(() => {
    if (pending.get(key) === work) { pending.delete(key); refreshAfterInFlight.delete(key); }
  });
  pending.set(key, work);
  return work;
}

/** Reads the canonical row/source projection without initializing or deleting anything. */
export function refreshActiveAcpCatalog(input: RefreshInput): Promise<AcpCatalogSnapshotV1> { return refresh(input); }
export function refreshActiveAcpCatalogAfterChange(input: RefreshInput & CapturedAccount): Promise<AcpCatalogSnapshotV1> {
  return refresh({ credentials: input.credentials }, input, true);
}
export async function refreshDemandedActiveAcpCatalog(input: Readonly<{ token: string; signal?: AbortSignal }>): Promise<void> {
  const active = getActiveAccountSettingsSnapshot();
  if (!active?.scopeKey || active.acpCatalog === undefined) return;
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return;
  input.signal?.throwIfAborted();
  await refreshActiveAcpCatalogAfterChange({ credentials, scopeKey: active.scopeKey, lifetimeToken });
}
