import { describe, expect, it } from 'vitest';

import {
  codexCliSessionCommandConfig,
  resolveCodexCliSessionExtraOptions,
} from './command';

describe('Codex CLI command policy', () => {
  it('declares Codex-owned session command parsing options', () => {
    expect(codexCliSessionCommandConfig).toEqual({
      sessionRuntimeId: 'codex',
      accountSettingsAgentId: 'codex',
      directoryFlags: ['-C', '--cd'],
      forwardModelFlag: true,
      versionFlags: ['-V', '--version'],
    });
  });

  it('normalizes terminal and remote starting modes to host session modes', () => {
    expect(
      resolveCodexCliSessionExtraOptions({
        startingMode: 'terminal',
        directory: '/tmp/codex',
        agentArgs: [],
      }),
    ).toEqual({
      ok: true,
      options: {
        startingMode: 'local',
        directory: '/tmp/codex',
      },
    });

    expect(
      resolveCodexCliSessionExtraOptions({
        startingMode: 'remote',
        agentArgs: ['exec', '--sandbox', 'workspace-write'],
      }),
    ).toEqual({
      ok: true,
      options: {
        startingMode: 'remote',
        codexArgs: ['exec', '--sandbox', 'workspace-write'],
      },
    });
  });

  it('rejects ambiguous starting modes without exiting the host process', () => {
    expect(
      resolveCodexCliSessionExtraOptions({
        startingMode: 'nope',
        agentArgs: [],
      }),
    ).toEqual({
      ok: false,
      errorMessage: 'Invalid --happy-starting-mode: nope. Use "terminal" or "remote".',
    });
  });
});
