import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from './types.js';
import type { AgentId } from './types.js';
import { AGENT_AUTH_PROBE_CONFIG, getAgentAuthProbeConfig } from './auth.js';
import { getProviderCliRuntimeSpec } from './providers/providerCliRuntime.js';

const cursorAgentId = 'cursor' as AgentId;

describe('AGENT_AUTH_PROBE_CONFIG', () => {
  it('covers every built-in agent', () => {
    expect(Object.keys(AGENT_AUTH_PROBE_CONFIG).sort()).toEqual([...AGENT_IDS].sort());
  });

  it('defines Kiro auth probing via whoami json', () => {
    expect(getAgentAuthProbeConfig('kiro')).toMatchObject({
      agentId: 'kiro',
      binaryNames: ['kiro-cli'],
      statusCommand: ['whoami', '--format', 'json'],
      parser: 'kiroWhoamiJson',
      backgroundChecks: 'manual_only',
    });
  });

  it('marks Custom ACP as non-probeable background auth state', () => {
    expect(getAgentAuthProbeConfig('customAcp')).toMatchObject({
      agentId: 'customAcp',
      statusCommand: null,
      parser: 'unknown',
      backgroundChecks: 'manual_only',
    });
  });

  it('keeps Codex auth probing metadata centralized', () => {
    expect(getAgentAuthProbeConfig('codex')).toMatchObject({
      statusCommand: ['login', 'status'],
      parser: 'codexLoginStatus',
      backgroundChecks: 'safe',
      envVars: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    });
  });

  it('defines Cursor auth probing from API key or safe JSON status commands', () => {
    expect(getAgentAuthProbeConfig(cursorAgentId)).toMatchObject({
      agentId: 'cursor',
      binaryNames: ['cursor-agent', 'agent'],
      statusCommand: ['about', '--format', 'json'],
      parser: 'cursorAboutJson',
      backgroundChecks: 'safe',
      envVars: ['CURSOR_API_KEY'],
    });
  });

  it('omits the generic Cursor agent fallback binary from auth probing when disabled by env', () => {
    expect(getAgentAuthProbeConfig(cursorAgentId, {
      HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED: '0',
    }).binaryNames).toEqual(['cursor-agent']);
  });

  it('supports both current and legacy Claude credential file layouts', () => {
    expect(getAgentAuthProbeConfig('claude').credentialPaths).toEqual([
      '~/.claude/.credentials.json',
      '~/.claude/.claude.json',
    ]);
  });

  it('probes grok auth via XAI_API_KEY only (the CLI does not read GROK_API_KEY)', () => {
    expect(getAgentAuthProbeConfig('grok')).toMatchObject({
      agentId: 'grok',
      statusCommand: null,
      parser: 'unknown',
      backgroundChecks: 'safe',
      envVars: ['XAI_API_KEY'],
    });
  });

  it('derives auth probe binary names from the provider runtime catalog', () => {
    for (const agentId of AGENT_IDS) {
      const runtimeSpec = getProviderCliRuntimeSpec(agentId);
      const expected = agentId === 'cursor'
        ? [runtimeSpec.binaryName, ...(runtimeSpec.alternativeBinaryNames ?? [])]
        : [runtimeSpec.binaryName];
      expect(getAgentAuthProbeConfig(agentId).binaryNames).toEqual(expected);
    }
  });
});
