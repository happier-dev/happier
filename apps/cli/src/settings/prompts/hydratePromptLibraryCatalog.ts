import { recordPromptPreparationFailure } from '@/agent/prompts/library/homeReadPreparationError';
import { $ZodError } from 'zod/v4/core';
import { isRetryableAccountEncryptionCurrentnessError } from '@/api/client/accountEncryptionCurrentness';
import { readPromptLibraryCatalogRecordV1, readRetainedPromptLibraryRecordV1, type PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { isPromptExternalLinkForMachine } from '@happier-dev/protocol/prompts/library/promptExternalLinksV1';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import type { AccountRoleOverridesReadV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey, resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { beginActivePromptLibraryCatalogRefresh, commitActivePromptLibraryCatalog, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken, readActiveAccountRoleOverrides, readAccountRoleOverridesFromSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { PromptLibraryCatalogKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createCliPromptLibraryStore } from './promptLibraryStore';

export { readActivePromptLibraryCatalog } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const pending = new Map<string, {
  readonly completion: Promise<PromptLibraryCatalogSnapshotV1>; readonly readers: Set<() => void>;
  rowsObserved: boolean;
}>();
const refreshAfterInFlight = new Set<string>();
type OperationRead = { completion: Promise<void>; rowsObserved: boolean; readers: Set<() => void> };
const operationReads = new WeakMap<SavedSecretOperationContextV1, Map<AbortSignal | undefined, OperationRead>>();
type RefreshInput = Readonly<{ credentials: StoredCredentials; signal?: AbortSignal; maintainSource?: false }>;
type CapturedPromptAccount = Readonly<{ scopeKey: string; lifetimeToken: number }>;

export type ActivePromptLibraryDemand = Readonly<{
  credentials: StoredCredentials; scopeKey: string; lifetimeToken: number;
  key: PromptLibraryCatalogKeyV1; signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1;
  /** Reobserve destination rows without making optional source/history maintenance an admission dependency. */
  refresh?: boolean;
}>;
export type ActivePromptLibraryRecordRead = ReturnType<typeof readPromptLibraryCatalogRecordV1>
  | Readonly<{ status: 'unavailable'; reason: 'catalog-unobserved' }>;

function catalogReadFailure(error: unknown, aborted: boolean, current: boolean): Extract<PromptLibraryCatalogSnapshotV1, { status: 'unavailable' }> {
  recordPromptPreparationFailure('prompt-library.read', error);
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return { status: 'unavailable', reason: aborted ? 'cancelled'
    : !current || code === 'scope-retired' ? 'scope-retired'
    : code === 'unauthorized' || code === 'forbidden' || code === 'unsupported' || code === 'account-mode-mismatch'
      || code === 'database_transaction_conflict_exhausted' ? code
    : isRetryableAccountEncryptionCurrentnessError(error) ? 'unreachable'
    : code === 'account_storage_currentness_unavailable' || code === 'account_encryption_currentness_unavailable' ? 'encryption-material-unavailable'
    : error instanceof $ZodError ? 'invalid-stored-content' : 'unreachable' };
}

/** One existing-loader demand for a real key in the caller's captured Account lifetime. */
async function demandActivePromptLibraryRecord(input: ActivePromptLibraryDemand): Promise<ActivePromptLibraryRecordRead> {
  input.signal?.throwIfAborted();
  const operation = input.operationContext;
  if (operation) {
    if (operation.credentials.token !== input.credentials.token || !await operation.isCurrent()
      || operation.readSnapshot()?.scopeKey !== input.scopeKey) return { status: 'unavailable', reason: 'scope-retired' };
    input.signal?.throwIfAborted();
    const current = operation.readSnapshot();
    const currentRead = current?.promptLibraryCatalog ? readPromptLibraryCatalogRecordV1({ catalog: current.promptLibraryCatalog,
      key: input.key, rawSettings: current.source === 'none' ? undefined : current.rawSettings }) : undefined;
    if (currentRead?.status === 'ready' && !input.refresh) return currentRead;
    const reads = operationReads.get(operation) ?? new Map<AbortSignal | undefined, OperationRead>();
    operationReads.set(operation, reads);
    let entry = reads.get(input.signal);
    // Destination authority is readable before optional source/history cleanup,
    // just as for the incumbent Account refresh below. The same loader retains
    // cleanup and its publication fences; it cannot hold admission open.
    // All keys consume one destination inventory in this retained operation.
    // An explicit post-write refresh must issue a new read; older maintenance
    // cannot publish over it. Distinct cancellation custody stays independent.
    if (!entry || entry.rowsObserved || input.refresh) {
      const owned: OperationRead = { completion: Promise.resolve(), rowsObserved: false, readers: new Set() };
      entry = owned;
      reads.set(input.signal, owned);
      const publish = async (catalog: PromptLibraryCatalogSnapshotV1) => (async () => {
        if (reads.get(input.signal) !== owned) return;
        const snapshot = operation.readSnapshot();
        if (!snapshot || !await operation.commitPromptLibraryCatalog({ expectedSettingsVersion: snapshot.settingsVersion, catalog })) {
          throw Object.assign(new Error('Captured Prompt library Account retired'), { code: 'scope-retired' });
        }
        owned.rowsObserved = true;
        for (const reader of owned.readers) reader();
      })();
      owned.completion = (async () => {
        let catalog: PromptLibraryCatalogSnapshotV1;
        try { catalog = await createCliPromptLibraryStore(input).readPromptLibraryCatalog(publish,
          input.refresh ? { maintainSource: false } : undefined); }
        catch (error) {
          input.signal?.throwIfAborted();
          const current = await operation.isCurrent() && operation.readSnapshot()?.scopeKey === input.scopeKey;
          if (!current) return;
          catalog = catalogReadFailure(error, false, current);
        }
        await publish(catalog);
      })().finally(() => { if (reads.get(input.signal) === owned) reads.delete(input.signal); });
    }
    let resolveReadable!: () => void;
    const readable = new Promise<void>(resolve => { resolveReadable = resolve; });
    const observe = () => {
      if (!entry?.rowsObserved) return;
      const snapshot = operation.readSnapshot();
      if (!snapshot || snapshot.promptLibraryCatalog && readPromptLibraryCatalogRecordV1({ catalog: snapshot.promptLibraryCatalog,
        key: input.key, rawSettings: snapshot.source === 'none' ? undefined : snapshot.rawSettings }).status === 'ready') resolveReadable();
    };
    entry.readers.add(observe);
    try { observe(); await Promise.race([entry.completion, readable]); }
    finally { entry.readers.delete(observe); }
    input.signal?.throwIfAborted();
    const snapshot = operation.readSnapshot();
    if (!snapshot || !await operation.isCurrent()) return { status: 'unavailable', reason: 'scope-retired' };
    return snapshot.promptLibraryCatalog ? readPromptLibraryCatalogRecordV1({ catalog: snapshot.promptLibraryCatalog,
      key: input.key, rawSettings: snapshot.source === 'none' ? undefined : snapshot.rawSettings })
      : { status: 'unavailable', reason: 'catalog-unobserved' };
  }
  const current = getActiveAccountSettingsSnapshot();
  if (current?.scopeKey !== input.scopeKey || resolveAccountSettingsScopeKey(input.credentials) !== input.scopeKey
    || getActiveAccountSettingsSnapshotLifetimeToken() !== input.lifetimeToken) return { status: 'unavailable', reason: 'scope-retired' };
  const currentRead = current.promptLibraryCatalog ? readPromptLibraryCatalogRecordV1({ catalog: current.promptLibraryCatalog,
    key: input.key, rawSettings: current.source === 'none' ? undefined : current.rawSettings }) : undefined;
  if (input.refresh || currentRead?.status !== 'ready') {
    // A fresh destination read is a consumption demand. Full hydration retains
    // source and exact-history maintenance.
    const completion = refresh({ ...input, ...(input.refresh ? { maintainSource: false } : {}) },
      { scopeKey: input.scopeKey, lifetimeToken: input.lifetimeToken });
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

export async function prepareActivePromptLibraryRecord(input: ActivePromptLibraryDemand): Promise<ActivePromptLibraryRecordRead> {
  try {
    const read = await demandActivePromptLibraryRecord(input);
    if (read.status !== 'ready') recordPromptPreparationFailure('prompt-library.read', undefined,
      read.status === 'unavailable' ? read.reason : 'invalid-stored-content');
    return read;
  } catch (error) {
    recordPromptPreparationFailure('prompt-library.read', error);
    throw error;
  }
}

/** Role preparation delegates to the same key demand used by Coding and Voice. */
export async function prepareActiveAccountRoleOverrides(input: Omit<ActivePromptLibraryDemand, 'key'>): Promise<AccountRoleOverridesReadV1> {
  const read = await prepareActivePromptLibraryRecord({ ...input, key: 'role-overrides' });
  if (read.status !== 'ready') return read;
  if (input.operationContext) {
    const snapshot = input.operationContext.readSnapshot();
    return snapshot ? readAccountRoleOverridesFromSnapshot(snapshot) : { status: 'unavailable', reason: 'scope-retired' };
  }
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
  if (existing && !existing.rowsObserved) {
    // A durable write needs rows issued after that write, even if an earlier
    // destination read has not returned yet.
    if (afterChange) {
      beginActivePromptLibraryCatalogRefresh({ scopeKey, lifetimeToken }); refreshAfterInFlight.add(key);
    }
    return existing.completion;
  }
  // Once destination rows have been observed, only optional maintenance is
  // pending. A later demand owns a new row read immediately; the older loader
  // may finish its cleanup but must no longer publish catalog authority.
  if (existing) { pending.delete(key); refreshAfterInFlight.delete(key); }
  beginActivePromptLibraryCatalogRefresh({ scopeKey, lifetimeToken });
  let work!: Promise<PromptLibraryCatalogSnapshotV1>;
  work = (async (): Promise<PromptLibraryCatalogSnapshotV1> => {
    let requestInput: RefreshInput = afterChange ? { credentials: input.credentials, maintainSource: false } : input;
    while (true) {
      if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
      const request = pending.get(key);
      if (request) request.rowsObserved = false;
      let catalog: PromptLibraryCatalogSnapshotV1;
      try { catalog = await createCliPromptLibraryStore(requestInput).readPromptLibraryCatalog(readable => {
        if (!current() || pending.get(key)?.completion !== work || refreshAfterInFlight.has(key)) return;
        const request = pending.get(key);
        if (request) request.rowsObserved = true;
        commitActivePromptLibraryCatalog({ scopeKey, lifetimeToken, catalog: readable });
        for (const reader of request?.readers ?? []) reader();
      }, requestInput.maintainSource === false ? { maintainSource: false } : undefined); }
      catch (error) {
        catalog = catalogReadFailure(error, requestInput.signal?.aborted === true, current());
      }
      if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
      if (pending.get(key)?.completion !== work) return catalog;
      if (refreshAfterInFlight.delete(key)) { requestInput = { credentials: input.credentials, maintainSource: false }; continue; }
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
  return refresh({ credentials: input.credentials, maintainSource: false }, input, true);
}
export type MachineSkillInstallCatalogDemand = Readonly<{
  target: MachineAdministrationTargetV1; libraryServerIdentityId: string;
}>;

/** The existing typed receipt reader supplies both Artifact invalidation and catalog demand. */
export function readActiveMachineSkillInstallArtifactIds(input: Readonly<{
  token: string; machineInstallDemand: MachineSkillInstallCatalogDemand;
}>): readonly string[] {
  const active = getActiveAccountSettingsSnapshot();
  if (!active?.scopeKey || active.scopeKey !== resolveAccountSettingsScopeKeyForToken(input.token)) return [];
  const read = active.promptLibraryCatalog
    ? readPromptLibraryCatalogRecordV1({ catalog: active.promptLibraryCatalog, key: 'external-links',
      rawSettings: active.source === 'none' ? undefined : active.rawSettings })
    : active.source === 'none' || active.rawSettings === undefined
      ? null : readRetainedPromptLibraryRecordV1(active.rawSettings, 'external-links');
  if (read?.status !== 'ready' || read.record.key !== 'external-links') return [];
  return [...new Set(read.record.value.links.filter(link => isPromptExternalLinkForMachine(link, input.machineInstallDemand))
    .map(link => link.artifactId))];
}

export async function refreshDemandedActivePromptLibraryCatalog(input: Readonly<{
  token: string; signal?: AbortSignal; machineInstallDemand?: MachineSkillInstallCatalogDemand;
}>): Promise<PromptLibraryCatalogSnapshotV1 | null> {
  const active = getActiveAccountSettingsSnapshot();
  if (!active?.scopeKey || (active.promptLibraryCatalog === undefined && (!input.machineInstallDemand
    || readActiveMachineSkillInstallArtifactIds({ token: input.token, machineInstallDemand: input.machineInstallDemand }).length === 0))) return null;
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return null;
  input.signal?.throwIfAborted();
  return await refreshActivePromptLibraryCatalogAfterChange({ credentials, scopeKey: active.scopeKey, lifetimeToken });
}
