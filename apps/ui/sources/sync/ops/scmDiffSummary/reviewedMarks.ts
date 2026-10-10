import { buildScmReviewedMarksKey, createScmReviewedMarksRecordPort, clearScmReviewedMarksRecord, type ScmComparison, type ScmReviewedMarkResponse } from '@happier-dev/protocol/scm';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { AccountStorageContext } from '@/sync/encryption/accountStorageContext';
import type { ServerFetch } from '@/sync/http/client';
import { AccountKvScopeRetiredError, createAccountKvJsonTransport } from '@/sync/ops/account/accountKvJsonTransport';
import { subscribeKvPrefixChanges } from '@/sync/engine/socket/kvUpdateDispatcher';
import { createScmReviewedMarksState, reconcileScmReviewedMarksState, type ScmReviewedMarksState } from '@/sync/domains/scm/diffSummary/reviewedMarks';

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'reviewed_marks_unavailable';
}
export async function clearScmReviewedMarksForComparisonId(params: Readonly<{
  comparisonId: string; credentials: AuthCredentials; request: ServerFetch;
  shouldContinue: () => boolean; encryption?: AccountStorageContext['encryption'];
}>): Promise<ScmReviewedMarkResponse> {
  try {
    if (!params.shouldContinue()) throw new AccountKvScopeRetiredError();
    const transport = createAccountKvJsonTransport({ ...params, key: buildScmReviewedMarksKey(params.comparisonId) });
    const result = await clearScmReviewedMarksRecord({ comparisonId: params.comparisonId, transport });
    if (!params.shouldContinue()) throw new AccountKvScopeRetiredError();
    return result;
  } catch (error) { return { success: false, errorCode: errorCode(error), error: error instanceof Error ? error.message : 'Reviewed marks are unavailable' }; }
}
/** A mounted comparison captures its Home/Account lifetime; no global marks singleton. */
export function createScmReviewedMarksOperations(params: Readonly<{
  comparison: ScmComparison; credentials: AuthCredentials; request: ServerFetch;
  shouldContinue: () => boolean; encryption?: AccountStorageContext['encryption'];
  /** Admitted exact-comparison Action; this observer never writes around its policy. */
  setReviewedAction?: (refs: readonly string[], reviewed: boolean) => Promise<ScmReviewedMarkResponse>;
}>) {
  const key = buildScmReviewedMarksKey(params.comparison.id);
  let retired = false;
  const current = () => !retired && params.shouldContinue();
  const transport = createAccountKvJsonTransport({ ...params, key, shouldContinue: current });
  const port = createScmReviewedMarksRecordPort({ comparison: params.comparison, transport });
  let state = createScmReviewedMarksState();
  const retiredState: ScmReviewedMarksState = { status: 'retired', record: null, version: -1, errorCode: 'account_kv_scope_retired' };
  const listeners = new Set<() => void>();
  const apply = (next: ScmReviewedMarksState) => {
    const reconciled = reconcileScmReviewedMarksState(state, next);
    if (state === reconciled) return;
    state = reconciled;
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
    if (!changes.some(change => change.key === key) || !current()) return;
    pushedWhileReading = true;
    void read().catch(() => { /* read publishes the typed failure without exposing old content. */ });
  }, { credentials: params.credentials, shouldContinue: current });
  const perform = async (operation: () => Promise<ScmReviewedMarkResponse>): Promise<ScmReviewedMarkResponse> => {
    try {
      if (!current()) throw new AccountKvScopeRetiredError();
      const result = await operation();
      if (!current()) throw new AccountKvScopeRetiredError();
      if (result.success || result.record) apply({ status: 'ready', record: result.record ?? null, version: result.version ?? state.version });
      return result;
    } catch (error) { fail(error); return { success: false, errorCode: errorCode(error), error: error instanceof Error ? error.message : 'Reviewed marks are unavailable' }; }
  };
  return {
    key, read, setReviewed: (refs: readonly string[], reviewed: boolean) => perform(() => params.setReviewedAction
      ? params.setReviewedAction(refs, reviewed)
      : Promise.resolve({ success: false, errorCode: 'reviewed_marks_unavailable', error: 'The comparison Action target is unavailable.' })),
    getSnapshot: () => current() ? state : retiredState,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retire: () => { retired = true; disposePush(); apply({ status: 'retired', record: null, version: state.version }); listeners.clear(); },
  };
}
