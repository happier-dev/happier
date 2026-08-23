import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import type { SessionUsageLimitRecoveryControlAdapterParams } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';
import { createOpenCodeUsageLimitRecoveryControlAdapter } from './openCodeUsageLimitRecoveryControlAdapter';

function createCredentials(): Credentials {
  return {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(9),
    },
  };
}

function createUsageLimitIssue(overrides: Partial<{
  occurredAt: number;
  resetAtMs: number | null;
  retryAfterMs: number | null;
}> = {}) {
  const occurredAt = overrides.occurredAt ?? 1_700_000_000_000;
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'usage_limit',
    source: 'usage_limit',
    provider: 'opencode',
    providerTurnId: 'turn-1',
    occurredAt,
    usageLimit: {
      v: 1,
      resetAtMs: overrides.resetAtMs ?? null,
      retryAfterMs: overrides.retryAfterMs ?? null,
      quotaScope: 'account',
      recoverability: 'wait',
      connectedService: {
        serviceId: 'openai',
        profileId: 'primary',
        groupId: null,
      },
    },
  } as const;
}

function createParams(
  metadata: Record<string, unknown>,
  rawSessionOverrides: Partial<SessionUsageLimitRecoveryControlAdapterParams['rawSession']> = {},
): SessionUsageLimitRecoveryControlAdapterParams {
  return {
    token: 'token',
    credentials: createCredentials(),
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
      encryptionVariant: 'legacy' as const,
    },
    mode: 'plain' as const,
  };
}

describe('openCodeUsageLimitRecoveryControlAdapter', () => {
  it('waits until retry-after-derived timing and keeps resetAtMs honest', async () => {
    const adapter = createOpenCodeUsageLimitRecoveryControlAdapter({
      nowMs: () => 1_700_000_059_999,
    });

    await expect(adapter.checkNow?.(createParams({
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: { v: 1, providerId: 'opencode' },
    }, {
      latestTurnStatus: 'failed',
      lastRuntimeIssue: createUsageLimitIssue({ retryAfterMs: 60_000 }),
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
            kind: 'profile',
            serviceId: 'openai',
            profileId: 'primary',
          },
        },
      },
    });
  });

  it('marks recovery ready and pauses the consumed intent after the check time', async () => {
    const adapter = createOpenCodeUsageLimitRecoveryControlAdapter({
      nowMs: () => 1_700_000_060_000,
    });

    await expect(adapter.checkNow?.(createParams({
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: { v: 1, providerId: 'opencode' },
    }, {
      latestTurnStatus: 'failed',
      lastRuntimeIssue: createUsageLimitIssue({ retryAfterMs: 60_000 }),
    }))).resolves.toMatchObject({
      ok: true,
      status: 'ready',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'paused',
          resetAtMs: null,
          nextCheckAtMs: null,
          attemptCount: 1,
        },
      },
    });
  });

  it('anchors fallback timing to an existing intent instead of sliding from check-now time', async () => {
    const intent: SessionUsageLimitRecoveryV1 = {
      v: 1,
      status: 'waiting',
      issueFingerprint: 'usage-limit:opencode:turn-1:1000:no-reset',
      armedAtMs: 1_000,
      resetAtMs: null,
      nextCheckAtMs: null,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      resumePromptMode: 'standard',
      selectedAuth: { kind: 'native' },
    };
    const adapter = createOpenCodeUsageLimitRecoveryControlAdapter({
      nowMs: () => 5_000,
      processEnv: { HAPPIER_OPENCODE_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS: '3000' },
    });

    await expect(adapter.checkNow?.(createParams({
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: { v: 1, providerId: 'opencode' },
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: intent,
    }))).resolves.toMatchObject({
      ok: true,
      status: 'ready',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'paused',
          nextCheckAtMs: null,
        },
      },
    });
  });

  it('uses the env-backed max attempts value when arming from the latest issue', async () => {
    const adapter = createOpenCodeUsageLimitRecoveryControlAdapter({
      nowMs: () => 1_700_000_000_000,
      processEnv: {
        HAPPIER_OPENCODE_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS: '3000',
        HAPPIER_OPENCODE_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS: '7',
      },
    });

    await expect(adapter.checkNow?.(createParams({
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: { v: 1, providerId: 'opencode' },
    }, {
      latestTurnStatus: 'failed',
      lastRuntimeIssue: createUsageLimitIssue({ occurredAt: 1_700_000_000_000 }),
    }))).resolves.toMatchObject({
      ok: true,
      status: 'waiting',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          maxAttempts: 7,
          nextCheckAtMs: 1_700_000_003_000,
        },
      },
    });
  });

  it('persists exhausted instead of using an invalid ready intent status after max attempts', async () => {
    const intent: SessionUsageLimitRecoveryV1 = {
      v: 1,
      status: 'waiting',
      issueFingerprint: 'usage-limit:opencode:turn-1:1000:no-reset',
      armedAtMs: 1_000,
      resetAtMs: null,
      nextCheckAtMs: 2_000,
      attemptCount: 1,
      maxAttempts: 1,
      lastProbeError: null,
      resumePromptMode: 'standard',
      selectedAuth: { kind: 'native' },
    };
    const adapter = createOpenCodeUsageLimitRecoveryControlAdapter({
      nowMs: () => 5_000,
    });

    await expect(adapter.checkNow?.(createParams({
      machineId: 'machine-local',
      agentRuntimeDescriptorV1: { v: 1, providerId: 'opencode' },
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: intent,
    }))).resolves.toMatchObject({
      ok: true,
      status: 'waiting',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'exhausted',
          attemptCount: 2,
          lastProbeError: 'usage_limit_recovery_max_attempts_exhausted',
        },
      },
    });
  });
});
