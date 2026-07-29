import { describe, expect, it } from 'vitest';

import { resolveVoiceProviderReadinessPresentation } from './voiceProviderReadinessPresentation';

describe('resolveVoiceProviderReadinessPresentation', () => {
  const translate = (key: string) => key;

  it('renders the canonical readiness reason and recovery action when a provider is unavailable', () => {
    expect(resolveVoiceProviderReadinessPresentation({
      role: 'realtime_conversation',
      providerId: 'example/provider',
      status: 'unavailable',
      code: 'server_feature_disabled',
      reasonKey: 'voice.readiness.server_feature_disabled',
      recoveryAction: 'switch_provider',
    }, translate)).toEqual({
      reason: 'voice.readiness.server_feature_disabled',
      action: 'voice.readiness.actions.switch_provider',
    });
  });

  it('does not add readiness noise to a ready provider', () => {
    expect(resolveVoiceProviderReadinessPresentation({
      role: 'realtime_conversation',
      providerId: 'example/provider',
      status: 'ready',
      code: 'ready',
      reasonKey: 'voice.readiness.ready',
      recoveryAction: 'none',
    }, translate)).toEqual({ reason: null, action: null });
  });
});
