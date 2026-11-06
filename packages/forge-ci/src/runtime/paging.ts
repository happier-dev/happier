import type { ForgeCiActionInputByOperationV1, ForgeCiLogV1, ForgeCiStepV1 } from '@happier-dev/triage-protocol/ci/v1';
import { triagePagedPanelInitialState, triagePagedPanelReducer, type TriagePagedPanelPageV1, type TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type { ForgeCiReadDemandV1, ForgeCiReadLeaseV1, ForgeCiReadsV1, ForgeCiReadSnapshotV1, ForgeCiReadValueV1 } from './reads.js';
import { mergeForgeCiLogPagesV1 } from './logs/page.js';
import type { ForgeCiLogIndexV1 } from './logs/index.js';

export type ForgeCiPagedReadOperationV1 = 'listWorkflows' | 'listRuns' | 'listJobs' | 'listArtifacts' | 'listAnnotations' | 'listEnvironments' | 'readDeploymentHistory' | 'readJobLog';
export type ForgeCiPagedReadLeaseV1<K extends ForgeCiPagedReadOperationV1> = ForgeCiReadLeaseV1<K> & Readonly<{ loadMore(): Promise<void> }>
  & (K extends 'readJobLog' ? Readonly<{ indexLog(steps?: readonly ForgeCiStepV1[]): ForgeCiLogIndexV1 | null }> : unknown);
type Page = TriagePagedPanelPageV1<unknown, 'pagination' | 'provider_ceiling'>;
type ReconcileRows = <T>(previous: readonly T[], incoming: readonly T[], context: Readonly<{ replacing: boolean; observedRows?: readonly T[] }>) => readonly T[];

/** A mounted cursor walk borrows exact queries; the existing read owner owns every request and timer. */
export function createForgeCiPagedReadV1<K extends ForgeCiPagedReadOperationV1>(
  reads: ForgeCiReadsV1, operation: K, input: ForgeCiActionInputByOperationV1[K],
  demand: ForgeCiReadDemandV1, reconcileRows: ReconcileRows,
): ForgeCiPagedReadLeaseV1<K> {
  type Source = { cursor: string | undefined; lease: ForgeCiReadLeaseV1<K>; unsubscribe(): void };
  const sources: Source[] = [];
  const semantic = new Set<() => void>();
  const presentation = new Set<() => void>();
  let released = false;
  let active = demand.active !== false;
  let refreshing = false;
  let mergeFailure: TriageSourceFailureV1 | null = null;
  let panel = triagePagedPanelInitialState<unknown, TriageSourceFailureV1, 'pagination' | 'provider_ceiling'>();
  let snapshot: ForgeCiReadSnapshotV1<K> = { value: null, pending: false, failure: null, checkedAtMs: null, retired: false };

  function publish(next: ForgeCiReadSnapshotV1<K>) {
    const changed = snapshot.value !== next.value;
    snapshot = next;
    if (changed) for (const listener of semantic) listener();
    for (const listener of presentation) listener();
  }
  function dropAfterFirst() {
    for (const source of sources.splice(1)) { source.unsubscribe(); source.lease.release(); }
  }
  function pageValue(observed: Page): ForgeCiReadValueV1<K> | null {
    const pages = sources.flatMap(source => {
      const value = source.lease.getValue();
      return value === null ? [] : [value as Page];
    });
    if (pages.length === 0) return null;
    // The native query owners retain the pages. Reconcile their demanded walk
    // against this reducer's actual previous rows, including peer refreshes.
    const page: Page = {
      rows: pages.flatMap(value => value.rows),
      omittedRowCount: pages.reduce((total, value) => total + value.omittedRowCount, 0),
      projectionTruncated: pages.some(value => value.projectionTruncated),
      continuation: pages.at(-1)!.continuation,
      incomplete: pages.reduce<Page['incomplete']>((reason, value) => value.incomplete ?? reason, null),
    };
    const token = panel.token + 1;
    panel = triagePagedPanelReducer(panel, { kind: 'refreshStarted', token });
    panel = triagePagedPanelReducer(panel, { kind: 'pageSettled', token, page }, {
      reconcileRows: (previous, incoming, context) => reconcileRows(previous, incoming, { ...context, observedRows: observed.rows }),
    });
    const previous = snapshot.value as Page | null;
    const value: Page = { rows: panel.rows, omittedRowCount: panel.omittedRowCount, projectionTruncated: panel.projectionTruncated,
      continuation: panel.continuation, incomplete: panel.incomplete };
    // This is the walk producer's baseline, not a second cache of provider bodies.
    return (previous && value.rows === previous.rows && value.omittedRowCount === previous.omittedRowCount
      && value.projectionTruncated === previous.projectionTruncated && value.continuation === previous.continuation
      && value.incomplete === previous.incomplete ? previous : value) as ForgeCiReadValueV1<K>;
  }
  function receive(source: Source) {
    if (released || !sources.includes(source)) return;
    const first = source === sources[0];
    if (first && (refreshing || operation === 'readJobLog')) {
      refreshing = false;
      dropAfterFirst();
    }
    mergeFailure = null;
    let value: ForgeCiReadValueV1<K> | null;
    if (operation === 'readJobLog') {
      const page = source.lease.getValue() as ForgeCiLogV1 | null;
      const previous = snapshot.value as ForgeCiLogV1 | null;
      if (!first && page?.kind === 'available' && previous?.kind === 'available') {
        const merged = mergeForgeCiLogPagesV1({ previous, page });
        if (merged.kind === 'unavailable') { mergeFailure = merged.failure; value = snapshot.value; }
        else value = merged.value as ForgeCiReadValueV1<K>;
      } else value = page as ForgeCiReadValueV1<K> | null;
    } else {
      const page = source.lease.getValue();
      value = page === null ? null : pageValue(page as Page);
    }
    publish({ ...snapshot, value });
  }
  function status() {
    if (released) return;
    const first = sources[0];
    if (refreshing && first && !first.lease.getSnapshot().pending) {
      refreshing = false;
      if (first.lease.getValue() !== null && first.lease.getSnapshot().failure === null) {
        dropAfterFirst();
        receive(first);
      }
    }
    const statuses = sources.map(source => source.lease.getSnapshot());
    const retired = statuses.some(value => value.retired);
    if (retired) panel = triagePagedPanelReducer(panel, { kind: 'panelLeft' });
    publish({ value: retired ? null : snapshot.value, pending: statuses.some(value => value.pending),
      failure: mergeFailure ?? statuses.find(value => value.failure !== null)?.failure ?? null,
      checkedAtMs: statuses.reduce<number | null>((latest, value) => value.checkedAtMs === null ? latest
        : latest === null ? value.checkedAtMs : Math.max(latest, value.checkedAtMs), null), retired });
  }
  function acquire(cursor: string | undefined): Source {
    const lease = reads.acquire(operation, { ...input, ...(cursor === undefined ? {} : { cursor }) }, { ...demand, active });
    const source: Source = { cursor, lease, unsubscribe: () => {} };
    sources.push(source);
    const unsubscribeValue = lease.subscribeValue(() => receive(source));
    const unsubscribeStatus = lease.subscribe(status);
    source.unsubscribe = () => { unsubscribeValue(); unsubscribeStatus(); };
    if (lease.getValue() !== null) receive(source);
    status();
    return source;
  }
  acquire('cursor' in input ? input.cursor : undefined);
  return {
    ...(operation === 'readJobLog' ? {
      indexLog(steps?: readonly ForgeCiStepV1[]) {
        const source = sources[0]?.lease.getValue() as ForgeCiLogV1 | null | undefined;
        return reads.indexLog({ log: snapshot.value as ForgeCiLogV1 | null,
          ...(steps === undefined ? {} : { steps }), ...(source == null ? {} : { source }) });
      },
    } : {}),
    getValue: () => snapshot.value,
    getSnapshot: () => snapshot,
    subscribeValue(listener) { semantic.add(listener); return () => { semantic.delete(listener); }; },
    subscribe(listener) { presentation.add(listener); return () => { presentation.delete(listener); }; },
    refresh() {
      if (released || !active) return Promise.resolve();
      refreshing = true; mergeFailure = null;
      return sources[0]!.lease.refresh().finally(status);
    },
    loadMore() {
      if (released || !active || snapshot.pending) return Promise.resolve();
      const value = snapshot.value;
      const cursor = value && 'continuation' in value ? value.continuation : null;
      if (!cursor) return Promise.resolve();
      const last = sources.at(-1)!;
      mergeFailure = null;
      if (last.cursor === cursor) return last.lease.refresh();
      const next = acquire(cursor).lease;
      return next.getSnapshot().pending ? next.refresh() : Promise.resolve();
    },
    setActive(next) {
      if (released || active === next) return;
      active = next;
      for (const source of [...sources]) source.lease.setActive(next);
    },
    release() {
      if (released) return;
      released = true;
      for (const source of sources.splice(0)) { source.unsubscribe(); source.lease.release(); }
      panel = triagePagedPanelReducer(panel, { kind: 'panelLeft' });
      publish({ value: null, pending: false, failure: null, checkedAtMs: null, retired: true });
      semantic.clear(); presentation.clear();
    },
  } as ForgeCiPagedReadLeaseV1<K>;
}
