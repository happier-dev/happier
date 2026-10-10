import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import type { SessionUsageLimitRecoveryControlAdapterParams } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';
import { buildNativeProviderAccountUsageSourceProfileId } from '@/daemon/connectedServices/accountUsage/nativeSourceIdentity';
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

function createNativeSourceRecovery(profileId: string, overrides: Partial<SessionUsageLimitRecoveryV1> = {}): SessionUsageLimitRecoveryV1 {
  return {
    v: 1, status: 'waiting', issueFingerprint: 'usage-limit:claude:turn-1:1700000000000:1700000060000',
    armedAtMs: 1_700_000_000_000, resetAtMs: 1_700_000_060_000, nextCheckAtMs: 1_700_000_060_000,
    attemptCount: 0, maxAttempts: 3, lastProbeError: null, resumePromptMode: 'standard',
    selectedAuth: { kind: 'profile', serviceId: 'claude-subscription', profileId }, ...overrides,
  };
}

describe('claudeUsageLimitRecoveryControlAdapter', () => {
  it.each([
    [1_700_000_059_999, 'waiting', 'waiting', 1_700_000_060_000],
    [1_700_000_060_000, 'ready', 'paused', null],
  ] as const)('checks retry-after timing at %s and preserves connected group authority', async (now, status, recoveryStatus, nextCheckAtMs) => {
    const adapter = createClaudeUsageLimitRecoveryControlAdapter({ nowMs: () => now });
    await expect(adapter.checkNow?.(createParams({
      machineId: 'machine-local', agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
    }, { latestTurnStatus: 'failed', lastRuntimeIssue: createClaudeUsageLimitIssue() }))).resolves.toMatchObject({
      ok: true, status, metadata: { sessionUsageLimitRecoveryV1: {
        status: recoveryStatus, resetAtMs: null, nextCheckAtMs, attemptCount: 1,
        selectedAuth: { kind: 'group', serviceId: 'claude-subscription', groupId: 'claude-group', profileId: 'claude-profile-1' },
      } },
    });
  });

  it.each(['unpersisted', 'waiting native', 'waiting connected', 'paused native', 'daemon-owned'] as const)(
    'qualifies native-looking quota evidence under %s authority without replacing its identity', async (scenario) => {
      const sourceId = buildNativeProviderAccountUsageSourceProfileId({ kind: 'localCredential', providerId: 'claude', material: '/native/config' });
      const intent = scenario === 'unpersisted' ? null : createNativeSourceRecovery(sourceId,
        scenario === 'paused native' ? { status: 'paused', nextCheckAtMs: null, attemptCount: 1 }
          : scenario === 'daemon-owned' ? { issueFingerprint: 'owned-attempt', runtimeAuthRecoveryAttemptId: 'owned-attempt' } : {});
      const issue = createClaudeUsageLimitIssue({ resetAtMs: intent?.resetAtMs });
      const metadata = {
        ...(intent ? { sessionUsageLimitRecoveryV1: intent } : {}),
        ...(scenario === 'waiting connected' ? { connectedServices: { v: 1, bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: sourceId },
        } } } : {}),
      };
      const selectedAuth = scenario === 'waiting connected' || scenario === 'daemon-owned'
        ? intent?.selectedAuth : { kind: 'native', serviceId: 'claude-subscription' };
      const adapter = createClaudeUsageLimitRecoveryControlAdapter({ nowMs: () => 1_700_000_060_000 });
      await expect(adapter.checkNow?.(createParams(metadata, { latestTurnStatus: 'failed',
        lastRuntimeIssue: { ...issue, usageLimit: { ...issue.usageLimit,
          connectedService: { serviceId: 'claude-subscription', profileId: sourceId, groupId: null } } },
      }))).resolves.toMatchObject({ ok: true, status: 'ready', metadata: { sessionUsageLimitRecoveryV1: {
        ...intent, status: 'paused', nextCheckAtMs: null, attemptCount: (intent?.attemptCount ?? 0) + 1, selectedAuth,
      } } });
    },
  );

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
