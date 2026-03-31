import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

import { handleSetupCommand } from './setup';

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '');
}

describe('happier setup', () => {
  let output = captureConsoleLogAndMuteStdout();

  beforeEach(() => {
    output.restore();
    output = captureConsoleLogAndMuteStdout();
  });

  afterEach(() => {
    output.restore();
  });

  it('prints a setup_plan JSON envelope', async () => {
    await handleSetupCommand(['plan', '--relay-url', 'https://relay.example.test', '--json']);
    const parsed = JSON.parse(output.logs.join('\n').trim());
    expect(parsed.v).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe('setup_plan');
    expect(parsed.data?.relayUrl).toBe('https://relay.example.test');
    expect(Array.isArray(parsed.data?.steps)).toBe(true);
    expect(parsed.data.steps.length).toBeGreaterThan(0);
  });

  it('renders --help output as a structured help page', async () => {
    await handleSetupCommand(['--help']);
    const text = stripAnsi(output.logs.join('\n'));
    expect(text).toContain('setup');
    expect(text).toContain('Guided setup');
    expect(text).toContain('Usage:');
    expect(text).toContain('happier setup plan');
    expect(text).toContain('Examples:');
    expect(text).toContain('Notes:');
    expect(text).not.toContain('Description:');
  });

  it('prints a numbered setup plan in non-JSON plan mode', async () => {
    await handleSetupCommand(['plan', '--relay-url', 'https://relay.example.test']);
    const text = stripAnsi(output.logs.join('\n'));
    expect(output.logs[0]?.startsWith('\n')).toBe(false);
    expect(text).toContain('Setup plan');
    expect(text).toContain('Relay:');
    expect(text).toContain('https://relay.example.test');
    expect(text).toContain('1. happier auth login');
  });

  it('executes the setup steps (server selection → auth → daemon → providers) in non-interactive mode when --yes is provided', async () => {
    const calls: string[][] = [];
    const applyServerSelectionFromArgs = async (args: string[]) => {
      expect(args).toEqual([
        '--server-url',
        'https://relay.example.test',
        '--persist',
        '--yes',
      ]);
      return ['--yes'];
    };

    await handleSetupCommand(
      ['--relay-url', 'https://relay.example.test', '--yes'],
      {
        applyServerSelectionFromArgs,
        readCredentialsFn: async () => null,
        isInteractiveTerminalFn: () => false,
        promptInputFn: async () => {
          throw new Error('prompt should not be used');
        },
        runHappyCliStepFn: async (argv) => {
          calls.push([...argv]);
          return 0;
        },
      },
    );

    expect(calls).toEqual([
      ['auth', 'login'],
      ['daemon', 'install'],
      ['providers', 'setup', '--yes'],
    ]);
  });

  it('skips auth when credentials already exist', async () => {
    const calls: string[][] = [];
    await handleSetupCommand(
      ['--relay-url', 'https://relay.example.test', '--yes', '--skip-daemon'],
      {
        applyServerSelectionFromArgs: async (args) => args,
        readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
        isInteractiveTerminalFn: () => false,
        promptInputFn: async () => {
          throw new Error('prompt should not be used');
        },
        runHappyCliStepFn: async (argv) => {
          calls.push([...argv]);
          return 0;
        },
      },
    );

    expect(calls).toEqual([
      ['providers', 'setup', '--yes'],
    ]);
  });
});
