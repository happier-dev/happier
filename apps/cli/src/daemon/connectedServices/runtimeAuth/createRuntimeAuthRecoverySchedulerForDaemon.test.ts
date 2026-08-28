import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import { createRuntimeAuthRecoverySchedulerForDaemon } from './createRuntimeAuthRecoverySchedulerForDaemon';
import { buildRuntimeAuthRecoveryKey } from './runtimeAuthRecoveryKey';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

const classification: ConnectedServiceRuntimeFailureClassification = {
  kind: 'usage_limit',
  serviceId: 'openai-codex',
  profileId: 'primary',
  groupId: 'team',
  resetsAtMs: null,
  planType: null,
  rateLimits: null,
  source: 'structured_provider_error',
};

const predecessorRecoveryKey =
  'runtime-auth:v1:WyJzZXNzaW9uLXByZWRlY2Vzc29yIiwib3BlbmFpLWNvZGV4IixudWxsLCJ0ZWFtIl0';
const currentRecoveryKey = buildRuntimeAuthRecoveryKey({
  sessionId: 'session-predecessor',
  serviceId: 'openai-codex',
  profileId: 'primary',
  groupId: 'team',
  failingAccessTokenFingerprint: 'sha256:abcdef12',
});
const predecessorCredentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
const predecessorAttemptId = 'runtime-auth-attempt:predecessor';

function buildPredecessorRecoveryKey(input: Readonly<{
  sessionId: string;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
}>): string {
  return `runtime-auth:v1:${Buffer.from(JSON.stringify([
    input.sessionId,
    input.serviceId,
    input.groupId ? null : input.profileId,
    input.groupId,
  ]), 'utf8').toString('base64url')}`;
}

// Exact V2 intent shape and four-part key introduced at
// 6e6ecb42e7f9ab8607b5710547563bbc9c232728 and revalidated against the moving
// predecessor origin/dev@fbdd5d9cb07391eb839eab313c5ba60fe77ce20b.
function predecessorV2Intent(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    v: 2,
    attemptId: predecessorAttemptId,
    lastSettledTransition: 'scheduled',
    pendingVisibleEvents: [{
      attemptId: predecessorAttemptId,
      transition: 'scheduled',
      transcriptEvent: {
        type: 'connected-service-runtime-auth-recovery',
        status: 'retry_scheduled',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team',
        nextRetryAtMs: 2_000,
        terminal: false,
        diagnostic: {
          code: 'recovery_retry_scheduled',
          failurePhase: 'runtime_auth_recovery',
          source: 'runtime_auth_recovery',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'team',
          retryable: true,
          suggestedActions: ['retry', 'open_connected_accounts'],
          diagnostics: {
            runtimeFailureKind: 'usage_limit',
            classificationSource: 'structured_provider_error',
            reason: 'handler_transient_failure',
            nextRetryAtMs: 2_000,
          },
        },
      },
    }],
    sessionId: 'session-predecessor',
    serviceId: 'openai-codex',
    profileId: 'primary',
    groupId: 'team',
    resumePromptMode: 'standard',
    status: 'waiting',
    armedAtMs: 1_000,
    nextRetryAtMs: 2_000,
    attemptCount: 0,
    maxAttempts: 5,
    switchesThisTurn: 0,
    classification: {
      ...classification,
      credentialRevision: predecessorCredentialRevision,
      groupGeneration: 7,
      failingAccessTokenFingerprint: 'sha256:abcdef12',
    },
    failurePhase: 'handler',
    failureReason: 'handler_transient_failure',
    lastError: 'network',
    lastErrorClassification: { kind: 'network', retryable: true },
    pendingTargetProfileId: null,
    pendingTargetGeneration: null,
    terminalAtMs: null,
    terminalReason: null,
    ...overrides,
  };
}

