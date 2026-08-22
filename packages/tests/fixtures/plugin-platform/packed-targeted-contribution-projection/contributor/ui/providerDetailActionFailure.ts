import { isPluginError } from '@happier-dev/plugin-sdk';

export type PackedActionFailureDisplay = 'retired' | 'platform-unavailable' | 'action-error';

export function classifyActionFailure(error: unknown): PackedActionFailureDisplay {
  if (!isPluginError(error)) return 'action-error';
  if (error.code === 'stale_surface' || error.code === 'plugin_action_generation_retired') {
    return 'retired';
  }
  if (error.code === 'plugin_action_unavailable' || error.code === 'plugin_action_surface_unavailable') {
    return 'platform-unavailable';
  }
  return 'action-error';
}
