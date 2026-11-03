import {
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { ResourceContent } from '@happier-dev/plugin-sdk/ui';

import { usePluginHostApiResourceActive, usePluginHostApiResourceStore } from './context.js';
import { usePluginHostReadiness, type PluginUiHostReadiness } from './readiness.public.js';
export { usePluginHostReadiness, type PluginUiHostReadiness } from './readiness.public.js';
import type {
  PluginUiResourceEntry,
  PluginUiResourceError,
  PluginUiResourceReference,
  PluginUiResourceSnapshot,
  PluginUiResourceProjection,
  PluginUiResourceProjectionSnapshot,
} from './resourceStore.js';
import {
  pluginUiResourceReferenceKey,
} from './resourceStore.js';

export type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
export { useFindSurfaceRegistration, type FindSurfaceRegistration } from './find.public.js';
export { useWidgetAreaPort, type PluginUiWidgetAreaPortV1 } from './widgetArea.public.js';

export {
  usePluginHostApi,
  usePluginSurfaceActivity,
  usePluginUiEphemeralSharedScope,
} from './context.js';
export {
  useReviewCommentProposalsForEntry,
  type ReviewCommentProposalQueryV1,
  type ReviewCommentProposalReadV1,
  type ReviewCommentProposalWithBodyV1,
} from './reviewCommentProposals.public.js';
export {
  useSessionState,
  useSessionStates,
  type SessionStateReadV1,
  type SessionStatesReadV1,
} from './sessionState.public.js';
export type {
  PluginUiEphemeralSharedScope,
  PluginUiEphemeralSharedValueLease,
} from './ephemeralSharedScope.public.js';
export {
  type ComposerHandle,
  type ComposerContentService,
  type ComposersService,
  useComposer,
  useComposerView,
} from '../composer/index.js';
export type {
  ComposerDecorationResultV1,
  ComposerDecorationSetV1,
  ComposerContentHandleV1,
  ComposerContentInspectRequestV1,
  ComposerContentInspectResultV1,
  ComposerContentPickMediaRequestV1,
  ComposerFocusResultV1,
  ComposerInputLockRequestV1,
  ComposerObserverV1,
  ComposerReadResultV1,
  ComposerRefV1,
  ComposerRequestOptions,
  ComposerSnapshotV1,
  ComposerTransactionResultV1,
  ComposerTransactionV1,
  ComposerViewStateV1,
} from '../composer/index.js';
export type {
  PluginUiResourceError,
  PluginUiResourceReference,
  PluginUiResourceSnapshot,
  PluginUiResourceProjection,
  PluginUiResourceProjectionSnapshot,
} from './resourceStore.js';
export {
  useExecutePluginAction,
  projectPluginActionRejectionV1,
  type PluginActionExecution,
  type PluginActionExecutionController,
  type PluginActionInput,
  type PluginActionInputFor,
  type PluginActionReference,
  type PluginActionResultFor,
} from './executeAction.js';

/**
 * The result of a plugin Resource read (§3.6).
 *
 * `resource` is the current independent-dimension snapshot. `refresh` re-reads
 * through the same canonical authority without clearing an admitted value,
 * and settles when that owner's refresh completes.
 */
export type PluginUiResourceResult = Readonly<{
  resource: PluginUiResourceSnapshot;
  refresh: () => Promise<void>;
}>;

export type PluginUiResourceOptions = Readonly<{ enabled?: boolean }>;

function usePluginResourceBinding(
  resource: PluginUiResourceReference,
  options?: PluginUiResourceOptions,
) {
  const resourceStore = usePluginHostApiResourceStore();
  const active = usePluginHostApiResourceActive();
  const enabled = options?.enabled !== false;
  const machineBound = typeof resource === 'string' || !('hostRead' in resource);
  const readiness = usePluginHostReadiness(machineBound && (resourceStore.requiresMachine?.(resource) ?? true));
  // The store owns bare-id normalization because it alone knows the mounted
  // plugin identity. The hook only stabilizes the author-facing spelling.
  const resourceKey = pluginUiResourceReferenceKey(resource, null);
  const entry = useMemo<PluginUiResourceEntry>(
    () => resourceStore.getEntry(resource),
    [resourceStore, resourceKey],
  );
  const refresh = useCallback(async () => {
    if (!enabled || !active || readiness.pending || readiness.ready === false) return;
    await entry.refresh();
  }, [entry, enabled, active, readiness.pending, readiness.ready]);
  return { entry, enabled, active, readiness, refresh };
}

function usePluginResourceReadinessPresentation<T>({ pending, ready }: PluginUiHostReadiness) {
  return useMemo(() => {
    let previous: PluginUiResourceProjectionSnapshot<T> | undefined;
    let presented: PluginUiResourceProjectionSnapshot<T> | undefined;
    return (state: PluginUiResourceProjectionSnapshot<T>): PluginUiResourceProjectionSnapshot<T> => {
      // A selector may return the whole snapshot. Repeated external-store reads
      // must retain its presentation identity until a source dimension changes.
      if (state === previous && presented !== undefined) return presented;
      if (pending) {
        const { error: _error, ...retained } = state;
        presented = Object.freeze({ ...retained, pending: state.value === undefined ? 'initial' : 'refresh' });
      } else if (ready === false) {
        presented = Object.freeze({
          ...state,
          pending: 'idle',
          freshness: state.value === undefined ? 'unknown' : 'stale',
          error: Object.freeze({ code: 'unavailable', message: 'Resource execution is unavailable' }),
        });
      } else {
        presented = state;
      }
      previous = state;
      return presented;
    };
  }, [pending, ready]);
}

function usePluginResourceResult(
  resource: PluginUiResourceReference,
  live: boolean,
  options?: PluginUiResourceOptions,
): PluginUiResourceResult {
  const { entry, enabled, active, readiness, refresh } = usePluginResourceBinding(resource, options);
  const present = usePluginResourceReadinessPresentation<ResourceContent>(readiness);
  const subscribe = useCallback(
    (listener: () => void) => enabled && active && !readiness.pending && readiness.ready !== false ? entry.subscribe(listener, live) : () => {},
    [entry, live, enabled, active, readiness.pending, readiness.ready, readiness.revision],
  );
  const state = useSyncExternalStore(subscribe, entry.getSnapshot, entry.getSnapshot);
  const presented = present(state);

  return useMemo(() => ({ resource: presented, refresh }), [refresh, presented]);
}

export type PluginUiResourceProjectionResult<T> = Readonly<{
  value: T;
  /** Reads the same admitted projection synchronously, without acquiring or subscribing again. */
  getSnapshot(): T;
  refresh(): Promise<void>;
}>;

/**
 * Share one decoded model on admitted snapshot demand, then observe selected facts.
 * Keep the projection descriptor stable across consumers. Select a retained leaf
 * or scalar: selected values use Object.is, including for subscription delivery.
 */
export function useLivePluginResourceProjection<T, Selected>(
  resource: PluginUiResourceReference,
  projection: PluginUiResourceProjection<T>,
  selector: (snapshot: PluginUiResourceProjectionSnapshot<T>) => Selected,
  options?: PluginUiResourceOptions,
): PluginUiResourceProjectionResult<Selected> {
  const { entry, enabled, active, readiness, refresh } = usePluginResourceBinding(resource, options);
  const present = usePluginResourceReadinessPresentation<T>(readiness);
  const selectorRef = useRef(selector);
  selectorRef.current = snapshot => selector(present(snapshot));
  const selected = useMemo(() => entry.select(projection, snapshot => selectorRef.current(snapshot)), [entry, projection]);
  const subscribe = useCallback(
    (listener: () => void) => enabled && active && !readiness.pending && readiness.ready !== false
      ? selected.subscribe(listener, true) : () => {},
    [selected, enabled, active, readiness.pending, readiness.ready, readiness.revision],
  );
  const value = useSyncExternalStore(subscribe, selected.getSnapshot, selected.getSnapshot);
  return useMemo(() => ({ value, getSnapshot: () => value, refresh }), [value, selected, refresh]);
}

/** Read/refresh the current Resource snapshot without opening a watch. */
export function usePluginResource(resource: PluginUiResourceReference, options?: PluginUiResourceOptions): PluginUiResourceResult {
  return usePluginResourceResult(resource, false, options);
}

/**
 * Read/refresh and observe a dynamic Resource through the mounted host adapter.
 * A host that does not advertise `watchResource` remains a truthful snapshot
 * source (`subscription: 'unsupported'`); this hook never falls back to polling.
 */
export function useLivePluginResource(resource: PluginUiResourceReference, options?: PluginUiResourceOptions): PluginUiResourceResult {
  return usePluginResourceResult(resource, true, options);
}