async function seedRuntimeAuthRecoveryFile(
  activeServerDir: string,
  intentsBySessionId: Readonly<Record<string, unknown>>,
  effectClaimsByRecoveryKey?: Readonly<Record<string, string>>,
): Promise<string> {
  const filePath = join(activeServerDir, 'connected-services', 'runtime-auth-recovery.json');
  await mkdir(join(activeServerDir, 'connected-services'), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({
    v: 1,
    intentsBySessionId,
    ...(effectClaimsByRecoveryKey ? { effectClaimsByRecoveryKey } : {}),
  })}\n`, 'utf8');
  return filePath;
}

describe('createRuntimeAuthRecoverySchedulerForDaemon', () => {
  it('passively upgrades the exact predecessor V2/key vector and preserves pending event custody', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-predecessor-'));
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));
    try {
      const filePath = await seedRuntimeAuthRecoveryFile(activeServerDir, {
        [predecessorRecoveryKey]: predecessorV2Intent(),
        'runtime-auth:v1:WyJzZXNzLXJ1bnRpbWUtcHJlZGVjZXNzb3IiLCJvcGVuYWktY29kZXgiLG51bGwsImNvZGV4LW1haW4iXQ':
          predecessorV2Intent({
            sessionId: 'sess-runtime-predecessor',
            groupId: 'codex-main',
            classification: {
              ...classification,
              groupId: 'codex-main',
              credentialRevision: predecessorCredentialRevision,
            },
            pendingVisibleEvents: [{
              attemptId: predecessorAttemptId,
              transition: 'scheduled',
              transcriptEvent: {
                type: 'connected-service-runtime-auth-recovery',
                status: 'retry_scheduled',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                nextRetryAtMs: 2_000,
                terminal: false,
                diagnostic: {
                  code: 'recovery_retry_scheduled',
                  failurePhase: 'runtime_auth_recovery',
                  source: 'runtime_auth_recovery',
                  serviceId: 'openai-codex',
                  profileId: 'primary',
                  groupId: 'codex-main',
                  retryable: true,
                  suggestedActions: ['retry', 'open_connected_accounts'],
                },
              },
            }],
          }),
      });

      const scheduler = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => -60_000,
        recover,
      });

      expect(scheduler.readForSession('session-predecessor')).toEqual([
        expect.objectContaining({
          v: 1,
          attemptId: predecessorAttemptId,
          status: 'waiting',
          nextRetryAtMs: 2_000,
          classification: expect.objectContaining({
            expectedCredentialRevision: predecessorCredentialRevision,
            groupGeneration: 7,
            failingAccessTokenFingerprint: 'sha256:abcdef12',
          }),
        }),
      ]);
      expect(scheduler.readForSession('sess-runtime-predecessor')).toHaveLength(1);
      expect(recover).not.toHaveBeenCalled();

      const delivered: string[] = [];
      await expect(scheduler.drainPendingVisibleEvents(async (delivery) => {
        delivered.push(`${delivery.sessionId}:${delivery.attemptId}:${delivery.transition}`);
      })).resolves.toBe(2);
      await expect(scheduler.drainPendingVisibleEvents(async () => {
        throw new Error('ACK did not clear predecessor custody');
      })).resolves.toBe(0);
      expect(delivered).toEqual([
        `session-predecessor:${predecessorAttemptId}:scheduled`,
        `sess-runtime-predecessor:${predecessorAttemptId}:scheduled`,
      ]);
      expect(recover).not.toHaveBeenCalled();

      const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
        intentsBySessionId: Record<string, { pendingVisibleEvents?: unknown }>;
      };
      expect(persisted.intentsBySessionId[currentRecoveryKey]).not.toHaveProperty('pendingVisibleEvents');
      expect(persisted.intentsBySessionId).not.toHaveProperty(predecessorRecoveryKey);
      scheduler.dispose();

      const replacement = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => -59_900,
        recover,
      });
      expect(replacement.readForSession('session-predecessor')).toHaveLength(1);
      expect(replacement.readForSession('sess-runtime-predecessor')).toHaveLength(1);
      await expect(replacement.drainPendingVisibleEvents(async () => {
        throw new Error('ACKed predecessor event was redelivered after replacement');
      })).resolves.toBe(0);
      expect(recover).not.toHaveBeenCalled();
      replacement.dispose();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });

  it('keeps V1 accepted and fails closed for malformed or future predecessor state', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-compat-filter-'));
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));
    try {
      await seedRuntimeAuthRecoveryFile(activeServerDir, {
        'future-version': predecessorV2Intent({ v: 3, sessionId: 'session-future' }),
        'unsafe-checking': predecessorV2Intent({ status: 'checking', sessionId: 'session-checking' }),
        'malformed-next-retry': predecessorV2Intent({
          sessionId: 'session-malformed-next-retry',
          nextRetryAtMs: '2_000',
        }),
        'mismatched-classification': predecessorV2Intent({
          sessionId: 'session-mismatch',
          classification: {
            ...classification,
            serviceId: 'anthropic-claude',
            credentialRevision: predecessorCredentialRevision,
          },
        }),
        'runtime-auth:v1:WyJzZXNzaW9uLXYxIiwib3BlbmFpLWNvZGV4IixudWxsLCJ0ZWFtIixudWxsXQ': {
          ...predecessorV2Intent({
            v: 1,
            sessionId: 'session-v1',
            classification: {
              ...classification,
              expectedCredentialRevision: predecessorCredentialRevision,
            },
          }),
          pendingVisibleEvents: [],
        },
      });

      const scheduler = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 1_500,
        recover,
      });

      expect(scheduler.readForSession('session-v1')).toHaveLength(1);
      expect(scheduler.readForSession('session-future')).toEqual([]);
      expect(scheduler.readForSession('session-checking')).toEqual([]);
      expect(scheduler.readForSession('session-malformed-next-retry')).toEqual([]);
      expect(scheduler.readForSession('session-mismatch')).toEqual([]);
      expect(recover).not.toHaveBeenCalled();
      scheduler.dispose();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });

  it.each([
    ['future', 'current'],
    ['future', 'predecessor'],
    ['malformed-v1', 'current'],
    ['mismatched-v1', 'predecessor'],
    ['malformed-v2', 'predecessor'],
  ] as const)(
    'preserves opaque %s custody at the exact %s owner key while unrelated identities remain writable',
    async (recordKind, ownerKeyKind) => {
      const activeServerDir = await mkdtemp(join(
        tmpdir(),
        `happier-runtime-auth-occupied-${recordKind}-${ownerKeyKind}-`,
      ));
      const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));
      const futureClassification: ConnectedServiceRuntimeFailureClassification = {
        ...classification,
        failingAccessTokenFingerprint: 'sha256:future-owner',
      };
      const ownerKeyParts = {
        sessionId: 'session-future-owner',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team',
        failingAccessTokenFingerprint: 'sha256:future-owner',
      } as const;
      const currentOwnerKey = buildRuntimeAuthRecoveryKey(ownerKeyParts);
      const predecessorOwnerKey = buildPredecessorRecoveryKey(ownerKeyParts);
      const occupiedOwnerKey = ownerKeyKind === 'current' ? currentOwnerKey : predecessorOwnerKey;
      const baseOwnedIntent = predecessorV2Intent({
        v: 1,
        sessionId: ownerKeyParts.sessionId,
        classification: {
          ...futureClassification,
          expectedCredentialRevision: predecessorCredentialRevision,
        },
        pendingVisibleEvents: [],
      });
      const occupiedIntent: Readonly<Record<string, unknown>> = recordKind === 'future'
        ? {
            v: 3,
            opaqueFutureCustody: 'do-not-replace',
            sessionId: ownerKeyParts.sessionId,
          }
        : recordKind === 'malformed-v1'
          ? {
              ...baseOwnedIntent,
              maxAttempts: 'three',
            }
          : recordKind === 'mismatched-v1'
            ? {
                ...baseOwnedIntent,
                sessionId: 'session-different-owner',
              }
            : predecessorV2Intent({
                sessionId: ownerKeyParts.sessionId,
                classification: {
                  ...futureClassification,
                  credentialRevision: predecessorCredentialRevision,
                },
                nextRetryAtMs: '2_000',
              });
      const unrelatedFutureIntent = {
        v: 3,
        opaqueFutureCustody: 'unrelated',
      } as const;
      let scheduler: ReturnType<typeof createRuntimeAuthRecoverySchedulerForDaemon> | null = null;

      try {
        const filePath = await seedRuntimeAuthRecoveryFile(
          activeServerDir,
          {
            [occupiedOwnerKey]: occupiedIntent,
            'opaque-unrelated-key': unrelatedFutureIntent,
          },
          { [occupiedOwnerKey]: 'future-effect-owner' },
        );
        scheduler = createRuntimeAuthRecoverySchedulerForDaemon({
          activeServerDir,
          nowMs: () => 1_500,
          recover,
        });

        expect(scheduler.readForSession(ownerKeyParts.sessionId)).toEqual([]);
        await expect(scheduler.beginClassifiedFailure({
          reportId: `runtime-auth-report:future-${ownerKeyKind}`,
          sessionId: ownerKeyParts.sessionId,
          switchesThisTurn: 0,
          classification: futureClassification,
        })).rejects.toMatchObject({
          code: 'runtime_auth_recovery_owner_occupied_by_unsupported_version',
        });

        const unrelatedClassification: ConnectedServiceRuntimeFailureClassification = {
          ...classification,
          groupId: 'other-team',
        };
        await expect(scheduler.beginClassifiedFailure({
          reportId: `runtime-auth-report:unrelated-${ownerKeyKind}`,
          sessionId: 'session-unrelated-owner',
          switchesThisTurn: 0,
          classification: unrelatedClassification,
        })).resolves.toMatchObject({ status: 'scheduled' });

        const unrelatedOwnerParts = {
          sessionId: 'session-unrelated-owner',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'other-team',
        } as const;
        const unrelatedCurrentKey = buildRuntimeAuthRecoveryKey(unrelatedOwnerParts);
        const unrelatedPredecessorKey = buildPredecessorRecoveryKey(unrelatedOwnerParts);
        const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
          intentsBySessionId: Record<string, unknown>;
          effectClaimsByRecoveryKey?: Record<string, string>;
        };
        expect(persisted.intentsBySessionId[occupiedOwnerKey]).toEqual(occupiedIntent);
        expect(persisted.effectClaimsByRecoveryKey?.[occupiedOwnerKey]).toBe('future-effect-owner');
        expect(persisted.intentsBySessionId['opaque-unrelated-key']).toEqual(unrelatedFutureIntent);
        expect(persisted.intentsBySessionId[unrelatedCurrentKey]).toMatchObject({ v: 1 });
        expect(persisted.intentsBySessionId).not.toHaveProperty(unrelatedPredecessorKey);
        expect(recover).not.toHaveBeenCalled();
      } finally {
        scheduler?.dispose();
        await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
      }
    },
  );

  it('rechecks both physical owners after predecessor hydration before mutating an aliased intent', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-alias-conflict-'));
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));
    const ownerClassification: ConnectedServiceRuntimeFailureClassification = {
      ...classification,
      failingAccessTokenFingerprint: 'sha256:abcdef12',
    };
    const currentOwnerKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-predecessor',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
      failingAccessTokenFingerprint: 'sha256:abcdef12',
    });
    const opaqueCurrentIntent = {
      v: 3,
      opaqueFutureCustody: 'current-owner',
    } as const;
    let scheduler: ReturnType<typeof createRuntimeAuthRecoverySchedulerForDaemon> | null = null;

    try {
      const filePath = await seedRuntimeAuthRecoveryFile(
        activeServerDir,
        {
          [predecessorRecoveryKey]: predecessorV2Intent(),
          [currentOwnerKey]: opaqueCurrentIntent,
        },
        {
          [predecessorRecoveryKey]: 'predecessor-effect-owner',
          [currentOwnerKey]: 'current-effect-owner',
        },
      );
      scheduler = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 1_500,
        recover,
      });

      expect(scheduler.readForSession('session-predecessor')).toEqual([]);
      await expect(scheduler.beginClassifiedFailure({
        reportId: 'runtime-auth-report:aliased-owner-conflict',
        sessionId: 'session-predecessor',
        switchesThisTurn: 0,
        classification: ownerClassification,
      })).rejects.toMatchObject({
        code: 'runtime_auth_recovery_owner_occupied_by_unsupported_version',
      });

      const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
        intentsBySessionId: Record<string, unknown>;
        effectClaimsByRecoveryKey?: Record<string, string>;
      };
      expect(persisted.intentsBySessionId[predecessorRecoveryKey]).toEqual(predecessorV2Intent());
      expect(persisted.intentsBySessionId[currentOwnerKey]).toEqual(opaqueCurrentIntent);
      expect(persisted.effectClaimsByRecoveryKey?.[predecessorRecoveryKey]).toBe(
        'predecessor-effect-owner',
      );
      expect(persisted.effectClaimsByRecoveryKey?.[currentOwnerKey]).toBe('current-effect-owner');
      expect(recover).not.toHaveBeenCalled();
    } finally {
      scheduler?.dispose();
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });

  it('atomically adopts predecessor state under the canonical current key before mutation', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-owner-interleaving-'));
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));
    const currentOwnerKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-predecessor',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
      failingAccessTokenFingerprint: 'sha256:abcdef12',
    });
    let scheduler: ReturnType<typeof createRuntimeAuthRecoverySchedulerForDaemon> | null = null;
    const currentMutation: {
      value: ReturnType<
        ReturnType<typeof createRuntimeAuthRecoverySchedulerForDaemon>['beginClassifiedFailure']
      > | null;
    } = { value: null };

    try {
      const filePath = join(
        activeServerDir,
        'connected-services',
        'runtime-auth-recovery.json',
      );
      scheduler = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 1_500,
        recover,
      });

      await withJsonOwnerFileLock({
        lockPath: `${filePath}.lock`,
        timeoutMs: 10_000,
        staleAfterMs: 30_000,
        errorCode: 'runtime_auth_recovery_interleaving_lock_timeout',
      }, async () => {
        currentMutation.value = scheduler?.beginClassifiedFailure({
          reportId: 'runtime-auth-report:owner-interleaving',
          sessionId: 'session-predecessor',
          switchesThisTurn: 0,
          classification: {
            ...classification,
            failingAccessTokenFingerprint: 'sha256:abcdef12',
          },
        }) ?? null;

        await seedRuntimeAuthRecoveryFile(
          activeServerDir,
          { [predecessorRecoveryKey]: predecessorV2Intent() },
          { [predecessorRecoveryKey]: 'predecessor-effect-owner' },
        );
      });

      await expect(currentMutation.value).resolves.toMatchObject({ status: 'scheduled' });
      const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
        intentsBySessionId: Record<string, unknown>;
        effectClaimsByRecoveryKey?: Record<string, string>;
      };
      expect(persisted.intentsBySessionId[currentOwnerKey]).toMatchObject({
        v: 1,
        sessionId: 'session-predecessor',
      });
      expect(persisted.intentsBySessionId).not.toHaveProperty(predecessorRecoveryKey);
      expect(persisted.effectClaimsByRecoveryKey).toEqual({
        [currentOwnerKey]: 'predecessor-effect-owner',
      });
      expect(recover).not.toHaveBeenCalled();
    } finally {
      await currentMutation.value?.catch(() => {});
      scheduler?.dispose();
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });

  it('keeps current writes on the canonical key even if an unsupported predecessor later writes', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-owner-inverse-'));
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));
    const currentOwnerKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-predecessor',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
      failingAccessTokenFingerprint: 'sha256:abcdef12',
    });
    let scheduler: ReturnType<typeof createRuntimeAuthRecoverySchedulerForDaemon> | null = null;

    try {
      const filePath = join(
        activeServerDir,
        'connected-services',
        'runtime-auth-recovery.json',
      );
      scheduler = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 1_500,
        recover,
      });

      await expect(scheduler.beginClassifiedFailure({
        reportId: 'runtime-auth-report:owner-inverse',
        sessionId: 'session-predecessor',
        switchesThisTurn: 0,
        classification: {
          ...classification,
          failingAccessTokenFingerprint: 'sha256:abcdef12',
        },
      })).resolves.toMatchObject({ status: 'scheduled' });

      const predecessorWriter = createRecoveryIntentFileStore<unknown>(filePath);
      await predecessorWriter.write(predecessorRecoveryKey, predecessorV2Intent());

      const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
        intentsBySessionId: Record<string, unknown>;
      };
      expect(persisted.intentsBySessionId[currentOwnerKey]).toMatchObject({
        v: 1,
        sessionId: 'session-predecessor',
      });
      expect(persisted.intentsBySessionId).toEqual({
        [currentOwnerKey]: expect.objectContaining({
          v: 1,
          sessionId: 'session-predecessor',
        }),
        [predecessorRecoveryKey]: predecessorV2Intent(),
      });
      expect(recover).not.toHaveBeenCalled();
    } finally {
      scheduler?.dispose();
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });

  it('fails occupied without rewriting custody when a different fingerprint exists only at a current key', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-runtime-auth-current-fingerprint-owner-',
    ));
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));
    const identity = {
      sessionId: 'session-current-fingerprint-owner',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    } as const;
    const fingerprintA = 'sha256:current-fingerprint-a';
    const fingerprintB = 'sha256:current-fingerprint-b';
    const currentOwnerKeyA = buildRuntimeAuthRecoveryKey({
      ...identity,
      failingAccessTokenFingerprint: fingerprintA,
    });
    const currentOwnerKeyB = buildRuntimeAuthRecoveryKey({
      ...identity,
      failingAccessTokenFingerprint: fingerprintB,
    });
    const predecessorOwnerKey = buildPredecessorRecoveryKey(identity);
    const currentOwnerIntent = predecessorV2Intent({
      v: 1,
      sessionId: identity.sessionId,
      classification: {
        ...classification,
        expectedCredentialRevision: predecessorCredentialRevision,
        failingAccessTokenFingerprint: fingerprintA,
      },
    });
    const unrelatedOpaqueIntent = {
      v: 3,
      opaqueFutureCustody: 'unrelated-owner',
    } as const;
    let scheduler: ReturnType<typeof createRuntimeAuthRecoverySchedulerForDaemon> | null = null;

    try {
      const filePath = await seedRuntimeAuthRecoveryFile(
        activeServerDir,
        {
          [currentOwnerKeyA]: currentOwnerIntent,
          'opaque-unrelated-key': unrelatedOpaqueIntent,
        },
        { [currentOwnerKeyA]: 'current-effect-owner-a' },
      );
      const beforeBytes = await readFile(filePath, 'utf8');
      scheduler = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 1_500,
        recover,
      });

      expect(scheduler.readForSession(identity.sessionId)).toHaveLength(1);
      await expect(scheduler.beginClassifiedFailure({
        reportId: 'runtime-auth-report:current-fingerprint-b',
        sessionId: identity.sessionId,
        switchesThisTurn: 0,
        classification: {
          ...classification,
          failingAccessTokenFingerprint: fingerprintB,
        },
      })).rejects.toMatchObject({
        code: 'runtime_auth_recovery_owner_occupied_by_unsupported_version',
      });

      const afterBytes = await readFile(filePath, 'utf8');
      const persisted = JSON.parse(afterBytes) as {
        intentsBySessionId: Record<string, unknown>;
        effectClaimsByRecoveryKey?: Record<string, string>;
      };
      expect(afterBytes).toBe(beforeBytes);
      expect(persisted.intentsBySessionId[currentOwnerKeyA]).toEqual(currentOwnerIntent);
      expect(persisted.effectClaimsByRecoveryKey?.[currentOwnerKeyA]).toBe(
        'current-effect-owner-a',
      );
      expect(persisted.intentsBySessionId['opaque-unrelated-key']).toEqual(unrelatedOpaqueIntent);
      expect(persisted.intentsBySessionId).not.toHaveProperty(currentOwnerKeyB);
      expect(persisted.intentsBySessionId).not.toHaveProperty(predecessorOwnerKey);
      expect(recover).not.toHaveBeenCalled();
    } finally {
      scheduler?.dispose();
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });

  it('fails occupied when two current fingerprints share the predecessor physical key', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-owner-fingerprint-'));
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));
    const identity = {
      sessionId: 'session-fingerprint-owner',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    } as const;
    const fingerprintA = 'sha256:fingerprint-a';
    const fingerprintB = 'sha256:fingerprint-b';
    const predecessorOwnerKey = buildPredecessorRecoveryKey(identity);
    const currentOwnerKeyA = buildRuntimeAuthRecoveryKey({
      ...identity,
      failingAccessTokenFingerprint: fingerprintA,
    });
    const currentOwnerKeyB = buildRuntimeAuthRecoveryKey({
      ...identity,
      failingAccessTokenFingerprint: fingerprintB,
    });
    let scheduler: ReturnType<typeof createRuntimeAuthRecoverySchedulerForDaemon> | null = null;

    try {
      const filePath = join(
        activeServerDir,
        'connected-services',
        'runtime-auth-recovery.json',
      );
      scheduler = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 1_500,
        recover,
      });
      await expect(scheduler.beginClassifiedFailure({
        reportId: 'runtime-auth-report:fingerprint-a',
        sessionId: identity.sessionId,
        switchesThisTurn: 0,
        classification: {
          ...classification,
          failingAccessTokenFingerprint: fingerprintA,
        },
      })).resolves.toMatchObject({ status: 'scheduled' });

      await expect(scheduler.beginClassifiedFailure({
        reportId: 'runtime-auth-report:fingerprint-b',
        sessionId: identity.sessionId,
        switchesThisTurn: 0,
        classification: {
          ...classification,
          failingAccessTokenFingerprint: fingerprintB,
        },
      })).rejects.toMatchObject({
        code: 'runtime_auth_recovery_owner_occupied_by_unsupported_version',
      });

      const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
        intentsBySessionId: Record<string, unknown>;
      };
      expect(persisted.intentsBySessionId[currentOwnerKeyA]).toMatchObject({
        v: 1,
        classification: expect.objectContaining({
          failingAccessTokenFingerprint: fingerprintA,
        }),
      });
      expect(persisted.intentsBySessionId).not.toHaveProperty(currentOwnerKeyB);
      expect(persisted.intentsBySessionId).not.toHaveProperty(predecessorOwnerKey);
      expect(recover).not.toHaveBeenCalled();
    } finally {
      scheduler?.dispose();
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });

  it('keeps one durable effect owner across replacement schedulers and removes the predecessor key on settlement', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-effect-owner-'));
    let releaseRecovery!: () => void;
    const recoveryBlocked = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let notifyRecoveryStarted!: () => void;
    const recoveryStarted = new Promise<void>((resolve) => {
      notifyRecoveryStarted = resolve;
    });
    const recover = vi.fn(async () => {
      notifyRecoveryStarted();
      await recoveryBlocked;
      return {
        status: 'recovery_superseded' as const,
        reason: 'failing_profile_inactive' as const,
      };
    });
    let ownerWake: Promise<Readonly<{ status: string }>> | null = null;
    try {
      const filePath = await seedRuntimeAuthRecoveryFile(activeServerDir, {
        [predecessorRecoveryKey]: predecessorV2Intent(),
      });
      const owner = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 1_500,
        recover,
      });
      const replacement = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 1_500,
        recover,
      });

      ownerWake = owner.wake({ sessionId: 'session-predecessor', reason: 'manual' });
      await recoveryStarted;
      await expect(replacement.wake({
        sessionId: 'session-predecessor',
        reason: 'manual',
      })).resolves.toEqual({ status: 'checking' });
      expect(recover).toHaveBeenCalledTimes(1);

      releaseRecovery();
      await expect(ownerWake).resolves.toEqual({ status: 'superseded' });
      ownerWake = null;
      expect(recover).toHaveBeenCalledTimes(1);

      const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
        intentsBySessionId: Record<string, unknown>;
        effectClaimsByRecoveryKey?: Record<string, string>;
      };
      expect(persisted.intentsBySessionId).not.toHaveProperty(predecessorRecoveryKey);
      expect(persisted.effectClaimsByRecoveryKey ?? {}).not.toHaveProperty(predecessorRecoveryKey);
      owner.dispose();
      replacement.dispose();
    } finally {
      releaseRecovery?.();
      await ownerWake?.catch(() => {});
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });

  it('retries pending presentation delivery until ACK and disposal prevents re-arming', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-delivery-retry-'));
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));
    const scheduler = createRuntimeAuthRecoverySchedulerForDaemon({
      activeServerDir,
      nowMs: () => 1_000,
      recover,
    });
    try {
      const intake = await scheduler.beginClassifiedFailure({
        reportId: 'runtime-auth-report:retry', sessionId: 'session-retry', switchesThisTurn: 0, classification,
      });
      if (!('attemptId' in intake)) throw new Error('expected in-process attempt identity');
      await scheduler.enqueueHandlerFailure({
        reportId: 'runtime-auth-report:retry',
        expectedAttemptId: intake.attemptId,
        sessionId: 'session-retry',
        switchesThisTurn: 0,
        classification,
        error: Object.assign(new Error('network'), { code: 'ECONNRESET' }),
      });
      let attempts = 0;
      let acknowledge!: () => void;
      const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
      scheduler.schedulePendingVisibleEventDrain({
        delayMs: 0,
        retryDelayMs: 5,
        deliver: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('lost ACK');
          acknowledge();
        },
      });
      await acknowledged;
      expect(attempts).toBe(2);
      scheduler.dispose();
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(attempts).toBe(2);
      expect(recover).not.toHaveBeenCalled();
    } finally {
      scheduler.dispose();
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });
});
