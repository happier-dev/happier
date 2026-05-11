import { describe, expect, it, vi } from 'vitest';

import { partitionProviderSessionArgs } from './providerSessionArgPartition';

describe('partitionProviderSessionArgs', () => {
  it('strips Happier-owned session flags while preserving provider-native arguments', () => {
    expect(partitionProviderSessionArgs({
      args: [
        'codex',
        'exec',
        '--profile',
        'work',
        '--permission-mode',
        'plan',
        '--permission-mode-updated-at',
        '123',
        '--agent-mode',
        'ask',
        '--agent-mode-updated-at',
        '456',
        '--model',
        'gpt-5.1-codex-max',
        '--model-updated-at',
        '789',
        '--existing-session',
        'session-1',
        '--resume',
        'vendor-1',
        '--happy-starting-mode',
        'remote',
        '-C',
        '/repo',
        '--sandbox',
        'workspace-write',
        '--config',
        'model_reasoning_effort=high',
      ],
      providerSubcommand: 'codex',
      directoryFlags: ['-C', '--cd'],
      forwardModelFlag: true,
    })).toMatchObject({
      profileQuery: 'work',
      permissionMode: 'plan',
      permissionModeUpdatedAt: 123,
      sessionModeId: 'ask',
      sessionModeUpdatedAt: 456,
      modelId: 'gpt-5.1-codex-max',
      modelUpdatedAt: 789,
      existingSessionId: 'session-1',
      resume: 'vendor-1',
      startingMode: 'remote',
      directory: '/repo',
      providerArgs: [
        'exec',
        '--model',
        'gpt-5.1-codex-max',
        '--sandbox',
        'workspace-write',
        '--config',
        'model_reasoning_effort=high',
      ],
    });
  });

  it('preserves provider help subcommand context and detects provider-specific version flags', () => {
    const help = partitionProviderSessionArgs({
      args: ['codex', 'exec', '--help'],
      providerSubcommand: 'codex',
      versionFlags: ['-v', '-V', '--version'],
    });
    expect(help.helpRequested).toBe(true);
    expect(help.providerArgs).toEqual(['exec', '--help']);

    const codexVersion = partitionProviderSessionArgs({
      args: ['codex', '-V'],
      providerSubcommand: 'codex',
      versionFlags: ['-v', '-V', '--version'],
    });
    expect(codexVersion.versionRequested).toBe(true);
    expect(codexVersion.versionFlag).toBe('-V');

    const genericVersion = partitionProviderSessionArgs({
      args: ['claude', '-V'],
      providerSubcommand: 'claude',
      versionFlags: ['-v', '--version'],
    });
    expect(genericVersion.versionRequested).toBe(false);
    expect(genericVersion.providerArgs).toEqual(['-V']);
  });

  it('maps --yolo to provider-specific arguments without leaking it as a Happier flag', () => {
    expect(partitionProviderSessionArgs({
      args: ['claude', '--yolo'],
      providerSubcommand: 'claude',
      yoloProviderArgs: ['--dangerously-skip-permissions'],
    }).providerArgs).toEqual(['--dangerously-skip-permissions']);
  });

  it('does not leak negative account settings version hints into provider arguments', () => {
    expect(partitionProviderSessionArgs({
      args: ['claude', '--account-settings-version-hint', '-1', 'agents'],
      providerSubcommand: 'claude',
    }).providerArgs).toEqual(['agents']);
  });

  it('treats option-like required flag values as missing', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
      throw new Error(`exit:${code ?? 0}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() => partitionProviderSessionArgs({
        args: ['codex', '--model', '--help'],
        providerSubcommand: 'codex',
        forwardModelFlag: true,
      })).toThrow('exit:1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Missing value for --model'));
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
