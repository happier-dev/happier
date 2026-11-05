import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import {
  ForgeCiMountedIntentInputV1Schema,
  type ForgeCiJobRefV1, type ForgeCiMountedIntentOperationV1, type ForgeCiMountedIntentResultV1,
  type ForgeCiRunFiltersV1, type ForgeCiSelectionV1, type ForgeCiStepRefV1, type ForgeCiTriggerValuesV1,
} from '@happier-dev/triage-protocol/ci/v1';
import { forgeCiJobKeyV1, forgeCiSelectionKeyV1 } from '../runtime/identity.js';
import type { LogLineSelectionV1 } from '../runtime/logs/selection.js';

/** Caller-owned presentation controls shared by native and CI logs. No source reads or state store. */
export type LogViewStateV1 = Readonly<{
  selection: LogLineSelectionV1; groupExpanded: Readonly<Record<string, boolean>>;
  revealedLine: number | null; timestampsVisible: boolean;
}>;
export type LogViewOperationV1 = Readonly<{ kind: 'setSelection'; selection: LogLineSelectionV1 }>
  | Readonly<{ kind: 'setGroupExpanded'; groupId: string; expanded: boolean }>
  | Readonly<{ kind: 'revealLine'; line: number }>;
export type LogViewV1 = Readonly<{
  getSnapshot(): LogViewStateV1 | null;
  subscribe(listener: () => void): () => void;
  isAvailable?(): boolean;
  invoke(operation: LogViewOperationV1): void;
  selectStep?(stepId: string): void;
}>;

/** CI keeps its job/step authority and existing mounted state; the shared viewer sees only log controls. */
export function adaptForgeCiLogViewV1(view: ForgeCiMountedViewV1, getJob: () => ForgeCiJobRefV1): LogViewV1 {
  let previous: ForgeCiMountedViewStateV1 | null | undefined;
  let previousJobKey: string | undefined;
  let projected: LogViewStateV1 | null = null;
  return {
    getSnapshot() {
      const state = view.getSnapshot();
      const jobKey = forgeCiJobKeyV1(getJob());
      if (state === previous && jobKey === previousJobKey) return projected;
      const sameSelection = state?.tailLines === previous?.tailLines;
      previous = state;
      previousJobKey = jobKey;
      projected = state ? {
        selection: sameSelection && projected ? projected.selection
          : state.tailLines === null ? { kind: 'all' } : { kind: 'tail', lines: state.tailLines },
        groupExpanded: state.groupExpanded, revealedLine: state.revealedLine, timestampsVisible: state.timestampsVisible,
      } : null;
      return projected;
    },
    subscribe: view.subscribe,
    isAvailable() {
      const job = view.getSnapshot()?.job;
      return job !== null && job !== undefined && forgeCiJobKeyV1(job) === forgeCiJobKeyV1(getJob());
    },
    invoke(operation) {
      if (operation.kind === 'setSelection') {
        if (operation.selection.kind === 'excerpt') return;
        void view.invoke({ mountId: view.mountId, operation: { kind: 'setTailLines',
          lines: operation.selection.kind === 'all' ? null : operation.selection.lines } });
      } else void view.invoke({ mountId: view.mountId, operation });
    },
    selectStep(stepId) { void view.invoke({ mountId: view.mountId, operation: { kind: 'selectStep', step: { job: getJob(), stepId } } }); },
  };
}

export type ForgeCiMountedViewStateV1 = Readonly<{
  view: 'runs' | 'workflows'; workflowId: string | null;
  selection: ForgeCiSelectionV1 | null; job: ForgeCiJobRefV1 | null; step: ForgeCiStepRefV1 | null;
  filters: ForgeCiRunFiltersV1;
  runScope: Extract<ForgeCiMountedIntentOperationV1, { kind: 'setRunScope' }>['scope']; query: string;
  jobsView: 'graph' | 'list'; annotationsExpanded: boolean;
  logFilter: 'all' | 'failed'; tailLines: number | null; groupExpanded: Readonly<Record<string, boolean>>;
  revealedLine: number | null; timestampsVisible: boolean;
  triggerFormOpen: boolean; triggerAvailable: boolean; triggerEnvironmentCursor: string | null;
}>;

