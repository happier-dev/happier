import { buildScmReviewedMarksKey, createScmReviewedMarksRecordPort, buildScmReviewScopeId, ScmReviewedMarksError, type ScmReviewedMarkResponse, type ScmReviewedMarksSelection, type ScmReviewedUnmarkInput } from '@happier-dev/protocol/scm';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { AccountStorageContext } from '@/sync/encryption/accountStorageContext';
import type { ServerFetch } from '@/sync/http/client';
import { AccountKvScopeRetiredError, createAccountKvJsonTransport } from '@/sync/ops/account/accountKvJsonTransport';
import { subscribeKvPrefixChanges } from '@/sync/engine/socket/kvUpdateDispatcher';
import { createScmReviewedMarksState, reconcileScmReviewedMarksState, type ScmReviewedMarksState } from '@/sync/domains/scm/diffSummary/reviewedMarks';

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'reviewed_marks_unavailable';
}
/** A mounted comparison captures its Home/Account lifetime; no global marks singleton. */
export function createScmReviewedMarksOperations(params: ScmReviewedMarksSelection & Readonly<{
  credentials: AuthCredentials; request: ServerFetch;
  shouldContinue: () => boolean; encryption?: AccountStorageContext['encryption'];
  /** Every UI intent enters the mounted Action; this observer never writes Account data directly. */
  setReviewedAction: (input: ScmReviewedUnmarkInput, reviewed: boolean) => Promise<ScmReviewedMarkResponse>;
  getSelection?: () => ScmReviewedMarksSelection;
}>) {
  const scopeId = buildScmReviewScopeId(params.comparison ? { repositoryRootPath: params.comparison.repository.rootPath, source: params.comparison.source } : params.source);
  const key = buildScmReviewedMarksKey(scopeId);
  let retired = false;
  const current = () => !retired && params.shouldContinue();
  const transport = createAccountKvJsonTransport({ ...params, key, shouldContinue: current });
  const port = createScmReviewedMarksRecordPort({ ...(params.comparison ? { comparison: params.comparison } : { source: params.source }),
    transport, ...(params.getSelection ? { getSelection: params.getSelection } : {}) });
  let state = createScmReviewedMarksState();
  const retiredState: ScmReviewedMarksState = { status: 'retired', record: null, version: -1, errorCode: 'account_kv_scope_retired' };
  const listeners = new Set<() => void>();
  const recordListeners = new Set<() => void>();
  const statusListeners = new Set<() => void>();
  const apply = (next: ScmReviewedMarksState) => {
    const reconciled = reconcileScmReviewedMarksState(state, next);
    if (state === reconciled) return;
    const recordChanged = state.record !== reconciled.record;
    const statusChanged = state.status !== reconciled.status || state.errorCode !== reconciled.errorCode;
    state = reconciled;
    if (recordChanged) for (const listener of recordListeners) listener();
    if (statusChanged) for (const listener of statusListeners) listener();
    for (const listener of listeners) listener();
  };
  const fail = (error: unknown) => apply({ status: current() ? 'error' : 'retired', record: null, version: state.version, errorCode: errorCode(error) });
  let pendingRead: Promise<Awaited<ReturnType<typeof port.read>>> | null = null;
  let pushedWhileReading = false;
  const read = (): Promise<Awaited<ReturnType<typeof port.read>>> => {
    if (!current()) { const error = new AccountKvScopeRetiredError(); fail(error); return Promise.reject(error); }
    if (pendingRead) return pendingRead;
    pendingRead = (async () => {
      try {
        let snapshot: Awaited<ReturnType<typeof port.read>>;
        do { pushedWhileReading = false; snapshot = await port.read(); }
        while (pushedWhileReading && current());
        apply({ status: 'ready', ...snapshot });
        return snapshot;
      } catch (error) { fail(error); throw error; }
      finally { pendingRead = null; }
    })();
    return pendingRead;
  };
  const disposePush = subscribeKvPrefixChanges(key, changes => {
    // A response already applied this authoritative per-key version. Other observers still
    // fetch a genuinely newer push; error/idle observations retain their recovery read.
    if (!changes.some(change => change.key === key && (state.status !== 'ready' || change.version > state.version)) || !current()) return;
    pushedWhileReading = true;
    void read().catch(() => { /* read publishes the typed failure without exposing old content. */ });
  }, { credentials: params.credentials, shouldContinue: current });
  const perform = async (operation: () => Promise<ScmReviewedMarkResponse>): Promise<ScmReviewedMarkResponse> => {
    try {
      if (!current()) throw new AccountKvScopeRetiredError();
      const result = await operation();
      if (current()) {
        if (result.success || result.record) apply({ status: 'ready', record: result.record ?? null, version: result.version ?? state.version });
        else apply({ status: 'error', record: null, version: state.version, errorCode: result.errorCode });
      }
      return result;
    } catch (error) { fail(error); return { success: false, errorCode: errorCode(error), error: error instanceof Error ? error.message : 'Reviewed marks are unavailable' }; }
  };
  const selection = () => {
    const selected = params.getSelection?.() ?? params;
    const scope = selected.comparison ? { repositoryRootPath: selected.comparison.repository.rootPath, source: selected.comparison.source } : selected.source;
    if (buildScmReviewScopeId(scope) !== scopeId) throw new ScmReviewedMarksError('reviewed_marks_invalid_selection', 'The displayed review scope changed');
    return { selected, input: { v: 2 as const, cwd: scope.repositoryRootPath, source: scope.source,
      ...(selected.comparison ? { comparisonId: selected.comparison.id } : {}) } };
  };
  return {
    key, read, setReviewed: (refs: readonly string[], reviewed: boolean) => perform(() => {
      const { selected, input } = selection();
      if (!selected.comparison) throw new ScmReviewedMarksError('reviewed_marks_invalid_selection', 'Captured evidence is required for occurrence references');
      return params.setReviewedAction({ ...input, comparisonId: selected.comparison.id, changeRefs: [...refs] }, reviewed);
    }),
    setReviewedKeys: (keys: readonly string[], reviewed: boolean) => perform(() => params.setReviewedAction({ ...selection().input, changeKeys: [...keys] }, reviewed)),
    clear: () => perform(() => params.setReviewedAction({ ...selection().input, reset: true }, false)),
    getSnapshot: () => current() ? state : retiredState,
    recordSource: {
      getSnapshot: () => current() && state.status === 'ready' ? state.record : null,
      subscribe: (listener: () => void) => { recordListeners.add(listener); return () => { recordListeners.delete(listener); }; },
    },
    subscribeStatus: (listener: () => void) => { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retire: () => { retired = true; disposePush(); apply({ status: 'retired', record: null, version: state.version }); listeners.clear(); recordListeners.clear(); statusListeners.clear(); },
  };
}
