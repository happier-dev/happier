import type { ScmComparison, ScmReviewedMarksRecord } from '@happier-dev/protocol/scm';
import { buildScmChangeKeys, buildScmReviewScopeId } from '@happier-dev/protocol/scm/comparisonOccurrences';

export type ScmReviewedMarksState = Readonly<{
  status: 'idle' | 'ready' | 'error' | 'retired'; record: ScmReviewedMarksRecord | null; version: number; errorCode?: string;
}>;
export type ScmReviewedMarksRecordSource = Readonly<{
  getSnapshot: () => ScmReviewedMarksRecord | null;
  subscribe: (listener: () => void) => () => void;
}>;
export function createScmReviewedMarksState(): ScmReviewedMarksState { return { status: 'idle', record: null, version: -1 }; }
export function reconcileScmReviewedMarksState(current: ScmReviewedMarksState, next: ScmReviewedMarksState): ScmReviewedMarksState {
  if (next.status === 'ready' && next.version < current.version) return current;
  const equalRecord = current.record === next.record || (current.record !== null && next.record !== null
    && current.record.scopeId === next.record.scopeId
    && current.record.reviewedChangeKeys.length === next.record.reviewedChangeKeys.length
    && current.record.reviewedChangeKeys.every((key, index) => key === next.record?.reviewedChangeKeys[index])
    && JSON.stringify(current.record.viewedFiles) === JSON.stringify(next.record.viewedFiles));
  if (equalRecord && current.status === next.status && current.version === next.version && current.errorCode === next.errorCode) return current;
  return equalRecord ? { ...next, record: current.record } : next;
}

/** One immutable comparison owns exact content membership for all its selection consumers. */
export function createScmReviewedSelections(comparison: ScmComparison, selections: readonly Readonly<{ changeRefs: readonly string[] }>[]) {
  const scopeId = buildScmReviewScopeId({ repositoryRootPath: comparison.repository.rootPath, source: comparison.source });
  const keysByRef = selections.length > 0 ? buildScmChangeKeys(comparison) : new Map<string, readonly string[]>();
  const selectionsByKey = new Map<string, Set<number>>();
  const states = selections.map((selection, index) => {
    const refs = selection.changeRefs;
    const keys = new Set(refs.flatMap(ref => keysByRef.get(ref) ?? []));
    const available = refs.length > 0 && refs.every(ref => (keysByRef.get(ref)?.length ?? 0) > 0);
    for (const key of keys) {
      let indexes = selectionsByKey.get(key);
      if (!indexes) selectionsByKey.set(key, indexes = new Set());
      indexes.add(index);
    }
    return { keys, available, marked: 0, reviewed: false };
  });
  let marked = new Set<string>();
  let reviewedCount = 0;
  return {
    isReviewed: (index: number) => states[index]?.reviewed ?? false,
    getReviewedCount: () => reviewedCount,
    apply: (record: ScmReviewedMarksRecord | null): ReadonlyMap<number, boolean> => {
      const next = new Set(record?.scopeId === scopeId ? record.reviewedChangeKeys : []);
      const affected = new Set<number>();
      const change = (key: string, delta: number) => {
        for (const index of selectionsByKey.get(key) ?? []) {
          states[index]!.marked += delta;
          affected.add(index);
        }
      };
      for (const key of marked) if (!next.has(key)) change(key, -1);
      for (const key of next) if (!marked.has(key)) change(key, 1);
      marked = next;
      const changed = new Map<number, boolean>();
      for (const index of affected) {
        const state = states[index]!;
        const reviewed = state.available && state.marked === state.keys.size;
        if (reviewed === state.reviewed) continue;
        state.reviewed = reviewed;
        reviewedCount += reviewed ? 1 : -1;
        changed.set(index, reviewed);
      }
      return changed;
    },
  };
}
