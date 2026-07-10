import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from './types.js';
import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from './generated/bundledAgentDefinitions.js';
import * as legacyCustomAcpCompat from './compat/customAcp.js';
import {
  type AgentLocalCliConfig,
  CANONICAL_AGENT_LOCAL_CLI_CONFIG,
  getAgentLocalCliConfig,
  AGENT_LOCAL_CLI_CONFIG,
} from './localCli.js';

describe('AGENT_LOCAL_CLI_CONFIG', () => {
  it('keeps the shared local CLI artifact map canonical-only', () => {
    expect(Object.keys(AGENT_LOCAL_CLI_CONFIG).sort()).toEqual([...AGENT_IDS].sort());
  });

  it('sources canonical provider local CLI facts from bundled provider definitions', () => {
    for (const providerId of AGENT_IDS) {
      expect(CANONICAL_AGENT_LOCAL_CLI_CONFIG[providerId]).toBe(
        BUNDLED_AGENT_DEFINITIONS_BY_ID[providerId].localCli,
      );
    }
  });

  it('keeps legacy customAcp out of the canonical local CLI artifacts', () => {
    expect(Object.keys(CANONICAL_AGENT_LOCAL_CLI_CONFIG).sort()).toEqual([...AGENT_IDS].sort());
    expect(CANONICAL_AGENT_LOCAL_CLI_CONFIG).not.toHaveProperty('customAcp');
  });

  it('keeps binary, detect, and machine login metadata for Kiro centralized', () => {
    const config = getAgentLocalCliConfig('kiro');

    expect(config).toMatchObject({
      agentId: 'kiro',
      detectKey: 'kiro-cli',
      machineLoginKey: 'kiro-cli',
      supportKind: 'login_terminal',
      loginLaunch: {
        command: 'kiro-cli',
        args: ['login'],
      },
    });
    expect(config).not.toHaveProperty('binaryNames');
  });

  it('marks Custom ACP as a catalog-management backend without local CLI login', () => {
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentLocalCliConfig()).toMatchObject({
      agentId: 'customAcp',
      detectKey: 'custom-acp',
      machineLoginKey: 'custom-acp',
      supportKind: 'unsupported',
      loginLaunch: null,
    });
  });

  it('keeps Claude login launch metadata centralized', () => {
    expect(getAgentLocalCliConfig('claude')).toMatchObject({
      detectKey: 'claude',
      machineLoginKey: 'claude-code',
      supportKind: 'login_terminal',
    });
  });

  it('keeps Gemini local CLI OAuth login deferred for API-key and Vertex closure', () => {
    const config = getAgentLocalCliConfig('gemini');

    expect(config).toMatchObject({
      agentId: 'gemini',
      detectKey: 'gemini',
      supportKind: 'unsupported',
      loginLaunch: null,
    });
    expect(config.machineLoginKey).not.toBe('gemini-cli');
    expect(JSON.stringify(config)).not.toContain('gemini auth');
  });

  it('declares Cursor as status-only local CLI auth until terminal login behavior is source-real', () => {
    const cursor = (AGENT_LOCAL_CLI_CONFIG as Readonly<Record<string, AgentLocalCliConfig>>).cursor;

    expect(cursor).toEqual(expect.objectContaining({
      agentId: 'cursor',
      detectKey: 'cursor-agent',
      machineLoginKey: 'cursor-agent',
      supportKind: 'status_only',
      loginLaunch: null,
    }));
  });

  it('still serves legacy customAcp through explicit compat lookup only', () => {
    expect(AGENT_LOCAL_CLI_CONFIG).not.toHaveProperty('customAcp');
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentLocalCliConfig()).toMatchObject({
      agentId: 'customAcp',
      detectKey: 'custom-acp',
    });
  });
});
