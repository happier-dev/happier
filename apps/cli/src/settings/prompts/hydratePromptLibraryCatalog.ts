import { readPromptLibraryCatalogRecordV1, type PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import type { AccountRoleOverridesReadV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { beginActivePromptLibraryCatalogRefresh, commitActivePromptLibraryCatalog, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken, readActiveAccountRoleOverrides } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliPromptLibraryStore } from './promptLibraryStore';
export { readActivePromptLibraryCatalog } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const pending = new Map<string, {
  readonly completion: Promise<PromptLibraryCatalogSnapshotV1>; readonly readers: Set<() => void>;
  rowsObserved: boolean;
}>();
const refreshAfterInFlight = new Set<string>();
type RefreshInput = Readonly<{ credentials: StoredCredentials; signal?: AbortSignal }>;
type CapturedPromptAccount = Readonly<{ scopeKey: string; lifetimeToken: number }>;

export type ActivePromptLibraryDemand = Readonly<{
  credentials: StoredCredentials; scopeKey: string; lifetimeToken: number;
  key: 'coding' | 'voice' | 'role-overrides'; signal?: AbortSignal;
}>;
export type ActivePromptLibraryRecordRead = ReturnType<typeof readPromptLibraryCatalogRecordV1>
  | Readonly<{ status: 'unavailable'; reason: 'catalog-unobserved' }>;

/** One existing-loader demand for a real key in the caller's captured Account lifetime. */
export async function prepareActivePromptLibraryRecord(input: ActivePromptLibraryDemand): Promise<ActivePromptLibraryRecordRead> {
  input.signal?.throwIfAborted();
  const current = getActiveAccountSettingsSnapshot();
  if (current?.scopeKey !== input.scopeKey || resolveAccountSettingsScopeKey(input.credentials) !== input.scopeKey
    || getActiveAccountSettingsSnapshotLifetimeToken() !== input.lifetimeToken) return { status: 'unavailable', reason: 'scope-retired' };
  const currentRead = current.promptLibraryCatalog ? readPromptLibraryCatalogRecordV1({ catalog: current.promptLibraryCatalog,
    key: input.key, rawSettings: current.source === 'none' ? undefined : current.rawSettings }) : undefined;
  if (currentRead?.status !== 'ready') {
    const completion = refresh(input, { scopeKey: input.scopeKey, lifetimeToken: input.lifetimeToken });
    const readers = pending.get(`${input.scopeKey}:${input.lifetimeToken}`)?.readers;
    let resolveReadable!: () => void;
    const readable = new Promise<void>(resolve => { resolveReadable = resolve; });
    const observeReadable = () => {
      const snapshot = getActiveAccountSettingsSnapshot();
      if (snapshot?.scopeKey !== input.scopeKey || getActiveAccountSettingsSnapshotLifetimeToken() !== input.lifetimeToken) {
        resolveReadable();
      } else if (snapshot.promptLibraryCatalog && readPromptLibraryCatalogRecordV1({ catalog: snapshot.promptLibraryCatalog,
        key: input.key, rawSettings: snapshot.source === 'none' ? undefined : snapshot.rawSettings }).status === 'ready') {
        resolveReadable();
      }
    };
    // Readiness is a phase of the incumbent refresh, including equal-row
    // refreshes which intentionally produce no broad Settings notification.
    readers?.add(observeReadable);
    try { observeReadable(); await Promise.race([completion, readable]); }
    finally { readers?.delete(observeReadable); }
  }
  input.signal?.throwIfAborted();
  const admitted = getActiveAccountSettingsSnapshot();
  if (admitted?.scopeKey !== input.scopeKey || getActiveAccountSettingsSnapshotLifetimeToken() !== input.lifetimeToken) {
    return { status: 'unavailable', reason: 'scope-retired' };
  }
  return admitted.promptLibraryCatalog ? readPromptLibraryCatalogRecordV1({ catalog: admitted.promptLibraryCatalog,
    key: input.key, rawSettings: admitted.source === 'none' ? undefined : admitted.rawSettings })
    : { status: 'unavailable', reason: 'catalog-unobserved' };
}

/** Role preparation delegates to the same key demand used by Coding and Voice. */
export async function prepareActiveAccountRoleOverrides(input: Omit<ActivePromptLibraryDemand, 'key'>): Promise<AccountRoleOverridesReadV1> {
  const read = await prepareActivePromptLibraryRecord({ ...input, key: 'role-overrides' });
  if (read.status !== 'ready') return read;
  return readActiveAccountRoleOverrides(input);
}

function refresh(input: RefreshInput, captured?: CapturedPromptAccount, afterChange = false): Promise<PromptLibraryCatalogSnapshotV1> {
  const scopeKey = captured?.scopeKey ?? resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = captured?.lifetimeToken ?? getActiveAccountSettingsSnapshotLifetimeToken();
  const key = `${scopeKey}:${lifetimeToken}`;
  const current = () => getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey
    && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken;
  if (!current() || resolveAccountSettingsScopeKey(input.credentials) !== scopeKey || (!afterChange && input.signal?.aborted)) {
    return Promise.resolve({ status: 'unavailable', reason: 'scope-retired' });
  }
  const existing = pending.get(key);
  if (existing) {
    // A withdrawn catalog cannot be re-admitted by an earlier readable phase
    // whose source/history maintenance is still completing.
    if (afterChange || (existing.rowsObserved && getActiveAccountSettingsSnapshot()?.promptLibraryCatalog?.status === 'loading')) {
      beginActivePromptLibraryCatalogRefresh({ scopeKey, lifetimeToken }); refreshAfterInFlight.add(key);
    }
    return existing.completion;
  }
  beginActivePromptLibraryCatalogRefresh({ scopeKey, lifetimeToken });
  let work!: Promise<PromptLibraryCatalogSnapshotV1>;
  work = (async () => {
    let requestInput: RefreshInput = afterChange ? { credentials: input.credentials } : input;
    while (true) {
      if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
      const request = pending.get(key);
      if (request) request.rowsObserved = false;
      let catalog: PromptLibraryCatalogSnapshotV1;
      try { catalog = await createCliPromptLibraryStore(requestInput).readPromptLibraryCatalog(readable => {
        if (!current() || refreshAfterInFlight.has(key)) return;
        const request = pending.get(key);
        if (request) request.rowsObserved = true;
        commitActivePromptLibraryCatalog({ scopeKey, lifetimeToken, catalog: readable });
        for (const reader of pending.get(key)?.readers ?? []) reader();
      }); }
      catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        catalog = { status: 'unavailable', reason: requestInput.signal?.aborted ? 'cancelled'
          : !current() || code === 'scope-retired' ? 'scope-retired'
          : code === 'unauthorized' || code === 'forbidden' || code === 'unsupported' || code === 'account-mode-mismatch' ? code
          : code === 'account_storage_currentness_unavailable' || code === 'account_encryption_currentness_unavailable' ? 'encryption-material-unavailable'
          : error instanceof Error && error.name === 'ZodError' ? 'invalid-stored-content' : 'unreachable' };
      }
      if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
      if (refreshAfterInFlight.delete(key)) { requestInput = { credentials: input.credentials }; continue; }
      // A synchronous wake cannot join a request which already chose to finish.
      if (pending.get(key)?.completion === work) pending.delete(key);
      commitActivePromptLibraryCatalog({ scopeKey, lifetimeToken, catalog });
      return catalog;
    }
  })().finally(() => {
    if (pending.get(key)?.completion === work) { pending.delete(key); refreshAfterInFlight.delete(key); }
    else if (!pending.has(key)) refreshAfterInFlight.delete(key);
  });
  pending.set(key, { completion: work, readers: new Set(), rowsObserved: false });
  return work;
}
export function refreshActivePromptLibraryCatalog(input: RefreshInput): Promise<PromptLibraryCatalogSnapshotV1> { return refresh(input); }
/** The original lifetime needs a read issued after a durable write or Account wake. */
export function refreshActivePromptLibraryCatalogAfterChange(input: RefreshInput & CapturedPromptAccount): Promise<PromptLibraryCatalogSnapshotV1> {
  return refresh({ credentials: input.credentials }, input, true);
}
export async function refreshDemandedActivePromptLibraryCatalog(input: Readonly<{ token: string; signal?: AbortSignal }>): Promise<void> {
  const active = getActiveAccountSettingsSnapshot();
  if (!active?.scopeKey || active.promptLibraryCatalog === undefined) return;
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return;
  input.signal?.throwIfAborted();
  await refreshActivePromptLibraryCatalogAfterChange({ credentials, scopeKey: active.scopeKey, lifetimeToken });
}
