import { describe, expect, it } from 'vitest';

import * as manifestModule from './manifest.js';
import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from './generated/bundledAgentDefinitions.js';
import { AGENT_IDS } from './types.js';
import { LEGACY_CONFIGURED_BACKEND_SENTINEL_ID } from './compat/legacyConfiguredBackend.js';
import { AGENTS_CORE, CANONICAL_AGENTS_CORE, getAgentCore, getAgentResumeConfig, getProviderConnectedServicesAdapter } from './manifest.js';
import * as legacyCustomAcpCompat from './compat/customAcp.js';

describe('AGENTS_CORE cloudConnect status', () => {
  it('marks codex and claude connect targets as wired', () => {
    expect(AGENTS_CORE.codex.cloudConnect?.status).toBe('wired');
    expect(AGENTS_CORE.claude.cloudConnect?.status).toBe('wired');
  });

  it('sources Codex shared core facts from the bundled plugin definition', () => {
    expect(CANONICAL_AGENTS_CORE.codex).toBe(BUNDLED_AGENT_DEFINITIONS_BY_ID.codex.core);
    expect(AGENTS_CORE.codex).toBe(BUNDLED_AGENT_DEFINITIONS_BY_ID.codex.core);
  });

  it('sources canonical provider core facts from bundled provider definitions', () => {
    for (const providerId of AGENT_IDS) {
      expect(CANONICAL_AGENTS_CORE[providerId]).toBe(
        BUNDLED_AGENT_DEFINITIONS_BY_ID[providerId].core,
      );
    }
  });

  it('exposes OpenAI API key connected service compatibility for codex/opencode/pi', () => {
    expect(AGENTS_CORE.codex.connectedServices?.supportedServiceIds).toContain('openai');
    expect(AGENTS_CORE.opencode.connectedServices?.supportedServiceIds).toContain('openai');
    expect(AGENTS_CORE.pi.connectedServices?.supportedServiceIds).toContain('openai');
  });

  it('exposes Claude subscription connected-account compatibility for OpenCode', () => {
    expect(AGENTS_CORE.opencode.connectedServices?.supportedServiceIds).toContain('claude-subscription');
    expect(AGENTS_CORE.opencode.connectedServices?.supportedServiceIds).toContain('anthropic');
  });

  it('exposes Claude subscription connected-account compatibility for Pi', () => {
    expect(AGENTS_CORE.pi.connectedServices?.supportedServiceIds).toContain('claude-subscription');
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

  it('keeps existing-session switch continuity out of the private AgentCore catalog', () => {
    for (const agentId of ['claude', 'codex', 'gemini', 'opencode', 'pi'] as const) {
      expect(AGENTS_CORE[agentId].connectedServices).not.toHaveProperty('sessionAuthSwitch');
    }
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
    expect(Object.keys(AGENTS_CORE).sort()).toEqual([...AGENT_IDS].sort());
    expect(AGENTS_CORE).not.toHaveProperty(LEGACY_CONFIGURED_BACKEND_SENTINEL_ID);
    expect(CANONICAL_AGENTS_CORE).not.toHaveProperty(LEGACY_CONFIGURED_BACKEND_SENTINEL_ID);
    expect('LEGACY_CUSTOM_ACP_AGENT_CORE' in manifestModule).toBe(false);
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentCore()).toMatchObject({ id: LEGACY_CONFIGURED_BACKEND_SENTINEL_ID });
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentCore().resume).toEqual({
      vendorResume: 'unsupported',
    });
  });
});
