import {
  resolveBackgroundServiceSetupServicesRequiringReplacement,
  type BackgroundServiceSetupGuidance,
} from './buildBackgroundServiceSetupGuidance.js';

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
  if (guidance.foreignHomeConflictingServices.length > 0) {
    const serviceCount = resolveBackgroundServiceSetupServicesRequiringReplacement(guidance).length;
    const pronoun = serviceCount === 1 ? 'it' : 'them';
    return `This computer is already using a Happier background service from another installation. Replace ${pronoun} so this installation becomes the background service for ${resolveBackgroundServiceTargetLabel(guidance)}?`;
  }
  return `This computer already has conflicting Happier background services. Replace them before installing the default background service targeting ${resolveBackgroundServiceTargetLabel(guidance)}?`;
}

export function formatBackgroundServiceManualRelayTakeoverPrompt(
  guidance: BackgroundServiceSetupGuidance,
): string {
  return `This computer is currently using a temporary relay process for ${resolveBackgroundServiceTargetLabel(guidance)}. Continue to stop that process and switch this computer to the background service?`;
}
