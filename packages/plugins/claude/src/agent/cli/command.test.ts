import { describe, expect, it } from 'vitest';

import {
  claudeCliSessionCommandConfig,
  resolveClaudeCliSessionOptions,
} from './command.js';

describe('Claude CLI session command', () => {
  it('declares Claude-owned session command parsing options', () => {
    expect(claudeCliSessionCommandConfig).toEqual({
      sessionRuntimeId: 'claude',
      accountSettingsAgentId: 'claude',
      implicitResumeDelegation: {
        resumeFlags: ['--resume', '-r'],
      },
      directoryFlags: ['-C', '--cd'],
      forwardModelFlag: true,
      yoloAgentArgs: ['--dangerously-skip-permissions'],
      versionFlags: ['-v', '--version'],
    });
  });

  it('maps explicit Claude subcommand agent args into session runtime options', () => {
    expect(resolveClaudeCliSessionOptions({
      isExplicitCliSubcommand: true,
      parsed: {
        startingMode: 'terminal',
        directory: '/workspace',
        resume: 'vendor-session-1',
        agentArgs: ['--model', 'claude-opus-4-6', '--js-runtime', 'bun'],
      },
    })).toEqual({
      ok: true,
      options: {
        startingMode: 'terminal',
        directory: '/workspace',
        jsRuntime: 'bun',
        resume: undefined,
        claudeArgs: ['--model', 'claude-opus-4-6', '--resume', 'vendor-session-1'],
      },
    });
  });

  it('canonicalizes native Claude permission agent args before deferred attach eligibility is decided', () => {
    expect(resolveClaudeCliSessionOptions({
      isExplicitCliSubcommand: true,
      parsed: {
        agentArgs: ['--permission-mode', 'acceptEdits'],
      },
    })).toEqual({
      ok: true,
      options: {
        permissionMode: 'safe-yolo',
        claudeArgs: ['--permission-mode', 'acceptEdits'],
      },
    });
  });

  it('keeps implicit default resume as a Happier session id instead of forwarding it to Claude', () => {
    expect(resolveClaudeCliSessionOptions({
      isExplicitCliSubcommand: false,
      parsed: {
        resume: 'session_happy_123',
        agentArgs: ['--model', 'claude-opus-4-6'],
      },
    })).toEqual({
      ok: true,
      options: {
        claudeArgs: ['--model', 'claude-opus-4-6'],
      },
    });
  });
});
