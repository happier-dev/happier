import { describe, expect, it } from 'vitest';

import * as manifestModule from './manifest.js';
import { AGENT_PROVIDER_IDS } from './types.js';
import { LEGACY_CONFIGURED_BACKEND_SENTINEL_ID } from './compat/legacyConfiguredBackend.js';
import { AGENTS_CORE, CANONICAL_AGENTS_CORE, getAgentCore, getAgentResumeConfig, getProviderConnectedServicesAdapter } from './manifest.js';
import { legacyCustomAcpCompat } from './index.js';

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

  it('exposes token-only Claude subscription compatibility for OpenCode', () => {
    expect(AGENTS_CORE.opencode.connectedServices?.supportedServiceIds).toContain('claude-subscription');
    expect(AGENTS_CORE.opencode.connectedServices?.supportedKindsByServiceId?.['claude-subscription']).toEqual(['token']);
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

  it('advertises Claude existing-session connected-service auth switching continuity', () => {
    expect(AGENTS_CORE.claude.connectedServices?.sessionAuthSwitch).toEqual({
      continuityMode: 'restart_same_home',
      supportedTransitions: ['same_connected_group'],
      providerStateSharingRequired: {
        serviceIds: ['claude-subscription', 'anthropic'],
        supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
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

  it('advertises existing-session connected-service auth switching for supported providers', () => {
    expect(AGENTS_CORE.codex.connectedServices?.sessionAuthSwitch).toEqual({
      continuityMode: 'restart_shared_state_required',
      supportedTransitions: ['same_connected_group'],
      providerStateSharingRequired: {
        serviceIds: ['openai-codex'],
        supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
      },
    });
    expect(AGENTS_CORE.gemini.connectedServices?.sessionAuthSwitch).toEqual({
      continuityMode: 'restart_same_home',
      supportedTransitions: ['native_to_connected', 'connected_to_connected'],
    });
    expect(AGENTS_CORE.opencode.connectedServices?.sessionAuthSwitch).toEqual({
      continuityMode: 'restart_same_home',
      supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
    });
    expect(AGENTS_CORE.pi.connectedServices?.sessionAuthSwitch).toEqual({
      continuityMode: 'restart_same_home',
      supportedTransitions: ['connected_to_connected'],
      providerStateSharingRequired: {
        supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
      },
    });
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

  it('does not claim shared provider state support for providers without an implemented materializer', () => {
    expect(AGENTS_CORE.gemini.connectedServices?.providerStateSharing?.state.supported).not.toBe(true);
    expect(AGENTS_CORE.opencode.connectedServices?.providerStateSharing?.state.supported).not.toBe(true);
  });

  it('derives the canonical provider connected-services adapter from manifest metadata', () => {
    expect(getProviderConnectedServicesAdapter('codex')).toEqual({
      cloudConnect: AGENTS_CORE.codex.cloudConnect,
      connectedServices: AGENTS_CORE.codex.connectedServices,
    });
    expect(getProviderConnectedServicesAdapter('auggie')).toBeNull();
  });

  it('returns the canonical provider resume config from manifest metadata', () => {
    expect(getAgentResumeConfig('claude')).toEqual(AGENTS_CORE.claude.resume);
  });

  it('keeps customAcp out of the shared provider manifest artifacts while preserving explicit compat lookup', () => {
    expect(Object.keys(AGENTS_CORE).sort()).toEqual([...AGENT_PROVIDER_IDS].sort());
    expect(AGENTS_CORE).not.toHaveProperty(LEGACY_CONFIGURED_BACKEND_SENTINEL_ID);
    expect(CANONICAL_AGENTS_CORE).not.toHaveProperty(LEGACY_CONFIGURED_BACKEND_SENTINEL_ID);
    expect('LEGACY_CUSTOM_ACP_AGENT_CORE' in manifestModule).toBe(false);
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentCore()).toMatchObject({ id: LEGACY_CONFIGURED_BACKEND_SENTINEL_ID });
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentCore().resume).toEqual({
      vendorResume: 'unsupported',
    });
  });
});
