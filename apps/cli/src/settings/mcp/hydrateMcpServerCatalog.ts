import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { beginActiveMcpServerCatalogRefresh, commitActiveMcpServerCatalog, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliMcpServerStore } from './mcpServerStore';

type RefreshInput = Readonly<{ credentials: StoredCredentials; signal?: AbortSignal }>;
type CapturedAccount = Readonly<{ scopeKey: string; lifetimeToken: number }>;
type PendingRefresh = {
  completion: Promise<McpServerCatalogSnapshotV1>;
  readers: Set<() => void>;
  maintenance: Set<Promise<McpServerCatalogSnapshotV1>>;
  refreshing: boolean;
};
const pending = new Map<string, PendingRefresh>();
const refreshAfterInFlight = new Set<string>();

function refresh(input: RefreshInput, captured?: CapturedAccount, afterChange = false): Promise<McpServerCatalogSnapshotV1> {
  const scopeKey = captured?.scopeKey ?? resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = captured?.lifetimeToken ?? getActiveAccountSettingsSnapshotLifetimeToken();
  const key = `${scopeKey}:${lifetimeToken}`;
  const current = () => getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey
    && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken;
  if (!current() || resolveAccountSettingsScopeKey(input.credentials) !== scopeKey) return Promise.resolve({ status: 'unavailable', reason: 'scope-retired' });
  const existing = pending.get(key);
  if (existing?.refreshing) {
    if (afterChange) { beginActiveMcpServerCatalogRefresh({ scopeKey, lifetimeToken }); refreshAfterInFlight.add(key); }
    return existing.completion;
  }
  const entry: PendingRefresh = existing ?? { completion: Promise.resolve({ status: 'loading' }), readers: new Set(),
    maintenance: new Set(), refreshing: false };
  pending.set(key, entry);
  entry.refreshing = true;
  beginActiveMcpServerCatalogRefresh({ scopeKey, lifetimeToken });
  let work!: Promise<McpServerCatalogSnapshotV1>;
  work = (async () => {
    let requestInput: RefreshInput = afterChange ? { credentials: input.credentials } : input;
    while (true) {
      if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
      let catalog: McpServerCatalogSnapshotV1;
      try {
        let resolveAdmission!: (catalog: McpServerCatalogSnapshotV1) => void;
        const admission = new Promise<McpServerCatalogSnapshotV1>(resolve => { resolveAdmission = resolve; });
        const maintenance = createCliMcpServerStore({ ...requestInput,
          hasPendingCleanup: () => entry.maintenance.size > 1 }).readCatalog(readable => {
          resolveAdmission(readable);
          if (!current() || refreshAfterInFlight.has(key)) return;
          commitActiveMcpServerCatalog({ scopeKey, lifetimeToken, catalog: readable });
          for (const reader of entry.readers) reader();
        });
        entry.maintenance.add(maintenance);
        // Keep the existing captured cleanup handle until terminal, while the
        // next demanded GET can reobserve a write without joining that phase.
        void maintenance.then(completed => {
          const incumbent = getActiveAccountSettingsSnapshot()?.mcpServerCatalog;
          if (current() && !entry.refreshing && completed.status === 'ready' && incumbent?.status === 'ready'
            && completed.revision === incumbent.revision && completed.authority === incumbent.authority) {
            commitActiveMcpServerCatalog({ scopeKey, lifetimeToken, catalog: completed });
          }
        }, () => undefined).finally(() => {
          entry.maintenance.delete(maintenance);
          if (!entry.refreshing && entry.maintenance.size === 0 && pending.get(key) === entry) pending.delete(key);
        });
        catalog = await Promise.race([maintenance, admission]);
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        catalog = { status: 'unavailable', reason: requestInput.signal?.aborted ? 'cancelled'
          : !current() || code === 'scope-retired' ? 'scope-retired'
          : code === 'unauthorized' || code === 'forbidden' || code === 'unsupported' || code === 'account-mode-mismatch' ? code
          : code === 'account_storage_currentness_unavailable' || code === 'account_encryption_currentness_unavailable' ? 'encryption-material-unavailable'
          : error instanceof Error && error.name === 'ZodError' ? 'invalid-stored-content' : 'unreachable' };
      }
      if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
      if (refreshAfterInFlight.delete(key)) { requestInput = { credentials: input.credentials }; continue; }
      // A synchronous publication wake must start a new read, not join an
      // admission that has already chosen its terminal result.
      entry.refreshing = false;
      commitActiveMcpServerCatalog({ scopeKey, lifetimeToken, catalog });
      return catalog;
    }
  })().finally(() => {
    if (entry.completion === work) entry.refreshing = false;
    if (!entry.refreshing && entry.maintenance.size === 0 && pending.get(key) === entry) pending.delete(key);
    if (!entry.refreshing) refreshAfterInFlight.delete(key);
  });
  entry.completion = work;
  return work;
}

export function refreshActiveMcpServerCatalog(input: RefreshInput): Promise<McpServerCatalogSnapshotV1> { return refresh(input); }
export function refreshActiveMcpServerCatalogAfterChange(input: RefreshInput & CapturedAccount): Promise<McpServerCatalogSnapshotV1> {
  return refresh({ credentials: input.credentials }, input, true);
}

/** Demand waits for admission, not optional source/history maintenance. */
export async function prepareActiveMcpServerCatalog(input: RefreshInput & CapturedAccount & Readonly<{ refresh?: boolean }>): Promise<McpServerCatalogSnapshotV1> {
  const current = () => getActiveAccountSettingsSnapshot()?.scopeKey === input.scopeKey
    && getActiveAccountSettingsSnapshotLifetimeToken() === input.lifetimeToken;
  if (!current() || resolveAccountSettingsScopeKey(input.credentials) !== input.scopeKey) return { status: 'unavailable', reason: 'scope-retired' };
  const incumbent = getActiveAccountSettingsSnapshot()?.mcpServerCatalog;
  if (incumbent?.status === 'ready' && !input.refresh) return incumbent;
  const completion = refresh(input, input, input.refresh === true);
  const readers = pending.get(`${input.scopeKey}:${input.lifetimeToken}`)?.readers;
  let resolveReadable!: () => void;
  const readable = new Promise<void>(resolve => { resolveReadable = resolve; });
  const observe = () => { if (!current() || getActiveAccountSettingsSnapshot()?.mcpServerCatalog?.status === 'ready') resolveReadable(); };
  readers?.add(observe);
  try { observe(); await Promise.race([completion, readable]); }
  finally { readers?.delete(observe); }
  input.signal?.throwIfAborted();
  return current() ? getActiveAccountSettingsSnapshot()?.mcpServerCatalog ?? { status: 'loading' }
    : { status: 'unavailable', reason: 'scope-retired' };
}

export async function refreshDemandedActiveMcpServerCatalog(input: Readonly<{ token: string; signal?: AbortSignal }>): Promise<void> {
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot?.scopeKey || snapshot.mcpServerCatalog === undefined) return;
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return;
  input.signal?.throwIfAborted();
  await refreshActiveMcpServerCatalogAfterChange({ credentials, scopeKey: snapshot.scopeKey, lifetimeToken });
}
