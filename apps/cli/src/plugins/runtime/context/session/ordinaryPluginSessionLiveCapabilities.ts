import type { InteractionsService } from '@happier-dev/plugin-sdk/interactions';

import type { CurrentSessionCapabilityBinding } from '@/session/presentation/currentSessionUiBindings';
import type { PluginSessionLiveCapabilities } from '@/session/services/pluginSessionHandleCapabilities';

export function projectOrdinaryPluginSessionLiveCapabilities(params: Readonly<{
  live: CurrentSessionCapabilityBinding;
  interactions: InteractionsService;
}>): PluginSessionLiveCapabilities {
  return Object.freeze({
    scopeId: params.live.scopeId,
    permissionHandler: params.live.permissionHandler,
    interactions: params.interactions,
    readPermissionMode: params.live.readPermissionMode,
    ...(params.live.applyPermissionModeIntent
      ? { applyPermissionModeIntent: params.live.applyPermissionModeIntent }
      : {}),
    ...(params.live.createMediaService
      ? { media: params.live.createMediaService(() => true) }
      : {}),
    signal: params.live.signal,
    isCurrent: params.live.isCurrent,
  });
}
