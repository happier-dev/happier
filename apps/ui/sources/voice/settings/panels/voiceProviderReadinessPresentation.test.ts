import { describe, expect, it } from 'vitest';

import { resolveVoiceProviderReadinessPresentation } from './voiceProviderReadinessPresentation';

describe('resolveVoiceProviderReadinessPresentation', () => {
  const translate = (key: string) => key;

  it('names the selected service when setup is incomplete, without referring to another page location', () => {
    const translateWithService = (key: string, params?: { service: string }) =>
      key === 'voice.readiness.settings_missing_required_setting' ? `Finish setting up ${params?.service} to start.` : key;
    expect(resolveVoiceProviderReadinessPresentation({
      role: 'realtime_conversation', providerId: 'example/provider', status: 'unavailable',
      code: 'settings_missing_required_setting', reasonKey: 'voice.readiness.settings_missing_required_setting',
      recoveryAction: 'open_provider_settings',
    }, translateWithService, 'ElevenLabs Voice').summary).toBe('Finish setting up ElevenLabs Voice to start.');
  });

  it('renders the canonical readiness reason and recovery action when a provider is unavailable', () => {
    expect(resolveVoiceProviderReadinessPresentation({
      role: 'realtime_conversation',
      providerId: 'example/provider',
      status: 'unavailable',
      code: 'server_feature_disabled',
      reasonKey: 'voice.readiness.server_feature_disabled',
      recoveryAction: 'switch_provider',
    }, translate)).toEqual({
      summary: 'voice.readiness.server_feature_disabled',
      reason: 'voice.readiness.server_feature_disabled',
      action: 'voice.readiness.actions.switch_provider',
      short: 'voice.readiness.short.offOnServer',
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
    }, translate)).toEqual({
      summary: 'voice.readiness.ready',
      reason: null,
      action: null,
      short: null,
    });
  });

  it.each([
    ['credential_missing', 'voice.readiness.short.needsKey'],
    ['credential_approval_required', 'voice.readiness.short.needsApproval'],
    ['settings_missing_required_setting', 'voice.readiness.short.needsSetup'],
    ['execution_machine_missing', 'voice.readiness.short.needsComputer'],
    ['daemon_unreachable', 'voice.readiness.short.needsComputer'],
    ['endpoint_missing', 'voice.readiness.short.needsAddress'],
    ['model_installing', 'voice.readiness.short.installing'],
    ['runtime_unknown', 'voice.readiness.short.cantCheck'],
  ])('gives a list one short status for %s', (code, short) => {
    expect(resolveVoiceProviderReadinessPresentation({
      role: 'realtime_conversation',
      providerId: 'example/provider',
      status: 'unavailable',
      code,
      reasonKey: `voice.readiness.${code}`,
      recoveryAction: 'none',
    }, translate).short).toBe(short);
  });
});
