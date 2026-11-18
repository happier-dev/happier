import { $ZodError } from 'zod/v4/core';
import { isRetryableAccountEncryptionCurrentnessError } from '@/api/client/accountEncryptionCurrentness';
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
type DaemonHydrationObserver = Readonly<{ credentials: StoredCredentials; scopeKey: string;
  onReady(input: Readonly<{ catalog: Extract<AcpCatalogSnapshotV1, { status: 'ready' }>; signal?: AbortSignal; isCurrent(): boolean }>): Promise<void>;
}>;
let daemonHydrationObserver: DaemonHydrationObserver | null = null;

/** Bound by the daemon's installed Account, independent of invocation/requester catalog reads. */
export function installDaemonAcpCatalogHydrationObserver(input: Omit<DaemonHydrationObserver, 'scopeKey'>): () => void {
  const observer = { ...input, scopeKey: resolveAccountSettingsScopeKey(input.credentials) };
  daemonHydrationObserver = observer;
  return () => { if (daemonHydrationObserver === observer) daemonHydrationObserver = null; };
}

export async function refreshDaemonAcpCatalog(input: Readonly<{ credentials: StoredCredentials; signal?: AbortSignal }>): Promise<AcpCatalogSnapshotV1> {
  const observer = daemonHydrationObserver;
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const catalog = await refreshActiveAcpCatalogAfterChange({ ...input, scopeKey: resolveAccountSettingsScopeKey(input.credentials), lifetimeToken });
  const isCurrent = () => daemonHydrationObserver === observer && observer !== null
    && observer.credentials.token === input.credentials.token && observer.scopeKey === getActiveAccountSettingsSnapshot()?.scopeKey
    && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken && getActiveAccountSettingsSnapshot()?.acpCatalog === catalog
    && !input.signal?.aborted;
  if (observer && catalog.status === 'ready' && isCurrent()) await observer.onReady({ catalog, signal: input.signal, isCurrent });
  return catalog;
}

function failure(error: unknown, signal?: AbortSignal): AcpCatalogSnapshotV1 {
  const reason = error instanceof Error && 'reason' in error && typeof error.reason === 'string' ? error.reason
    : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code
      : error instanceof $ZodError ? 'invalid-stored-content' : 'unreachable';
  return { status: 'unavailable', reason: signal?.aborted ? 'cancelled'
    : isRetryableAccountEncryptionCurrentnessError(error) ? 'unreachable'
    : reason === 'account_storage_currentness_unavailable' || reason === 'account_encryption_currentness_unavailable'
      ? 'encryption-material-unavailable' : reason };
}

function refresh(input: RefreshInput, captured?: CapturedAccount, afterChange = false): Promise<AcpCatalogSnapshotV1> {
  const operation = input.operationContext;
  if (operation) return (async () => {
    const store = createCliAcpCatalogStore(input);
    let catalog: AcpCatalogSnapshotV1;
    if (!await operation.commitAcpCatalog({ catalog: { status: 'loading' } })) return { status: 'unavailable', reason: 'scope-retired' };
    try { catalog = await store.readCatalog(); } catch (error) { catalog = failure(error, input.signal); }
    if (!await operation.isCurrent()) return { status: 'unavailable', reason: 'scope-retired' };
    // The holder may retain an equivalent publication from a concurrent read.
    return await operation.commitAcpCatalog({ catalog }) ?? { status: 'unavailable', reason: 'source-stale' };
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
  work = (async (): Promise<AcpCatalogSnapshotV1> => {
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
  const daemon = daemonHydrationObserver?.credentials.token === input.token ? daemonHydrationObserver : null;
  if (!active?.scopeKey || active.acpCatalog === undefined && !daemon) return;
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return;
  input.signal?.throwIfAborted();
  if (daemon) await refreshDaemonAcpCatalog({ credentials, signal: input.signal });
  else await refreshActiveAcpCatalogAfterChange({ credentials, scopeKey: active.scopeKey, lifetimeToken });
}
