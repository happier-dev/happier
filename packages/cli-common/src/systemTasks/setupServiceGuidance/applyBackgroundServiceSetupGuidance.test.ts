import { describe, expect, it, vi } from 'vitest';

import type { BackgroundServiceSetupGuidance } from './buildBackgroundServiceSetupGuidance.js';

describe('applyBackgroundServiceSetupGuidance', () => {
  const baseGuidance: BackgroundServiceSetupGuidance = {
    targetReleaseChannel: 'preview',
    targetServerUrl: 'https://relay.example.test',
    currentDefaultReleaseChannel: 'stable',
    managedReleaseChannels: [],
    manualRelayOwner: null,
    exactDefaultServiceExists: false,
    conflictingServices: [],
    shouldOfferDefaultReleaseChannelSwitch: true,
    shouldPromptForManualRelayTakeover: false,
    shouldPromptForServiceReplacement: true,
  };

  it('applies both guidance actions when the user accepts both prompts', async () => {
    const switchDefaultReleaseChannel = vi.fn(async () => undefined);
    const replaceExistingServices = vi.fn(async () => undefined);

    const { applyBackgroundServiceSetupGuidance } = await import('./applyBackgroundServiceSetupGuidance.js');
    const result = await applyBackgroundServiceSetupGuidance({
      guidance: baseGuidance,
      promptSwitchDefaultReleaseChannel: async () => true,
      promptTakeOverManualRelayRuntime: async () => true,
      promptReplaceExistingServices: async () => true,
      switchDefaultReleaseChannel,
      takeOverManualRelayRuntime: async () => undefined,
      replaceExistingServices,
    });

    expect(result).toEqual({
      cancelled: false,
      cancellationReason: null,
      switchedDefaultReleaseChannel: true,
      tookOverManualRelayRuntime: false,
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
      promptTakeOverManualRelayRuntime: async () => true,
      promptReplaceExistingServices: async () => true,
      switchDefaultReleaseChannel,
      takeOverManualRelayRuntime: async () => undefined,
      replaceExistingServices,
    });

    expect(result).toEqual({
      cancelled: true,
      cancellationReason: 'declined_release_channel_switch',
      switchedDefaultReleaseChannel: false,
      tookOverManualRelayRuntime: false,
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
      promptTakeOverManualRelayRuntime: async () => true,
      promptReplaceExistingServices: async () => false,
      switchDefaultReleaseChannel,
      takeOverManualRelayRuntime: async () => undefined,
      replaceExistingServices,
    });

    expect(result).toEqual({
      cancelled: true,
      cancellationReason: 'declined_service_replacement',
      switchedDefaultReleaseChannel: false,
      tookOverManualRelayRuntime: false,
      replacedExistingServices: false,
    });
    expect(switchDefaultReleaseChannel).not.toHaveBeenCalled();
    expect(replaceExistingServices).not.toHaveBeenCalled();
  });

  it('prompts to take over a manual relay runtime before replacing background services', async () => {
    const guidance: BackgroundServiceSetupGuidance = {
      ...baseGuidance,
      shouldOfferDefaultReleaseChannelSwitch: false,
      shouldPromptForManualRelayTakeover: true,
      manualRelayOwner: {
        currentReleaseChannel: 'stable',
        currentCliVersion: '0.2.0',
      },
    };
    const takeOverManualRelayRuntime = vi.fn(async () => undefined);
    const replaceExistingServices = vi.fn(async () => undefined);

    const { applyBackgroundServiceSetupGuidance } = await import('./applyBackgroundServiceSetupGuidance.js');
    const result = await applyBackgroundServiceSetupGuidance({
      guidance,
      promptSwitchDefaultReleaseChannel: async () => true,
      promptTakeOverManualRelayRuntime: async () => true,
      promptReplaceExistingServices: async () => true,
      switchDefaultReleaseChannel: async () => undefined,
      takeOverManualRelayRuntime,
      replaceExistingServices,
    });

    expect(result).toEqual({
      cancelled: false,
      cancellationReason: null,
      switchedDefaultReleaseChannel: false,
      tookOverManualRelayRuntime: true,
      replacedExistingServices: true,
    });
    expect(takeOverManualRelayRuntime).toHaveBeenCalledTimes(1);
    expect(replaceExistingServices).toHaveBeenCalledTimes(1);
  });
});
