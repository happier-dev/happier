import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from './types.js';
import type { AgentId } from './types.js';
import { getAgentLocalCliConfig, AGENT_LOCAL_CLI_CONFIG } from './localCli.js';

const cursorAgentId = 'cursor' as AgentId;

describe('AGENT_LOCAL_CLI_CONFIG', () => {
  it('covers every built-in agent', () => {
    expect(Object.keys(AGENT_LOCAL_CLI_CONFIG).sort()).toEqual([...AGENT_IDS].sort());
  });

  it('keeps binary, detect, and machine login metadata for Kiro centralized', () => {
    const config = getAgentLocalCliConfig('kiro');

    expect(config).toMatchObject({
      agentId: 'kiro',
      detectKey: 'kiro-cli',
      machineLoginKey: 'kiro-cli',
      authSupport: 'login_terminal',
      loginLaunch: {
        command: 'kiro-cli',
        args: ['login'],
      },
    });
    expect(config).not.toHaveProperty('binaryNames');
  });

  it('marks Custom ACP as a catalog-management backend without local CLI login', () => {
    expect(getAgentLocalCliConfig('customAcp')).toMatchObject({
      agentId: 'customAcp',
      detectKey: 'custom-acp',
      machineLoginKey: 'custom-acp',
      authSupport: 'unsupported',
      loginLaunch: null,
    });
  });

  it('keeps Claude login launch metadata centralized', () => {
    expect(getAgentLocalCliConfig('claude')).toMatchObject({
      detectKey: 'claude',
      machineLoginKey: 'claude-code',
      authSupport: 'login_terminal',
    });
  });

  it('logs in grok via the `grok login` subcommand rather than an interactive /login slash', () => {
    const config = getAgentLocalCliConfig('grok');
    expect(config).toMatchObject({
      agentId: 'grok',
      authSupport: 'login_terminal',
      loginLaunch: {
        command: 'grok',
        args: ['login'],
      },
    });
    expect(config.loginLaunch).not.toHaveProperty('initialInput');
  });

  it('uses Cursor CLI login as a terminal-auth flow while keeping cursor-agent as the launch command', () => {
    expect(getAgentLocalCliConfig(cursorAgentId)).toMatchObject({
      agentId: 'cursor',
      detectKey: 'cursor-agent',
      machineLoginKey: 'cursor-agent',
      authSupport: 'login_terminal',
      loginLaunch: {
        command: 'cursor-agent',
        args: ['login'],
      },
    });
  });
});
