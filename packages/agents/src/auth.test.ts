import { describe, expect, it } from 'vitest';

import { AGENT_IDS, CANONICAL_AGENT_IDS } from './types.js';
import {
  AGENT_AUTH_PROBE_CONFIG,
  CANONICAL_AGENT_AUTH_PROBE_CONFIG,
  getAgentAuthProbeConfig,
} from './auth.js';
import { CANONICAL_AGENT_LOCAL_CLI_CONFIG } from './localCli.js';
import {
  legacyCustomAcpCompat,
} from './index.js';

describe('AGENT_AUTH_PROBE_CONFIG', () => {
  it('keeps the shared auth probe artifact map canonical-only', () => {
    expect(Object.keys(AGENT_AUTH_PROBE_CONFIG).sort()).toEqual([...CANONICAL_AGENT_IDS].sort());
  });

  it('keeps legacy customAcp out of the canonical auth probe artifacts', () => {
    expect(Object.keys(CANONICAL_AGENT_AUTH_PROBE_CONFIG).sort()).toEqual([...CANONICAL_AGENT_IDS].sort());
    expect(CANONICAL_AGENT_AUTH_PROBE_CONFIG).not.toHaveProperty('customAcp');
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
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentAuthProbeConfig()).toMatchObject({
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

  it('supports both current and legacy Claude credential file layouts', () => {
    expect(getAgentAuthProbeConfig('claude').credentialPaths).toEqual([
      '~/.claude/.credentials.json',
      '~/.claude/.claude.json',
    ]);
  });

  it('probes ohMyPi auth via environment-only checks for its supported vendors', () => {
    expect(getAgentAuthProbeConfig('ohMyPi')).toMatchObject({
      agentId: 'ohMyPi',
      binaryNames: ['omp'],
      statusCommand: null,
      parser: 'piEnvOnly',
      backgroundChecks: 'safe',
      envVars: [
        'OPENAI_CODEX_OAUTH_TOKEN',
        'OPENAI_API_KEY',
        'ANTHROPIC_OAUTH_TOKEN',
        'ANTHROPIC_API_KEY',
        'GEMINI_API_KEY',
      ],
    });
  });

  it('keeps explicit compat auth metadata aligned with the explicit compat local CLI metadata', () => {
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentAuthProbeConfig()).toEqual({
      agentId: 'customAcp',
      binaryNames: [legacyCustomAcpCompat.getLegacyCustomAcpProviderCliRuntimeSpec().binaryName],
      statusCommand: null,
      parser: 'unknown',
      backgroundChecks: 'manual_only',
    });
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentLocalCliConfig()).toMatchObject({
      agentId: 'customAcp',
      supportKind: 'unsupported',
      detectKey: 'custom-acp',
    });
  });

  it('derives auth probe binary names from the provider runtime catalog', () => {
    for (const agentId of AGENT_IDS) {
      expect(getAgentAuthProbeConfig(agentId).binaryNames).toEqual(CANONICAL_AGENT_AUTH_PROBE_CONFIG[agentId].binaryNames);
    }
  });
});
