import { describe, expect, it } from 'vitest';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol';

import { partitionProviderSessionArgs } from '@/cli/providerSessionArgPartition';
import type { NativeForkSource } from '@/session/shared/spawnSessionContract';
import { buildHappySessionControlArgs } from './sessionSpawnArgs';

function nativeModelSelection(modelId: string, updatedAt: number) {
  return {
    v: 1 as const,
    updatedAt,
    ref: {
      agentTargetKey: 'backend:codex',
      providerConnectionId: null,
      modelId,
    },
  };
}

const nativeForkSource: NativeForkSource = {
  sessionId: 'source-session',
  providerSessionId: 'provider-session',
  cwd: '/tmp/source-project',
  target: {
    turnId: 'source-turn',
    providerCheckpoint: {
      providerCursor: 'checkpoint-1',
    },
  },
};

describe('buildHappySessionControlArgs', () => {
  it('includes permission mode flags when provided', () => {
    expect(buildHappySessionControlArgs({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 123,
    })).toEqual(['--permission-mode', 'safe-yolo', '--permission-mode-updated-at', '123']);
  });

  it('includes model flags when provided', () => {
    const selection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 456,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'default',
      },
    });
    const args = buildHappySessionControlArgs({ modelSelection: selection });

    expect(args).toEqual(['--model-selection-v1', expect.stringMatching(/^sms1:/u)]);
    expect(partitionProviderSessionArgs({
      args: ['codex', ...args],
      providerSubcommand: 'codex',
    })).toMatchObject({
      modelSelection: selection,
      modelId: undefined,
      modelUpdatedAt: undefined,
    });
  });

  it('round-trips configured-target provider identity without collapsing it to a built-in target', () => {
    const selection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 457,
      ref: {
        agentTargetKey: 'backend:review-bot:configured:review-bot',
        providerConnectionId: 'pc_gateway',
        modelId: 'vendor/model',
      },
    });
    const parsed = partitionProviderSessionArgs({
      args: ['acp-catalog', ...buildHappySessionControlArgs({ modelSelection: selection })],
      providerSubcommand: 'acp-catalog',
    });

    expect(parsed.modelSelection).toEqual(selection);
    expect(parsed.providerArgs).toEqual([]);
  });

  it('includes agent mode flags when provided', () => {
    expect(buildHappySessionControlArgs({
      agentModeId: 'plan',
    })).toEqual(['--agent-mode', 'plan']);
  });

  it('omits model flags when the structured selection is missing', () => {
    expect(buildHappySessionControlArgs({})).toEqual([]);
  });

  it('refuses an invalid structured selection instead of silently omitting it', () => {
    expect(() => buildHappySessionControlArgs({
      modelSelection: nativeModelSelection('   ', 456),
    })).toThrow();
  });

  it('includes resume and existing-session flags when values are present', () => {
    expect(buildHappySessionControlArgs({
      resume: '  resume-id  ',
      existingSessionId: ' existing-session-id ',
    })).toEqual(['--resume', 'resume-id', '--existing-session', 'existing-session-id']);
  });

  it('round-trips a native fork source without forwarding the carrier to provider arguments', () => {
    const args = buildHappySessionControlArgs({ nativeForkSource });

    expect(args).toEqual([
      '--native-fork-source-v1',
      expect.stringMatching(/^nfs1:[A-Za-z0-9_-]+$/u),
    ]);
    expect(partitionProviderSessionArgs({
      args: ['grok', ...args],
      providerSubcommand: 'grok',
    })).toMatchObject({
      nativeForkSource,
      resume: undefined,
      providerArgs: [],
    });
  });

  it('rejects a native fork source combined with provider resume', () => {
    expect(() => buildHappySessionControlArgs({
      nativeForkSource,
      resume: 'provider-session',
    })).toThrow(/cannot be combined with provider resume/u);
  });

  it('rejects unbounded or non-contract native fork source fields', () => {
    expect(() => buildHappySessionControlArgs({
      nativeForkSource: {
        ...nativeForkSource,
        providerSessionId: 'p'.repeat(2_001),
      },
    })).toThrow();
    expect(() => buildHappySessionControlArgs({
      nativeForkSource: {
        ...nativeForkSource,
        unexpected: true,
      } as never,
    })).toThrow();
  });

  it('includes permission mode without timestamp when updatedAt is absent', () => {
    expect(buildHappySessionControlArgs({
      permissionMode: 'safe',
    })).toEqual(['--permission-mode', 'safe']);
  });

  it('normalizes Claude permission mode aliases before passing session-control flags', () => {
    expect(buildHappySessionControlArgs({
      permissionMode: 'safe-yolo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
    })).toEqual(['--permission-mode', 'acceptEdits']);
  });

  it('supports model timestamp boundary value zero', () => {
    expect(buildHappySessionControlArgs({
      modelSelection: nativeModelSelection('o3', 0),
    })).toEqual(['--model-selection-v1', expect.stringMatching(/^sms1:/u)]);
  });

  it('does not pass account settings version hints to child sessions', () => {
    const obsoleteOptions: Parameters<typeof buildHappySessionControlArgs>[0] & { accountSettingsVersionHint: number } = {
      accountSettingsVersionHint: 14,
    };
    expect(buildHappySessionControlArgs(obsoleteOptions)).toEqual([]);
  });

  it('includes backend flag when the backend target is a configured ACP backend', () => {
    expect(buildHappySessionControlArgs({
      backendTarget: {
        kind: 'backend',
        backendId: ' custom-kiro ',
        configuredBackendId: ' custom-kiro ',
        sourceKind: 'configured',
      } as any,
    })).toEqual(['--backend', 'custom-kiro']);
  });

  it('uses configuredBackendId for configured ACP targets that still carry the customAcp family marker', () => {
    expect(buildHappySessionControlArgs({
      backendTarget: {
        kind: 'backend',
        backendId: 'customAcp',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      } as never,
    })).toEqual(['--backend', 'review-bot']);
  });

  it('omits backend flag for customAcp placeholder targets', () => {
    expect(buildHappySessionControlArgs({
      backendTarget: {
        kind: 'backend',
        backendId: 'customAcp',
        configuredBackendId: 'customAcp',
        sourceKind: 'configured',
      } as any,
    })).toEqual([]);
  });
});
