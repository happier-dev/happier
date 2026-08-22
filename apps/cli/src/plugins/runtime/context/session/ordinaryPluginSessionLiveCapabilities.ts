import type { InteractionsService } from '@happier-dev/plugin-sdk/interactions';

import type { CurrentSessionCapabilityBinding } from '@/session/presentation/currentSessionUiBindings';
import type { PluginSessionLiveCapabilities } from '@/session/services/pluginSessionHandleCapabilities';
import {
  isCanonicalPathAuthorizedByPluginFileSystemScopes,
  type PluginFileSystemScope,
} from '../../invocation/services/filesystem';
import type { PluginFileSystemRoots } from '../../invocation/services/types';

export function projectOrdinaryPluginSessionLiveCapabilities(params: Readonly<{
  live: CurrentSessionCapabilityBinding;
  interactions: InteractionsService;
  filesystemRoots?: PluginFileSystemRoots;
  filesystemScopes?: readonly PluginFileSystemScope[];
}>): PluginSessionLiveCapabilities {
  const roots = params.filesystemRoots;
  const scopes = params.filesystemScopes;
  const authorizeSourceRoot = roots && scopes
    ? async (canonicalRoot: string): Promise<boolean> => (
      await isCanonicalPathAuthorizedByPluginFileSystemScopes({
        roots,
        scopes,
        canonicalPath: canonicalRoot,
        access: 'read',
      })
    )
    : null;
  return Object.freeze({
    scopeId: params.live.scopeId,
    permissionHandler: params.live.permissionHandler,
    interactions: params.interactions,
    readPermissionMode: params.live.readPermissionMode,
    ...(authorizeSourceRoot && params.live.createMediaService
      ? { media: params.live.createMediaService(authorizeSourceRoot) }
      : {}),
    signal: params.live.signal,
    isCurrent: params.live.isCurrent,
  });
}
