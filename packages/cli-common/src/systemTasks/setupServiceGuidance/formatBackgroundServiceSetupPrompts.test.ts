import { describe, expect, it } from 'vitest';

import type { BackgroundServiceSetupGuidance } from './buildBackgroundServiceSetupGuidance.js';
import {
  formatBackgroundServiceReleaseChannelSwitchPrompt,
  formatBackgroundServiceReplacementPrompt,
} from './formatBackgroundServiceSetupPrompts.js';

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

describe('formatBackgroundServiceSetupPrompts', () => {
  it('formats the release-channel switch prompt around the default-following background service target', () => {
    expect(formatBackgroundServiceReleaseChannelSwitchPrompt(baseGuidance)).toBe(
      'Make preview the default release-channel before installing the default background service targeting https://relay.example.test?',
    );
  });

  it('formats the replacement prompt around the default-following background service target', () => {
    expect(formatBackgroundServiceReplacementPrompt(baseGuidance)).toBe(
      'This computer already has conflicting Happier background services. Replace them before installing the default background service targeting https://relay.example.test?',
    );
  });

  it('falls back to the current default server label when no explicit target URL is available', () => {
    const guidance = {
      ...baseGuidance,
      targetServerUrl: null,
    } satisfies BackgroundServiceSetupGuidance;

    expect(formatBackgroundServiceReleaseChannelSwitchPrompt(guidance)).toBe(
      'Make preview the default release-channel before installing the default background service targeting the current default server?',
    );
    expect(formatBackgroundServiceReplacementPrompt(guidance)).toBe(
      'This computer already has conflicting Happier background services. Replace them before installing the default background service targeting the current default server?',
    );
  });
});