/** The selected controller owns ref and raw Form draft; the mount holds no shadow copy. */
export type ForgeCiMountedTriggerControllerV1 = Readonly<{
  available: boolean;
  environmentCursor: string | null;
  setRef(ref: string): void;
  setDraftValues(values: ForgeCiTriggerValuesV1): boolean;
  loadMore(cursor: string): Promise<boolean>;
}>;

export type ForgeCiMountedViewV1 = Readonly<{
  mountId: string;
  getSnapshot(): ForgeCiMountedViewStateV1 | null;
  subscribe(listener: () => void): () => void;
  invoke(input: unknown): Promise<ForgeCiMountedIntentResultV1>;
  openSummary(): void;
  closeSelection(): void;
  setTriggerController(controller: ForgeCiMountedTriggerControllerV1 | null): void;
  dispose(): void;
}>;

/** One controlled mount. Registration and parameterless commands stay host-owned. */
export function createForgeCiMountedViewV1(options: Readonly<{
  mountId: string; phone: boolean;
  initialState?: Partial<ForgeCiMountedViewStateV1>;
  isAvailable?: () => boolean;
  canApply?: (operation: ForgeCiMountedIntentOperationV1, state: ForgeCiMountedViewStateV1) => boolean;
  applyOperation?: (operation: ForgeCiMountedIntentOperationV1, state: ForgeCiMountedViewStateV1) => boolean | Promise<boolean>;
}>): ForgeCiMountedViewV1 {
  let state: ForgeCiMountedViewStateV1 | null = Object.freeze({
    view: 'runs', workflowId: null, selection: null, job: null, step: null, filters: Object.freeze({}), runScope: 'all', query: '',
    jobsView: 'list', annotationsExpanded: false, logFilter: 'all', tailLines: null,
    groupExpanded: Object.freeze({}), revealedLine: null,
    triggerFormOpen: false, triggerAvailable: false, triggerEnvironmentCursor: null,
    timestampsVisible: !options.phone,
    ...options.initialState,
  });
  let trigger: ForgeCiMountedTriggerControllerV1 | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ForgeCiMountedViewStateV1>) => {
    if (!state) return;
    const changes = Object.entries(patch).some(([key, value]) => state?.[key as keyof ForgeCiMountedViewStateV1] !== value);
    if (!changes) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  return {
    mountId: options.mountId,
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    openSummary() { publish({ job: null, step: null, annotationsExpanded: false, revealedLine: null }); },
    closeSelection() { publish({ selection: null, job: null, step: null, annotationsExpanded: false, revealedLine: null }); },
    setTriggerController(controller) {
      if (state === null) return;
      trigger = controller;
      publish({ triggerAvailable: controller?.available === true,
        triggerEnvironmentCursor: controller?.environmentCursor ?? null,
        ...(controller === null ? { triggerFormOpen: false } : {}) });
    },
    async invoke(input) {
      if (state === null || options.isAvailable?.() === false) return { status: 'unavailable' };
      const parsed = ForgeCiMountedIntentInputV1Schema.safeParse(input);
      if (!parsed.success) return { status: 'rejected' };
      if (parsed.data.mountId !== options.mountId) return { status: 'unavailable' };
      const operation = parsed.data.operation;
      const available = options.canApply?.(operation, state);
      if (available === false || operation.kind === 'setJobsView' && operation.view === 'graph' && available !== true) return { status: 'unavailable' };
      if (operation.kind === 'selectJob' && (!state.selection || forgeCiSelectionKeyV1(state.selection) !== forgeCiSelectionKeyV1(operation.job.selection))) return { status: 'rejected' };
      if (operation.kind === 'selectStep' && (!state.job || forgeCiJobKeyV1(state.job) !== forgeCiJobKeyV1(operation.step.job))) return { status: 'rejected' };
      // Route synchronization repeats the current selection. Settle that no-op
      // before host navigation: replaying an unchanged attempt from a job route
      // would reopen its summary, retire the log, then select the job again.
      if (operation.kind === 'selectRun' || operation.kind === 'selectAttempt') {
        const selection: ForgeCiSelectionV1 = operation.kind === 'selectRun' ? { kind: 'run', run: operation.run } : operation.selection;
        if (state.selection && forgeCiSelectionKeyV1(state.selection) === forgeCiSelectionKeyV1(selection)) return { status: 'applied' };
      }
      if (operation.kind === 'selectJob' && state.job && forgeCiJobKeyV1(state.job) === forgeCiJobKeyV1(operation.job)) return { status: 'applied' };
      if (options.applyOperation) {
        const applied = options.applyOperation(operation, state);
        if (!(typeof applied === 'boolean' ? applied : await applied)) return { status: 'unavailable' };
      }
      if (state === null || options.isAvailable?.() === false) return { status: 'unavailable' };
      switch (operation.kind) {
        case 'selectView': publish({ view: operation.view }); break;
        case 'selectWorkflow': publish({ workflowId: operation.workflowId }); break;
        case 'selectRun':
        case 'selectAttempt': {
          const selection: ForgeCiSelectionV1 = operation.kind === 'selectRun' ? { kind: 'run', run: operation.run } : operation.selection;
          if (state.selection && forgeCiSelectionKeyV1(state.selection) === forgeCiSelectionKeyV1(selection)) break;
          publish({ selection, job: null, step: null, annotationsExpanded: false, revealedLine: null });
          break;
        }
        case 'selectJob':
          if (!state.selection || forgeCiSelectionKeyV1(state.selection) !== forgeCiSelectionKeyV1(operation.job.selection)) return { status: 'rejected' };
          if (state.job && forgeCiJobKeyV1(state.job) === forgeCiJobKeyV1(operation.job)) break;
          publish({ job: operation.job, step: null, annotationsExpanded: false, revealedLine: null }); break;
        case 'selectStep':
          if (!state.job || forgeCiJobKeyV1(state.job) !== forgeCiJobKeyV1(operation.step.job)) return { status: 'rejected' };
          if (state.step?.stepId !== operation.step.stepId) publish({ step: operation.step });
          break;
        case 'setFilters': if (!pluginJsonValuesEqual(state.filters, operation.filters)) publish({ filters: operation.filters }); break;
        case 'setRunScope': publish({ runScope: operation.scope }); break;
        case 'setQuery': publish({ query: operation.query }); break;
        case 'setJobsView': publish({ jobsView: operation.view }); break;
        case 'setAnnotationsExpanded': publish({ annotationsExpanded: operation.expanded }); break;
        case 'setLogFilter': publish({ logFilter: operation.filter }); break;
        case 'setTailLines': publish({ tailLines: operation.lines }); break;
        case 'setGroupExpanded':
          if ((state.groupExpanded[operation.groupId] ?? false) !== operation.expanded) publish({ groupExpanded: Object.freeze({ ...state.groupExpanded, [operation.groupId]: operation.expanded }) });
          break;
        case 'revealLine': publish({ revealedLine: operation.line }); break;
        case 'setTriggerRef':
          if (!trigger) return { status: 'unavailable' };
          trigger.setRef(operation.ref); break;
        case 'setTriggerDraft':
          if (!trigger || !state.triggerFormOpen || !trigger.setDraftValues(operation.values)) return { status: 'unavailable' };
          break;
        case 'setTriggerFormOpen':
          if (!trigger || operation.open && !trigger.available) return { status: 'unavailable' };
          publish({ triggerFormOpen: operation.open }); break;
        case 'loadTriggerEnvironments':
          if (!trigger || !state.triggerFormOpen || operation.cursor !== trigger.environmentCursor
            || !await trigger.loadMore(operation.cursor)) return { status: 'unavailable' };
          break;
        case 'setTimestampsVisible': publish({ timestampsVisible: operation.visible }); break;
      }
      return { status: 'applied' };
    },
    dispose() {
      if (!state) return;
      trigger = null;
      state = null;
      for (const listener of listeners) listener();
      listeners.clear();
    },
  };
}
