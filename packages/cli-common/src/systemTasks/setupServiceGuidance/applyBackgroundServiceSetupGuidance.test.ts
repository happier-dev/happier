import { describe, expect, it, vi } from 'vitest';

import type { BackgroundServiceSetupGuidance } from './buildBackgroundServiceSetupGuidance.js';

describe('applyBackgroundServiceSetupGuidance', () => {
  const baseGuidance: BackgroundServiceSetupGuidance = {
    targetReleaseChannel: 'preview',
    targetServerUrl: 'https://relay.example.test',
    currentDefaultReleaseChannel: 'stable',
    managedReleaseChannels: [],
    exactDefaultServiceExists: false,
    conflictingServices: [],
    shouldOfferDefaultReleaseChannelSwitch: true,
    shouldPromptForServiceReplacement: true,
  };

  it('applies both guidance actions when the user accepts both prompts', async () => {
    const switchDefaultReleaseChannel = vi.fn(async () => undefined);
    const replaceExistingServices = vi.fn(async () => undefined);

    const { applyBackgroundServiceSetupGuidance } = await import('./applyBackgroundServiceSetupGuidance.js');
    const result = await applyBackgroundServiceSetupGuidance({
      guidance: baseGuidance,
      promptSwitchDefaultReleaseChannel: async () => true,
      promptReplaceExistingServices: async () => true,
      switchDefaultReleaseChannel,
      replaceExistingServices,
    });

    expect(result).toEqual({
      cancelled: false,
      cancellationReason: null,
      switchedDefaultReleaseChannel: true,
      replacedExistingServices: true,
    });
    expect(switchDefaultReleaseChannel).toHaveBeenCalledTimes(1);
    expect(replaceExistingServices).toHaveBeenCalledTimes(1);
  });

  it('stops after the first declined prompt', async () => {
    const switchDefaultReleaseChannel = vi.fn(async () => undefined);
    const replaceExistingServices = vi.fn(async () => undefined);

    const { applyBackgroundServiceSetupGuidance } = await import('./applyBackgroundServiceSetupGuidance.js');
    const result = await applyBackgroundServiceSetupGuidance({
      guidance: baseGuidance,
      promptSwitchDefaultReleaseChannel: async () => false,
      promptReplaceExistingServices: async () => true,
      switchDefaultReleaseChannel,
      replaceExistingServices,
    });

    expect(result).toEqual({
      cancelled: true,
      cancellationReason: 'declined_release_channel_switch',
      switchedDefaultReleaseChannel: false,
      replacedExistingServices: false,
    });
    expect(switchDefaultReleaseChannel).not.toHaveBeenCalled();
    expect(replaceExistingServices).not.toHaveBeenCalled();
  });

  it('cancels without changing the default release channel when service replacement is declined', async () => {
    const switchDefaultReleaseChannel = vi.fn(async () => undefined);
    const replaceExistingServices = vi.fn(async () => undefined);

    const { applyBackgroundServiceSetupGuidance } = await import('./applyBackgroundServiceSetupGuidance.js');
    const result = await applyBackgroundServiceSetupGuidance({
      guidance: baseGuidance,
      promptSwitchDefaultReleaseChannel: async () => true,
      promptReplaceExistingServices: async () => false,
      switchDefaultReleaseChannel,
      replaceExistingServices,
    });

    expect(result).toEqual({
      cancelled: true,
      cancellationReason: 'declined_service_replacement',
      switchedDefaultReleaseChannel: false,
      replacedExistingServices: false,
    });
    expect(switchDefaultReleaseChannel).not.toHaveBeenCalled();
    expect(replaceExistingServices).not.toHaveBeenCalled();
  });
});
