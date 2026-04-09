import type { BackgroundServiceSetupGuidance } from './buildBackgroundServiceSetupGuidance.js';

function resolveBackgroundServiceTargetLabel(guidance: BackgroundServiceSetupGuidance): string {
  const targetServerUrl = typeof guidance.targetServerUrl === 'string' ? guidance.targetServerUrl.trim() : '';
  return targetServerUrl || 'the current default server';
}

export function formatBackgroundServiceReleaseChannelSwitchPrompt(
  guidance: BackgroundServiceSetupGuidance,
): string {
  return `Make ${guidance.targetReleaseChannel} the default release-channel before installing the default background service targeting ${resolveBackgroundServiceTargetLabel(guidance)}?`;
}

export function formatBackgroundServiceReplacementPrompt(
  guidance: BackgroundServiceSetupGuidance,
): string {
  return `This computer already has conflicting Happier background services. Replace them before installing the default background service targeting ${resolveBackgroundServiceTargetLabel(guidance)}?`;
}
