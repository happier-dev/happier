import { describe, expect, it } from 'vitest';

import {
  PluginReactNativeCompatibilityDecisionV1Schema,
  PluginReactNativeCompatibilityInputV1Schema,
} from './reactNativeCompatibility.js';

describe('React Native plugin UI compatibility contracts', () => {
  it('captures exact runtime inputs before any bundle can load', () => {
    const parsed = PluginReactNativeCompatibilityInputV1Schema.parse({
      pluginId: 'acme.preview',
      contributionId: 'native-preview',
      artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      hostAppVersion: '2.0.0',
      hostUiApiVersion: '1.0.0',
      reactVersion: '19.0.0',
      reactNativeVersion: '0.79.0',
      expoRuntimeVersion: '1.0.0',
      hermesVersion: '0.15.0',
      platform: 'ios',
      channel: 'store',
      availableNativeCapabilities: ['clipboard'],
      requiredNativeCapabilities: ['clipboard'],
      featureState: 'enabled',
      previousCrashCount: 0,
    });

    expect(parsed.channel).toBe('store');
  });

  it('requires fallback diagnostics when a bundle cannot load', () => {
    expect(PluginReactNativeCompatibilityDecisionV1Schema.parse({
      state: 'fallback',
      reason: 'channel_policy_denied',
      diagnostics: ['ios_store_channel_denied'],
    })).toMatchObject({ state: 'fallback' });
  });

  it('rejects the removed UI-specific artifact-revocation decision tier', () => {
    expect(PluginReactNativeCompatibilityDecisionV1Schema.safeParse({
      state: 'blocked',
      reason: 'artifact_revoked',
      diagnostics: ['artifact_revoked'],
    }).success).toBe(false);
  });
});
