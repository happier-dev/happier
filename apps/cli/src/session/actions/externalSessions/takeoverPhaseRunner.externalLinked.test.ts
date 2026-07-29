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
  readExternalSessionOperationRecord,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';
import {
  repairExternalSessionOperationProgressProjections,
} from './operationProgressPublisher';
import {
  createExternalSessionExternalLinkedTakeoverPhaseRunner,
} from './takeoverPhaseRunner';
import {
  ExternalSessionPersistedTakeoverPreflightError,
} from './materializeAction';

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

  it('revalidates source currentness after the spawning CAS and immediately before launch', async () => {
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
          phase: 'spawning',
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

  it.each([
    {
      name: 'settles a rejected final spawn as retryable when no hosted owner is proven',
      reconciledHostedOwnerSessionId: null,
      expected: {
        revision: 4,
        status: 'failed',
        phase: 'spawning',
        retryTargetPhase: 'spawning',
        error: {
          code: 'spawn_failed',
          retryable: true,
        },
      },
    },
    {
      name: 'completes an ambiguous final spawn when the same hosted owner is proven',
      reconciledHostedOwnerSessionId: 'session-1',
      expected: {
        revision: 4,
        status: 'completed',
        phase: 'finalizing',
      },
      expectedTerminalResult: { kind: 'completed' as const },
    },
  ])('$name', async ({
    reconciledHostedOwnerSessionId,
    expected,
    expectedTerminalResult,
  }) => {
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
    const loadCurrent = vi.fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({
        ...prepared,
        permitsAdmission: reconciledHostedOwnerSessionId === null,
        hostedOwnerSessionId: reconciledHostedOwnerSessionId,
      });
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
        publishProgress: async () => undefined,
        nowMs: () => 38,
      });

      await expect(runner.resume({
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        revision: record.revision,
      })).resolves.toMatchObject({
        ok: true,
        progress: expected,
      });
      expect(loadCurrent).toHaveBeenCalledTimes(4);
      expect(spawnResolvedTakeoverSession).toHaveBeenCalledOnce();
      expect(spawnSession).toHaveBeenCalledOnce();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).resolves.toMatchObject({
        ...expected,
        ...(expectedTerminalResult
          ? { terminalResult: expectedTerminalResult }
          : {}),
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      phase: 'quiescing',
      hostedOwnerSessionId: null,
      expectedSpawnCount: 1,
    },
    {
      phase: 'admitting',
      hostedOwnerSessionId: null,
      expectedSpawnCount: 1,
    },
    {
      phase: 'spawning',
      hostedOwnerSessionId: 'session-1',
      expectedSpawnCount: 0,
    },
  ] as const)(
    'passively repairs a crash after durable $phase and lets only exact Resume continue once',
    async ({ phase, hostedOwnerSessionId, expectedSpawnCount }) => {
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
      const spawnSession = vi.fn(async () => ({
        type: 'success' as const,
        sessionId: interrupted.request.sessionId,
      }));
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
        expect(loadCurrent).toHaveBeenCalledTimes(
          expectedSpawnCount === 0 ? 1 : 3,
        );
        expect(acquire).toHaveBeenCalledTimes(expectedSpawnCount);
        expect(suspendSession).toHaveBeenCalledTimes(expectedSpawnCount);
        expect(resolveSpawn).toHaveBeenCalledTimes(expectedSpawnCount);
        expect(spawnResolvedTakeoverSession)
          .toHaveBeenCalledTimes(expectedSpawnCount);
        expect(spawnSession).toHaveBeenCalledTimes(expectedSpawnCount);

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
          expectedSpawnCount === 0
            ? interrupted.bindings.operationClaimId
            : expect.any(String),
        );
        if (expectedSpawnCount === 1) {
          expect(completed?.bindings.operationClaimId)
            .not.toBe(interrupted.bindings.operationClaimId);
        }
      } finally {
        await rm(activeServerDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      name: 'completes only from the exact current hosted owner',
      hostedOwnerSessionId: 'session-1',
      expectedResponse: {
        ok: true,
        progress: {
          revision: 5,
          status: 'completed',
          phase: 'finalizing',
        },
      },
    },
    {
      name: 'fails closed when the current hosted owner is absent',
      hostedOwnerSessionId: null,
      expectedResponse: {
        ok: false,
        error: {
          code: 'not_allowed',
        },
      },
    },
    {
      name: 'fails closed when a different current hosted owner is proven',
      hostedOwnerSessionId: 'session-other',
      expectedResponse: {
        ok: false,
        error: {
          code: 'not_allowed',
        },
      },
    },
  ])('passive finalizing recovery $name without launching another runtime', async ({
    hostedOwnerSessionId,
    expectedResponse,
  }) => {
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
      })).resolves.toMatchObject(expectedResponse);

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
      )).resolves.toMatchObject(
        hostedOwnerSessionId === interrupted.request.sessionId
          ? {
            revision: 5,
            status: 'completed',
            phase: 'finalizing',
            bindings: interrupted.bindings,
            terminalResult: { kind: 'completed' },
          }
          : {
            revision: 4,
            status: 'awaiting_user_resume',
            phase: 'finalizing',
            retryTargetPhase: 'finalizing',
            bindings: interrupted.bindings,
          },
      );
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
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: record.request.sessionId,
    }));
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
          revision: 6,
          status: 'completed',
          phase: 'finalizing',
          request: { targetStorageMode: 'external-linked' },
          currentStorageState: 'machine_only',
        },
      });

      expect(acquire).toHaveBeenCalledTimes(2);
      expect(loadCurrent).toHaveBeenCalledTimes(5);
      expect(suspendSession).toHaveBeenCalledTimes(2);
      expect(spawnResolvedTakeoverSession).toHaveBeenCalledOnce();
      expect(spawnSession).toHaveBeenCalledOnce();
      expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
        transcriptStorage: 'direct',
      }));
      expect(resumeSession).toHaveBeenCalledTimes(2);
      expect(publishProgress).toHaveBeenCalledTimes(6);
      const completed = await readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      );
      expect(completed).toMatchObject({
        revision: 6,
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
});
