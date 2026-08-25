import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveExternalSessionOperationTimelineV1,
  type ExternalSessionOperationRecordV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  mutateExternalSessionOperationRecordAtRevision,
  readExternalSessionOperationRecord,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';
import {
  createExternalSessionTakeoverAdmissionActionExecutor,
  isExternalSessionPersistedTakeoverAdmissionReady,
} from './takeoverAdmissionAction';
import {
  buildPersistedTakeoverRetiredMetadata,
  createExternalSessionPersistedTakeoverAdmissionOwner,
} from './persistedTakeoverAdmission';
import type {
  PersistedTakeoverAdmissionOutcome,
} from '@/daemon/spawn/persistedTakeoverAdmission';
import { createPersistedTakeoverAdmissionWaiter } from '@/daemon/spawn/persistedTakeoverAdmission';
import type {
  ExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';
import type {
  ResolvedExternalTakeoverSpawn,
} from '@/api/session/external/takeover/resolveExternalTakeoverSpawnOptions';
import type {
  SpawnSessionOptions,
  SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';

/**
 * The durable record store owns its own on-disk layout, so locate the Account
 * partition that actually holds this operation's row instead of reconstructing
 * a path. A layout change fails loudly here rather than silently locking a
 * directory the store does not use.
 */
async function resolveDurableRecordsDirectory(
  activeServerDir: string,
  operationId: string,
): Promise<string> {
  const root = join(activeServerDir, 'external-session-operations');
  const byAccount = join(root, 'by-account');
  const candidates = [
    ...(await readdir(byAccount).catch(() => [] as string[]))
      .map((accountDirectory) => join(byAccount, accountDirectory, 'records')),
    join(root, 'records'),
  ];
  const key = createHash('sha256').update(operationId, 'utf8').digest('hex');
  for (const candidate of candidates) {
    const found = await access(join(candidate, `${key}.json`))
      .then(() => true, () => false);
    if (found) return candidate;
  }
  throw new Error('durable external-session operation record was not found');
}

function resolvedSpawn(
  options: SpawnSessionOptions,
): ResolvedExternalTakeoverSpawn {
  return {
    options,
    origin: {
      agentId: 'example',
      pluginId: 'com.example.agent',
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

function deferredAdmissionOutcome() {
  let settle!: (outcome: PersistedTakeoverAdmissionOutcome) => void;
  const outcome = new Promise<PersistedTakeoverAdmissionOutcome>((resolve) => {
    settle = resolve;
  });
  return { outcome, settle };
}

const publisherPrecondition = Object.freeze({
  machineId: 'machine-1',
  committedFenceMs: 1,
});

function persistedAdmissionWaiterCorrelation<T extends Readonly<{
  operationId: string;
  attemptId: string;
}>>(input: T): T & Readonly<{ mode: 'persisted' }> {
  return { ...input, mode: 'persisted' };
}

function persistedAdmissionCorrelation<T extends Readonly<{
  sessionId: string;
  operationId: string;
  attemptId: string;
}>>(input: T): T & Readonly<{
  mode: 'persisted';
  publisherPrecondition: typeof publisherPrecondition;
}> {
  return { ...input, mode: 'persisted', publisherPrecondition };
}

function admissionReadyRecord(): ExternalSessionOperationRecordV1 {
  const publication = {
    materializationPublicationId: 'publication-1',
    materializedThroughSourceAt: 10,
    publishedThroughServerSeq: 3,
  };
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
        source: { kind: 'jsonl', contractVersion: 1 as const },
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
    status: 'awaiting_user_resume',
    phase: 'admitting',
    timeline: resolveExternalSessionOperationTimelineV1(request),
    createdAtMs: 1,
    updatedAtMs: 2,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: 'snapshot_complete',
    publication,
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
      operationClaimId: 'released-start-claim',
    },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: {
      linkedSessionRevision: 4,
    },
    fence: { kind: 'none' },
    retryTargetPhase: 'admitting',
  };
}

function runtimeBoundReadyRecord(): ExternalSessionOperationRecordV1 {
  const base = admissionReadyRecord();
  const {
    publication: _publication,
    retryTargetPhase: _retryTargetPhase,
    ...withoutPublication
  } = base;
  const {
    acceptedThroughServerSeq: _acceptedThroughServerSeq,
    acknowledgedBatchId: _acknowledgedBatchId,
    ...checkpoint
  } = base.checkpoint;
  return {
    ...withoutPublication,
    status: 'running',
    phase: 'spawning',
    currentStorageState: 'hosted',
    checkpoint,
    bindings: {
      operationClaimId: 'admission-claim-1',
      targetRuntimeAttemptId: 'attempt-1',
    },
  };
}

function externalLinkedAdmissionReadyRecord(): ExternalSessionOperationRecordV1 {
  const request = {
    v: 1 as const,
    idempotencyKey: 'takeover-external-linked-admission-1',
    sessionId: 'session-external-linked-admission-1',
    source: {
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      qualifiedIdentity: {
        v: 1 as const,
        agent: { pluginId: 'com.example.agent', localId: 'example' },
        source: { kind: 'jsonl', contractVersion: 1 as const },
      },
      linkGeneration: 'link-1',
      sourceGeneration: 'source-1',
      contributionGeneration: 'contribution-1',
    },
    plan: 'takeover' as const,
    targetStorageMode: 'external-linked' as const,
    targetDirectory: '/local/selected/workspace',
    targetRuntimeMode: 'terminal' as const,
  };
  return {
    v: 1,
    operationId: 'external-takeover:external-linked-admission-1',
    revision: 7,
    request,
    status: 'running',
    phase: 'admitting',
    timeline: resolveExternalSessionOperationTimelineV1(request),
    createdAtMs: 1,
    updatedAtMs: 2,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: 'machine_only',
    checkpoint: {
      sourcePagesRead: 0,
      stagedItemCount: 0,
      importedItemCount: 0,
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
      operationClaimId: 'external-linked-admission-claim',
      targetRuntimeAttemptId: 'attempt-a',
    },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: { linkedSessionRevision: 4 },
    fence: { kind: 'none' },
  };
}

describe('external-session persisted takeover admission action', () => {
  it('writes the canonical agentId-only conversion tombstone', () => {
    expect(buildPersistedTakeoverRetiredMetadata({
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source: { kind: 'codexHome', home: 'user' },
        },
      },
      linked: {
        agentId: 'codex',
        remoteSessionId: 'remote-1',
        source: { kind: 'codexHome', home: 'user' },
      },
      importedAtMs: 100,
    })).toEqual({
      externalHistoryImportV1: {
        v: 1,
        agentId: 'codex',
        remoteSessionId: 'remote-1',
        importedAtMs: 100,
        source: { kind: 'codexHome', home: 'user' },
      },
    });
  });

  it('re-establishes follow suspension after daemon restart before rereading snapshot admission authority', async () => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-takeover-follow-recovery-'),
    );
    let followSuspended = false;
    const order: string[] = [];
    const suspendFollow = vi.fn(async () => {
      order.push('suspend');
      followSuspended = true;
    });
    const initial = admissionReadyRecord();
    const running: ExternalSessionOperationRecordV1 = {
      ...initial,
      status: 'running',
      bindings: {
        operationClaimId: 'admission-claim-1',
        targetRuntimeAttemptId: 'attempt-1',
      },
    };
    const linked = {
      rawSession: {
        id: initial.request.sessionId,
        metadataVersion: initial.canonicalOwnerEvidence.linkedSessionRevision,
        seq: initial.publication!.publishedThroughServerSeq,
        pendingVersion: 0,
        pendingCount: 0,
        pendingBlockedCount: 0,
        currentStorageState: 'snapshot_complete',
        acceptedThroughServerSeq: null,
        active: true,
        thinking: false,
      },
      metadata: {},
      sessionPath: '/workspace',
      agentId: 'example',
      machineId: initial.request.source.machineId,
      remoteSessionId: initial.request.source.remoteSessionId,
      linkGeneration: initial.request.source.linkGeneration,
      source: { kind: 'jsonl', path: '/tmp/session.jsonl' },
      codexBackendMode: null,
    } as never;
    try {
      const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
        activeServerDir,
        admissionWaiter: createPersistedTakeoverAdmissionWaiter(),
        isFollowSuspended: () => followSuspended,
        suspendFollow,
        sendHistoricalCommand: vi.fn(),
        loadCurrent: vi.fn(async () => {
          order.push('load');
          expect(followSuspended).toBe(true);
          return {
            linked,
            pluginGeneration:
              initial.request.source.contributionGeneration,
            quiescenceIdentity: 'verified-source-and-process',
          };
        }),
        resolveSpawnOptions: vi.fn(async () => {
          order.push('resolve');
          return {
            ok: true as const,
            value: resolvedSpawn({
              directory: '/workspace',
              existingSessionId: initial.request.sessionId,
            }),
          };
        }),
      });

      await expect(owner.prepareSpawn(running)).resolves.toEqual(
        resolvedSpawn({
          directory: '/workspace',
          existingSessionId: initial.request.sessionId,
        }),
      );
      expect(suspendFollow).toHaveBeenCalledWith({
        sessionId: initial.request.sessionId,
        reason: 'takeover',
      });
      expect(order).toEqual(['suspend', 'load', 'resolve']);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('keeps an explicit external-linked admission rejection precommit', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-external-linked-admission-rejection-',
    ));
    const record = externalLinkedAdmissionReadyRecord();
    const waiter = createPersistedTakeoverAdmissionWaiter();
    const correlation = {
      mode: 'external_linked' as const,
      sessionId: record.request.sessionId,
      operationId: record.operationId,
      attemptId: 'attempt-a',
      publisherPrecondition,
    };
    const admission = waiter.register({
      mode: 'external_linked',
      operationId: record.operationId,
      attemptId: 'attempt-a',
    });
    const sendHistoricalCommand = vi.fn(async () => ({
      v: 1 as const,
      kind: 'error' as const,
      errorCode: 'storage_mode_conflict' as const,
      message: 'The server rejected this exact admission attempt.',
    }));
    const linked = {
      rawSession: {
        id: record.request.sessionId,
        metadataVersion: 4,
        seq: 3,
        pendingVersion: 2,
        pendingCount: 0,
        pendingBlockedCount: 0,
        currentStorageState: 'machine_only',
        acceptedThroughServerSeq: null,
        materializationPublicationId: null,
        materializedThroughSourceAt: null,
        publishedThroughServerSeq: null,
        active: true,
        thinking: false,
      },
      metadata: {},
      sessionPath: '/workspace',
      agentId: 'example',
      machineId: record.request.source.machineId,
      remoteSessionId: record.request.source.remoteSessionId,
      linkGeneration: record.request.source.linkGeneration,
      source: { kind: 'jsonl', path: '/tmp/session.jsonl' },
      codexBackendMode: null,
    } as never;
    try {
      await writeExternalSessionOperationRecord(activeServerDir, record);
      const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
        activeServerDir,
        admissionWaiter: waiter,
        isFollowSuspended: () => true,
        suspendFollow: async () => undefined,
        sendHistoricalCommand,
        loadExternalLinkedCurrent: async () => ({
          linked,
          pluginGeneration: record.request.source.contributionGeneration,
          quiescenceIdentity: 'verified-source-and-process',
          permitsAdmission: true,
          hostedOwnerSessionId: null,
        }),
        nowMs: () => 20,
      });

      await expect(owner.admit(correlation)).rejects.toThrow(
        'external_linked_takeover_admission_storage_mode_conflict',
      );
      await expect(admission.outcome).resolves.toEqual({
        status: 'failed',
        errorCode: 'external_linked_takeover_admission_storage_mode_conflict',
      });
      await expect(owner.reconcileRuntimeBindingFailure(correlation))
        .resolves.toBeNull();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).resolves.toMatchObject({
        status: 'running',
        phase: 'admitting',
        bindings: { targetRuntimeAttemptId: 'attempt-a' },
      });
      expect(sendHistoricalCommand).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('resumes a recoverable admission under a fresh attempt so a late attempt A cannot complete B', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-resume-fresh-attempt-',
    ));
    const waiter = createPersistedTakeoverAdmissionWaiter();
    const release = vi.fn(async () => undefined);
    try {
      // The first Resume episode launched attempt A under its own exclusion
      // claim and left exactly this recoverable row behind when admission
      // failed before commit.
      const base = admissionReadyRecord();
      const {
        acceptedThroughServerSeq: _acceptedThroughServerSeq,
        acknowledgedBatchId: _acknowledgedBatchId,
        ...checkpoint
      } = base.checkpoint;
      const initial: ExternalSessionOperationRecordV1 = {
        ...base,
        status: 'failed',
        checkpoint,
        bindings: {
          operationClaimId: 'attempt-a-claim',
          targetRuntimeAttemptId: 'attempt-a',
        },
        error: {
          code: 'admission_failed',
          message: 'Attempt A admission did not complete.',
          retryable: true,
          occurredAtMs: 3,
        },
      };
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const observed: {
        attemptIdAtSpawn?: string;
        staleAttemptSettled?: boolean;
        freshAttemptSettled?: boolean;
      } = {};
      const spawnSession = vi.fn(async () => {
        const running = await readExternalSessionOperationRecord(
          activeServerDir,
          initial.operationId,
        );
        observed.attemptIdAtSpawn = running?.bindings.targetRuntimeAttemptId;
        // The detached child launched under the released claim still reports
        // `{ mode, operationId, attemptId }` only, so a retained attempt would
        // let it satisfy the waiter this Resume registered.
        observed.staleAttemptSettled = waiter.settle(
          persistedAdmissionWaiterCorrelation({
            operationId: initial.operationId,
            attemptId: 'attempt-a',
          }),
          { status: 'committed' },
        );
        observed.freshAttemptSettled = waiter.settle(
          persistedAdmissionWaiterCorrelation({
            operationId: initial.operationId,
            attemptId: 'attempt-b',
          }),
          { status: 'committed' },
        );
        return {
          type: 'success' as const,
          sessionId: initial.request.sessionId,
        };
      });
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'acquired' as const,
            claim: {
              record: {
                schemaVersion: 1 as const,
                claimId: 'attempt-b-claim',
                ownerId: 'takeover-admission-test',
                request: operationRequest,
                acquiredAtMs: 1,
                renewedAtMs: 1,
                expiresAtMs: 20_001,
              },
              renew: async () => true,
              release,
            },
          })),
        },
        prepareSpawn: async () => resolvedSpawn({
          directory: '/workspace',
          existingSessionId: initial.request.sessionId,
        }),
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter: waiter,
        isHostedAdmissionAvailable: () => true,
        createAttemptId: () => 'attempt-b',
        nowMs: () => 100,
      });

      await expect(executor.resume({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        revision: initial.revision,
      })).resolves.toMatchObject({ ok: true });
      expect(observed).toEqual({
        attemptIdAtSpawn: 'attempt-b',
        staleAttemptSettled: false,
        freshAttemptSettled: true,
      });
      expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
        persistedTakeoverAdmission: {
          mode: 'persisted',
          operationId: initial.operationId,
          attemptId: 'attempt-b',
        },
      }));
      expect((
        await readExternalSessionOperationRecord(
          activeServerDir,
          initial.operationId,
        )
      )?.bindings).toMatchObject({
        operationClaimId: 'attempt-b-claim',
        targetRuntimeAttemptId: 'attempt-b',
      });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('retries hosted-offline with a fresh attempt so late attempt A cannot complete B', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-runtime-retry-'));
    const waiter = createPersistedTakeoverAdmissionWaiter();
    const release = vi.fn(async () => undefined);
    try {
      const base = admissionReadyRecord();
      const {
        publication: _publication,
        ...withoutPublication
      } = base;
      const {
        acceptedThroughServerSeq: _acceptedThroughServerSeq,
        acknowledgedBatchId: _acknowledgedBatchId,
        ...checkpoint
      } = base.checkpoint;
      const initial: ExternalSessionOperationRecordV1 = {
        ...withoutPublication,
        status: 'failed',
        phase: 'spawning',
        currentStorageState: 'hosted',
        checkpoint,
        bindings: {
          operationClaimId: 'attempt-a-claim',
          targetRuntimeAttemptId: 'attempt-a',
        },
        retryTargetPhase: 'spawning',
        error: {
          code: 'spawn_failed',
          message: 'Attempt A exited before runtime binding.',
          retryable: true,
          occurredAtMs: 3,
        },
      };
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const spawnSession = vi.fn(async () => {
        const running = await readExternalSessionOperationRecord(
          activeServerDir,
          initial.operationId,
        );
        expect(running).toMatchObject({
          status: 'running',
          phase: 'spawning',
          bindings: { targetRuntimeAttemptId: 'attempt-b' },
        });
        const completed = await mutateExternalSessionOperationRecordAtRevision(
          activeServerDir,
          initial.operationId,
          running!.revision,
          (fresh) => ({
            ...fresh,
            revision: fresh.revision + 1,
            status: 'completed',
            phase: 'finalizing',
            updatedAtMs: 102,
            terminalResult: { kind: 'completed' },
          }),
        );
        expect(completed.ok).toBe(true);
        expect(waiter.settle(persistedAdmissionWaiterCorrelation({
          operationId: initial.operationId,
          attemptId: 'attempt-a',
        }), { status: 'committed' })).toBe(false);
        expect(waiter.settle(persistedAdmissionWaiterCorrelation({
          operationId: initial.operationId,
          attemptId: 'attempt-b',
        }), { status: 'committed' })).toBe(true);
        return {
          type: 'success' as const,
          sessionId: initial.request.sessionId,
        };
      });
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'acquired' as const,
            claim: {
              record: {
                schemaVersion: 1 as const,
                claimId: 'attempt-b-claim',
                ownerId: 'takeover-admission-test',
                request: operationRequest,
                acquiredAtMs: 1,
                renewedAtMs: 1,
                expiresAtMs: 20_001,
              },
              renew: async () => true,
              release,
            },
          })),
        },
        prepareSpawn: async () => resolvedSpawn({
          directory: '/workspace',
          existingSessionId: initial.request.sessionId,
        }),
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter: waiter,
        isHostedAdmissionAvailable: () => true,
        createAttemptId: () => 'attempt-b',
        nowMs: () => 100,
      });

      await expect(executor.retry({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        revision: initial.revision,
      })).resolves.toMatchObject({
        ok: true,
        progress: {
          status: 'completed',
          phase: 'finalizing',
          currentStorageState: 'hosted',
        },
      });
      expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
        persistedTakeoverAdmission: {
          mode: 'persisted',
          operationId: initial.operationId,
          attemptId: 'attempt-b',
        },
      }));
      const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
        activeServerDir,
        admissionWaiter: waiter,
        isFollowSuspended: () => true,
        suspendFollow: async () => undefined,
        sendHistoricalCommand: vi.fn(),
      });
      await expect(owner.runtimeBound(persistedAdmissionCorrelation({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        attemptId: 'attempt-a',
      }))).rejects.toThrow('persisted_takeover_runtime_bound_operation_mismatch');
      expect((
        await readExternalSessionOperationRecord(
          activeServerDir,
          initial.operationId,
        )
      )?.bindings.targetRuntimeAttemptId).toBe('attempt-b');
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('keeps a retry recoverable when its fenced spawn loses the agent before spawn', async () => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-takeover-runtime-fenced-spawn-'),
    );
    const waiter = createPersistedTakeoverAdmissionWaiter();
    const release = vi.fn(async () => undefined);
    try {
      const base = admissionReadyRecord();
      const {
        publication: _publication,
        ...withoutPublication
      } = base;
      const {
        acceptedThroughServerSeq: _acceptedThroughServerSeq,
        acknowledgedBatchId: _acknowledgedBatchId,
        ...checkpoint
      } = base.checkpoint;
      const initial: ExternalSessionOperationRecordV1 = {
        ...withoutPublication,
        status: 'failed',
        phase: 'spawning',
        currentStorageState: 'hosted',
        checkpoint,
        bindings: {
          operationClaimId: 'attempt-a-claim',
          targetRuntimeAttemptId: 'attempt-a',
        },
        retryTargetPhase: 'spawning',
        error: {
          code: 'spawn_failed',
          message: 'Attempt A exited before runtime binding.',
          retryable: true,
          occurredAtMs: 3,
        },
      };
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
        activeServerDir,
        admissionWaiter: waiter,
        isFollowSuspended: () => true,
        suspendFollow: async () => undefined,
        sendHistoricalCommand: vi.fn(),
        nowMs: () => 102,
      });
      const attemptIds = ['attempt-b'];
      const spawnSession = vi.fn();
      const spawnResolvedTakeoverSessionWithAgentLoss = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false as const,
          code: 'agent_unavailable' as const,
        });
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'acquired' as const,
            claim: {
              record: {
                schemaVersion: 1 as const,
                claimId: `claim-${attemptIds[0]}`,
                ownerId: 'takeover-admission-test',
                request: operationRequest,
                acquiredAtMs: 1,
                renewedAtMs: 1,
                expiresAtMs: 20_001,
              },
              renew: async () => true,
              release,
            },
          })),
        },
        prepareSpawn: async () => resolvedSpawn({
          directory: '/workspace',
          existingSessionId: initial.request.sessionId,
        }),
        reconcileRuntimeBindingFailure: owner.reconcileRuntimeBindingFailure,
        spawnResolvedTakeoverSession: spawnResolvedTakeoverSessionWithAgentLoss,
        spawnSession,
        admissionWaiter: waiter,
        isHostedAdmissionAvailable: () => true,
        createAttemptId: () => attemptIds.shift()!,
        nowMs: () => 100,
      });

      const firstRetry = await executor.retry({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        revision: initial.revision,
      });
      expect(firstRetry).toMatchObject({
        ok: true,
        progress: {
          status: 'failed',
          phase: 'spawning',
          currentStorageState: 'hosted',
          retryTargetPhase: 'spawning',
          error: { code: 'spawn_failed', retryable: true },
        },
      });
      expect(spawnSession).not.toHaveBeenCalled();

      const recoverable = await readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      );
      expect(recoverable).toMatchObject({
        status: 'failed',
        phase: 'spawning',
        currentStorageState: 'hosted',
        bindings: { targetRuntimeAttemptId: 'attempt-b' },
        retryTargetPhase: 'spawning',
      });
      expect(
        isExternalSessionPersistedTakeoverAdmissionReady(recoverable!),
      ).toBe(true);
      await expect(owner.runtimeBound(persistedAdmissionCorrelation({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        attemptId: 'attempt-a',
      }))).rejects.toThrow(
        'persisted_takeover_runtime_bound_operation_mismatch',
      );
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('durably converges an admitted attempt to hosted-offline when runtime_bound times out', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-runtime-timeout-'));
    const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 20 });
    const release = vi.fn(async () => undefined);
    try {
      const initial = admissionReadyRecord();
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
        activeServerDir,
        admissionWaiter: waiter,
        isFollowSuspended: () => true,
        suspendFollow: async () => undefined,
        sendHistoricalCommand: vi.fn(),
        nowMs: () => 102,
      });
      const spawnSession = vi.fn(async () => {
        const admitting = await readExternalSessionOperationRecord(
          activeServerDir,
          initial.operationId,
        );
        const converged = await mutateExternalSessionOperationRecordAtRevision(
          activeServerDir,
          initial.operationId,
          admitting!.revision,
          (fresh) => {
            const {
              publication: _publication,
              retryTargetPhase: _retryTargetPhase,
              error: _error,
              ...withoutPublication
            } = fresh;
            const {
              acceptedThroughServerSeq: _acceptedThroughServerSeq,
              acknowledgedBatchId: _acknowledgedBatchId,
              ...checkpoint
            } = fresh.checkpoint;
            return {
              ...withoutPublication,
              revision: fresh.revision + 1,
              status: 'running',
              phase: 'spawning',
              currentStorageState: 'hosted',
              checkpoint,
              updatedAtMs: 101,
            };
          },
        );
        expect(converged.ok).toBe(true);
        return {
          type: 'success' as const,
          sessionId: initial.request.sessionId,
        };
      });
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'acquired' as const,
            claim: {
              record: {
                schemaVersion: 1 as const,
                claimId: 'resume-claim-1',
                ownerId: 'takeover-admission-test',
                request: operationRequest,
                acquiredAtMs: 1,
                renewedAtMs: 1,
                expiresAtMs: 20_001,
              },
              renew: async () => true,
              release,
            },
          })),
        },
        prepareSpawn: async () => resolvedSpawn({
          directory: '/workspace',
          existingSessionId: initial.request.sessionId,
        }),
        reconcileRuntimeBindingFailure: owner.reconcileRuntimeBindingFailure,
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter: waiter,
        isHostedAdmissionAvailable: () => true,
        createAttemptId: () => 'attempt-1',
        nowMs: () => 100,
      });

      await expect(executor.resume({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        revision: initial.revision,
      })).resolves.toMatchObject({
        ok: true,
        progress: {
          status: 'failed',
          phase: 'spawning',
          currentStorageState: 'hosted',
          retryTargetPhase: 'spawning',
          error: { code: 'spawn_failed', retryable: true },
        },
      });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      )).resolves.toMatchObject({
        status: 'failed',
        phase: 'spawning',
        currentStorageState: 'hosted',
        error: { code: 'spawn_failed' },
      });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('keeps runtime-bound success authoritative when terminal staging cleanup outlives the admission timeout', async () => {
    vi.useFakeTimers();
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-takeover-runtime-cleanup-timeout-'),
    );
    let releaseCleanup!: () => void;
    let announceCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      announceCleanupStarted = resolve;
    });
    const cleanupBlocked = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupTerminalStaging = vi.fn(async () => {
      announceCleanupStarted();
      await cleanupBlocked;
      return 'cleaned' as const;
    });
    let runtimeBound: Promise<void> | null = null;
    try {
      const initial = runtimeBoundReadyRecord();
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 20 });
      const admission = waiter.register(persistedAdmissionWaiterCorrelation({
        operationId: initial.operationId,
        attemptId: 'attempt-1',
      }));
      const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
        activeServerDir,
        admissionWaiter: waiter,
        isFollowSuspended: () => true,
        suspendFollow: async () => undefined,
        sendHistoricalCommand: vi.fn(),
        cleanupTerminalStaging,
        nowMs: () => 102,
      });

      let runtimeBoundSettled = false;
      runtimeBound = owner.runtimeBound(persistedAdmissionCorrelation({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        attemptId: 'attempt-1',
      })).finally(() => {
        runtimeBoundSettled = true;
      });
      await cleanupStarted;
      expect(cleanupTerminalStaging).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(20);

      await expect(admission.outcome).resolves.toEqual({ status: 'committed' });
      expect(runtimeBoundSettled).toBe(false);
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      )).resolves.toMatchObject({
        status: 'completed',
        phase: 'finalizing',
        currentStorageState: 'hosted',
        bindings: { targetRuntimeAttemptId: 'attempt-1' },
        terminalResult: { kind: 'completed' },
      });
      await expect(owner.runtimeBound(persistedAdmissionCorrelation({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        attemptId: 'attempt-1',
      }))).resolves.toBeUndefined();

      releaseCleanup();
      await expect(runtimeBound).resolves.toBeUndefined();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      )).resolves.not.toMatchObject({
        status: 'failed',
        error: { code: 'spawn_failed' },
      });
    } finally {
      releaseCleanup();
      await runtimeBound?.catch(() => undefined);
      await rm(activeServerDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it('keeps runtime-bound success authoritative when its request aborts during terminal staging cleanup', async () => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-takeover-runtime-cleanup-abort-'),
    );
    let releaseCleanup!: () => void;
    let announceCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      announceCleanupStarted = resolve;
    });
    const cleanupBlocked = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupTerminalStaging = vi.fn(async () => {
      announceCleanupStarted();
      await cleanupBlocked;
      return 'cleaned' as const;
    });
    let runtimeBound: Promise<void> | null = null;
    try {
      const initial = runtimeBoundReadyRecord();
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 5_000 });
      const admission = waiter.register(persistedAdmissionWaiterCorrelation({
        operationId: initial.operationId,
        attemptId: 'attempt-1',
      }));
      const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
        activeServerDir,
        admissionWaiter: waiter,
        isFollowSuspended: () => true,
        suspendFollow: async () => undefined,
        sendHistoricalCommand: vi.fn(),
        cleanupTerminalStaging,
        nowMs: () => 102,
      });
      const controller = new AbortController();
      let runtimeBoundSettled = false;
      runtimeBound = owner.runtimeBound(persistedAdmissionCorrelation({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        attemptId: 'attempt-1',
        signal: controller.signal,
      })).finally(() => {
        runtimeBoundSettled = true;
      });
      await cleanupStarted;
      expect(cleanupTerminalStaging).toHaveBeenCalledOnce();

      controller.abort();

      await expect(admission.outcome).resolves.toEqual({ status: 'committed' });
      expect(runtimeBoundSettled).toBe(false);
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      )).resolves.toMatchObject({
        status: 'completed',
        phase: 'finalizing',
        currentStorageState: 'hosted',
        bindings: { targetRuntimeAttemptId: 'attempt-1' },
        terminalResult: { kind: 'completed' },
      });
      await expect(owner.runtimeBound(persistedAdmissionCorrelation({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        attemptId: 'attempt-1',
      }))).resolves.toBeUndefined();

      releaseCleanup();
      await expect(runtimeBound).resolves.toBeUndefined();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      )).resolves.not.toMatchObject({
        status: 'failed',
        error: { code: 'spawn_failed' },
      });
    } finally {
      releaseCleanup();
      await runtimeBound?.catch(() => undefined);
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('keeps the imported snapshot authoritative when spawn fails before admit', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-pre-admit-spawn-failure-'));
    const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 5_000 });
    const release = vi.fn(async () => undefined);
    try {
      const initial = admissionReadyRecord();
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const owner = createExternalSessionPersistedTakeoverAdmissionOwner({
        activeServerDir,
        admissionWaiter: waiter,
        isFollowSuspended: () => true,
        suspendFollow: async () => undefined,
        sendHistoricalCommand: vi.fn(),
        nowMs: () => 102,
      });
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'acquired' as const,
            claim: {
              record: {
                schemaVersion: 1 as const,
                claimId: 'resume-claim-1',
                ownerId: 'takeover-admission-test',
                request: operationRequest,
                acquiredAtMs: 1,
                renewedAtMs: 1,
                expiresAtMs: 20_001,
              },
              renew: async () => true,
              release,
            },
          })),
        },
        prepareSpawn: async () => resolvedSpawn({
          directory: '/workspace',
          existingSessionId: initial.request.sessionId,
        }),
        reconcileRuntimeBindingFailure: owner.reconcileRuntimeBindingFailure,
        spawnResolvedTakeoverSession,
        spawnSession: vi.fn(async () => ({
          type: 'error' as const,
          errorCode: 'SPAWN_FAILED' as const,
          errorMessage: 'child did not start',
        })),
        admissionWaiter: waiter,
        isHostedAdmissionAvailable: () => true,
        createAttemptId: () => 'attempt-1',
        nowMs: () => 100,
      });

      await expect(executor.resume({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        revision: initial.revision,
      })).resolves.toMatchObject({
        ok: true,
        progress: {
          status: 'failed',
          phase: 'admitting',
          currentStorageState: 'snapshot_complete',
          retryTargetPhase: 'admitting',
          error: { code: 'admission_failed', retryable: true },
        },
      });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      )).resolves.toMatchObject({
        status: 'failed',
        phase: 'admitting',
        currentStorageState: 'snapshot_complete',
        error: { code: 'admission_failed' },
      });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('returns internal_error without effects when the canonical admission record is corrupt', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-admission-corrupt-'));
    try {
      const initial = admissionReadyRecord();
      const recordKey = createHash('sha256')
        .update(initial.operationId, 'utf8')
        .digest('hex');
      const recordsDir = join(
        activeServerDir,
        'external-session-operations',
        'by-account',
        `sub-${createHash('sha256').update('vitest', 'utf8').digest('hex').slice(0, 32)}`,
        'records',
      );
      await mkdir(recordsDir, { recursive: true });
      await writeFile(join(recordsDir, `${recordKey}.json`), '{"v":', 'utf8');
      const acquireImplementation: ExternalSessionOperationExclusion['acquire'] =
        async () => ({
          status: 'conflict',
          reason: 'active_operation',
          active: null,
        });
      const acquire = vi.fn(acquireImplementation);
      const prepareSpawn = vi.fn();
      const spawnSession = vi.fn();
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        prepareSpawn,
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter: {
          isPending: vi.fn(() => false),
          register: vi.fn(),
          settle: vi.fn(),
        },
        isHostedAdmissionAvailable: () => true,
      });

      await expect(executor.resume({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        revision: initial.revision,
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'internal_error' },
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(prepareSpawn).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('routes an exact admission-ready Resume into one attempt-scoped spawn', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-admission-'));
    const release = vi.fn(async () => undefined);
    const admission = deferredAdmissionOutcome();
    const cancelAdmissionWait = vi.fn();
    const spawnSession = vi.fn(async () => {
      throw new Error('spawn response was ambiguous');
    });
    try {
      const base = admissionReadyRecord();
      const {
        acceptedThroughServerSeq: _acceptedThroughServerSeq,
        acknowledgedBatchId: _acknowledgedBatchId,
        ...checkpoint
      } = base.checkpoint;
      const initial: ExternalSessionOperationRecordV1 = {
        ...base,
        status: 'failed',
        checkpoint,
        error: {
          code: 'admission_failed',
          message: 'Known precommit admission failure.',
          retryable: true,
          occurredAtMs: 3,
        },
      };
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'acquired' as const,
            claim: {
              record: {
                schemaVersion: 1 as const,
                claimId: 'resume-claim-1',
                ownerId: 'takeover-admission-test',
                request: operationRequest,
                acquiredAtMs: 1,
                renewedAtMs: 1,
                expiresAtMs: 20_001,
              },
              renew: async () => true,
              release,
            },
          })),
        },
        prepareSpawn: async () => resolvedSpawn({
          directory: '/workspace',
          existingSessionId: 'session-1',
        }),
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter: {
          isPending: vi.fn(() => true),
          register: vi.fn(() => ({
            outcome: admission.outcome,
            readOutcome: vi.fn(() => null),
            cancel: cancelAdmissionWait,
          })),
          settle: vi.fn(),
        },
        isHostedAdmissionAvailable: () => true,
        createAttemptId: () => 'attempt-1',
        nowMs: () => 100,
      });

      let settled = false;
      const resultPromise = executor.resume({
        sessionId: 'session-1',
        operationId: initial.operationId,
        revision: initial.revision,
      }).finally(() => {
        settled = true;
      });

      await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledOnce());
      expect(spawnSession).toHaveBeenCalledWith({
        directory: '/workspace',
        existingSessionId: 'session-1',
        transcriptStorage: 'persisted',
        persistedTakeoverAdmission: {
          mode: 'persisted',
          operationId: initial.operationId,
          attemptId: 'attempt-1',
        },
      });
      expect(settled).toBe(false);
      expect(release).not.toHaveBeenCalled();
      admission.settle({
        status: 'failed',
        errorCode: 'persisted_takeover_admission_failed',
      });
      const result = await resultPromise;
      expect(result).toMatchObject({
        ok: true,
        progress: {
          status: 'failed',
          phase: 'admitting',
          retryTargetPhase: 'admitting',
          error: { code: 'admission_failed', retryable: true },
        },
      });
      const failed = await readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      );
      expect(failed?.bindings).toMatchObject({
        operationClaimId: 'resume-claim-1',
        targetRuntimeAttemptId: 'attempt-1',
      });
      expect(release).toHaveBeenCalledOnce();
      expect(cancelAdmissionWait).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  // POSIX-only: forcing the durable record store to reject a write needs
  // directory permissions, and Windows `chmod` cannot express them.
  it.skipIf(process.platform === 'win32')('refuses to report a stranded precommit admission as recovered when its transition cannot commit', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-admission-recovery-unresolved-',
    ));
    const release = vi.fn(async () => undefined);
    const initial = admissionReadyRecord();
    let lockedRecordsDirectory: string | null = null;
    try {
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const spawnSession = vi.fn(async () => {
        // The operation is committed to `running`/`admitting` for this exact
        // attempt by now; make the durable store reject the recovery write.
        lockedRecordsDirectory = await resolveDurableRecordsDirectory(
          activeServerDir,
          initial.operationId,
        );
        await chmod(lockedRecordsDirectory, 0o500);
        return {
          type: 'error' as const,
          errorCode: 'SPAWN_FAILED' as const,
          errorMessage: 'child did not start',
        };
      });
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'acquired' as const,
            claim: {
              record: {
                schemaVersion: 1 as const,
                claimId: 'resume-claim-1',
                ownerId: 'takeover-admission-test',
                request: operationRequest,
                acquiredAtMs: 1,
                renewedAtMs: 1,
                expiresAtMs: 20_001,
              },
              renew: async () => true,
              release,
            },
          })),
        },
        prepareSpawn: async () => resolvedSpawn({
          directory: '/workspace',
          existingSessionId: initial.request.sessionId,
        }),
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter: {
          isPending: vi.fn(() => true),
          register: vi.fn(() => ({
            outcome: new Promise<PersistedTakeoverAdmissionOutcome>(() => undefined),
            readOutcome: vi.fn(() => null),
            cancel: vi.fn(),
          })),
          settle: vi.fn(),
        },
        isHostedAdmissionAvailable: () => true,
        createAttemptId: () => 'attempt-1',
        nowMs: () => 100,
      });

      // The claim is released and the waiter cancelled in the same turn, so an
      // operation still parked at `running`/`admitting` is stranded, not
      // recovered, and must never be published as a successful outcome.
      await expect(executor.resume({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        revision: initial.revision,
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'internal_error' },
      });
      await chmod(lockedRecordsDirectory!, 0o700);
      lockedRecordsDirectory = null;
      expect(await readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      )).toMatchObject({ status: 'running', phase: 'admitting' });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      if (lockedRecordsDirectory) {
        await chmod(lockedRecordsDirectory, 0o700).catch(() => undefined);
      }
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('recovers a definitively rejected precommit admission that already advanced the operation revision', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-admission-precommit-rejection-',
    ));
    const release = vi.fn(async () => undefined);
    const admission = deferredAdmissionOutcome();
    const initial = admissionReadyRecord();
    // Reproduces the admission owner's own committed authority refresh: before
    // sending the Server command it CASes `record.revision -> revision + 1`
    // with refreshed transcript/pending authority evidence. Any recovery that
    // marks failure at the action's pre-preparation revision is already stale.
    const spawnSession = vi.fn(async () => {
      const latest = await readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      );
      if (!latest) throw new Error('expected an admitting operation record');
      const prepared = await mutateExternalSessionOperationRecordAtRevision(
        activeServerDir,
        latest.operationId,
        latest.revision,
        (fresh) => ({
          ...fresh,
          revision: fresh.revision + 1,
          canonicalOwnerEvidence: {
            ...fresh.canonicalOwnerEvidence,
            linkedSessionRevision: 5,
            transcriptAuthorityRevision: 9,
            pendingAdmissionRevision: 6,
          },
          updatedAtMs: 100,
        }),
      );
      if (!prepared.ok) throw new Error('expected prepared authority commit');
      return { type: 'success' as const, sessionId: 'session-1' };
    });
    try {
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'acquired' as const,
            claim: {
              record: {
                schemaVersion: 1 as const,
                claimId: 'resume-claim-1',
                ownerId: 'takeover-admission-test',
                request: operationRequest,
                acquiredAtMs: 1,
                renewedAtMs: 1,
                expiresAtMs: 20_001,
              },
              renew: async () => true,
              release,
            },
          })),
        },
        prepareSpawn: async () => resolvedSpawn({
          directory: '/workspace',
          existingSessionId: 'session-1',
        }),
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter: {
          isPending: vi.fn(() => true),
          register: vi.fn(() => ({
            outcome: admission.outcome,
            readOutcome: vi.fn(() => null),
            cancel: vi.fn(),
          })),
          settle: vi.fn(),
        },
        isHostedAdmissionAvailable: () => true,
        createAttemptId: () => 'attempt-1',
        nowMs: () => 100,
      });

      const resultPromise = executor.resume({
        sessionId: 'session-1',
        operationId: initial.operationId,
        revision: initial.revision,
      });
      await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledOnce());
      admission.settle({
        status: 'failed',
        errorCode: 'persisted_takeover_admission_storage_mode_conflict',
      });

      await expect(resultPromise).resolves.toMatchObject({
        ok: true,
        progress: {
          status: 'failed',
          phase: 'admitting',
          retryTargetPhase: 'admitting',
          error: { code: 'admission_failed', retryable: true },
        },
      });
      const recovered = await readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      );
      expect(recovered).toMatchObject({
        status: 'failed',
        phase: 'admitting',
        retryTargetPhase: 'admitting',
        error: { code: 'admission_failed', retryable: true },
        bindings: { targetRuntimeAttemptId: 'attempt-1' },
      });
      // The refreshed authority evidence stays intact so the operation stays
      // eligible for the canonical authority-reconciliation Retry route.
      expect(recovered?.canonicalOwnerEvidence).toMatchObject({
        transcriptAuthorityRevision: 9,
        pendingAdmissionRevision: 6,
      });
      expect(isExternalSessionPersistedTakeoverAdmissionReady(recovered!))
        .toBe(true);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('keeps the claim until delayed strict admission fails after ordinary spawn readiness', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-admission-'));
    const admission = deferredAdmissionOutcome();
    const release = vi.fn(async () => undefined);
    const cancelAdmissionWait = vi.fn();
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'session-1',
    }));
    try {
      const initial = admissionReadyRecord();
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'acquired' as const,
            claim: {
              record: {
                schemaVersion: 1 as const,
                claimId: 'resume-claim-1',
                ownerId: 'takeover-admission-test',
                request: operationRequest,
                acquiredAtMs: 1,
                renewedAtMs: 1,
                expiresAtMs: 20_001,
              },
              renew: async () => true,
              release,
            },
          })),
        },
        prepareSpawn: async () => resolvedSpawn({
          directory: '/workspace',
          existingSessionId: 'session-1',
        }),
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter: {
          isPending: vi.fn(() => true),
          register: vi.fn(() => ({
            outcome: admission.outcome,
            readOutcome: vi.fn(() => null),
            cancel: cancelAdmissionWait,
          })),
          settle: vi.fn(),
        },
        isHostedAdmissionAvailable: () => true,
        createAttemptId: () => 'attempt-1',
        nowMs: () => 100,
      });

      let settled = false;
      const resultPromise = executor.resume({
        sessionId: 'session-1',
        operationId: initial.operationId,
        revision: initial.revision,
      }).finally(() => {
        settled = true;
      });

      await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      expect(release).not.toHaveBeenCalled();

      admission.settle({
        status: 'failed',
        errorCode: 'persisted_takeover_admission_failed',
      });

      await expect(resultPromise).resolves.toMatchObject({
        ok: true,
        progress: {
          status: 'failed',
          phase: 'admitting',
          retryTargetPhase: 'admitting',
          error: { code: 'admission_failed', retryable: true },
        },
      });
      expect(release).toHaveBeenCalledOnce();
      expect(cancelAdmissionWait).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('rereads the server-converged spawning row after strict admission commits', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-admission-'));
    const waiter = createPersistedTakeoverAdmissionWaiter();
    const release = vi.fn(async () => undefined);
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'session-1',
    }));
    try {
      const initial = admissionReadyRecord();
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'acquired' as const,
            claim: {
              record: {
                schemaVersion: 1 as const,
                claimId: 'resume-claim-1',
                ownerId: 'takeover-admission-test',
                request: operationRequest,
                acquiredAtMs: 1,
                renewedAtMs: 1,
                expiresAtMs: 20_001,
              },
              renew: async () => true,
              release,
            },
          })),
        },
        prepareSpawn: async () => resolvedSpawn({
          directory: '/workspace',
          existingSessionId: 'session-1',
        }),
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter: waiter,
        isHostedAdmissionAvailable: () => true,
        createAttemptId: () => 'attempt-1',
        nowMs: () => 100,
      });
      const resultPromise = executor.resume({
        sessionId: 'session-1',
        operationId: initial.operationId,
        revision: initial.revision,
      });

      await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledOnce());
      const admitting = await readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      );
      expect(admitting).not.toBeNull();
      const converged = await mutateExternalSessionOperationRecordAtRevision(
        activeServerDir,
        initial.operationId,
        admitting!.revision,
        (fresh) => {
          const { publication: _publication, ...withoutPublication } = fresh;
          return {
            ...withoutPublication,
            revision: fresh.revision + 1,
            phase: 'spawning',
            currentStorageState: 'hosted',
            updatedAtMs: 101,
          };
        },
      );
      expect(converged.ok).toBe(true);
      waiter.settle(persistedAdmissionWaiterCorrelation({
        operationId: initial.operationId,
        attemptId: 'attempt-1',
      }), { status: 'committed' });

      await expect(resultPromise).resolves.toMatchObject({
        ok: true,
        progress: {
          revision: initial.revision + 2,
          status: 'running',
          phase: 'spawning',
          currentStorageState: 'hosted',
        },
      });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('does not race retry recovery against exact admission after the local claim is lost', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-admission-'));
    const waiter = createPersistedTakeoverAdmissionWaiter();
    const release = vi.fn(async () => undefined);
    let spawnStarted = false;
    const renew = vi.fn(async () => !spawnStarted);
    const spawnSession = vi.fn(async () => {
      spawnStarted = true;
      return {
        type: 'success' as const,
        sessionId: 'session-1',
      };
    });
    try {
      const initial = admissionReadyRecord();
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'acquired' as const,
            claim: {
              record: {
                schemaVersion: 1 as const,
                claimId: 'resume-claim-1',
                ownerId: 'takeover-admission-test',
                request: operationRequest,
                acquiredAtMs: 1,
                renewedAtMs: 1,
                expiresAtMs: 20_001,
              },
              renew,
              release,
            },
          })),
        },
        prepareSpawn: async () => resolvedSpawn({
          directory: '/workspace',
          existingSessionId: 'session-1',
        }),
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter: waiter,
        isHostedAdmissionAvailable: () => true,
        createAttemptId: () => 'attempt-1',
        nowMs: () => 100,
        claimRenewalIntervalMs: 1,
      });
      let resultSettled = false;
      const resultPromise = executor.resume({
        sessionId: 'session-1',
        operationId: initial.operationId,
        revision: initial.revision,
      }).finally(() => {
        resultSettled = true;
      });

      await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(renew).toHaveBeenCalled());
      const stillAdmitting = await readExternalSessionOperationRecord(
        activeServerDir,
        initial.operationId,
      );
      expect(stillAdmitting).toMatchObject({
        revision: initial.revision + 1,
        status: 'running',
        phase: 'admitting',
        currentStorageState: 'snapshot_complete',
      });
      expect(resultSettled).toBe(false);

      const converged = await mutateExternalSessionOperationRecordAtRevision(
        activeServerDir,
        initial.operationId,
        stillAdmitting!.revision,
        (fresh) => {
          const { publication: _publication, ...withoutPublication } = fresh;
          return {
            ...withoutPublication,
            revision: fresh.revision + 1,
            phase: 'spawning',
            currentStorageState: 'hosted',
            updatedAtMs: 101,
          };
        },
      );
      expect(converged.ok).toBe(true);
      waiter.settle(persistedAdmissionWaiterCorrelation({
        operationId: initial.operationId,
        attemptId: 'attempt-1',
      }), { status: 'committed' });

      await expect(resultPromise).resolves.toMatchObject({
        ok: true,
        progress: {
          revision: initial.revision + 2,
          status: 'running',
          phase: 'spawning',
          currentStorageState: 'hosted',
        },
      });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it.each([
    'publish',
    'prepare_spawn',
    'register_wait',
    'spawn',
  ] as const)(
    'restores a retryable admission row when %s fails after the attempt commit',
    async (failureStage) => {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-admission-'));
      const release = vi.fn(async () => undefined);
      const cancelAdmissionWait = vi.fn();
      const publishProgress = vi.fn(async () => undefined);
      const prepareSpawn = vi.fn(async () => resolvedSpawn({
        directory: '/workspace',
        existingSessionId: 'session-1',
      }));
      const registerAdmissionWait = vi.fn(() => ({
        outcome: Promise.resolve<PersistedTakeoverAdmissionOutcome>({
          status: 'failed',
          errorCode: 'persisted_takeover_admission_failed',
        }),
        readOutcome: vi.fn(() => (
          failureStage === 'spawn'
            ? {
                status: 'failed' as const,
                errorCode: 'persisted_takeover_admission_failed',
              }
            : null
        )),
        cancel: cancelAdmissionWait,
      }));
      const spawnSession = vi.fn(async () => ({
        type: 'success' as const,
        sessionId: 'session-1',
      }));
      if (failureStage === 'publish') {
        publishProgress.mockRejectedValueOnce(new Error('publish failed'));
      } else if (failureStage === 'prepare_spawn') {
        prepareSpawn.mockRejectedValueOnce(new Error('prepare failed'));
      } else if (failureStage === 'register_wait') {
        registerAdmissionWait.mockImplementationOnce(() => {
          throw new Error('wait registration failed');
        });
      } else {
        spawnSession.mockRejectedValueOnce(new Error('spawn outcome ambiguous'));
      }
      try {
        const initial = admissionReadyRecord();
        await writeExternalSessionOperationRecord(activeServerDir, initial);
        const executor = createExternalSessionTakeoverAdmissionActionExecutor({
          activeServerDir,
          operationExclusion: {
            acquire: vi.fn(async (operationRequest) => ({
              status: 'acquired' as const,
              claim: {
                record: {
                  schemaVersion: 1 as const,
                  claimId: 'resume-claim-1',
                  ownerId: 'takeover-admission-test',
                  request: operationRequest,
                  acquiredAtMs: 1,
                  renewedAtMs: 1,
                  expiresAtMs: 20_001,
              },
              renew: async () => true,
              release,
            },
          })),
          },
          prepareSpawn,
          spawnResolvedTakeoverSession,
          spawnSession,
          admissionWaiter: {
            isPending: vi.fn(() => true),
            register: registerAdmissionWait,
            settle: vi.fn(),
          },
          isHostedAdmissionAvailable: () => true,
          publishProgress,
          createAttemptId: () => 'attempt-1',
          nowMs: () => 100,
        });

        const result = await executor.resume({
          sessionId: 'session-1',
          operationId: initial.operationId,
          revision: initial.revision,
        });

        expect(result).toMatchObject({
          ok: true,
          progress: {
            revision: initial.revision + 2,
            status: 'failed',
            phase: 'admitting',
            retryTargetPhase: 'admitting',
            error: { code: 'admission_failed', retryable: true },
          },
        });
        const failed = await readExternalSessionOperationRecord(
          activeServerDir,
          initial.operationId,
        );
        expect(failed).toMatchObject({
          revision: initial.revision + 2,
          status: 'failed',
          phase: 'admitting',
          retryTargetPhase: 'admitting',
          bindings: {
            operationClaimId: 'resume-claim-1',
            targetRuntimeAttemptId: 'attempt-1',
          },
          error: { code: 'admission_failed', retryable: true },
        });
        expect(publishProgress).toHaveBeenLastCalledWith({
          sessionId: 'session-1',
          progress: expect.objectContaining({
            revision: initial.revision + 2,
            status: 'failed',
          }),
        });
        expect(release).toHaveBeenCalledOnce();
      } finally {
        await rm(activeServerDir, { recursive: true, force: true });
      }
    },
  );

  it('returns upgrade_required with zero effects when current hosted admission is unavailable', async () => {
    const acquire = vi.fn();
    const prepareSpawn = vi.fn();
    const spawnSession = vi.fn();
    const registerAdmissionWait = vi.fn();
    const publishProgress = vi.fn();
    const executor = createExternalSessionTakeoverAdmissionActionExecutor({
      activeServerDir: '/unused',
      operationExclusion: { acquire },
      prepareSpawn,
      spawnResolvedTakeoverSession,
      spawnSession,
      admissionWaiter: {
        isPending: vi.fn(() => false),
        register: registerAdmissionWait,
        settle: vi.fn(),
      },
      isHostedAdmissionAvailable: () => false,
      publishProgress,
    });

    await expect(executor.resume({
      sessionId: 'session-1',
      operationId: 'external-takeover:operation-1',
      revision: 7,
    })).resolves.toEqual({
      ok: false,
      error: {
        code: 'upgrade_required',
        message: 'Persisted takeover admission requires a newer server.',
      },
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(prepareSpawn).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
    expect(registerAdmissionWait).not.toHaveBeenCalled();
    expect(publishProgress).not.toHaveBeenCalled();
  });

  it('keeps an unavailable authority reconciliation recoverable with zero admission effects', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-admission-unresolved-'));
    const acquire = vi.fn();
    const prepareSpawn = vi.fn();
    const spawnSession = vi.fn();
    const registerAdmissionWait = vi.fn();
    const publishProgress = vi.fn();
    try {
      const base = admissionReadyRecord();
      const {
        acceptedThroughServerSeq: _acceptedThroughServerSeq,
        acknowledgedBatchId: _acknowledgedBatchId,
        ...checkpoint
      } = base.checkpoint;
      const initial: ExternalSessionOperationRecordV1 = {
        ...base,
        status: 'failed',
        checkpoint,
        canonicalOwnerEvidence: {
          ...base.canonicalOwnerEvidence,
          transcriptAuthorityRevision: 3,
          pendingAdmissionRevision: 11,
        },
        fence: { kind: 'none' },
        error: {
          code: 'admission_failed',
          message: 'Admission outcome is unresolved.',
          retryable: true,
          occurredAtMs: 3,
        },
      };
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        prepareSpawn,
        reconcileAuthority: async () => null,
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter: {
          isPending: vi.fn(() => false),
          register: registerAdmissionWait,
          settle: vi.fn(),
        },
        isHostedAdmissionAvailable: () => true,
        publishProgress,
      });

      await expect(executor.resume({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        revision: initial.revision,
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'source_unavailable' },
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(prepareSpawn).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
      expect(registerAdmissionWait).not.toHaveBeenCalled();
      expect(publishProgress).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('converges an explicit authority action to hosted offline before any admission effects', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-admission-hosted-reconcile-'));
    const acquire = vi.fn();
    const prepareSpawn = vi.fn();
    const spawnSession = vi.fn();
    try {
      const base = admissionReadyRecord();
      const {
        acceptedThroughServerSeq: _acceptedThroughServerSeq,
        acknowledgedBatchId: _acknowledgedBatchId,
        ...checkpoint
      } = base.checkpoint;
      const initial: ExternalSessionOperationRecordV1 = {
        ...base,
        status: 'failed',
        checkpoint,
        canonicalOwnerEvidence: {
          ...base.canonicalOwnerEvidence,
          transcriptAuthorityRevision: 3,
          pendingAdmissionRevision: 11,
        },
        fence: { kind: 'none' },
        error: {
          code: 'admission_failed',
          message: 'Admission outcome is unresolved.',
          retryable: true,
          occurredAtMs: 3,
        },
      };
      const {
        publication: _publication,
        ...withoutPublication
      } = initial;
      const hosted: ExternalSessionOperationRecordV1 = {
        ...withoutPublication,
        revision: initial.revision + 1,
        status: 'failed',
        phase: 'spawning',
        currentStorageState: 'hosted',
        checkpoint,
        fence: { kind: 'none' },
        retryTargetPhase: 'spawning',
        error: {
          code: 'spawn_failed',
          message: 'Admitted runtime remains offline.',
          retryable: true,
          occurredAtMs: 4,
        },
      };
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const reconcileAuthority = vi.fn(async () => hosted);
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        prepareSpawn,
        reconcileAuthority,
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter: createPersistedTakeoverAdmissionWaiter(),
        isHostedAdmissionAvailable: () => true,
      });

      await expect(executor.resume({
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        revision: initial.revision,
      })).resolves.toMatchObject({
        ok: true,
        progress: {
          status: 'failed',
          phase: 'spawning',
          currentStorageState: 'hosted',
        },
      });
      expect(reconcileAuthority).toHaveBeenCalledOnce();
      expect(acquire).not.toHaveBeenCalled();
      expect(prepareSpawn).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('refuses validating takeover records without spawning or inventing skipped work', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-admission-'));
    const spawnSession = vi.fn();
    try {
      const initial = {
        ...admissionReadyRecord(),
        phase: 'validating' as const,
        retryTargetPhase: 'validating' as const,
        checkpoint: {
          sourcePagesRead: 0,
          stagedItemCount: 0,
          importedItemCount: 0,
          requiredItemFailures: {
            total: 0,
            record: 0,
            media: 0,
            conversion: 0,
            diagnosticsTruncated: false,
            diagnostics: [],
          },
        },
      };
      await writeExternalSessionOperationRecord(activeServerDir, initial);
      const executor = createExternalSessionTakeoverAdmissionActionExecutor({
        activeServerDir,
        operationExclusion: { acquire: vi.fn() },
        prepareSpawn: vi.fn(),
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter: {
          isPending: vi.fn(() => false),
          register: vi.fn(),
          settle: vi.fn(),
        },
        isHostedAdmissionAvailable: () => true,
      });

      const result = await executor.resume({
        sessionId: 'session-1',
        operationId: initial.operationId,
        revision: initial.revision,
      });

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'invalid_state',
          message: 'Persisted takeover is not ready for runtime admission.',
        },
      });
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
