import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import type { SessionUsageLimitRecoveryControlAdapterParams } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';
import { createClaudeUsageLimitRecoveryControlAdapter } from './claudeUsageLimitRecoveryControlAdapter';

function createParams(
  metadata: Record<string, unknown>,
  rawSessionOverrides: Partial<SessionUsageLimitRecoveryControlAdapterParams['rawSession']> = {},
): SessionUsageLimitRecoveryControlAdapterParams {
  return {
    token: 'token',
    sessionId: 'sess_1',
    rawSession: {
      id: 'sess_1',
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
      active: false,
      activeAt: 1,
      path: '/repo',
      machineId: 'machine-local',
      metadata: '{}',
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      dataEncryptionKey: null,
      ...rawSessionOverrides,
    },
    metadata,
    currentMachineId: 'machine-local',
    sessionMachineId: 'machine-local',
    cwd: '/repo',
    ctx: {
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
    },
    mode: 'plain',
  };
}

function createClaudeUsageLimitIssue(overrides: Partial<{
  resetAtMs: number | null;
  retryAfterMs: number | null;
}> = {}) {
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'usage_limit',
    source: 'usage_limit',
    provider: 'claude',
    providerTurnId: 'turn-1',
    occurredAt: 1_700_000_000_000,
    usageLimit: {
      v: 1,
      resetAtMs: overrides.resetAtMs ?? null,
      retryAfterMs: overrides.retryAfterMs ?? 60_000,
      quotaScope: 'account',
      recoverability: 'wait',
      connectedService: {
        serviceId: 'claude-subscription',
        profileId: 'claude-profile-1',
        groupId: 'claude-group',
      },
    },
  } as const;
}

describe('claudeUsageLimitRecoveryControlAdapter', () => {
  it('waits until Claude retry-after timing and preserves the selected connected-service group', async () => {
    const adapter = createClaudeUsageLimitRecoveryControlAdapter({
      nowMs: () => 1_700_000_059_999,
    });

    await expect(adapter.checkNow?.(createParams({
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
    }, {
      latestTurnStatus: 'failed',
      lastRuntimeIssue: createClaudeUsageLimitIssue(),
    }))).resolves.toMatchObject({
      ok: true,
      status: 'waiting',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'waiting',
          resetAtMs: null,
          nextCheckAtMs: 1_700_000_060_000,
          attemptCount: 1,
          selectedAuth: {
            kind: 'group',
            serviceId: 'claude-subscription',
            groupId: 'claude-group',
            profileId: 'claude-profile-1',
          },
        },
      },
    });
  });

  it('marks Claude recovery ready after the check time', async () => {
    const adapter = createClaudeUsageLimitRecoveryControlAdapter({
      nowMs: () => 1_700_000_060_000,
    });

    await expect(adapter.checkNow?.(createParams({
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
    }, {
      latestTurnStatus: 'failed',
      lastRuntimeIssue: createClaudeUsageLimitIssue(),
    }))).resolves.toMatchObject({
      ok: true,
      status: 'ready',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'paused',
          nextCheckAtMs: null,
          attemptCount: 1,
        },
      },
    });
  });

  it('exhausts stale Claude recovery intents instead of retrying forever', async () => {
    const intent: SessionUsageLimitRecoveryV1 = {
      v: 1,
      status: 'waiting',
      issueFingerprint: 'usage-limit:claude:turn-1:1000:no-reset',
      armedAtMs: 1_000,
      resetAtMs: null,
      nextCheckAtMs: 2_000,
      attemptCount: 1,
      maxAttempts: 1,
      lastProbeError: null,
      resumePromptMode: 'standard',
      selectedAuth: { kind: 'native', serviceId: 'claude-subscription' },
    };
    const adapter = createClaudeUsageLimitRecoveryControlAdapter({
      nowMs: () => 5_000,
    });

    await expect(adapter.checkNow?.(createParams({
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: intent,
    }))).resolves.toMatchObject({
      ok: true,
      status: 'waiting',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'exhausted',
          attemptCount: 2,
        },
      },
    });
  });
});
