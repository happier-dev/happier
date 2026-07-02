import { describe, expect, it } from 'vitest';

import { CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION } from './runtime.js';

type CliSessionCommandContribution = Readonly<{
  backendIdForSessionRuntime: string;
  agentIdForAccountSettings?: string;
  implicitResumeDelegation?: Readonly<{
    resumeFlags: readonly string[];
  }>;
  directoryFlags?: readonly string[];
  forwardModelFlag?: boolean;
  yoloProviderArgs?: readonly string[];
  versionFlags?: readonly string[];
  buildSessionOptions?: (input: Readonly<{
    args: readonly string[];
    parsed: Readonly<{
      startingMode?: string;
      directory?: string;
      resume?: string;
      providerArgs: readonly string[];
    }>;
  }>) => unknown;
}>;

function readCliSessionCommand(): CliSessionCommandContribution {
  const command = (CLAUDE_PROVIDER_RUNTIME_CONTRIBUTION as Readonly<{
    cliSessionCommand?: CliSessionCommandContribution;
  }>).cliSessionCommand;
  if (!command) {
    throw new Error('Expected Claude to contribute CLI session command options');
  }
  return command;
}

describe('Claude runtime contribution CLI command options', () => {
  it('declares provider-owned session command parsing through the runtime contribution', () => {
    const command = readCliSessionCommand();

    expect(command).toMatchObject({
      backendIdForSessionRuntime: 'claude',
      agentIdForAccountSettings: 'claude',
      implicitResumeDelegation: {
        resumeFlags: ['--resume', '-r'],
      },
      directoryFlags: ['-C', '--cd'],
      forwardModelFlag: true,
      yoloProviderArgs: ['--dangerously-skip-permissions'],
      versionFlags: ['-v', '--version'],
    });
    expect(command.buildSessionOptions).toBeTypeOf('function');
  });

  it('maps Claude CLI-only args into session runtime options without host command code', () => {
    const command = readCliSessionCommand();

    expect(command.buildSessionOptions?.({
      args: ['claude', '--js-runtime', 'bun', '--resume', 'vendor-session-1'],
      parsed: {
        startingMode: 'terminal',
        directory: '/workspace',
        resume: 'vendor-session-1',
        providerArgs: ['--model', 'claude-opus-4-6', '--js-runtime', 'bun'],
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

  it('keeps implicit default resume as a Happier session id instead of forwarding it to Claude', () => {
    const command = readCliSessionCommand();

    expect(command.buildSessionOptions?.({
      args: ['--resume', 'session_happy_123'],
      parsed: {
        resume: 'session_happy_123',
        providerArgs: ['--model', 'claude-opus-4-6'],
      },
    })).toEqual({
      ok: true,
      options: {
        claudeArgs: ['--model', 'claude-opus-4-6'],
      },
    });
  });
});
