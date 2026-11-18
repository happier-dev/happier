import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from './manifest';

describe('AGENTS_CORE cloudConnect status', () => {
  it('marks codex and claude connect targets as wired', () => {
    expect(AGENTS_CORE.codex.cloudConnect?.status).toBe('wired');
    expect(AGENTS_CORE.claude.cloudConnect?.status).toBe('wired');
  });

  it('exposes OpenAI API key connected service compatibility for codex/opencode/pi', () => {
    expect(AGENTS_CORE.codex.connectedServices?.supportedServiceIds).toContain('openai');
    expect(AGENTS_CORE.opencode.connectedServices?.supportedServiceIds).toContain('openai');
    expect(AGENTS_CORE.pi.connectedServices?.supportedServiceIds).toContain('openai');
  });

  it('exposes Claude subscription OAuth + setup-token compatibility for opencode and pi while keeping Anthropic API-key token-only', () => {
    expect(AGENTS_CORE.opencode.connectedServices?.supportedServiceIds).toContain('claude-subscription');
    expect(AGENTS_CORE.opencode.connectedServices?.supportedKindsByServiceId?.['claude-subscription']).toEqual(['oauth', 'token']);
    expect(AGENTS_CORE.opencode.connectedServices?.supportedKindsByServiceId?.anthropic).toEqual(['token']);
    expect(AGENTS_CORE.pi.connectedServices?.supportedServiceIds).toContain('claude-subscription');
    expect(AGENTS_CORE.pi.connectedServices?.supportedKindsByServiceId?.['claude-subscription']).toEqual(['oauth', 'token']);
  });

  it('advertises session auth switching for providers with implemented switch continuity', () => {
    expect(AGENTS_CORE.claude.connectedServices?.sessionAuthSwitch).toEqual({
      continuityMode: 'restart_same_home',
      supportedTransitions: ['same_connected_group'],
      providerStateSharingRequired: {
        serviceIds: ['claude-subscription', 'anthropic'],
        supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
      },
    });
    expect(AGENTS_CORE.codex.connectedServices?.sessionAuthSwitch).toEqual({
      continuityMode: 'restart_shared_state_required',
      supportedTransitions: ['same_connected_group'],
      providerStateSharingRequired: {
        serviceIds: ['openai-codex'],
        supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
      },
    });
    expect(AGENTS_CORE.opencode.connectedServices?.sessionAuthSwitch).toEqual({
      continuityMode: 'restart_same_home',
      supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
    });
    expect(AGENTS_CORE.gemini.connectedServices?.sessionAuthSwitch).toEqual({
      continuityMode: 'restart_same_home',
      supportedTransitions: ['native_to_connected', 'connected_to_connected', 'same_connected_group'],
    });
    expect(AGENTS_CORE.pi.connectedServices?.sessionAuthSwitch).toEqual({
      continuityMode: 'restart_same_home',
      supportedTransitions: ['connected_to_connected'],
      providerStateSharingRequired: {
        supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
      },
    });
    expect(AGENTS_CORE.agy.connectedServices?.sessionAuthSwitch).toEqual({
      continuityMode: 'restart_shared_state_required',
      supportedTransitions: ['same_connected_group'],
      providerStateSharingRequired: {
        supportedTransitions: ['connected_to_connected'],
      },
    });
  });

  it('advertises Codex provider state sharing capabilities from the shared catalog', () => {
    expect(AGENTS_CORE.codex.connectedServices?.providerStateSharing).toEqual({
      config: {
        supported: true,
        modes: ['linked', 'copied', 'isolated'],
      },
      state: {
        supported: true,
        modes: ['isolated', 'shared'],
        sharedStatePrivacyRiskAcknowledgementRequired: true,
      },
    });
  });

  it('advertises Claude provider state sharing capabilities from the shared catalog', () => {
    expect(AGENTS_CORE.claude.connectedServices?.providerStateSharing).toEqual({
      config: {
        supported: true,
        modes: ['linked', 'copied', 'isolated'],
      },
      state: {
        supported: true,
        modes: ['isolated', 'shared'],
        sharedStatePrivacyRiskAcknowledgementRequired: true,
      },
    });
  });

  it('does not claim shared provider state support for providers without an implemented materializer', () => {
    expect(AGENTS_CORE.gemini.connectedServices?.providerStateSharing?.state.supported).not.toBe(true);
    expect(AGENTS_CORE.opencode.connectedServices?.providerStateSharing?.state.supported).not.toBe(true);
  });

  it('advertises Pi shared session state only through its implemented session directory materializer', () => {
    expect(AGENTS_CORE.pi.connectedServices?.providerStateSharing).toEqual({
      config: {
        supported: false,
        modes: ['isolated'],
        unavailableReason: 'not_implemented',
      },
      state: {
        supported: true,
        modes: ['isolated', 'shared'],
        sharedStatePrivacyRiskAcknowledgementRequired: true,
      },
    });
  });
});
