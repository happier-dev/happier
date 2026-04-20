import { describe, expect, it } from 'vitest';

import * as manifestModule from './manifest.js';
import { CANONICAL_AGENT_IDS } from './types.js';
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
    expect(Object.keys(AGENTS_CORE).sort()).toEqual([...CANONICAL_AGENT_IDS].sort());
    expect(AGENTS_CORE).not.toHaveProperty(LEGACY_CONFIGURED_BACKEND_SENTINEL_ID);
    expect(CANONICAL_AGENTS_CORE).not.toHaveProperty(LEGACY_CONFIGURED_BACKEND_SENTINEL_ID);
    expect('LEGACY_CUSTOM_ACP_AGENT_CORE' in manifestModule).toBe(false);
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentCore()).toMatchObject({ id: LEGACY_CONFIGURED_BACKEND_SENTINEL_ID });
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentCore().resume).toEqual({
      vendorResume: 'unsupported',
    });
  });
});
