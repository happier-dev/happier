import { describe, expect, it, vi } from 'vitest';
import { serializeSessionModelSelectionV1, SessionModelSelectionV1Schema } from '@happier-dev/protocol';

import { partitionProviderSessionArgs } from './providerSessionArgPartition';

const nativeForkSource = {
  sessionId: 'source-session',
  providerSessionId: 'provider-session',
  cwd: '/tmp/source-project',
  target: {
    turnId: 'source-turn',
    providerCheckpoint: {
      providerCursor: 'checkpoint-1',
    },
  },
} as const;

function encodeNativeForkSourceTestVector(): string {
  return `nfs1:${Buffer.from(JSON.stringify(nativeForkSource), 'utf8').toString('base64url')}`;
}

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

  it('parses canonical structured model selection without forwarding it to the provider CLI', () => {
    const selection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 789,
      ref: {
        agentTargetKey: 'backend:review-bot:configured:review-bot',
        providerConnectionId: 'pc_work',
        modelId: 'default',
      },
    });
    expect(partitionProviderSessionArgs({
      args: ['acp-catalog', '--model-selection-v1', serializeSessionModelSelectionV1(selection), '--sandbox'],
      providerSubcommand: 'acp-catalog',
    })).toMatchObject({
      modelSelection: selection,
      providerArgs: ['--sandbox'],
    });
  });

  it('parses separate provider connection and model identity without forwarding connection identity', () => {
    expect(partitionProviderSessionArgs({
      args: ['codex', '--model', 'model-a', '--provider-connection', 'pc_work', '--sandbox'],
      providerSubcommand: 'codex',
      forwardModelFlag: true,
    })).toMatchObject({
      modelId: 'model-a',
      providerConnectionId: 'pc_work',
      providerArgs: ['--model', 'model-a', '--sandbox'],
    });
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

  it('refuses malformed canonical model-selection payloads', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
      throw new Error(`exit:${code ?? 0}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() => partitionProviderSessionArgs({
        args: ['codex', '--model-selection-v1', 'sms1:not-valid-base64url'],
        providerSubcommand: 'codex',
      })).toThrow('exit:1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --model-selection-v1 value'));
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('consumes a canonical native fork source without forwarding it to the provider CLI', () => {
    expect(partitionProviderSessionArgs({
      args: ['grok', '--native-fork-source-v1', encodeNativeForkSourceTestVector(), '--provider-arg'],
      providerSubcommand: 'grok',
    })).toMatchObject({
      nativeForkSource,
      providerArgs: ['--provider-arg'],
    });
  });

  it('rejects malformed native fork source carriers and resume coexistence', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
      throw new Error(`exit:${code ?? 0}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() => partitionProviderSessionArgs({
        args: ['grok', '--native-fork-source-v1', 'nfs1:not-canonical'],
        providerSubcommand: 'grok',
      })).toThrow('exit:1');
      expect(() => partitionProviderSessionArgs({
        args: [
          'grok',
          '--native-fork-source-v1',
          encodeNativeForkSourceTestVector(),
          '--resume',
          'provider-session',
        ],
        providerSubcommand: 'grok',
      })).toThrow('exit:1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('cannot be combined with --resume'));
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('keeps launch profile and connected-services auth in Happier ownership', () => {
    expect(partitionProviderSessionArgs({
      args: [
        'claude',
        '--launch-profile=work',
        '--connected-services', 'cs:team',
        '--print',
      ],
      providerSubcommand: 'claude',
    })).toMatchObject({
      profileQuery: 'work',
      connectedServicesAuthRaw: 'cs:team',
      providerArgs: ['--print'],
    });
  });

  it('rejects competing shorthand and JSON connected-services auth inputs', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
      throw new Error(`exit:${code ?? 0}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => partitionProviderSessionArgs({
        args: ['claude', '--auth', 'default', '--connected-services-json', '{"v":1,"bindingsByServiceId":{}}'],
        providerSubcommand: 'claude',
      })).toThrow('exit:1');
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
