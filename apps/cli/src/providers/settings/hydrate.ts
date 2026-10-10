import type { ProviderConnectionsCatalogSnapshotV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { beginActiveProviderConnectionsCatalogRefresh, commitActiveProviderConnectionsCatalog,
  getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliProviderConnectionsStore, createCliProviderConnectionsStoreForOperation } from './catalogStore';
export { readActiveProviderConnectionsCatalog } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const pending = new Map<string, Promise<ProviderConnectionsCatalogSnapshotV1>>();
const reloadAfterPending = new Set<string>();
type RefreshInput = Readonly<{ credentials: StoredCredentials; signal?: AbortSignal; operationContext?: SavedSecretOperationContextV1;
  isCredentialCurrent?(): boolean | Promise<boolean> }>;

/** Admission uses an issued owner when present, otherwise the current stored daemon credentials. */
export async function prepareProviderConnectionsCatalogForCli(input: Readonly<{
  expectedScopeKey: string; operationContext?: SavedSecretOperationContextV1; signal?: AbortSignal;
}>): Promise<ProviderConnectionsCatalogSnapshotV1> {
  const snapshot = input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  if (snapshot?.scopeKey !== input.expectedScopeKey) return { status: 'unavailable', reason: 'scope-retired' };
  if (input.operationContext && !await input.operationContext.isCurrent()) return { status: 'unavailable', reason: 'scope-retired' };
  if (snapshot.providerConnectionsCatalog?.status === 'ready') return snapshot.providerConnectionsCatalog;
  const credentials = input.operationContext?.credentials ?? await readStoredCredentials();
  if (!credentials || resolveAccountSettingsScopeKey(credentials) !== input.expectedScopeKey) return { status: 'unavailable', reason: 'scope-retired' };
  if (!input.operationContext && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) return { status: 'unavailable', reason: 'scope-retired' };
  return refreshActiveProviderConnectionsCatalog({ credentials, operationContext: input.operationContext, signal: input.signal });
}

/** Demand-load the sole catalog in the caller's existing Account custody. */
export function refreshActiveProviderConnectionsCatalog(input: RefreshInput,
  options?: Readonly<{ afterChange?: boolean }>): Promise<ProviderConnectionsCatalogSnapshotV1> {
  return refresh(input, options?.afterChange === true);
}

function refresh(input: RefreshInput, afterChange = false): Promise<ProviderConnectionsCatalogSnapshotV1> {
  const context = input.operationContext;
  const scopeKey = resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const key = `${scopeKey}:${lifetimeToken}`;
  const readSnapshot = () => context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  const current = () => readSnapshot()?.scopeKey === scopeKey
    && (context ? context.credentials.token === input.credentials.token : getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken);
  if (!current() || input.signal?.aborted) return Promise.resolve({ status: 'unavailable', reason: 'scope-retired' });
  const existing = context ? undefined : pending.get(key);
  if (existing) {
    if (afterChange) { reloadAfterPending.add(key); beginActiveProviderConnectionsCatalogRefresh({ scopeKey, lifetimeToken }); }
    return existing;
  }
  if (!context) beginActiveProviderConnectionsCatalogRefresh({ scopeKey, lifetimeToken });
  const store = context ? createCliProviderConnectionsStoreForOperation({ operationContext: context, signal: input.signal })
    : createCliProviderConnectionsStore(input);
  const publish = async (catalog: ProviderConnectionsCatalogSnapshotV1) => {
    if (!current() || context && !await context.isCurrent()) return false;
    const expectedSettingsVersion = readSnapshot()?.settingsVersion;
    return context ? expectedSettingsVersion !== undefined
      && await context.commitProviderConnectionsCatalog({ expectedSettingsVersion, catalog })
      : commitActiveProviderConnectionsCatalog({ scopeKey, lifetimeToken, catalog });
  };
  let work!: Promise<ProviderConnectionsCatalogSnapshotV1>;
  work = (async () => {
    while (true) {
      if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
      if (!context) reloadAfterPending.delete(key);
      let catalog: ProviderConnectionsCatalogSnapshotV1;
      try {
        catalog = await store.readCatalog({ onReadyBeforeCleanup: async ready => {
          if (!context && reloadAfterPending.has(key)) return;
          await publish(ready);
        }, hasPendingCleanup: () => !context && reloadAfterPending.has(key) });
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        catalog = { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled'
          : !current() || code === 'scope-retired' ? 'scope-retired'
          : code === 'unauthorized' || code === 'forbidden' || code === 'unsupported' || code === 'account-mode-mismatch' ? code
          : code === 'account_storage_currentness_unavailable' || code === 'account_encryption_currentness_unavailable' ? 'encryption-material-unavailable'
          : error instanceof Error && error.name === 'ZodError' ? 'invalid-stored-content' : 'unreachable' };
      }
      if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
      if (!context && reloadAfterPending.has(key)) continue;
      if (!context && pending.get(key) === work) pending.delete(key);
      if (!await publish(catalog)) return { status: 'unavailable', reason: 'scope-retired' };
      return catalog;
    }
  })().finally(() => {
    if (pending.get(key) === work) { pending.delete(key); reloadAfterPending.delete(key); }
  });
  if (!context) pending.set(key, work);
  return work;
}

/** The incumbent Account-change observer reopens only an already-demanded catalog. */
export async function refreshDemandedActiveProviderConnectionsCatalog(input: Readonly<{ token: string; signal?: AbortSignal }>): Promise<void> {
  if (getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog === undefined) return;
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return;
  await refresh({ credentials, signal: input.signal }, true);
}
