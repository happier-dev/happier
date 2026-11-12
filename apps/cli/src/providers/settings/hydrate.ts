import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createProviderCatalogAdmissionError, readProviderSettingsForCli } from './read';
import { $ZodError } from 'zod/v4/core';
import { awaitWithinProviderOperation, type ProviderOperationLifetime } from '../operationLifetime';
import { isRetryableAccountEncryptionCurrentnessError } from '@/api/client/accountEncryptionCurrentness';
import type { ProviderConnectionsCatalogSnapshotV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { randomUUID } from 'node:crypto';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { beginActiveProviderConnectionsCatalogRefresh, commitActiveProviderConnectionsCatalog,
  getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { sameProviderConnectionsCatalogAuthority } from '@/providers/lifecycle/currentAccountSettingsSnapshot';
import { createCliProviderConnectionsStore, createCliProviderConnectionsStoreForOperation, observeProviderCatalogPhase } from './catalogStore';

export { readActiveProviderConnectionsCatalog } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const pending = new Map<string, {
  completion: Promise<ProviderConnectionsCatalogSnapshotV1>; readers: Set<() => void>;
}>();
const reloadAfterPending = new Set<string>();
type RefreshInput = Readonly<{ credentials: StoredCredentials; signal?: AbortSignal; operationContext?: SavedSecretOperationContextV1;
  isCredentialCurrent?(): boolean | Promise<boolean> }>;

type CliCatalogInput = Readonly<{
  expectedScopeKey: string; operationContext?: SavedSecretOperationContextV1; signal?: AbortSignal; credentials?: StoredCredentials;
}>;

/** Retained runtime admission demand-loads its captured catalog once. */
export function prepareProviderConnectionsCatalogForCli(input: CliCatalogInput): Promise<ProviderConnectionsCatalogSnapshotV1> {
  return readProviderConnectionsCatalogForCli(input, false);
}

/** Join only an already-owned observation; spawn revalidation must not start a fallback read. */
export async function waitForPendingProviderConnectionsCatalogRefreshForCli(input: Readonly<{
  expectedScopeKey: string; lifetime: ProviderOperationLifetime;
}>): Promise<void> {
  if (getActiveAccountSettingsSnapshot()?.scopeKey !== input.expectedScopeKey) return;
  const key = `${input.expectedScopeKey}:${getActiveAccountSettingsSnapshotLifetimeToken()}`;
  const refresh = pending.get(key);
  if (!refresh) return;
  let onReadable!: () => void;
  const readable = new Promise<void>(resolve => { onReadable = resolve; });
  refresh.readers.add(onReadable);
  try {
    // Readable publication precedes optional history maintenance. Both this
    // reader and ordinary preparation share that same settlement edge.
    await awaitWithinProviderOperation(Promise.race([refresh.completion, readable]), input.lifetime);
  } finally {
    refresh.readers.delete(onReadable);
  }
}

/** Explicit machine operations reobserve row authority before capturing their basis. */
export function refreshProviderConnectionsCatalogForCli(input: CliCatalogInput): Promise<ProviderConnectionsCatalogSnapshotV1> {
  return readProviderConnectionsCatalogForCli(input, true);
}

function readProviderConnectionsCatalogForCli(input: CliCatalogInput, reobserve: boolean): Promise<ProviderConnectionsCatalogSnapshotV1> {
  // Admission, row loading and local publication are one read preparation.
  // The store exits this checkpoint before source mutations or history cleanup.
  return (async () => {
    const snapshot = input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    if (snapshot?.scopeKey !== input.expectedScopeKey) return { status: 'unavailable', reason: 'scope-retired' };
    const operationContext = input.operationContext;
    if (operationContext && !await observeProviderCatalogPhase({ catalogReadId: randomUUID(), phase: 'admission_currentness' },
      () => operationContext.isCurrent())) return { status: 'unavailable', reason: 'scope-retired' };
    if (!reobserve && snapshot.providerConnectionsCatalog?.status === 'ready') return snapshot.providerConnectionsCatalog;
    const credentials = input.operationContext?.credentials ?? input.credentials ?? await readStoredCredentials();
    if (!credentials || resolveAccountSettingsScopeKey(credentials) !== input.expectedScopeKey) return { status: 'unavailable', reason: 'scope-retired' };
    if (!input.operationContext && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) return { status: 'unavailable', reason: 'scope-retired' };
    const readSnapshot = () => input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
    const refreshInput: RefreshInput = { credentials, operationContext: input.operationContext, signal: input.signal };
    let resolveReadable!: (catalog: ProviderConnectionsCatalogSnapshotV1) => void;
    const readable = new Promise<ProviderConnectionsCatalogSnapshotV1>(resolve => { resolveReadable = resolve; });
    const observeReadable = () => {
      const catalog = readSnapshot()?.providerConnectionsCatalog;
      if (catalog?.status === 'ready') resolveReadable(catalog);
    };
    // Readiness belongs to the refresh, including an equal-row publication
    // which intentionally produces no broad Account notification.
    const completion = refresh(refreshInput, reobserve ? 'reobserve' : 'read', observeReadable);
    // Source preference handoff still precedes this publication; optional
    // history maintenance remains with the loader without holding admission.
    const result = await Promise.race([completion, readable]);
    if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    if (input.operationContext && !await input.operationContext.isCurrent()) return { status: 'unavailable', reason: 'scope-retired' };
    const admitted = readSnapshot();
    if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    if (admitted?.scopeKey !== input.expectedScopeKey
      || !input.operationContext && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
      return { status: 'unavailable', reason: 'scope-retired' };
    }
    if (result.status !== 'ready') return result;
    return admitted.providerConnectionsCatalog ?? { status: 'unavailable', reason: 'unreachable' };
  })();
}

/** Demand-load the sole catalog in the caller's existing Account custody. */
export function refreshActiveProviderConnectionsCatalog(input: RefreshInput,
  options?: Readonly<{ afterChange?: boolean }>): Promise<ProviderConnectionsCatalogSnapshotV1> {
  return refresh(input, options?.afterChange === true ? 'change' : 'read');
}

function refresh(input: RefreshInput, intent: 'read' | 'reobserve' | 'change' = 'read', onReadable?: () => void): Promise<ProviderConnectionsCatalogSnapshotV1> {
  const context = input.operationContext;
  const scopeKey = resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const key = `${scopeKey}:${lifetimeToken}`;
  const readSnapshot = () => context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  const current = () => readSnapshot()?.scopeKey === scopeKey
    && (context ? context.credentials.token === input.credentials.token : getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken);
  if (!current() || input.signal?.aborted) return Promise.resolve({ status: 'unavailable', reason: 'scope-retired' });
  const previousCatalog = readSnapshot()?.providerConnectionsCatalog;
  const sourceCleanupPending = previousCatalog?.status === 'ready' && previousCatalog.cleanup?.status === 'cleanup-pending';
  const existing = context ? undefined : pending.get(key);
  if (existing) {
    // Pending covers observation through publication, never optional history.
    // Read demand joins this pass; only an actual change invalidates its basis.
    if (intent === 'change') {
      reloadAfterPending.add(key); beginActiveProviderConnectionsCatalogRefresh({ scopeKey, lifetimeToken });
    }
    if (onReadable) existing.readers.add(onReadable);
    return existing.completion;
  }
  if (!context && (intent !== 'reobserve' || readSnapshot()?.providerConnectionsCatalog?.status !== 'ready')) {
    beginActiveProviderConnectionsCatalogRefresh({ scopeKey, lifetimeToken });
  }
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
  work = (async (): Promise<ProviderConnectionsCatalogSnapshotV1> => {
    while (true) {
      if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
      if (!context) reloadAfterPending.delete(key);
      let catalog: ProviderConnectionsCatalogSnapshotV1;
      let publishedReady: ProviderConnectionsCatalogSnapshotV1 | undefined;
      try {
        catalog = await store.readCatalog({ sourceCleanupPending, onReadyBeforeCleanup: async ready => {
          if (!context && reloadAfterPending.has(key)) return;
          if (await publish(ready)) {
            if (!context && reloadAfterPending.has(key)) return;
            const admitted = readSnapshot()?.providerConnectionsCatalog;
            publishedReady = admitted?.status === 'ready' ? admitted : ready;
            if (context) onReadable?.();
            else {
              const request = pending.get(key);
              if (request) {
                const readers = [...request.readers];
                request.readers.clear();
                // A later explicit reobservation can start immediately. Its
                // readers share that next pass while this pass cleans history.
                pending.delete(key);
                for (const reader of readers) reader();
              }
            }
          }
        }, hasPendingCleanup: () => !context && pending.get(key)?.completion === work && reloadAfterPending.has(key) });
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        catalog = { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled'
          : !current() || code === 'scope-retired' ? 'scope-retired'
          : code === 'unauthorized' || code === 'forbidden' || code === 'unsupported' || code === 'account-mode-mismatch' ? code
          : isRetryableAccountEncryptionCurrentnessError(error) ? 'unreachable'
          : code === 'account_storage_currentness_unavailable' || code === 'account_encryption_currentness_unavailable' ? 'encryption-material-unavailable'
          : error instanceof $ZodError ? 'invalid-stored-content' : 'unreachable' };
      }
      if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
      if (!context && publishedReady) {
        // Maintenance from an older observation cannot overwrite a later
        // publication or a genuine change's withdrawal.
        const result = catalog.status === 'unavailable' && catalog.reason === 'cancelled' ? publishedReady : catalog;
        if (sameProviderConnectionsCatalogAuthority(publishedReady, readSnapshot()?.providerConnectionsCatalog)) await publish(result);
        return result;
      }
      if (!context && reloadAfterPending.has(key)) continue;
      if (!context && pending.get(key)?.completion === work) pending.delete(key);
      // Cancelling optional maintenance cannot withdraw a row already admitted
      // to this still-current Account. No new authority is published here.
      if (publishedReady && catalog.status === 'unavailable' && catalog.reason === 'cancelled') return publishedReady;
      if (!await publish(catalog)) return { status: 'unavailable', reason: 'scope-retired' };
      return catalog;
    }
  })().finally(() => {
    if (pending.get(key)?.completion === work) { pending.delete(key); reloadAfterPending.delete(key); }
  });
  if (!context) pending.set(key, { completion: work, readers: new Set(onReadable ? [onReadable] : []) });
  return work;
}

/** The incumbent Account-change observer reopens only an already-demanded catalog. */
export async function refreshDemandedActiveProviderConnectionsCatalog(input: Readonly<{ token: string; signal?: AbortSignal }>): Promise<void> {
  const catalog = getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog;
  if (catalog === undefined) return;
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return;
  await refresh({ credentials, signal: input.signal }, 'change');
}

/** Direct-purpose compatibility consumes the same prepared Account row as saved connections. */
export async function prepareProviderSettingsForCli(input: Readonly<{
  readSnapshot(): ActiveAccountSettingsSnapshot | null;
  operationContext?: SavedSecretOperationContextV1;
  signal?: AbortSignal;
}>): Promise<import('@happier-dev/protocol').ProviderSettingsV1 | null> {
  const snapshot = input.operationContext ? input.operationContext.readSnapshot() : input.readSnapshot();
  if (!snapshot) return null;
  if (snapshot.providerConnectionsCatalog?.status === 'ready') return readProviderSettingsForCli(snapshot).settings;
  const catalog = await prepareProviderConnectionsCatalogForCli({
    expectedScopeKey: snapshot.scopeKey ?? '', operationContext: input.operationContext, signal: input.signal,
  });
  if (catalog.status !== 'ready') {
    const reason = catalog.status === 'unavailable' ? catalog.reason : catalog.status;
    throw Object.assign(new Error('Provider catalog preparation failed: ' + reason),
      createProviderCatalogAdmissionError(catalog));
  }
  return readProviderSettingsForCli({ ...snapshot, providerConnectionsCatalog: catalog }).settings;
}
