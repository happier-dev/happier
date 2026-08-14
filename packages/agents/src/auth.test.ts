import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from './types.js';
import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from './generated/bundledAgentDefinitions.js';
import {
  AGENT_AUTH_PROBE_CONFIG,
  type AgentAuthProbeConfig,
  CANONICAL_AGENT_AUTH_PROBE_CONFIG,
  getAgentAuthProbeConfig,
} from './auth.js';
import { CANONICAL_AGENT_LOCAL_CLI_CONFIG } from './localCli.js';
import * as legacyCustomAcpCompat from './compat/customAcp.js';

describe('AGENT_AUTH_PROBE_CONFIG', () => {
  it('keeps the shared auth probe artifact map canonical-only', () => {
    expect(Object.keys(AGENT_AUTH_PROBE_CONFIG).sort()).toEqual([...AGENT_IDS].sort());
  });

  it('projects canonical auth probe facts from strict bundled CLI metadata', () => {
    for (const agentId of AGENT_IDS) {
      const definition = BUNDLED_AGENT_DEFINITIONS_BY_ID[agentId];
      const probe = definition.cli.auth.probe;

      expect(CANONICAL_AGENT_AUTH_PROBE_CONFIG[agentId]).toEqual({
        agentId,
        binaryNames: [
          definition.cli.executable.binaryName,
          ...(definition.cli.executable.alternativeBinaryNames ?? []),
        ],
        statusCommand: probe.statusArgs ?? null,
        parser: probe.parser,
        backgroundChecks: probe.backgroundChecks,
        ...(probe.envVars ? { envVars: probe.envVars } : {}),
        ...(probe.credentialPaths ? { credentialPaths: probe.credentialPaths } : {}),
      });
    }
  });

  it('keeps legacy customAcp out of the canonical auth probe artifacts', () => {
    expect(Object.keys(CANONICAL_AGENT_AUTH_PROBE_CONFIG).sort()).toEqual([...AGENT_IDS].sort());
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

  it('keeps Gemini auth probing scoped to API-key and Vertex environment facts', () => {
    const config = getAgentAuthProbeConfig('gemini');
    const serializedConfig = JSON.stringify(config);

    expect(config).toMatchObject({
      statusCommand: null,
      parser: 'envOnly',
      backgroundChecks: 'safe',
      envVars: [
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'GOOGLE_GENAI_USE_VERTEXAI',
        'GOOGLE_CLOUD_PROJECT',
        'GOOGLE_CLOUD_LOCATION',
      ],
    });
    expect(config).not.toHaveProperty('credentialPaths');
    for (const forbiddenFact of [
      'oauth_creds.json',
      'auth.json',
      'application_default_credentials.json',
      'gcloud ADC',
    ]) {
      expect(serializedConfig).not.toContain(forbiddenFact);
    }
  });

  it('declares Cursor auth probing via about json with API-key fallback', () => {
    const cursor = (AGENT_AUTH_PROBE_CONFIG as Readonly<Record<string, AgentAuthProbeConfig>>).cursor;

    expect(cursor).toEqual(expect.objectContaining({
      agentId: 'cursor',
      binaryNames: ['cursor-agent', 'agent'],
      statusCommand: ['about', '--format', 'json'],
      parser: 'cursorAboutJson',
      backgroundChecks: 'safe',
      envVars: ['CURSOR_API_KEY'],
    }));
  });

  it('drops the legacy Cursor fallback binary when the env disables it', () => {
    expect(getAgentAuthProbeConfig('cursor', {
      HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED: '0',
    }).binaryNames).toEqual(['cursor-agent']);
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
      binaryNames: [legacyCustomAcpCompat.getLegacyCustomAcpAgentCliRuntimeSpec().binaryName],
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
