import { useCallback, useSyncExternalStore } from 'react';
import {
  IDLE_SCM_FILE_VIEWED, UNKNOWN_SCM_FILE_VIEWED,
  type ScmFileViewedRequest, type ScmFileViewedSource, type ScmFileViewedFile, type ScmFileViewedSnapshot,
} from '@happier-dev/plugin-sdk/scm';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { usePluginSurfaceActivity } from './context.js';

const noSubscribe = () => () => {};

/** Native/same-realm plugins join the host's existing core Viewed owner without a duplicate read. */
export function useScmFileViewed(params: ScmFileViewedRequest): ScmFileViewedSource | null {
  const host = useOptionalPluginUiPresentationHost();
  const { active } = usePluginSurfaceActivity();
  return host?.useScmFileViewed?.({ ...params, active: active && params.active !== false }) ?? null;
}

export function useScmFileViewedFile(source: ScmFileViewedSource | null | undefined, path: string, active = true): ScmFileViewedFile {
  const subscribe = useCallback((listener: () => void) => active && source
    ? source.subscribeFile(path, listener) : noSubscribe(), [source, path, active]);
  const read = useCallback(() => source?.getFile(path) ?? UNKNOWN_SCM_FILE_VIEWED, [source, path]);
  return useSyncExternalStore(subscribe, read, read);
}

export function useScmFileViewedStatus(source: ScmFileViewedSource | null | undefined, active = true): ScmFileViewedSnapshot {
  const read = useCallback(() => source?.getSnapshot() ?? IDLE_SCM_FILE_VIEWED, [source]);
  return useSyncExternalStore(active ? source?.subscribeStatus ?? noSubscribe : noSubscribe, read, read);
}
