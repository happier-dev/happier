import {
  useCallback,
  useMemo,
  useSyncExternalStore,
} from 'react';

import { usePluginHostApiResourceStore } from './context.js';
import type {
  PluginUiResourceEntry,
  PluginUiResourceError,
  PluginUiResourceReference,
  PluginUiResourceSnapshot,
} from './resourceStore.js';
import {
  pluginUiResourceReferenceKey,
} from './resourceStore.js';

export type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

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
} from './resourceStore.js';
export {
  useExecutePluginAction,
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
 * through the same canonical authority without clearing an admitted value.
 */
export type PluginUiResourceResult = Readonly<{
  resource: PluginUiResourceSnapshot;
  refresh: () => void;
}>;

function usePluginResourceResult(
  resource: PluginUiResourceReference,
  live: boolean,
): PluginUiResourceResult {
  const resourceStore = usePluginHostApiResourceStore();
  // The store owns bare-id normalization because it alone knows the mounted
  // plugin identity. The hook only stabilizes the author-facing spelling.
  const resourceKey = pluginUiResourceReferenceKey(resource, null);
  const entry = useMemo<PluginUiResourceEntry>(
    () => resourceStore.getEntry(resource),
    [resourceStore, resourceKey],
  );
  const subscribe = useCallback(
    (listener: () => void) => entry.subscribe(listener, live),
    [entry, live],
  );
  const state = useSyncExternalStore(subscribe, entry.getSnapshot, entry.getSnapshot);

  const refresh = useCallback(() => {
    entry.refresh();
  }, [entry]);

  return useMemo(() => ({ resource: state, refresh }), [refresh, state]);
}

/** Read/refresh the current Resource snapshot without opening a watch. */
export function usePluginResource(resource: PluginUiResourceReference): PluginUiResourceResult {
  return usePluginResourceResult(resource, false);
}

/**
 * Read/refresh and observe a dynamic Resource through the mounted host adapter.
 * A host that does not advertise `watchResource` remains a truthful snapshot
 * source (`subscription: 'unsupported'`); this hook never falls back to polling.
 */
export function useLivePluginResource(resource: PluginUiResourceReference): PluginUiResourceResult {
  return usePluginResourceResult(resource, true);
}
