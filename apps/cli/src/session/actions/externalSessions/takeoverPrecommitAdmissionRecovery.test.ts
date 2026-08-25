import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  authorizeExternalSessionOperationSocketCommandV1,
  resolveExternalSessionOperationTimelineV1,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationSocketCommandV1,
  type SessionMetadataOwnerPatchV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  admitPersistedTakeoverBeforeRuntime,
  reportPersistedTakeoverRuntimeBound,
} from '@/agent/runtime/startupSideEffects';
import type { Metadata } from '@/api/types';
import { createPersistedTakeoverAdmissionWaiter } from '@/daemon/spawn/persistedTakeoverAdmission';
import type { ResolvedExternalTakeoverSpawn } from '@/api/session/external/takeover/resolveExternalTakeoverSpawnOptions';
import type {
  SpawnSessionOptions,
  SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';

import {
  readExternalSessionOperationRecord,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';
import {
  createExternalSessionTakeoverAdmissionActionExecutor,
} from './takeoverAdmissionAction';
import {
  createExternalSessionPersistedTakeoverAdmissionOwner,
} from './persistedTakeoverAdmission';
import {
  recoverExternalSessionTakeoverPrecommitAdmission,
} from './takeoverPrecommitAdmissionRecovery';
import type {
  PreparedExternalSessionPersistedTakeoverSource,
} from './takeoverPhaseRunner';

const ATTEMPT_ID = 'attempt-1';
const CLAIM_ID = 'released-start-claim';
const publisherPrecondition = Object.freeze({
  machineId: 'machine-1',
  committedFenceMs: 1,
});

function precommitAdmittingRecord(): ExternalSessionOperationRecordV1 {
  const request = {
    v: 1 as const,
    idempotencyKey: 'takeover-request-1',
    sessionId: 'session-1',
    source: {
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      qualifiedIdentity: {
        v: 1 as const,
        agent: { pluginId: 'com.example.agent', localId: 'example' },
        source: { kind: 'jsonl' as const, contractVersion: 1 as const },
      },
      linkGeneration: 'link-1',
      sourceGeneration: 'source-1',
      contributionGeneration: 'contribution-1',
    },
    plan: 'takeover' as const,
    targetStorageMode: 'persisted' as const,
    targetDirectory: '/local/selected/workspace',
    targetRuntimeMode: 'terminal' as const,
  };
  return {
    v: 1,
    operationId: 'external-takeover:operation-1',
    revision: 7,
    request,
    status: 'running',
    phase: 'admitting',
    timeline: resolveExternalSessionOperationTimelineV1(request),
    createdAtMs: 1,
    updatedAtMs: 2,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: 'snapshot_complete',
    publication: {
      materializationPublicationId: 'publication-1',
      materializedThroughSourceAt: 10,
      publishedThroughServerSeq: 3,
    },
    checkpoint: {
      sourcePagesRead: 0,
      stagedItemCount: 0,
      importedItemCount: 0,
      acceptedThroughServerSeq: 3,
      acknowledgedBatchId: 'historical-import-complete',
      requiredItemFailures: {
        total: 0,
        record: 0,
        media: 0,
        conversion: 0,
        diagnosticsTruncated: false,
        diagnostics: [],
      },
    },
    bindings: {
      operationClaimId: CLAIM_ID,
      targetRuntimeAttemptId: ATTEMPT_ID,
    },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: { linkedSessionRevision: 4 },
    fence: { kind: 'none' },
  };
}

async function recover(
  activeServerDir: string,
  record: ExternalSessionOperationRecordV1,
) {
  await writeExternalSessionOperationRecord(activeServerDir, record);
  return await recoverExternalSessionTakeoverPrecommitAdmission({
    activeServerDir,
    targetStorageMode: 'persisted',
    sessionId: record.request.sessionId,
    operationId: record.operationId,
    attemptId: ATTEMPT_ID,
    operationClaimId: CLAIM_ID,
    message: 'Server rejected the takeover admission.',
    nowMs: 500,
  });
}

async function withActiveServerDir(
  run: (activeServerDir: string) => Promise<void>,
): Promise<void> {
  const activeServerDir = await mkdtemp(join(
    tmpdir(),
    'happier-takeover-precommit-recovery-',
  ));
  try {
    await run(activeServerDir);
  } finally {
    await rm(activeServerDir, { recursive: true, force: true });
  }
}

function admissionReadyRecord(): ExternalSessionOperationRecordV1 {
  const initial = precommitAdmittingRecord();
  return {
    ...initial,
    status: 'awaiting_user_resume',
    bindings: {
      operationClaimId: CLAIM_ID,
    },
    retryTargetPhase: 'admitting',
  };
}

function persistedCurrentSource(): PreparedExternalSessionPersistedTakeoverSource {
  return {
    pluginGeneration: 'contribution-1',
    quiescenceIdentity: 'stopped-source-1',
    linked: {
      rawSession: {
        id: 'session-1',
        metadataVersion: 7,
        seq: 3,
        pendingVersion: 4,
        pendingCount: 2,
        pendingBlockedCount: 1,
        currentStorageState: 'snapshot_complete',
        acceptedThroughServerSeq: null,
        active: true,
        thinking: false,
      },
      metadata: {},
      sessionPath: '/tmp/external-session',
      agentId: 'claude',
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      linkGeneration: 'link-1',
      source: { kind: 'claudeConfig', projectId: 'project-1' },
      codexBackendMode: null,
    } as unknown as PreparedExternalSessionPersistedTakeoverSource['linked'],
  };
}

function metadataPatchFor(
  linked: PreparedExternalSessionPersistedTakeoverSource['linked'],
): SessionMetadataOwnerPatchV1 {
  const ownerMetadata = {
    t: 'plain' as const,
    v: { v: 1 as const },
  };
  return {
    mode: 'owner',
    metadataLayoutVersion: 1,
    expectedOwnerMetadata: ownerMetadata,
    sharedMetadata: {
      ciphertext: 'recipient-safe-metadata',
      expectedVersion: linked.rawSession.metadataVersion,
    },
    ownerMetadata,
    agentState: {
      ciphertext: null,
      expectedVersion: 0,
    },
  };
}

function resolvedSpawn(
  options: SpawnSessionOptions,
): ResolvedExternalTakeoverSpawn {
  return {
    options,
    origin: {
      agentId: 'claude',
      pluginId: 'claude',
      generation: 'contribution-1',
    },
  };
}

async function spawnResolvedTakeoverSession(input: Readonly<{
  resolved: ResolvedExternalTakeoverSpawn;
  options: Pick<
    SpawnSessionOptions,
    'transcriptStorage' | 'persistedTakeoverAdmission'
  >;
  spawnSession(options: SpawnSessionOptions): Promise<SpawnSessionResult>;
}>) {
  return {
    ok: true as const,
    value: await input.spawnSession({
      ...input.resolved.options,
      ...input.options,
    }),
  };
}

describe('external-session takeover precommit admission recovery', () => {
  // Positive twin for the two refusal cases below: without it a refusal test
  // could pass simply because the fixture never reaches the transition at all.
  it('fails the exact pre-commit admitting attempt whatever revision the admission owner left behind', async () => {
    await withActiveServerDir(async (activeServerDir) => {
      const recovered = await recover(activeServerDir, precommitAdmittingRecord());
      expect(recovered).toMatchObject({
        status: 'recovered',
        record: {
          revision: 8,
          status: 'failed',
          phase: 'admitting',
          retryTargetPhase: 'admitting',
          error: { code: 'admission_failed', retryable: true },
        },
      });
      expect(await readExternalSessionOperationRecord(
        activeServerDir,
        'external-takeover:operation-1',
      )).toMatchObject({ status: 'failed', phase: 'admitting' });
    });
  });

  // An operation parked for explicit user Resume is not a live pre-commit
  // attempt: its recovery state belongs to the resume route, and marking it
  // `failed`/`admission_failed` would discard the user's pending decision.
  it('refuses an attempt that is parked awaiting an explicit user resume', async () => {
    await withActiveServerDir(async (activeServerDir) => {
      const parked = {
        ...precommitAdmittingRecord(),
        status: 'awaiting_user_resume' as const,
        retryTargetPhase: 'admitting' as const,
      };
      expect(await recover(activeServerDir, parked)).toMatchObject({
        status: 'already_settled',
        record: { status: 'awaiting_user_resume', phase: 'admitting' },
      });
      expect(await readExternalSessionOperationRecord(
        activeServerDir,
        'external-takeover:operation-1',
      )).toMatchObject({ status: 'awaiting_user_resume', phase: 'admitting' });
    });
  });

  // An absent or unreadable row proves nothing about where the attempt went, so
  // it stays unresolved rather than being reported as an already-settled
  // outcome the caller would publish.
  it('stays unresolved when the durable operation row cannot be read', async () => {
    await withActiveServerDir(async (activeServerDir) => {
      expect(await recoverExternalSessionTakeoverPrecommitAdmission({
        activeServerDir,
        targetStorageMode: 'persisted',
        sessionId: 'session-1',
        operationId: 'external-takeover:operation-1',
        attemptId: ATTEMPT_ID,
        operationClaimId: CLAIM_ID,
        message: 'Server rejected the takeover admission.',
        nowMs: 500,
      })).toEqual({ status: 'unresolved' });
    });
  });

  it('refuses a resumed operation owned by a new claim even when it reuses the same admission attempt', async () => {
    await withActiveServerDir(async (activeServerDir) => {
      const resumed = {
        ...precommitAdmittingRecord(),
        revision: 8,
        bindings: {
          operationClaimId: 'resume-claim-2',
          targetRuntimeAttemptId: ATTEMPT_ID,
        },
      };
      expect(await recover(activeServerDir, resumed)).toMatchObject({
        status: 'already_settled',
        record: {
          revision: 8,
          bindings: { operationClaimId: 'resume-claim-2' },
        },
      });
      expect(await readExternalSessionOperationRecord(
        activeServerDir,
        'external-takeover:operation-1',
      )).toMatchObject({
        revision: 8,
        status: 'running',
        phase: 'admitting',
        bindings: {
          operationClaimId: 'resume-claim-2',
          targetRuntimeAttemptId: ATTEMPT_ID,
        },
      });
    });
  });

  it('keeps a double-lost-ack predecessor child from binding its replacement', async () => {
    await withActiveServerDir(async (activeServerDir) => {
      const waiter = createPersistedTakeoverAdmissionWaiter({
        timeoutMs: 5_000,
      });
      const predecessorAttemptId = 'attempt-predecessor';
      const replacementAttemptId = 'attempt-replacement';
      const predecessorClaimId = 'claim-predecessor';
      const replacementClaimId = 'claim-replacement';
      const clock = (() => {
        let now = 100;
        return () => ++now;
      })();
      const releasedClaims: string[] = [];
      const predecessorCommands: Array<Extract<
        ExternalSessionOperationSocketCommandV1,
        { kind: 'admit_persisted_takeover'; mode: 'persisted' }
      >> = [];
      let replacementCommand: Extract<
        ExternalSessionOperationSocketCommandV1,
        { kind: 'admit_persisted_takeover'; mode: 'persisted' }
      > | null = null;
      let replacementRecordAtAdmission: ExternalSessionOperationRecordV1 | null = null;
      const childReports: Array<Readonly<{
        phase: 'admit' | 'runtime_bound';
        mode: 'persisted';
        operationId: string;
        attemptId: string;
        fields: string[];
      }>> = [];
      const initial = admissionReadyRecord();
      await writeExternalSessionOperationRecord(activeServerDir, initial);

      const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
        activeServerDir,
        admissionWaiter: waiter,
        isFollowSuspended: () => true,
        suspendFollow: async () => undefined,
        loadCurrent: async () => persistedCurrentSource(),
        loadCanonicalTarget: async () => persistedCurrentSource().linked,
        prepareLinkRetirementPatch: async ({ linked }) => metadataPatchFor(linked),
        sendHistoricalCommand: async (command) => {
          if (
            command.kind !== 'admit_persisted_takeover'
            || command.mode !== 'persisted'
          ) {
            throw new Error('unexpected historical command');
          }
          if (command.claim.operationClaimId === predecessorClaimId) {
            predecessorCommands.push(command);
            throw new Error('historical import acknowledgement was lost');
          }
          if (command.claim.operationClaimId !== replacementClaimId) {
            throw new Error('unexpected historical claim');
          }
          replacementCommand = command;
          replacementRecordAtAdmission = await readExternalSessionOperationRecord(
            activeServerDir,
            command.claim.operationId,
          );
          return {
            v: 1,
            kind: 'takeover_admitted',
            mode: 'persisted',
            claim: command.claim,
            revision: command.expectedRevision,
            attemptId: command.attemptId,
          };
        },
        nowMs: clock,
      });

      type DaemonSessionStartedNotifier =
        typeof import('@/daemon/controlClient').notifyDaemonSessionStarted;
      const notifyChildToDaemon: DaemonSessionStartedNotifier = async (
        sessionId,
        _metadata,
        options,
      ) => {
        const report = options?.persistedTakeoverAdmission;
        if (!report || report.mode !== 'persisted') {
          return {
            error: 'Persisted takeover admission report is missing.',
            errorCode: 'persisted_takeover_admission_missing',
          };
        }
        childReports.push({
          phase: report.phase,
          mode: report.mode,
          operationId: report.operationId,
          attemptId: report.attemptId,
          fields: Object.keys(report).sort(),
        });
        try {
          const correlation = {
            sessionId,
            mode: report.mode,
            operationId: report.operationId,
            attemptId: report.attemptId,
            publisherPrecondition: report.publisherPrecondition,
          };
          if (report.phase === 'admit') {
            await owner.admit(correlation);
          } else {
            await owner.runtimeBound(correlation);
          }
          return { status: 'ok' };
        } catch (error) {
          const errorCode = error instanceof Error
            ? error.message
            : 'persisted_takeover_admission_failed';
          return { error: errorCode, errorCode };
        }
      };

      const attemptIds = [predecessorAttemptId, replacementAttemptId];
      const claimIds = [predecessorClaimId, replacementClaimId];
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: async (request) => {
            const claimId = claimIds.shift();
            if (!claimId) throw new Error('unexpected takeover claim');
            return {
              status: 'acquired',
              claim: {
                record: {
                  schemaVersion: 1,
                  claimId,
                  ownerId: 'takeover-composition-test',
                  request,
                  acquiredAtMs: clock(),
                  renewedAtMs: clock(),
                  expiresAtMs: clock() + 20_000,
                },
                renew: async () => true,
                release: async () => {
                  releasedClaims.push(claimId);
                },
              },
            };
          },
        },
        prepareSpawn: async (record) => resolvedSpawn({
          directory: record.request.targetDirectory,
          existingSessionId: record.request.sessionId,
        }),
        reconcileAuthority: owner.reconcileAuthority,
        reconcileRuntimeBindingFailure: owner.reconcileRuntimeBindingFailure,
        spawnResolvedTakeoverSession,
        spawnSession: async (options) => {
          const correlation = options.persistedTakeoverAdmission;
          if (!correlation || correlation.mode !== 'persisted') {
            throw new Error('persisted takeover child correlation is missing');
          }
          expect(Object.keys(correlation).sort()).toEqual([
            'attemptId',
            'mode',
            'operationId',
          ]);
          const childOptions = {
            sessionId: initial.request.sessionId,
            metadata: {} as Metadata,
            correlation: {
              ...correlation,
              publisherPrecondition,
            },
          };
          if (correlation.attemptId === predecessorAttemptId) {
            await expect(admitPersistedTakeoverBeforeRuntime(
              childOptions,
              { notifyDaemonSessionStartedFn: notifyChildToDaemon },
            )).rejects.toThrow(
              'persisted_takeover_admission_authority_unresolved',
            );
            return {
              type: 'success',
              sessionId: initial.request.sessionId,
            };
          }
          if (correlation.attemptId !== replacementAttemptId) {
            throw new Error('unexpected persisted takeover attempt');
          }
          await admitPersistedTakeoverBeforeRuntime(
            childOptions,
            { notifyDaemonSessionStartedFn: notifyChildToDaemon },
          );
          expect(replacementCommand).not.toBeNull();
          expect(replacementRecordAtAdmission).toMatchObject({
            revision: replacementCommand!.expectedRevision,
            bindings: {
              operationClaimId: replacementCommand!.claim.operationClaimId,
              targetRuntimeAttemptId: replacementCommand!.attemptId,
            },
          });
          // The server owns claim succession. The client supplies one exact
          // replacement claim/revision tuple, then the protocol fence rejects
          // the delayed predecessor against that now-bound successor.
          expect(
            authorizeExternalSessionOperationSocketCommandV1({
              transportMachineId: 'machine-1',
              boundClaim: {
                machineId: 'machine-1',
                sessionId: replacementCommand!.claim.sessionId,
                operationId: replacementCommand!.claim.operationId,
                operationClaimId: replacementCommand!.claim.operationClaimId,
                revision: replacementCommand!.expectedRevision,
              },
              command: predecessorCommands[0]!,
            }),
          ).toEqual({ ok: false, errorCode: 'wrong_operation_claim' });
          await expect(reportPersistedTakeoverRuntimeBound(
            {
              ...childOptions,
              correlation: {
                mode: 'persisted',
                operationId: initial.operationId,
                attemptId: predecessorAttemptId,
                publisherPrecondition,
              },
            },
            { notifyDaemonSessionStartedFn: notifyChildToDaemon },
          )).rejects.toThrow(
            'persisted_takeover_runtime_bound_operation_mismatch',
          );
          expect(waiter.isPending({
            mode: 'persisted',
            operationId: initial.operationId,
            attemptId: replacementAttemptId,
          })).toBe(true);
          await reportPersistedTakeoverRuntimeBound(
            childOptions,
            { notifyDaemonSessionStartedFn: notifyChildToDaemon },
          );
          return {
            type: 'success',
            sessionId: initial.request.sessionId,
          };
        },
        admissionWaiter: waiter,
        isHostedAdmissionAvailable: () => true,
        createAttemptId: () => {
          const attemptId = attemptIds.shift();
          if (!attemptId) throw new Error('unexpected takeover attempt');
          return attemptId;
        },
        nowMs: clock,
      });

      await expect(executor.resume({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        revision: initial.revision,
      })).resolves.toMatchObject({ ok: true });
      const recovered = await readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      );
      expect(recovered).toMatchObject({
        status: 'failed',
        phase: 'admitting',
        retryTargetPhase: 'admitting',
        error: { code: 'admission_failed', retryable: true },
        bindings: {
          operationClaimId: predecessorClaimId,
          targetRuntimeAttemptId: predecessorAttemptId,
        },
      });

      await expect(executor.resume({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        revision: recovered!.revision,
      })).resolves.toMatchObject({ ok: true });
      expect(predecessorCommands).toHaveLength(2);
      expect(predecessorCommands[1]).toEqual(predecessorCommands[0]);
      expect(replacementCommand).toMatchObject({
        claim: {
          operationClaimId: replacementClaimId,
          operationId: initial.operationId,
          sessionId: initial.request.sessionId,
        },
        attemptId: replacementAttemptId,
      });
      expect(childReports).toEqual([
        {
          phase: 'admit',
          mode: 'persisted',
          operationId: initial.operationId,
          attemptId: predecessorAttemptId,
          fields: [
            'attemptId',
            'mode',
            'operationId',
            'phase',
            'publisherPrecondition',
          ],
        },
        {
          phase: 'admit',
          mode: 'persisted',
          operationId: initial.operationId,
          attemptId: replacementAttemptId,
          fields: [
            'attemptId',
            'mode',
            'operationId',
            'phase',
            'publisherPrecondition',
          ],
        },
        {
          phase: 'runtime_bound',
          mode: 'persisted',
          operationId: initial.operationId,
          attemptId: predecessorAttemptId,
          fields: [
            'attemptId',
            'mode',
            'operationId',
            'phase',
            'publisherPrecondition',
          ],
        },
        {
          phase: 'runtime_bound',
          mode: 'persisted',
          operationId: initial.operationId,
          attemptId: replacementAttemptId,
          fields: [
            'attemptId',
            'mode',
            'operationId',
            'phase',
            'publisherPrecondition',
          ],
        },
      ]);
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      )).resolves.toMatchObject({
        status: 'completed',
        phase: 'finalizing',
        currentStorageState: 'hosted',
        bindings: {
          operationClaimId: replacementClaimId,
          targetRuntimeAttemptId: replacementAttemptId,
        },
        terminalResult: { kind: 'completed' },
      });
      expect(releasedClaims).toEqual([
        predecessorClaimId,
        replacementClaimId,
      ]);
    });
  });
});
