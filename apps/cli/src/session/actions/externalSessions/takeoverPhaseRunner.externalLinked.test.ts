import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveExternalSessionOperationTimelineV1,
  type ExternalSessionOperationRecordV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  createExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';
import {
  mutateExternalSessionOperationRecordAtRevision,
  readExternalSessionOperationRecord,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';
import { createPersistedTakeoverAdmissionWaiter } from '@/daemon/spawn/persistedTakeoverAdmission';
import {
  repairExternalSessionOperationProgressProjections,
} from './operationProgressPublisher';
import {
  createExternalSessionExternalLinkedTakeoverPhaseRunner,
} from './takeoverPhaseRunner';
import {
  ExternalSessionPersistedTakeoverPreflightError,
} from './materializeAction';
import {
  createExternalSessionPersistedTakeoverAdmissionOwner,
} from './persistedTakeoverAdmission';

function externalLinkedRecord(): ExternalSessionOperationRecordV1 {
  const request = {
    v: 1 as const,
    idempotencyKey: 'takeover-external-1',
    sessionId: 'session-1',
    source: {
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      qualifiedIdentity: {
        v: 1 as const,
        agent: { pluginId: 'example.plugin', localId: 'example' },
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
    operationId: 'external-takeover:external-1',
    revision: 0,
    request,
    status: 'awaiting_user_resume',
    phase: 'validating',
    timeline: resolveExternalSessionOperationTimelineV1(request),
    createdAtMs: 1,
    updatedAtMs: 1,
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
    bindings: { operationClaimId: 'private-claim-1' },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: {
      linkedSessionRevision: 1,
      sourceSnapshotEvidenceRef: 'source-cursor-1',
    },
    fence: { kind: 'none' },
    retryTargetPhase: 'validating',
  };
}

const noCommittedRuntimeBindingFailure = async (): Promise<
  ExternalSessionOperationRecordV1 | null
> => null;

describe('external-linked durable takeover continuation', () => {
  it('fails unsupported writer safety before durable advance, exclusion, follow suspension, or spawn', async () => {
    const writerSafety = 'unsupported' as const;
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-external-linked-takeover-'),
    );
    const record = externalLinkedRecord();
    const acquire = vi.fn();
    const loadCurrent = vi.fn();
    const suspendSession = vi.fn();
    const spawnSession = vi.fn();
    const publishProgress = vi.fn();
    try {
      await writeExternalSessionOperationRecord(activeServerDir, record);
      const runner = createExternalSessionExternalLinkedTakeoverPhaseRunner({
        activeServerDir,
        operationExclusion: { acquire },
        resolveWriterSafety: async () => writerSafety,
        loadCurrent,
        followLeaseManager: {
          suspendSession,
          resumeSession: vi.fn(),
        },
        resolveSpawn: vi.fn(),
        spawnResolvedTakeoverSession: vi.fn(),
        spawnSession,
        reconcileRuntimeBindingFailure: noCommittedRuntimeBindingFailure,
        publishProgress,
      });

      await expect(runner.resume({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: record.revision,
      })).resolves.toEqual({
        ok: false,
        error: {
          code: 'not_allowed',
          message: 'External-linked takeover is unsupported for this Agent writer-safety contract.',
        },
      });

      expect(acquire).not.toHaveBeenCalled();
      expect(loadCurrent).not.toHaveBeenCalled();
      expect(suspendSession).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
      expect(publishProgress).not.toHaveBeenCalled();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).resolves.toEqual(record);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['validating', 'quiescing'],
    ['admitting', 'admitting'],
  ] as const)('durably fails a post-CAS source revalidation error from awaiting %s without phase regression', async (
    initialPhase,
    expectedPhase,
  ) => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-external-linked-takeover-post-cas-'),
    );
    const record: ExternalSessionOperationRecordV1 = {
      ...externalLinkedRecord(),
      phase: initialPhase,
      retryTargetPhase: initialPhase,
    };
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'external-linked-post-cas-owner',
    });
    const prepared = {
      linked: {} as never,
      pluginGeneration: 'contribution-1',
      quiescenceIdentity: 'verified-source-and-process-1',
      permitsAdmission: true,
      hostedOwnerSessionId: null,
    };
    const loadCurrent = vi.fn()
      .mockResolvedValueOnce(prepared)
      .mockRejectedValueOnce(
        new ExternalSessionPersistedTakeoverPreflightError(
          'source_unavailable',
          'External-linked takeover source was replaced.',
        ),
      );
    const spawnSession = vi.fn();
    const publishProgress = vi.fn(async () => undefined);
    try {
      await writeExternalSessionOperationRecord(activeServerDir, record);
      const runner = createExternalSessionExternalLinkedTakeoverPhaseRunner({
        activeServerDir,
        operationExclusion,
        resolveWriterSafety: async () => 'native_prevention',
        loadCurrent,
        followLeaseManager: {
          suspendSession: async () => true,
          resumeSession: async () => ({
            resumed: true,
            leaseAcquired: false,
          }),
        },
        resolveSpawn: vi.fn(),
        spawnResolvedTakeoverSession: vi.fn(),
        spawnSession,
        reconcileRuntimeBindingFailure: noCommittedRuntimeBindingFailure,
        publishProgress,
        nowMs: () => 20,
      });

      await expect(runner.resume({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: record.revision,
      })).resolves.toMatchObject({
        ok: true,
        progress: {
          revision: 2,
          status: 'failed',
          phase: expectedPhase,
          retryTargetPhase: expectedPhase,
          error: {
            code: 'source_unavailable',
            retryable: true,
          },
        },
      });
      expect(spawnSession).not.toHaveBeenCalled();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).resolves.toMatchObject({
        revision: 2,
        status: 'failed',
        phase: expectedPhase,
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails a replacement launch generation before the spawn boundary', async () => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-external-linked-takeover-generation-'),
    );
    const record = externalLinkedRecord();
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'external-linked-generation-owner',
    });
    const prepared = {
      linked: {} as never,
      pluginGeneration: 'contribution-1',
      quiescenceIdentity: 'verified-source-and-process-1',
      permitsAdmission: true,
      hostedOwnerSessionId: null,
    };
    const spawnSession = vi.fn();
    try {
      await writeExternalSessionOperationRecord(activeServerDir, record);
      const runner = createExternalSessionExternalLinkedTakeoverPhaseRunner({
        activeServerDir,
        operationExclusion,
        resolveWriterSafety: async () => 'native_prevention',
        loadCurrent: async () => prepared,
        followLeaseManager: {
          suspendSession: async () => true,
          resumeSession: async () => ({
            resumed: true,
            leaseAcquired: false,
          }),
        },
        resolveSpawn: async () => ({
          ok: true,
          value: {
            options: { directory: '/tmp/session' },
            origin: {
              agentId: 'example',
              pluginId: 'example.plugin',
              generation: 'contribution-2',
            },
          },
        }),
        spawnResolvedTakeoverSession: vi.fn(),
        spawnSession,
        reconcileRuntimeBindingFailure: noCommittedRuntimeBindingFailure,
        publishProgress: async () => undefined,
        nowMs: () => 30,
      });

      await expect(runner.resume({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: record.revision,
      })).resolves.toMatchObject({
        ok: true,
        progress: {
          status: 'failed',
          phase: 'admitting',
          error: { code: 'source_unavailable', retryable: true },
        },
      });
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('revalidates source currentness immediately before launch', async () => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-external-linked-takeover-final-fence-'),
    );
    const record = externalLinkedRecord();
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'external-linked-final-fence-owner',
    });
    const prepared = {
      linked: {} as never,
      pluginGeneration: 'contribution-1',
      quiescenceIdentity: 'verified-source-and-process-1',
      permitsAdmission: true,
      hostedOwnerSessionId: null,
    };
    const loadCurrent = vi.fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({
        ...prepared,
        quiescenceIdentity: 'verified-source-and-process-2',
      });
    const spawnSession = vi.fn();
    const spawnResolvedTakeoverSession = vi.fn();
    try {
      await writeExternalSessionOperationRecord(activeServerDir, record);
      const runner = createExternalSessionExternalLinkedTakeoverPhaseRunner({
        activeServerDir,
        operationExclusion,
        resolveWriterSafety: async () => 'native_prevention',
        loadCurrent,
        followLeaseManager: {
          suspendSession: async () => true,
          resumeSession: async () => ({
            resumed: true,
            leaseAcquired: false,
          }),
        },
        resolveSpawn: async () => ({
          ok: true,
          value: {
            options: { directory: '/tmp/session' },
            origin: {
              agentId: 'example',
              pluginId: 'example.plugin',
              generation: 'contribution-1',
            },
          },
        }),
        spawnResolvedTakeoverSession,
        spawnSession,
        reconcileRuntimeBindingFailure: noCommittedRuntimeBindingFailure,
        publishProgress: async () => undefined,
        nowMs: () => 35,
      });

      await expect(runner.resume({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: record.revision,
      })).resolves.toMatchObject({
        ok: true,
        progress: {
          status: 'failed',
          phase: 'admitting',
          error: { code: 'source_unavailable', retryable: true },
        },
      });
      expect(loadCurrent).toHaveBeenCalledTimes(3);
      expect(spawnResolvedTakeoverSession).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('keeps a spawn-boundary error before admission retryable at admitting', async () => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-external-linked-takeover-spawn-rejection-'),
    );
    const record = externalLinkedRecord();
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'external-linked-spawn-rejection-owner',
    });
    const prepared = {
      linked: {} as never,
      pluginGeneration: 'contribution-1',
      quiescenceIdentity: 'verified-source-and-process-1',
      permitsAdmission: true,
      hostedOwnerSessionId: null,
    };
    const loadCurrent = vi.fn(async () => prepared);
    const admissionWaiter = createPersistedTakeoverAdmissionWaiter();
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: record.request.sessionId,
    }));
    const spawnResolvedTakeoverSession = vi.fn(async (input) => {
      await input.spawnSession({
        ...input.resolved.options,
        ...input.options,
      });
      throw new Error('runtime registry lease release failed');
    });
    try {
      await writeExternalSessionOperationRecord(activeServerDir, record);
      const runner = createExternalSessionExternalLinkedTakeoverPhaseRunner({
        activeServerDir,
        operationExclusion,
        resolveWriterSafety: async () => 'native_prevention',
        loadCurrent,
        followLeaseManager: {
          suspendSession: async () => true,
          resumeSession: async () => ({
            resumed: true,
            leaseAcquired: false,
          }),
        },
        resolveSpawn: async () => ({
          ok: true,
          value: {
            options: { directory: '/tmp/session' },
            origin: {
              agentId: 'example',
              pluginId: 'example.plugin',
              generation: 'contribution-1',
            },
          },
        }),
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter,
        reconcileRuntimeBindingFailure: noCommittedRuntimeBindingFailure,
        publishProgress: async () => undefined,
        nowMs: () => 38,
      });

      await expect(runner.resume({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: record.revision,
      })).resolves.toMatchObject({
        ok: true,
        progress: {
          revision: 3,
          status: 'failed',
          phase: 'admitting',
          retryTargetPhase: 'admitting',
          error: {
            code: 'admission_failed',
            retryable: true,
          },
        },
      });
      expect(loadCurrent).toHaveBeenCalledTimes(3);
      expect(spawnResolvedTakeoverSession).toHaveBeenCalledOnce();
      expect(spawnSession).toHaveBeenCalledOnce();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).resolves.toMatchObject({
        revision: 3,
        status: 'failed',
        phase: 'admitting',
        retryTargetPhase: 'admitting',
        error: {
          code: 'admission_failed',
          retryable: true,
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('recovers a definitively rejected precommit admission instead of stranding it running/admitting', async () => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-external-linked-takeover-precommit-rejection-'),
    );
    const record = externalLinkedRecord();
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'external-linked-precommit-rejection-owner',
    });
    const admissionWaiter = createPersistedTakeoverAdmissionWaiter();
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
    const prepared = {
      linked,
      pluginGeneration: record.request.source.contributionGeneration,
      quiescenceIdentity: 'verified-source-and-process-1',
      permitsAdmission: true,
      hostedOwnerSessionId: null,
    };
    // The Server definitively refuses this exact attempt. The admission owner
    // has already committed refreshed authority evidence at revision + 1, so a
    // phase runner that marks failure at its own pre-preparation revision CASes
    // against a stale revision and leaves a live operation stuck.
    const sendHistoricalCommand = vi.fn(async () => ({
      v: 1 as const,
      kind: 'error' as const,
      errorCode: 'storage_mode_conflict' as const,
      message: 'The server rejected this exact admission attempt.',
    }));
    // One shared monotonic clock: the runner and the admission owner write the
    // same record, and a non-monotonic test clock would be rejected by the
    // record store rather than by the behaviour under test.
    let clock = 38;
    const nowMs = () => (clock += 1);
    const admissionOwner = createExternalSessionPersistedTakeoverAdmissionOwner({
      activeServerDir,
      admissionWaiter,
      isFollowSuspended: () => true,
      suspendFollow: async () => undefined,
      sendHistoricalCommand,
      loadExternalLinkedCurrent: async () => prepared,
      nowMs,
    });
    let admitError: unknown = null;
    const spawnSession = vi.fn(async (options) => {
      const correlation = options.persistedTakeoverAdmission;
      if (!correlation || correlation.mode !== 'external_linked') {
        throw new Error('expected external-linked admission correlation');
      }
      await admissionOwner.admit({
        mode: 'external_linked',
        sessionId: record.request.sessionId,
        operationId: correlation.operationId,
        attemptId: correlation.attemptId,
        publisherPrecondition: {
          machineId: record.request.source.machineId,
          committedFenceMs: 1,
        },
      }).catch((error: unknown) => { admitError = error; });
      return {
        type: 'success' as const,
        sessionId: record.request.sessionId,
      };
    });
    try {
      await writeExternalSessionOperationRecord(activeServerDir, record);
      const runner = createExternalSessionExternalLinkedTakeoverPhaseRunner({
        activeServerDir,
        operationExclusion,
        resolveWriterSafety: async () => 'native_prevention',
        loadCurrent: async () => prepared,
        followLeaseManager: {
          suspendSession: async () => true,
          resumeSession: async () => ({ resumed: true, leaseAcquired: false }),
        },
        resolveSpawn: async () => ({
          ok: true,
          value: {
            options: { directory: '/tmp/session' },
            origin: {
              agentId: 'example',
              pluginId: 'example.plugin',
              generation: record.request.source.contributionGeneration,
            },
          },
        }),
        spawnResolvedTakeoverSession: async (input) => ({
          ok: true as const,
          value: await input.spawnSession({
            ...input.resolved.options,
            ...input.options,
          }),
        }),
        spawnSession,
        admissionWaiter,
        reconcileRuntimeBindingFailure:
          admissionOwner.reconcileRuntimeBindingFailure,
        publishProgress: async () => undefined,
        createAttemptId: () => 'attempt-a',
        nowMs,
      });

      await expect(runner.resume({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: record.revision,
      })).resolves.toMatchObject({
        ok: true,
        progress: {
          status: 'failed',
          phase: 'admitting',
          retryTargetPhase: 'admitting',
          error: { code: 'admission_failed', retryable: true },
        },
      });
      expect(admitError).toBeInstanceOf(Error);
      expect(sendHistoricalCommand).toHaveBeenCalledOnce();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).resolves.toMatchObject({
        status: 'failed',
        phase: 'admitting',
        retryTargetPhase: 'admitting',
        bindings: { targetRuntimeAttemptId: 'attempt-a' },
        error: { code: 'admission_failed', retryable: true },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('keeps a crash-after-commit attempt noncancellable, then fences late attempt A after fresh Retry', async () => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-external-linked-takeover-runtime-bound-timeout-'),
    );
    const record = externalLinkedRecord();
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'external-linked-runtime-bound-timeout-owner',
    });
    const admissionWaiter = createPersistedTakeoverAdmissionWaiter({
      timeoutMs: 30_000,
    });
    const admissionOwner = createExternalSessionPersistedTakeoverAdmissionOwner({
      activeServerDir,
      admissionWaiter,
      isFollowSuspended: () => true,
      suspendFollow: async () => undefined,
      sendHistoricalCommand: vi.fn(),
      nowMs: () => 20,
    });
    const prepared = {
      linked: {} as never,
      pluginGeneration: record.request.source.contributionGeneration,
      quiescenceIdentity: 'verified-source-and-process-1',
      permitsAdmission: true,
      hostedOwnerSessionId: null,
    };
    let firstSpawned!: () => void;
    const firstSpawn = new Promise<void>((resolve) => {
      firstSpawned = resolve;
    });
    let secondSpawned!: () => void;
    const secondSpawn = new Promise<void>((resolve) => {
      secondSpawned = resolve;
    });
    let spawnCount = 0;
    const spawnSession = vi.fn(async (options) => {
      const correlation = options.persistedTakeoverAdmission;
      if (!correlation || correlation.mode !== 'external_linked') {
        throw new Error('expected external-linked admission correlation');
      }
      spawnCount += 1;
      if (spawnCount === 1) {
        const committed = await mutateExternalSessionOperationRecordAtRevision(
          activeServerDir,
          record.operationId,
          (await readExternalSessionOperationRecord(
            activeServerDir,
            record.operationId,
          ))?.revision ?? -1,
          (fresh) => ({
            ...fresh,
            revision: fresh.revision + 1,
            status: 'running',
            phase: 'spawning',
            updatedAtMs: 20,
          }),
        );
        if (!committed.ok) throw new Error('expected committed admission record');
        firstSpawned();
      } else {
        secondSpawned();
      }
      return {
        type: 'success' as const,
        sessionId: record.request.sessionId,
      };
    });
    const spawnResolvedTakeoverSession = vi.fn(async (input) => ({
      ok: true as const,
      value: await input.spawnSession({
        ...input.resolved.options,
        ...input.options,
      }),
    }));
    const runnerDependencies = {
      activeServerDir,
      operationExclusion,
      resolveWriterSafety: async () => 'native_prevention' as const,
      loadCurrent: async () => prepared,
      followLeaseManager: {
        suspendSession: async () => true,
        resumeSession: vi.fn(async () => ({
          resumed: true as const,
          leaseAcquired: false,
        })),
      },
      resolveSpawn: async () => ({
        ok: true as const,
        value: {
          options: { directory: '/tmp/session' },
          origin: {
            agentId: 'example',
            pluginId: 'example.plugin',
            generation: record.request.source.contributionGeneration,
          },
        },
      }),
      spawnResolvedTakeoverSession,
      spawnSession,
      admissionWaiter,
      reconcileRuntimeBindingFailure:
        admissionOwner.reconcileRuntimeBindingFailure,
      publishProgress: async () => undefined,
      createAttemptId: vi.fn()
        .mockReturnValueOnce('attempt-a')
        .mockReturnValueOnce('attempt-b'),
      nowMs: () => 20,
    };
    try {
      await writeExternalSessionOperationRecord(activeServerDir, record);
      const runner = createExternalSessionExternalLinkedTakeoverPhaseRunner(
        runnerDependencies,
      );

      const firstAttempt = runner.resume({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: record.revision,
      });
      await firstSpawn;
      expect(admissionWaiter.settle({
        mode: 'external_linked',
        operationId: record.operationId,
        attemptId: 'attempt-a',
      }, {
        status: 'failed',
        errorCode: 'persisted_takeover_admission_timeout',
      })).toBe(true);
      await expect(firstAttempt).resolves.toMatchObject({
        ok: true,
        progress: {
          status: 'failed',
          phase: 'spawning',
          retryTargetPhase: 'spawning',
          error: { code: 'spawn_failed', retryable: true },
        },
      });
      const failedAttempt = await readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      );
      if (!failedAttempt) throw new Error('expected failed first attempt');
      expect(failedAttempt).toMatchObject({
        bindings: { targetRuntimeAttemptId: 'attempt-a' },
      });
      await expect(runner.cancel({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: failedAttempt.revision,
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'not_allowed' },
      });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).resolves.toMatchObject({
        revision: failedAttempt.revision,
        status: 'failed',
        phase: 'spawning',
        bindings: { targetRuntimeAttemptId: 'attempt-a' },
      });

      const retry = runner.retry({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: failedAttempt.revision,
      });
      await Promise.race([
        secondSpawn,
        retry.then((response) => {
          throw new Error(
            `expected Retry to launch attempt B, received ${response.ok ? 'success' : response.error.code}`,
          );
        }),
      ]);
      await expect(admissionOwner.reconcileRuntimeBindingFailure({
        mode: 'external_linked',
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        attemptId: 'attempt-a',
      })).resolves.toBeNull();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).resolves.toMatchObject({
        status: 'running',
        phase: 'spawning',
        bindings: { targetRuntimeAttemptId: 'attempt-b' },
      });

      await admissionOwner.runtimeBound({
        mode: 'external_linked',
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        attemptId: 'attempt-b',
        publisherPrecondition: {
          machineId: record.request.source.machineId,
          committedFenceMs: 1,
        },
      });
      await expect(retry).resolves.toMatchObject({
        ok: true,
        progress: {
          status: 'completed',
          phase: 'finalizing',
        },
      });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).resolves.toMatchObject({
        status: 'completed',
        phase: 'finalizing',
        bindings: { targetRuntimeAttemptId: 'attempt-b' },
      });
      expect(spawnSession).toHaveBeenCalledTimes(2);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      phase: 'quiescing',
      hostedOwnerSessionId: null,
    },
    {
      phase: 'admitting',
      hostedOwnerSessionId: null,
    },
  ] as const)(
    'passively repairs a crash after durable $phase and lets only exact Resume continue once',
    async ({ phase, hostedOwnerSessionId }) => {
      const activeServerDir = await mkdtemp(
        join(tmpdir(), `happier-external-linked-${phase}-restart-`),
      );
      const base = externalLinkedRecord();
      const {
        retryTargetPhase: _retryTargetPhase,
        ...withoutRecovery
      } = base;
      const interrupted: ExternalSessionOperationRecordV1 = {
        ...withoutRecovery,
        revision: 3,
        status: 'running',
        phase,
        updatedAtMs: 3,
      };
      const resolveWriterSafety = vi.fn(
        async () => 'native_prevention' as const,
      );
      const loadCurrent = vi.fn(async () => ({
        linked: {} as never,
        pluginGeneration:
          interrupted.request.source.contributionGeneration,
        quiescenceIdentity: 'verified-source-and-process-1',
        permitsAdmission: hostedOwnerSessionId === null,
        hostedOwnerSessionId,
      }));
      const acquire = vi.fn();
      const suspendSession = vi.fn(async () => true);
      const resolveSpawn = vi.fn(async () => ({
        ok: true as const,
        value: {
          options: { directory: '/tmp/session' },
          origin: {
            agentId: 'example',
            pluginId: 'example.plugin',
            generation:
              interrupted.request.source.contributionGeneration,
          },
        },
      }));
      const admissionWaiter = createPersistedTakeoverAdmissionWaiter();
      const spawnSession = vi.fn(async (options) => {
        const correlation = options.persistedTakeoverAdmission;
        if (!correlation || correlation.mode !== 'external_linked') {
          throw new Error('expected external-linked admission correlation');
        }
        const current = await readExternalSessionOperationRecord(
          activeServerDir,
          interrupted.operationId,
        );
        if (!current) throw new Error('expected active operation record');
        const completed = await mutateExternalSessionOperationRecordAtRevision(
          activeServerDir,
          current.operationId,
          current.revision,
          (fresh) => ({
            ...fresh,
            revision: fresh.revision + 1,
            status: 'completed',
            phase: 'finalizing',
            terminalResult: { kind: 'completed' },
            updatedAtMs: 5,
          }),
        );
        if (!completed.ok) throw new Error('expected completion mutation');
        if (!admissionWaiter.settle(correlation, { status: 'committed' })) {
          throw new Error('expected pending external-linked admission');
        }
        return {
          type: 'success' as const,
          sessionId: interrupted.request.sessionId,
        };
      });
      const spawnResolvedTakeoverSession = vi.fn(async (input) => ({
        ok: true as const,
        value: await input.spawnSession({
          ...input.resolved.options,
          ...input.options,
        }),
      }));
      const publishProgress = vi.fn(async () => undefined);
      const operationExclusion = createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: `external-linked-${phase}-restart-owner`,
      });
      try {
        await writeExternalSessionOperationRecord(
          activeServerDir,
          interrupted,
        );

        await expect(repairExternalSessionOperationProgressProjections(
          activeServerDir,
          {
            inspectOperationClaim:
              operationExclusion.inspectPassiveRepairClaim,
            withOperationClaimBarrier:
              operationExclusion.withPassiveRepairClaimBarrier,
            readPresentation: async () => ({ kind: 'absent' }),
            publish: publishProgress,
            nowMs: () => 4,
          },
        )).resolves.toBe(1);
        const repaired = await readExternalSessionOperationRecord(
          activeServerDir,
          interrupted.operationId,
        );
        expect(repaired).toMatchObject({
          revision: interrupted.revision + 1,
          status: 'awaiting_user_resume',
          phase,
          retryTargetPhase: phase,
          bindings: interrupted.bindings,
        });
        if (!repaired) throw new Error('expected passively repaired operation');
        expect(resolveWriterSafety).not.toHaveBeenCalled();
        expect(loadCurrent).not.toHaveBeenCalled();
        expect(acquire).not.toHaveBeenCalled();
        expect(suspendSession).not.toHaveBeenCalled();
        expect(resolveSpawn).not.toHaveBeenCalled();
        expect(spawnResolvedTakeoverSession).not.toHaveBeenCalled();
        expect(spawnSession).not.toHaveBeenCalled();

        const runner =
          createExternalSessionExternalLinkedTakeoverPhaseRunner({
            activeServerDir,
            operationExclusion: {
              acquire: async (request) => {
                acquire(request);
                return await operationExclusion.acquire(request);
              },
            },
            resolveWriterSafety,
            loadCurrent,
            followLeaseManager: {
              suspendSession,
              resumeSession: vi.fn(async () => ({
                resumed: true as const,
                leaseAcquired: false,
              })),
            },
            resolveSpawn,
            spawnResolvedTakeoverSession,
            spawnSession,
            admissionWaiter,
            reconcileRuntimeBindingFailure: noCommittedRuntimeBindingFailure,
            publishProgress,
            nowMs: () => 5,
          });

        await expect(runner.resume({
          sessionId: repaired.request.sessionId,
          operationId: repaired.operationId,
          revision: repaired.revision - 1,
        })).resolves.toMatchObject({
          ok: false,
          error: { code: 'stale_revision' },
        });
        expect(resolveWriterSafety).not.toHaveBeenCalled();

        await expect(runner.resume({
          sessionId: repaired.request.sessionId,
          operationId: repaired.operationId,
          revision: repaired.revision,
        })).resolves.toMatchObject({
          ok: true,
          progress: {
            status: 'completed',
            phase: 'finalizing',
          },
        });
        expect(resolveWriterSafety).toHaveBeenCalledOnce();
        expect(loadCurrent).toHaveBeenCalledTimes(3);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(suspendSession).toHaveBeenCalledTimes(1);
        expect(resolveSpawn).toHaveBeenCalledTimes(1);
        if (interrupted.request.plan !== 'takeover') {
          throw new Error('expected takeover request fixture');
        }
        expect(resolveSpawn).toHaveBeenCalledWith(expect.objectContaining({
          linked: expect.any(Object),
          sessionId: interrupted.request.sessionId,
          targetDirectory: interrupted.request.targetDirectory,
        }));
        expect(spawnResolvedTakeoverSession).toHaveBeenCalledTimes(1);
        expect(spawnSession).toHaveBeenCalledTimes(1);

        const effectCounts = {
          writerSafety: resolveWriterSafety.mock.calls.length,
          loadCurrent: loadCurrent.mock.calls.length,
          acquire: acquire.mock.calls.length,
          suspend: suspendSession.mock.calls.length,
          resolveSpawn: resolveSpawn.mock.calls.length,
          spawnResolved: spawnResolvedTakeoverSession.mock.calls.length,
          spawn: spawnSession.mock.calls.length,
        };
        await expect(runner.resume({
          sessionId: repaired.request.sessionId,
          operationId: repaired.operationId,
          revision: repaired.revision,
        })).resolves.toMatchObject({
          ok: false,
          error: { code: 'stale_revision' },
        });
        expect({
          writerSafety: resolveWriterSafety.mock.calls.length,
          loadCurrent: loadCurrent.mock.calls.length,
          acquire: acquire.mock.calls.length,
          suspend: suspendSession.mock.calls.length,
          resolveSpawn: resolveSpawn.mock.calls.length,
          spawnResolved: spawnResolvedTakeoverSession.mock.calls.length,
          spawn: spawnSession.mock.calls.length,
        }).toEqual(effectCounts);
        const completed = await readExternalSessionOperationRecord(
          activeServerDir,
          interrupted.operationId,
        );
        expect(completed).toMatchObject({
          status: 'completed',
          phase: 'finalizing',
          terminalResult: { kind: 'completed' },
        });
        expect(completed?.bindings.operationClaimId).toEqual(
          expect.any(String),
        );
        expect(completed?.bindings.operationClaimId)
          .not.toBe(interrupted.bindings.operationClaimId);
      } finally {
        await rm(activeServerDir, { recursive: true, force: true });
      }
    },
  );

  it('does not let phase recovery finalize an external-linked takeover without its child runtime', async () => {
    const hostedOwnerSessionId = 'session-1';
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-external-linked-takeover-finalizing-recovery-'),
    );
    const base = externalLinkedRecord();
    const {
      retryTargetPhase: _retryTargetPhase,
      ...withoutRecovery
    } = base;
    const interrupted: ExternalSessionOperationRecordV1 = {
      ...withoutRecovery,
      revision: 3,
      status: 'running',
      phase: 'finalizing',
      updatedAtMs: 3,
    };
    const publishProgress = vi.fn(async () => undefined);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'external-linked-finalizing-restart-owner',
    });
    const acquire = vi.fn();
    const resolveWriterSafety = vi.fn(
      async () => 'native_prevention' as const,
    );
    const loadCurrent = vi.fn(async () => ({
      linked: {} as never,
      pluginGeneration:
        interrupted.request.source.contributionGeneration,
      quiescenceIdentity: 'verified-source-and-process-1',
      permitsAdmission: hostedOwnerSessionId === null,
      hostedOwnerSessionId,
    }));
    const suspendSession = vi.fn();
    const resolveSpawn = vi.fn();
    const spawnResolvedTakeoverSession = vi.fn();
    const spawnSession = vi.fn();
    try {
      await writeExternalSessionOperationRecord(activeServerDir, interrupted);

      await expect(repairExternalSessionOperationProgressProjections(
        activeServerDir,
        {
          inspectOperationClaim:
            operationExclusion.inspectPassiveRepairClaim,
          withOperationClaimBarrier:
            operationExclusion.withPassiveRepairClaimBarrier,
          readPresentation: async () => ({ kind: 'absent' }),
          publish: publishProgress,
          nowMs: () => 4,
        },
      )).resolves.toBe(1);
      const repaired = await readExternalSessionOperationRecord(
        activeServerDir,
        interrupted.operationId,
      );
      expect(repaired).toMatchObject({
        revision: 4,
        status: 'awaiting_user_resume',
        phase: 'finalizing',
        retryTargetPhase: 'finalizing',
        bindings: interrupted.bindings,
      });
      if (!repaired) throw new Error('expected passively repaired operation');

      const runner = createExternalSessionExternalLinkedTakeoverPhaseRunner({
        activeServerDir,
        operationExclusion: { acquire },
        resolveWriterSafety,
        loadCurrent,
        followLeaseManager: {
          suspendSession,
          resumeSession: vi.fn(),
        },
        resolveSpawn,
        spawnResolvedTakeoverSession,
        spawnSession,
        reconcileRuntimeBindingFailure: noCommittedRuntimeBindingFailure,
        publishProgress,
        nowMs: () => 5,
      });

      await expect(runner.retry({
        sessionId: repaired.request.sessionId,
        operationId: repaired.operationId,
        revision: repaired.revision,
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_state' },
      });
      expect(loadCurrent).not.toHaveBeenCalled();

      await expect(runner.resume({
        sessionId: repaired.request.sessionId,
        operationId: repaired.operationId,
        revision: repaired.revision - 1,
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'stale_revision' },
      });
      expect(loadCurrent).not.toHaveBeenCalled();

      await expect(runner.resume({
        sessionId: repaired.request.sessionId,
        operationId: repaired.operationId,
        revision: repaired.revision,
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'not_allowed' },
      });

      expect(resolveWriterSafety).toHaveBeenCalledOnce();
      expect(loadCurrent).toHaveBeenCalledOnce();
      expect(loadCurrent).toHaveBeenCalledWith(expect.objectContaining({
        revision: repaired.revision,
        bindings: interrupted.bindings,
        request: expect.objectContaining({
          source: expect.objectContaining({
            contributionGeneration:
              interrupted.request.source.contributionGeneration,
          }),
        }),
      }));
      expect(acquire).not.toHaveBeenCalled();
      expect(suspendSession).not.toHaveBeenCalled();
      expect(resolveSpawn).not.toHaveBeenCalled();
      expect(spawnResolvedTakeoverSession).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        interrupted.operationId,
      )).resolves.toMatchObject({
        revision: 4,
        status: 'awaiting_user_resume',
        phase: 'finalizing',
        retryTargetPhase: 'finalizing',
        bindings: interrupted.bindings,
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('cancels an awaiting external-linked operation without source, spawn, or authority effects', async () => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-external-linked-takeover-cancel-'),
    );
    const record = externalLinkedRecord();
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'external-linked-cancel-owner',
    });
    const loadCurrent = vi.fn();
    const spawnSession = vi.fn();
    try {
      await writeExternalSessionOperationRecord(activeServerDir, record);
      const runner = createExternalSessionExternalLinkedTakeoverPhaseRunner({
        activeServerDir,
        operationExclusion,
        resolveWriterSafety: vi.fn(),
        loadCurrent,
        followLeaseManager: {
          suspendSession: vi.fn(),
          resumeSession: vi.fn(),
        },
        resolveSpawn: vi.fn(),
        spawnResolvedTakeoverSession: vi.fn(),
        spawnSession,
        reconcileRuntimeBindingFailure: noCommittedRuntimeBindingFailure,
        publishProgress: async () => undefined,
        nowMs: () => 40,
      });

      await expect(runner.cancel({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: record.revision,
      })).resolves.toMatchObject({
        ok: true,
        progress: {
          revision: 2,
          status: 'cancelled',
          phase: 'validating',
        },
      });
      expect(loadCurrent).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).resolves.toMatchObject({
        revision: 2,
        status: 'cancelled',
        terminalResult: { kind: 'cancelled' },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('idempotently finalizes a durable external-linked cancellation request after interruption', async () => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-external-linked-takeover-cancel-resume-'),
    );
    const awaiting = externalLinkedRecord();
    const {
      retryTargetPhase: _retryTargetPhase,
      ...withoutRecovery
    } = awaiting;
    const record: ExternalSessionOperationRecordV1 = {
      ...withoutRecovery,
      revision: 1,
      status: 'cancel_requested',
      updatedAtMs: 2,
      cancellation: {
        requestedAtMs: 2,
        requestedAtRevision: 0,
      },
    };
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'external-linked-cancel-resume-owner',
    });
    const loadCurrent = vi.fn();
    const spawnSession = vi.fn();
    try {
      await writeExternalSessionOperationRecord(activeServerDir, record);
      const runner = createExternalSessionExternalLinkedTakeoverPhaseRunner({
        activeServerDir,
        operationExclusion,
        resolveWriterSafety: vi.fn(),
        loadCurrent,
        followLeaseManager: {
          suspendSession: vi.fn(),
          resumeSession: vi.fn(),
        },
        resolveSpawn: vi.fn(),
        spawnResolvedTakeoverSession: vi.fn(),
        spawnSession,
        reconcileRuntimeBindingFailure: noCommittedRuntimeBindingFailure,
        publishProgress: async () => undefined,
        nowMs: () => 45,
      });

      await expect(runner.cancel({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: record.revision,
      })).resolves.toMatchObject({
        ok: true,
        progress: {
          revision: 2,
          status: 'cancelled',
        },
      });
      expect(loadCurrent).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('retries durable launch admission and still performs one spawn without importing', async () => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-external-linked-takeover-success-'),
    );
    const record = externalLinkedRecord();
    const realExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'external-linked-takeover-test-owner',
    });
    const acquire = vi.fn(realExclusion.acquire);
    const prepared = {
      linked: {
        rawSession: { id: 'session-1' },
        metadata: {},
        sessionPath: '/tmp/session',
        agentId: 'example',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        linkGeneration: 'link-1',
        source: { kind: 'jsonl', path: '/tmp/session.jsonl' },
        codexBackendMode: null,
      } as never,
      pluginGeneration: 'contribution-1',
      quiescenceIdentity: 'verified-source-and-process-1',
      permitsAdmission: true,
      hostedOwnerSessionId: null,
    };
    const loadCurrent = vi.fn(async () => prepared);
    const suspendSession = vi.fn(async () => true);
    const resumeSession = vi.fn(async () => ({
      resumed: true as const,
      leaseAcquired: false,
    }));
    const admissionWaiter = createPersistedTakeoverAdmissionWaiter();
    const spawnSession = vi.fn(async (options) => {
      const correlation = options.persistedTakeoverAdmission;
      if (!correlation || correlation.mode !== 'external_linked') {
        throw new Error('expected external-linked admission correlation');
      }
      const current = await readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      );
      if (!current) throw new Error('expected active operation record');
      const completed = await mutateExternalSessionOperationRecordAtRevision(
        activeServerDir,
        current.operationId,
        current.revision,
        (fresh) => ({
          ...fresh,
          revision: fresh.revision + 1,
          status: 'completed',
          phase: 'finalizing',
          terminalResult: { kind: 'completed' },
          updatedAtMs: 50,
        }),
      );
      if (!completed.ok) throw new Error('expected completion mutation');
      admissionWaiter.settle(correlation, { status: 'committed' });
      return {
        type: 'success' as const,
        sessionId: record.request.sessionId,
      };
    });
    const spawnResolvedTakeoverSession = vi.fn(async (input) => ({
      ok: true as const,
      value: await input.spawnSession({
        ...input.resolved.options,
        ...input.options,
      }),
    }));
    const resolveSpawn = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, code: 'unavailable' as const })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          options: { directory: '/tmp/session' },
          origin: {
            agentId: 'example',
            pluginId: 'example.plugin',
            generation: 'contribution-1',
          },
        },
      });
    const publishProgress = vi.fn(async () => undefined);
    try {
      await writeExternalSessionOperationRecord(activeServerDir, record);
      const runner = createExternalSessionExternalLinkedTakeoverPhaseRunner({
        activeServerDir,
        operationExclusion: { acquire },
        resolveWriterSafety: async () => 'native_prevention',
        loadCurrent,
        followLeaseManager: { suspendSession, resumeSession },
        resolveSpawn,
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter,
        reconcileRuntimeBindingFailure: noCommittedRuntimeBindingFailure,
        publishProgress,
        nowMs: () => 50,
      });

      const first = await runner.resume({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: record.revision,
      });
      expect(first).toMatchObject({
        ok: true,
        progress: {
          revision: 2,
          status: 'failed',
          phase: 'admitting',
          error: {
            code: 'admission_failed',
            retryable: true,
          },
          retryTargetPhase: 'admitting',
        },
      });
      if (!first.ok) throw new Error('expected failed durable progress');

      await expect(runner.retry({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: first.progress.revision,
      })).resolves.toMatchObject({
        ok: true,
        progress: {
          operationId: record.operationId,
          revision: 4,
          status: 'completed',
          phase: 'finalizing',
          request: { targetStorageMode: 'external-linked' },
          currentStorageState: 'machine_only',
        },
      });

      expect(acquire).toHaveBeenCalledTimes(2);
      expect(loadCurrent).toHaveBeenCalledTimes(5);
      expect(suspendSession).toHaveBeenCalledTimes(2);
      expect(resolveSpawn).toHaveBeenCalledTimes(2);
      if (record.request.plan !== 'takeover') {
        throw new Error('expected takeover request fixture');
      }
      expect(resolveSpawn).toHaveBeenNthCalledWith(1, expect.objectContaining({
        sessionId: record.request.sessionId,
        targetDirectory: record.request.targetDirectory,
      }));
      expect(resolveSpawn).toHaveBeenNthCalledWith(2, expect.objectContaining({
        sessionId: record.request.sessionId,
        targetDirectory: record.request.targetDirectory,
      }));
      expect(spawnResolvedTakeoverSession).toHaveBeenCalledOnce();
      expect(spawnSession).toHaveBeenCalledOnce();
      expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
        transcriptStorage: 'direct',
        persistedTakeoverAdmission: expect.objectContaining({
          mode: 'external_linked',
          operationId: record.operationId,
          attemptId: expect.any(String),
        }),
      }));
      expect(resumeSession).toHaveBeenCalledTimes(2);
      expect(publishProgress).toHaveBeenCalledTimes(3);
      const completed = await readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      );
      expect(completed).toMatchObject({
        revision: 4,
        status: 'completed',
        phase: 'finalizing',
        currentStorageState: 'machine_only',
        terminalResult: { kind: 'completed' },
      });
      expect(completed).not.toHaveProperty('publication');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('retains a double-lost admission acknowledgement at its exact attempt, forbids Cancel, and retries that attempt', async () => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-external-linked-takeover-ambiguous-admission-'),
    );
    const record = externalLinkedRecord();
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'external-linked-ambiguous-admission-owner',
    });
    const admissionWaiter = createPersistedTakeoverAdmissionWaiter();
    const prepared = {
      linked: {} as never,
      pluginGeneration: record.request.source.contributionGeneration,
      quiescenceIdentity: 'verified-source-and-process-1',
      permitsAdmission: true,
      hostedOwnerSessionId: null,
    };
    const admissionLinked = {
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
    const sendAdmissionCommand = vi.fn(async () => {
      throw new Error('acknowledgement lost after admission');
    });
    const admissionOwner = createExternalSessionPersistedTakeoverAdmissionOwner({
      activeServerDir,
      admissionWaiter,
      isFollowSuspended: () => true,
      suspendFollow: async () => undefined,
      sendHistoricalCommand: sendAdmissionCommand,
      loadExternalLinkedCurrent: async () => ({
        linked: admissionLinked,
        pluginGeneration: record.request.source.contributionGeneration,
        quiescenceIdentity: 'verified-source-and-process-1',
        permitsAdmission: true,
        hostedOwnerSessionId: null,
      }),
      nowMs: () => 60,
    });
    const resumeSession = vi.fn(async () => ({
      resumed: true as const,
      leaseAcquired: false,
    }));
    let spawned = 0;
    const spawnSession = vi.fn(async (options) => {
      const correlation = options.persistedTakeoverAdmission;
      if (!correlation || correlation.mode !== 'external_linked') {
        throw new Error('expected external-linked admission correlation');
      }
      spawned += 1;
      if (spawned === 1) {
        try {
          await admissionOwner.admit({
            ...correlation,
            sessionId: record.request.sessionId,
            publisherPrecondition: {
              machineId: record.request.source.machineId,
              committedFenceMs: 1,
            },
          });
        } catch (error) {
          if (
            !(error instanceof Error)
            || error.message
              !== 'external_linked_takeover_admission_ack_ambiguous'
          ) {
            throw error;
          }
        }
      } else {
        const current = await readExternalSessionOperationRecord(
          activeServerDir,
          record.operationId,
        );
        if (!current) throw new Error('expected active operation record');
        const completed = await mutateExternalSessionOperationRecordAtRevision(
          activeServerDir,
          current.operationId,
          current.revision,
          (fresh) => ({
            ...fresh,
            revision: fresh.revision + 1,
            status: 'completed',
            phase: 'finalizing',
            terminalResult: { kind: 'completed' },
            updatedAtMs: 60,
          }),
        );
        if (!completed.ok) throw new Error('expected completion mutation');
        admissionWaiter.settle(correlation, { status: 'committed' });
      }
      return {
        type: 'success' as const,
        sessionId: record.request.sessionId,
      };
    });
    const spawnResolvedTakeoverSession = vi.fn(async (input) => ({
      ok: true as const,
      value: await input.spawnSession({
        ...input.resolved.options,
        ...input.options,
      }),
    }));
    const createAttemptId = vi.fn()
      .mockReturnValueOnce('admission-attempt-1')
      .mockReturnValueOnce('unexpected-fresh-attempt');
    try {
      await writeExternalSessionOperationRecord(activeServerDir, record);
      const runner = createExternalSessionExternalLinkedTakeoverPhaseRunner({
        activeServerDir,
        operationExclusion,
        resolveWriterSafety: async () => 'native_prevention',
        loadCurrent: async () => prepared,
        followLeaseManager: {
          suspendSession: async () => true,
          resumeSession,
        },
        resolveSpawn: async () => ({
          ok: true as const,
          value: {
            options: { directory: '/tmp/session' },
            origin: {
              agentId: 'example',
              pluginId: 'example.plugin',
              generation: record.request.source.contributionGeneration,
            },
          },
        }),
        spawnResolvedTakeoverSession,
        spawnSession,
        admissionWaiter,
        reconcileRuntimeBindingFailure: noCommittedRuntimeBindingFailure,
        publishProgress: async () => undefined,
        createAttemptId,
        nowMs: () => 60,
      });

      const ambiguous = await runner.resume({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: record.revision,
      });
      expect(ambiguous).toMatchObject({
        ok: true,
        progress: {
          status: 'reconciliation_required',
          phase: 'admitting',
          retryTargetPhase: 'admitting',
          error: {
            code: 'reconciliation_required',
            retryable: true,
          },
        },
      });
      if (!ambiguous.ok) throw new Error('expected ambiguous admission progress');
      expect(resumeSession).not.toHaveBeenCalled();

      await expect(runner.resume({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: ambiguous.progress.revision,
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_state' },
      });
      await expect(runner.cancel({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: ambiguous.progress.revision,
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'not_allowed' },
      });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).resolves.toMatchObject({
        revision: ambiguous.progress.revision,
        status: 'reconciliation_required',
        phase: 'admitting',
        retryTargetPhase: 'admitting',
        error: {
          code: 'reconciliation_required',
          message: 'External-linked takeover admission acknowledgement remains ambiguous after bounded exact-attempt replay.',
          retryable: true,
        },
        bindings: { targetRuntimeAttemptId: 'admission-attempt-1' },
      });

      await expect(runner.retry({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: ambiguous.progress.revision,
      })).resolves.toMatchObject({
        ok: true,
        progress: {
          status: 'completed',
          phase: 'finalizing',
        },
      });
      expect(createAttemptId).toHaveBeenCalledTimes(1);
      expect(sendAdmissionCommand).toHaveBeenCalledTimes(2);
      expect(spawnSession).toHaveBeenNthCalledWith(1, expect.objectContaining({
        persistedTakeoverAdmission: {
          mode: 'external_linked',
          operationId: record.operationId,
          attemptId: 'admission-attempt-1',
        },
      }));
      expect(spawnSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
        persistedTakeoverAdmission: {
          mode: 'external_linked',
          operationId: record.operationId,
          attemptId: 'admission-attempt-1',
        },
      }));
      expect(resumeSession).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
