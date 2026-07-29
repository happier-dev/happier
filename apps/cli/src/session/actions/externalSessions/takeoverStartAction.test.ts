import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';
import type {
  ExternalSessionOperationRecordV1,
  ExternalSessionOperationSemanticRequestV1,
  ExternalSessionOperationSocketCommandV1,
  ExternalSessionOperationSocketResponseV1,
  ExternalSessionTakeoverStartInputV1,
} from '@happier-dev/protocol';
import { resolveExternalSessionOperationTimelineV1 } from '@happier-dev/protocol';

import {
  createExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';
import {
  externalSessionOperationIdForRequest,
  readExternalSessionOperationRecord,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';
import {
  captureExternalSessionTakeoverSourceSnapshot,
  createExternalSessionTakeoverStartActionExecutor,
} from './takeoverStartAction';
import {
  createExternalSessionSourceGenerationAnchor,
} from './sourceGenerationAnchor';

const request = {
  v: 1,
  idempotencyKey: 'takeover-request-1',
  sessionId: 'session-1',
  source: {
    machineId: 'machine-1',
    remoteSessionId: 'remote-1',
    qualifiedIdentity: {
      v: 1,
      agent: {
        pluginId: 'com.example.agent',
        localId: 'example',
      },
      source: {
        kind: 'jsonl',
        contractVersion: 1,
      },
    },
    linkGeneration: 'link-1',
  },
  plan: 'takeover',
  targetStorageMode: 'persisted',
  targetRuntimeMode: 'terminal',
} satisfies ExternalSessionTakeoverStartInputV1['request'];

const semanticRequest = {
  ...request,
  source: {
    ...request.source,
    sourceGeneration: 'source-1',
    contributionGeneration: 'contribution-1',
  },
} satisfies Extract<
  ExternalSessionOperationSemanticRequestV1,
  { plan: 'takeover' }
>;

const externalLinkedRequest = {
  ...request,
  idempotencyKey: 'takeover-external-linked-1',
  targetStorageMode: 'external-linked',
} satisfies ExternalSessionTakeoverStartInputV1['request'];

const externalLinkedSemanticRequest = {
  ...semanticRequest,
  idempotencyKey: externalLinkedRequest.idempotencyKey,
  targetStorageMode: 'external-linked',
} satisfies Extract<
  ExternalSessionOperationSemanticRequestV1,
  { plan: 'takeover' }
>;

function describedSession(
  sourceGeneration = 'source-1',
  sourceSnapshotEvidenceRef = 'source-cursor-1',
) {
  return {
    request: {
      ...semanticRequest,
      source: {
        ...semanticRequest.source,
        sourceGeneration,
      },
    },
    sourceSnapshotEvidenceRef,
    linkedSessionRevision: 7,
    priorStableStorage: { state: 'machine_only' as const },
  };
}

function takeoverRecordFor(
  operationRequest: Extract<
    ExternalSessionOperationSemanticRequestV1,
    { plan: 'takeover' }
  > = semanticRequest,
) {
  return {
    v: 1 as const,
    operationId: externalSessionOperationIdForRequest(operationRequest),
    revision: 0,
    request: operationRequest,
    status: 'awaiting_user_resume' as const,
    phase: 'validating' as const,
    timeline: resolveExternalSessionOperationTimelineV1(operationRequest),
    createdAtMs: 1,
    updatedAtMs: 1,
    priorStableStorage: { state: 'machine_only' as const },
    currentStorageState: 'machine_only' as const,
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
      linkedSessionRevision: 7,
      sourceSnapshotEvidenceRef: 'source-cursor-1',
    },
    fence: { kind: 'none' as const },
    retryTargetPhase: 'validating' as const,
  };
}

async function inspectMachineOnly(
  command: ExternalSessionOperationSocketCommandV1,
): Promise<ExternalSessionOperationSocketResponseV1> {
  if (command.kind !== 'inspect') {
    throw new Error(`unexpected historical command ${command.kind}`);
  }
  return {
    v: 1,
    kind: 'authority',
    claim: command.claim,
    revision: command.expectedRevision,
    priorStableStorage: { state: 'machine_only' },
  };
}

describe('external-session durable takeover start', () => {
  it('returns a completed identical takeover as a stable no-op without reacquiring authority', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-start-completed-',
    ));
    const {
      retryTargetPhase: _retryTargetPhase,
      ...resumable
    } = takeoverRecordFor(externalLinkedSemanticRequest);
    const completed = {
      ...resumable,
      revision: 6,
      status: 'completed',
      phase: 'finalizing',
      updatedAtMs: 6,
      terminalResult: { kind: 'completed' },
    } satisfies ExternalSessionOperationRecordV1;
    const describeSession = vi.fn(async () => {
      throw new Error('completed takeover must not re-read its source');
    });
    const acquire = vi.fn(async () => {
      throw new Error('completed takeover must not reacquire exclusion');
    });
    const sendHistoricalCommand = vi.fn(async () => {
      throw new Error('completed takeover must not inspect authority');
    });
    const validateProgressSelection = vi.fn(async () => undefined);
    const publishProgress = vi.fn(async () => undefined);
    const convergeProgress = vi.fn(async (
      record: ExternalSessionOperationRecordV1,
    ) => record);

    try {
      await writeExternalSessionOperationRecord(activeServerDir, completed);
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        describeSession,
        sendHistoricalCommand,
        validateProgressSelection,
        publishProgress,
        convergeProgress,
      });

      const first = await executor.start({ request: externalLinkedRequest });
      const second = await executor.start({ request: externalLinkedRequest });

      expect(first).toEqual({
        ok: true,
        progress: expect.objectContaining({
          operationId: completed.operationId,
          revision: completed.revision,
          status: 'completed',
          phase: 'finalizing',
        }),
      });
      expect(second).toEqual(first);
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        completed.operationId,
      )).resolves.toEqual(completed);
      expect(publishProgress).not.toHaveBeenCalled();
      expect(convergeProgress).toHaveBeenCalledTimes(2);
      expect(describeSession).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(sendHistoricalCommand).not.toHaveBeenCalled();
      expect(validateProgressSelection).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('creates one durable external-linked takeover and converges the same semantic retry', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-start-'));
    const release = vi.fn(async () => undefined);
    const describeSession = vi.fn(async () => ({
      ...describedSession(),
      request: externalLinkedSemanticRequest,
    }));
    const publishProgress = vi.fn(async () => undefined);
    const acquire = vi.fn(async (operationRequest) => ({
      status: 'acquired' as const,
      claim: {
        record: {
          schemaVersion: 1 as const,
          claimId: 'private-claim-external',
          ownerId: 'takeover-start-test',
          request: operationRequest,
          acquiredAtMs: 1,
          renewedAtMs: 1,
          expiresAtMs: 20_001,
        },
        renew: async () => true,
        release,
      },
    }));
    const spawn = vi.fn();
    try {
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        describeSession,
        sendHistoricalCommand: inspectMachineOnly,
        validateProgressSelection: async () => undefined,
        publishProgress,
      });

      const first = await executor.start({ request: externalLinkedRequest });
      expect(first).toMatchObject({
        ok: true,
        progress: {
          request: {
            plan: 'takeover',
            targetStorageMode: 'external-linked',
            targetRuntimeMode: 'terminal',
          },
          status: 'awaiting_user_resume',
          phase: 'validating',
          revision: 0,
        },
      });
      await expect(executor.start({ request: externalLinkedRequest }))
        .resolves.toEqual(first);
      expect(describeSession).toHaveBeenCalledOnce();
      expect(acquire).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();

      const stored = await readExternalSessionOperationRecord(
        activeServerDir,
        externalSessionOperationIdForRequest(externalLinkedSemanticRequest),
      );
      expect(stored).toMatchObject({
        request: externalLinkedSemanticRequest,
        timeline: [
          'validating',
          'quiescing',
          'admitting',
          'spawning',
          'finalizing',
        ],
      });

      await expect(executor.start({
        request: {
          ...externalLinkedRequest,
          targetStorageMode: 'persisted',
        },
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'operation_conflict' },
      });
      expect(describeSession).toHaveBeenCalledOnce();
      expect(acquire).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('captures a bounded qualified Codex multi-stream cursor as private source evidence', async () => {
    const multiStreamCursor = Buffer.from(JSON.stringify({
      v: 6,
      kind: 'codexForwardStreamVector',
      sourceGeneration: ['home-generation', 'sessions-generation'],
      streams: [
        { id: 'rollout', cursor: 'rollout-cursor-1' },
        { id: 'app-server', cursor: 'app-server-cursor-1' },
      ],
    }), 'utf8').toString('base64url');

    await expect(captureExternalSessionTakeoverSourceSnapshot(
      async () => ({ tailCursor: multiStreamCursor }),
    )).resolves.toEqual({
      sourceGeneration:
        createExternalSessionSourceGenerationAnchor(multiStreamCursor),
      sourceSnapshotEvidenceRef: multiStreamCursor,
    });
  });

  it('fails closed when the source cannot provide a nonempty qualified cursor', async () => {
    await expect(captureExternalSessionTakeoverSourceSnapshot(
      async () => ({ tailCursor: null }),
    )).rejects.toThrow('external_session_takeover_start_source_unavailable');
    await expect(captureExternalSessionTakeoverSourceSnapshot(
      async () => ({ tailCursor: '' }),
    )).rejects.toThrow('external_session_takeover_start_source_unavailable');
  });

  it('returns internal_error without effects when the canonical record is corrupt', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-start-'));
    const operationId = externalSessionOperationIdForRequest(semanticRequest);
    const key = createHash('sha256').update(operationId, 'utf8').digest('hex');
    const recordsDir = join(
      activeServerDir,
      'external-session-operations',
      'records',
    );
    const acquire = vi.fn();
    const describeSession = vi.fn(async () => describedSession());
    const publishProgress = vi.fn();
    try {
      await mkdir(recordsDir, { recursive: true });
      await writeFile(join(recordsDir, `${key}.json`), '{"v":', 'utf8');
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        describeSession,
        sendHistoricalCommand: inspectMachineOnly,
        validateProgressSelection: vi.fn(),
        publishProgress,
      });

      await expect(executor.start({ request })).resolves.toEqual({
        ok: false,
        error: {
          code: 'internal_error',
          message: 'Takeover operation record could not be read.',
        },
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(describeSession).not.toHaveBeenCalled();
      expect(publishProgress).not.toHaveBeenCalled();
      await expect(readFile(join(recordsDir, `${key}.json`), 'utf8')).resolves.toBe('{"v":');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('commits one canonical resumable record before publishing public-safe progress', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-start-'));
    const release = vi.fn(async () => undefined);
    const publishProgress = vi.fn(async () => undefined);
    const priorPublication = {
      materializationPublicationId: 'publication-prior',
      materializedThroughSourceAt: 100,
      publishedThroughServerSeq: 4,
    } as const;
    try {
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'acquired' as const,
            claim: {
              record: {
                schemaVersion: 1 as const,
                claimId: 'private-claim-1',
                ownerId: 'takeover-start-test',
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
        describeSession: async () => describedSession(),
        sendHistoricalCommand: async (command) => ({
          v: 1,
          kind: 'authority' as const,
          claim: command.claim,
          revision: command.expectedRevision,
          priorStableStorage: {
            state: 'snapshot_complete' as const,
            publication: priorPublication,
          },
        }),
        validateProgressSelection: async () => undefined,
        publishProgress,
      });

      const result = await executor.start({ request });
      expect(result).toMatchObject({
        ok: true,
        progress: {
          request: {
            plan: 'takeover',
            targetStorageMode: 'persisted',
            targetRuntimeMode: 'terminal',
          },
          status: 'awaiting_user_resume',
          phase: 'validating',
          revision: 0,
        },
      });
      if (!result.ok) throw new Error('expected takeover start success');
      const record = await readExternalSessionOperationRecord(
        activeServerDir,
        result.progress.operationId,
      );
      expect(record?.bindings.operationClaimId).toBe('private-claim-1');
      expect(record).toMatchObject({
        priorStableStorage: {
          state: 'snapshot_complete',
          publication: priorPublication,
        },
        currentStorageState: 'snapshot_complete',
        publication: priorPublication,
      });
      expect(record?.request.source).toMatchObject({
        linkGeneration: 'link-1',
        sourceGeneration: 'source-1',
        contributionGeneration: 'contribution-1',
      });
      expect(record?.canonicalOwnerEvidence.sourceSnapshotEvidenceRef)
        .toBe('source-cursor-1');
      expect(publishProgress).toHaveBeenCalledOnce();
      expect(JSON.stringify(publishProgress.mock.calls)).not.toContain('private-claim-1');
      expect(JSON.stringify(publishProgress.mock.calls)).not.toContain('source-1');
      expect(JSON.stringify(publishProgress.mock.calls)).not.toContain('contribution-1');
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('rejects stale public link intent before acquiring an exclusion or writing a record', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-start-'));
    const acquire = vi.fn();
    const publishProgress = vi.fn();
    try {
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        describeSession: vi.fn(async () => {
          throw new Error('external_session_takeover_start_source_changed');
        }),
        sendHistoricalCommand: inspectMachineOnly,
        validateProgressSelection: vi.fn(),
        publishProgress,
      });

      await expect(executor.start({ request })).resolves.toEqual({
        ok: false,
        error: {
          code: 'source_unavailable',
          message: 'Linked external session identity changed.',
        },
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(publishProgress).not.toHaveBeenCalled();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        externalSessionOperationIdForRequest(semanticRequest),
      )).resolves.toBeNull();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('surfaces dual-row metadata disagreement before takeover exclusion or persistence', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-reconciliation-'));
    const acquire = vi.fn();
    const publishProgress = vi.fn();
    try {
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        describeSession: vi.fn(async () => {
          throw new Error('linked_session_reconciliation_required');
        }),
        sendHistoricalCommand: inspectMachineOnly,
        validateProgressSelection: vi.fn(),
        publishProgress,
      });

      await expect(executor.start({ request })).resolves.toEqual({
        ok: false,
        error: {
          code: 'reconciliation_required',
          message: 'Linked external session metadata requires reconciliation.',
        },
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(publishProgress).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('republishes the same committed record on retry after publication fails', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-start-'));
    const release = vi.fn(async () => undefined);
    const acquire = vi.fn(async (operationRequest) => ({
      status: 'acquired' as const,
      claim: {
        record: {
          schemaVersion: 1 as const,
          claimId: 'private-claim-1',
          ownerId: 'takeover-start-test',
          request: operationRequest,
          acquiredAtMs: 1,
          renewedAtMs: 1,
          expiresAtMs: 20_001,
        },
        renew: async () => true,
        release,
      },
    }));
    const publishProgress = vi.fn()
      .mockRejectedValueOnce(new Error('publish_failed'))
      .mockResolvedValueOnce(undefined);
    try {
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        describeSession: async () => describedSession(),
        sendHistoricalCommand: inspectMachineOnly,
        validateProgressSelection: async () => undefined,
        publishProgress,
      });

      await expect(executor.start({ request })).resolves.toMatchObject({
        ok: false,
        error: { code: 'internal_error' },
      });
      await expect(executor.start({ request })).resolves.toMatchObject({
        ok: true,
        progress: { operationId: externalSessionOperationIdForRequest(semanticRequest) },
      });
      expect(acquire).toHaveBeenCalledOnce();
      expect(publishProgress).toHaveBeenCalledTimes(2);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('blocks a different start from a hidden unpublished nonterminal row with zero new effects', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-start-'));
    const release = vi.fn(async () => undefined);
    const acquire = vi.fn(async (operationRequest) => ({
      status: 'acquired' as const,
      claim: {
        record: {
          schemaVersion: 1 as const,
          claimId: 'private-claim-1',
          ownerId: 'takeover-start-test',
          request: operationRequest,
          acquiredAtMs: 1,
          renewedAtMs: 1,
          expiresAtMs: 20_001,
        },
        renew: async () => true,
        release,
      },
    }));
    try {
      const firstExecutor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        describeSession: async () => describedSession(),
        sendHistoricalCommand: inspectMachineOnly,
        validateProgressSelection: async () => undefined,
        publishProgress: async () => {
          throw new Error('publish_failed');
        },
      });
      await expect(firstExecutor.start({ request })).resolves.toMatchObject({
        ok: false,
        error: { code: 'internal_error' },
      });

      acquire.mockClear();
      const differentRequest = {
        ...request,
        idempotencyKey: 'takeover-request-2',
      } satisfies ExternalSessionTakeoverStartInputV1['request'];
      const describeDifferent = vi.fn();
      const publishDifferent = vi.fn();
      const secondExecutor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        describeSession: describeDifferent,
        sendHistoricalCommand: inspectMachineOnly,
        validateProgressSelection: vi.fn(),
        publishProgress: publishDifferent,
      });

      await expect(secondExecutor.start({ request: differentRequest })).resolves.toEqual({
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'Another external-session operation is active.',
        },
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(describeDifferent).not.toHaveBeenCalled();
      expect(publishDifferent).not.toHaveBeenCalled();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        externalSessionOperationIdForRequest(differentRequest),
      )).resolves.toBeNull();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('republishes the stored row without recapturing an appended physical source', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-start-'));
    const release = vi.fn(async () => undefined);
    const acquire = vi.fn(async (operationRequest) => ({
      status: 'acquired' as const,
      claim: {
        record: {
          schemaVersion: 1 as const,
          claimId: 'private-claim-1',
          ownerId: 'takeover-start-test',
          request: operationRequest,
          acquiredAtMs: 1,
          renewedAtMs: 1,
          expiresAtMs: 20_001,
        },
        renew: async () => true,
        release,
      },
    }));
    try {
      const first = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        describeSession: async () => describedSession('source-1', 'cursor-1'),
        sendHistoricalCommand: inspectMachineOnly,
        validateProgressSelection: async () => undefined,
        publishProgress: async () => {
          throw new Error('publish_failed');
        },
      });
      await expect(first.start({ request })).resolves.toMatchObject({
        ok: false,
        error: { code: 'internal_error' },
      });

      acquire.mockClear();
      const recaptureAfterAppend = vi.fn(
        async () => describedSession('source-2', 'cursor-2'),
      );
      const publishRetry = vi.fn(async () => undefined);
      const second = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        describeSession: recaptureAfterAppend,
        sendHistoricalCommand: inspectMachineOnly,
        validateProgressSelection: async () => undefined,
        publishProgress: publishRetry,
      });
      await expect(second.start({ request })).resolves.toMatchObject({
        ok: true,
        progress: {
          operationId: externalSessionOperationIdForRequest(semanticRequest),
        },
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(recaptureAfterAppend).not.toHaveBeenCalled();
      expect(publishRetry).toHaveBeenCalledOnce();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        externalSessionOperationIdForRequest(semanticRequest),
      )).resolves.toMatchObject({
        request: {
          source: {
            sourceGeneration: 'source-1',
          },
        },
        canonicalOwnerEvidence: {
          sourceSnapshotEvidenceRef: 'cursor-1',
        },
      });
      await expect(second.start({
        request: {
          ...request,
          source: {
            ...request.source,
            linkGeneration: 'link-2',
          },
        },
      })).resolves.toEqual({
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'Takeover idempotency request changed.',
        },
      });
      expect(recaptureAfterAppend).not.toHaveBeenCalled();
      expect(publishRetry).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('republishes a record committed by the converged start race before returning success', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-start-'));
    const publishProgress = vi.fn(async () => undefined);
    try {
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => {
            await writeExternalSessionOperationRecord(
              activeServerDir,
              takeoverRecordFor(),
            );
            return {
              status: 'converged' as const,
              active: {
                schemaVersion: 1 as const,
                claimId: 'private-claim-1',
                ownerId: 'other-start',
                request: operationRequest,
                acquiredAtMs: 1,
                renewedAtMs: 1,
                expiresAtMs: 20_001,
              },
            };
          }),
        },
        describeSession: async () => describedSession(),
        sendHistoricalCommand: inspectMachineOnly,
        validateProgressSelection: async () => undefined,
        publishProgress,
      });

      await expect(executor.start({ request })).resolves.toEqual({
        ok: true,
        progress: expect.objectContaining({
          operationId: externalSessionOperationIdForRequest(semanticRequest),
        }),
      });
      expect(publishProgress).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('maps a canonical claim-wait failure into the strict typed Start result', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-start-wait-failure-'));
    try {
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'converged' as const,
            active: {
              schemaVersion: 1 as const,
              claimId: 'private-claim-1',
              ownerId: 'other-start',
              request: operationRequest,
              acquiredAtMs: 1,
              renewedAtMs: 1,
              expiresAtMs: 20_001,
            },
            waitForRelease: async () => ({
              status: 'failed' as const,
              reason: 'watch_iteration_failed' as const,
            }),
          })),
        } as never,
        describeSession: async () => describedSession(),
        sendHistoricalCommand: inspectMachineOnly,
        validateProgressSelection: async () => undefined,
        publishProgress: async () => undefined,
      });

      await expect(executor.start({ request })).resolves.toEqual({
        ok: false,
        error: {
          code: 'internal_error',
          message: 'Takeover operation convergence could not be observed.',
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('settles a converged Start when its caller cancellation signal aborts', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-start-cancel-'));
    const firstExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'first-start',
      ttlMs: 10_000,
    });
    let notifyClaimChanged!: () => void;
    const claimChanged = new Promise<void>((resolve) => {
      notifyClaimChanged = resolve;
    });
    const watcher = {
      next: vi.fn(async () => {
        await claimChanged;
        return {
          done: false as const,
          value: { eventType: 'rename' as const, filename: 'claim.json' },
        };
      }),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const secondExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'cancelled-start',
      ttlMs: 10_000,
      watchClaimChanges: vi.fn(() => watcher) as unknown as
        typeof import('node:fs/promises').watch,
    });
    const first = await firstExclusion.acquire({
      kind: 'takeover',
      sessionId: semanticRequest.sessionId,
      requestId: semanticRequest.idempotencyKey,
      sourceIdentity: JSON.stringify(semanticRequest.source.qualifiedIdentity),
      sourceGeneration: semanticRequest.source.sourceGeneration,
      plan: semanticRequest.targetStorageMode,
    });
    if (first.status !== 'acquired') {
      throw new Error('expected first owner acquisition');
    }
    let observedConvergence!: () => void;
    const convergenceObserved = new Promise<void>((resolve) => {
      observedConvergence = resolve;
    });
    const acquire = vi.fn(async (
      input: Parameters<typeof secondExclusion.acquire>[0],
    ) => {
      const result = await secondExclusion.acquire(input);
      if (result.status === 'converged') observedConvergence();
      return result;
    });
    const executor = createExternalSessionTakeoverStartActionExecutor({
      activeServerDir,
      operationExclusion: { acquire },
      describeSession: async () => describedSession(),
      sendHistoricalCommand: inspectMachineOnly,
      validateProgressSelection: async () => undefined,
      publishProgress: async () => undefined,
    });
    const controller = new AbortController();
    const result = executor.start(
      { request },
      { signal: controller.signal },
    );
    let cancellationAssertionTimer: NodeJS.Timeout | null = null;
    try {
      await convergenceObserved;
      controller.abort();
      await expect(Promise.race([
        result,
        new Promise((resolve) => {
          cancellationAssertionTimer = setTimeout(
            () => resolve('start_did_not_observe_cancellation'),
            500,
          );
        }),
      ])).resolves.toEqual({
        ok: false,
        error: {
          code: 'internal_error',
          message: 'Takeover operation convergence could not be observed.',
        },
      });
    } finally {
      if (cancellationAssertionTimer) {
        clearTimeout(cancellationAssertionTimer);
      }
      await first.claim.release();
      notifyClaimChanged();
      await result;
      await rm(activeServerDir, { recursive: true, force: true });
    }
  }, 3_000);

  it('reaps an expired same-semantic owner with no final write and completes Start', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-start-expiry-'));
    const firstExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'crashed-start',
      ttlMs: 30,
    });
    const secondExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'replacement-start',
      ttlMs: 10_000,
    });
    const orphaned = await firstExclusion.acquire({
      kind: 'takeover',
      sessionId: semanticRequest.sessionId,
      requestId: semanticRequest.idempotencyKey,
      sourceIdentity: JSON.stringify(semanticRequest.source.qualifiedIdentity),
      sourceGeneration: semanticRequest.source.sourceGeneration,
      plan: semanticRequest.targetStorageMode,
    });
    if (orphaned.status !== 'acquired') {
      throw new Error('expected orphaned owner acquisition');
    }
    const sendHistoricalCommand = vi.fn(inspectMachineOnly);
    try {
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: secondExclusion,
        describeSession: async () => describedSession(),
        sendHistoricalCommand,
        validateProgressSelection: async () => undefined,
        publishProgress: async () => undefined,
      });

      await expect(executor.start({ request })).resolves.toMatchObject({
        ok: true,
        progress: {
          operationId: externalSessionOperationIdForRequest(semanticRequest),
        },
      });
      expect(sendHistoricalCommand).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  }, 1_000);

  it('converges identical concurrent starts held beyond the former claim-visible polling window', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-start-window-'));
    const firstExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'first-start',
    });
    let notifyClaimChanged!: () => void;
    const claimChanged = new Promise<void>((resolve) => {
      notifyClaimChanged = resolve;
    });
    const watcher = {
      next: vi.fn(async () => {
        await claimChanged;
        return {
          done: false as const,
          value: { eventType: 'rename' as const, filename: 'claim.json' },
        };
      }),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const secondExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'second-start',
      watchClaimChanges: vi.fn(() => watcher) as unknown as
        typeof import('node:fs/promises').watch,
    });
    let releaseAuthority!: () => void;
    const authorityGate = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    let observedConvergence!: () => void;
    const convergenceObserved = new Promise<void>((resolve) => {
      observedConvergence = resolve;
    });
    const secondAcquire = vi.fn(async (
      input: Parameters<typeof secondExclusion.acquire>[0],
    ) => {
      const result = await secondExclusion.acquire(input);
      if (result.status === 'converged') observedConvergence();
      return result;
    });
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      await authorityGate;
      return inspectMachineOnly(command);
    });
    try {
      const first = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: firstExclusion,
        describeSession: async () => describedSession(),
        sendHistoricalCommand,
        validateProgressSelection: async () => undefined,
        publishProgress: async () => undefined,
      });
      const second = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: { acquire: secondAcquire },
        describeSession: async () => describedSession(),
        sendHistoricalCommand,
        validateProgressSelection: async () => undefined,
        publishProgress: async () => undefined,
      });

      const firstResult = first.start({ request });
      await vi.waitFor(() => {
        expect(sendHistoricalCommand).toHaveBeenCalledOnce();
      });
      const secondResult = second.start({ request });
      let secondSettled = false;
      void secondResult.finally(() => {
        secondSettled = true;
      });
      await convergenceObserved;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(secondSettled).toBe(false);
      releaseAuthority();

      const firstResponse = await firstResult;
      notifyClaimChanged();
      const secondResponse = await secondResult;
      expect(firstResponse).toMatchObject({
        ok: true,
        progress: {
          operationId: externalSessionOperationIdForRequest(semanticRequest),
        },
      });
      expect(secondResponse).toEqual(firstResponse);
      expect(sendHistoricalCommand).toHaveBeenCalledOnce();
      expect(watcher.return).toHaveBeenCalledOnce();
    } finally {
      releaseAuthority();
      notifyClaimChanged();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
