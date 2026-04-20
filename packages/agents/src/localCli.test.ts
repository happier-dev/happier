import { describe, expect, it } from 'vitest';

import { AGENT_IDS, CANONICAL_AGENT_IDS } from './types.js';
import { legacyCustomAcpCompat } from './index.js';
import { CANONICAL_AGENT_LOCAL_CLI_CONFIG, getAgentLocalCliConfig, AGENT_LOCAL_CLI_CONFIG } from './localCli.js';

describe('AGENT_LOCAL_CLI_CONFIG', () => {
  it('keeps the shared local CLI artifact map canonical-only', () => {
    expect(Object.keys(AGENT_LOCAL_CLI_CONFIG).sort()).toEqual([...CANONICAL_AGENT_IDS].sort());
  });

  it('keeps legacy customAcp out of the canonical local CLI artifacts', () => {
    expect(Object.keys(CANONICAL_AGENT_LOCAL_CLI_CONFIG).sort()).toEqual([...CANONICAL_AGENT_IDS].sort());
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

  it('still serves legacy customAcp through explicit compat lookup only', () => {
    expect(AGENT_LOCAL_CLI_CONFIG).not.toHaveProperty('customAcp');
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentLocalCliConfig()).toMatchObject({
      agentId: 'customAcp',
      detectKey: 'custom-acp',
    });
  });
});
