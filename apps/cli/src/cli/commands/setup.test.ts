import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

import { handleSetupCommand } from './setup';

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
