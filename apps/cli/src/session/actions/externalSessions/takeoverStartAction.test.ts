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
import {
  projectExternalSessionOperationProgressV1,
  projectExternalSessionOperationSharedPresentationV1,
  resolveExternalSessionOperationTimelineV1,
} from '@happier-dev/protocol';

import {
  createExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';
import {
  convergeExternalSessionOperationProgressProjection,
} from './operationProgressPublisher';
import {
  acknowledgeExternalSessionOperationProgressProjection,
  compactExternalSessionOperationRecordToCompletionReceipt,
  listExternalSessionOperationRecords,
  readExternalSessionOperationRecord,
  readExternalSessionOperationStoredEntry,
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
  targetDirectory: '/local/selected/workspace',
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

const changedTakeoverPublicIntents = [
  {
    field: 'sessionId',
    change: (input: ExternalSessionTakeoverStartInputV1['request']) => ({
      ...input,
      sessionId: 'session-2',
    }),
  },
  {
    field: 'machineId',
    change: (input: ExternalSessionTakeoverStartInputV1['request']) => ({
      ...input,
      source: { ...input.source, machineId: 'machine-2' },
    }),
  },
  {
    field: 'linkGeneration',
    change: (input: ExternalSessionTakeoverStartInputV1['request']) => ({
      ...input,
      source: { ...input.source, linkGeneration: 'link-2' },
    }),
  },
] satisfies readonly Readonly<{
  field: string;
  change: (
    input: ExternalSessionTakeoverStartInputV1['request'],
  ) => ExternalSessionTakeoverStartInputV1['request'];
}>[];

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
  >,
  operationId: string,
) {
  return {
    v: 1 as const,
    operationId,
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

async function compactCompletedExternalLinkedTakeover(input: Readonly<{
  activeServerDir: string;
  completedAtMs: number;
}>): Promise<ExternalSessionOperationRecordV1> {
  const {
    retryTargetPhase: _retryTargetPhase,
    ...resumable
  } = takeoverRecordFor(
    externalLinkedSemanticRequest,
    'external-takeover:completed-external-linked-fixture',
  );
  const completed = {
    ...resumable,
    revision: 6,
    status: 'completed',
    phase: 'finalizing',
    updatedAtMs: input.completedAtMs,
    progressProjection: { acknowledgedRevision: null },
    terminalResult: { kind: 'completed' },
  } satisfies ExternalSessionOperationRecordV1;
  await writeExternalSessionOperationRecord(input.activeServerDir, completed);
  await acknowledgeExternalSessionOperationProgressProjection({
    activeServerDir: input.activeServerDir,
    operationId: completed.operationId,
    projectedRevision: completed.revision,
  });
  await expect(compactExternalSessionOperationRecordToCompletionReceipt({
    activeServerDir: input.activeServerDir,
    operationId: completed.operationId,
    expectedRevision: completed.revision,
    stagingDisposition: 'not_applicable',
  })).resolves.toMatchObject({ status: 'compacted' });
  return completed;
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
  it.each(changedTakeoverPublicIntents)(
    'rejects changed $field against an unexpired receipt before source or exclusion effects',
    async ({ change }) => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-start-receipt-conflict-',
    ));
    const completedAtMs = 25_000;
    const describeSession = vi.fn();
    const acquire = vi.fn();
    const sendHistoricalCommand = vi.fn();
    const validateProgressSelection = vi.fn();
    const publishProgress = vi.fn();
    try {
      await compactCompletedExternalLinkedTakeover({
        activeServerDir,
        completedAtMs,
      });
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        describeSession,
        sendHistoricalCommand,
        validateProgressSelection,
        publishProgress,
        nowMs: () => completedAtMs + 86_400_000 - 1,
      });

      await expect(executor.start({
        request: change(externalLinkedRequest),
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'operation_conflict' },
      });
      expect(describeSession).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(sendHistoricalCommand).not.toHaveBeenCalled();
      expect(validateProgressSelection).not.toHaveBeenCalled();
      expect(publishProgress).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
    },
  );

  it('converges concurrent public Starts on one acknowledged successor before removing its selected expired receipt', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-start-expired-receipt-',
    ));
    const completedAtMs = 25_000;
    const nowMs = completedAtMs + 86_400_000;
    const firstExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'expired-receipt-successor-first-start',
    });
    const secondExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'expired-receipt-successor-second-start',
    });
    const describeSession = vi.fn(async () => ({
      ...describedSession(),
      request: externalLinkedSemanticRequest,
    }));
    let releaseAuthority!: () => void;
    const authorityGate = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      await authorityGate;
      return inspectMachineOnly(command);
    });
    let secondConverged!: () => void;
    const secondConvergence = new Promise<void>((resolve) => {
      secondConverged = resolve;
    });
    const secondAcquire = vi.fn(async (
      ...args: Parameters<typeof secondExclusion.acquire>
    ) => {
      const acquired = await secondExclusion.acquire(...args);
      if (acquired.status === 'converged') secondConverged();
      return acquired;
    });
    const authorIntent = {
      v: 1 as const,
      surface: 'plugin' as const,
      kind: 'takeover' as const,
      agentId: 'example',
      sourceId: 'codexHome:user:::',
      remoteSessionId: externalLinkedRequest.source.remoteSessionId,
      targetStorageMode: 'external-linked' as const,
    };
    let firstResult:
      ReturnType<ReturnType<
        typeof createExternalSessionTakeoverStartActionExecutor
      >['startPluginTakeover']> | undefined;
    let secondResult: typeof firstResult;
    try {
      const expired = await compactCompletedExternalLinkedTakeover({
        activeServerDir,
        completedAtMs,
      });
      const predecessorPresentation =
        projectExternalSessionOperationSharedPresentationV1(
          projectExternalSessionOperationProgressV1(expired),
        );
      let selectedPresentation = predecessorPresentation;
      const readSelectedPresentation = vi.fn(async () => ({
        kind: 'valid' as const,
        presentation: selectedPresentation,
      }));
      const validateProgressSelection = vi.fn(async ({
          priorTerminalReceiptEvidence,
        }: Parameters<Parameters<
          typeof createExternalSessionTakeoverStartActionExecutor
        >[0]['validateProgressSelection']>[0]) => {
        expect(priorTerminalReceiptEvidence).toEqual([{
          reference: {
            sessionId: expired.request.sessionId,
            operationId: expired.operationId,
            revision: expired.revision,
          },
          presentation: predecessorPresentation,
        }]);
        return predecessorPresentation;
      });
      const publishSelectedPresentation = vi.fn(async (input: Readonly<{
        progress: ReturnType<typeof projectExternalSessionOperationProgressV1>;
        expectedDifferentTerminalPresentation?:
          typeof predecessorPresentation;
      }>) => {
        expect(input.expectedDifferentTerminalPresentation).toEqual(
          predecessorPresentation,
        );
        await expect(readExternalSessionOperationStoredEntry(
          activeServerDir,
          expired.operationId,
        )).resolves.toMatchObject({ kind: 'completion_receipt' });
        await expect(readExternalSessionOperationRecord(
          activeServerDir,
          input.progress.operationId,
        )).resolves.toMatchObject({
          progressProjection: { acknowledgedRevision: null },
        });
        selectedPresentation =
          projectExternalSessionOperationSharedPresentationV1(input.progress);
      });
      const convergeProgress = async (
        record: ExternalSessionOperationRecordV1,
      ): Promise<ExternalSessionOperationRecordV1> => {
        await convergeExternalSessionOperationProgressProjection(
          activeServerDir,
          record,
          {
            allowSettledTerminalPredecessorReplacement: true,
            readPresentation: readSelectedPresentation,
            publish: publishSelectedPresentation,
          },
        );
        const converged = await readExternalSessionOperationRecord(
          activeServerDir,
          record.operationId,
        );
        if (!converged) {
          throw new Error('Expected the successor full record to remain.');
        }
        return converged;
      };
      const dependencies = {
        activeServerDir,
        describeSession,
        sendHistoricalCommand,
        validateProgressSelection,
        publishProgress: async (input: Parameters<
          Parameters<
            typeof createExternalSessionTakeoverStartActionExecutor
          >[0]['publishProgress']
        >[0]) => {
          const record = await readExternalSessionOperationRecord(
            activeServerDir,
            input.progress.operationId,
          );
          if (!record) throw new Error('Expected a durable successor record.');
          return await convergeProgress(record);
        },
        convergeProgress,
        nowMs: () => nowMs,
        readSelectedPresentation,
      };
      const first = createExternalSessionTakeoverStartActionExecutor({
        ...dependencies,
        operationExclusion: firstExclusion,
      });
      const second = createExternalSessionTakeoverStartActionExecutor({
        ...dependencies,
        operationExclusion: { acquire: secondAcquire },
      });

      firstResult = first.startPluginTakeover(
        { request: externalLinkedRequest },
        { authorIntent },
      );
      await vi.waitFor(() => {
        expect(sendHistoricalCommand).toHaveBeenCalledOnce();
      });
      secondResult = second.startPluginTakeover(
        { request: externalLinkedRequest },
        { authorIntent },
      );
      await secondConvergence;

      await expect(readExternalSessionOperationStoredEntry(
        activeServerDir,
        expired.operationId,
      )).resolves.toMatchObject({
        kind: 'completion_receipt',
        receipt: { presentation: predecessorPresentation },
      });
      releaseAuthority();

      const [firstResponse, secondResponse] = await Promise.all([
        firstResult,
        secondResult,
      ]);
      expect(firstResponse).toMatchObject({ ok: true });
      expect(secondResponse).toEqual(firstResponse);
      if (!firstResponse.ok) {
        throw new Error('Expected fresh takeover Start success.');
      }
      expect(firstResponse.operation.operationId).not.toBe(
        expired.operationId,
      );
      expect(firstResponse.operation.operationId).toMatch(
        /^external-takeover:/u,
      );
      expect(sendHistoricalCommand).toHaveBeenCalledOnce();
      expect(validateProgressSelection).toHaveBeenCalledOnce();
      expect(publishSelectedPresentation).toHaveBeenCalledOnce();
      await expect(readExternalSessionOperationStoredEntry(
        activeServerDir,
        expired.operationId,
      )).resolves.toBeNull();
      const records = await listExternalSessionOperationRecords(
        activeServerDir,
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        operationId: firstResponse.operation.operationId,
        request: externalLinkedSemanticRequest,
        authorIntent,
        status: 'awaiting_user_resume',
        progressProjection: { acknowledgedRevision: 0 },
      });
    } finally {
      releaseAuthority();
      await Promise.allSettled([
        ...(firstResult ? [firstResult] : []),
        ...(secondResult ? [secondResult] : []),
      ]);
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('returns a completed identical takeover as a stable no-op without reacquiring authority', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-start-completed-',
    ));
    const {
      retryTargetPhase: _retryTargetPhase,
      ...resumable
    } = takeoverRecordFor(
      externalLinkedSemanticRequest,
      'external-takeover:compacted-external-linked-fixture',
    );
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
            targetDirectory: externalLinkedRequest.targetDirectory,
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
        first.ok ? first.progress.operationId : 'unexpected-failed-start',
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

  it('carries host-stamped plugin author intent through canonical Start and replays before source effects', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-plugin-takeover-start-',
    ));
    const release = vi.fn(async () => undefined);
    const describeSession = vi.fn(async () => ({
      ...describedSession(),
      request: externalLinkedSemanticRequest,
    }));
    const authorIntent = {
      v: 1 as const,
      surface: 'plugin' as const,
      kind: 'takeover' as const,
      agentId: 'example',
      sourceId: 'codexHome:user:::',
      remoteSessionId: externalLinkedRequest.source.remoteSessionId,
      targetStorageMode: 'external-linked' as const,
    };
    try {
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'acquired' as const,
            claim: {
              record: {
                schemaVersion: 1 as const,
                claimId: 'plugin-private-claim-1',
                ownerId: 'plugin-takeover-start-test',
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
        describeSession,
        sendHistoricalCommand: inspectMachineOnly,
        validateProgressSelection: async () => undefined,
        publishProgress: async () => undefined,
      });

      const first = await executor.startPluginTakeover(
        { request: externalLinkedRequest },
        { authorIntent },
      );
      if (!first.ok) {
        throw new Error(`expected plugin takeover admission: ${JSON.stringify(first)}`);
      }
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        first.operation.operationId,
      )).resolves.toMatchObject({ authorIntent });

      await expect(executor.startPluginTakeover(
        { request: externalLinkedRequest },
        { authorIntent },
      )).resolves.toEqual(first);
      expect(describeSession).toHaveBeenCalledOnce();

      await expect(executor.startPluginTakeover(
        { request: externalLinkedRequest },
        {
          authorIntent: {
            ...authorIntent,
            remoteSessionId: 'changed-remote-session',
          },
        },
      )).resolves.toMatchObject({
        ok: false,
        error: { code: 'operation_conflict' },
      });
      expect(describeSession).toHaveBeenCalledOnce();
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
    const operationId = 'external-takeover:corrupt-record-fixture';
    const key = createHash('sha256').update(operationId, 'utf8').digest('hex');
    const recordsDir = join(
      activeServerDir,
      'external-session-operations',
      'by-account',
      `sub-${createHash('sha256').update('vitest', 'utf8').digest('hex').slice(0, 32)}`,
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
          message: 'Takeover operation inventory could not be read.',
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
            targetDirectory: request.targetDirectory,
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

  it('rejects an unknown selected terminal before committing a takeover successor', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-unknown-predecessor-',
    ));
    const release = vi.fn(async () => undefined);
    const publishProgress = vi.fn(async () => undefined);
    const validateProgressSelection = vi.fn(async (input) => {
      expect(input.priorTerminalRecords).toEqual([]);
      throw new Error('external_session_operation_projection_conflict');
    });
    try {
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: vi.fn(async (operationRequest) => ({
            status: 'acquired' as const,
            claim: {
              record: {
                schemaVersion: 1 as const,
                claimId: 'unknown-predecessor-claim',
                ownerId: 'takeover-unknown-predecessor-test',
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
        sendHistoricalCommand: inspectMachineOnly,
        validateProgressSelection,
        publishProgress,
      });

      await expect(executor.start({ request })).resolves.toMatchObject({
        ok: false,
        error: { code: 'operation_conflict' },
      });
      expect(validateProgressSelection).toHaveBeenCalledOnce();
      expect(publishProgress).not.toHaveBeenCalled();
      await expect(listExternalSessionOperationRecords(
        activeServerDir,
      )).resolves.toEqual([]);
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
      await expect(listExternalSessionOperationRecords(
        activeServerDir,
      )).resolves.toEqual([]);
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
      const retried = await executor.start({ request });
      expect(retried).toMatchObject({
        ok: true,
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
      const recordsAfterFirstStart =
        await listExternalSessionOperationRecords(activeServerDir);
      expect(recordsAfterFirstStart).toHaveLength(1);

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

      await expect(secondExecutor.start({ request: differentRequest })).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'operation_conflict',
        },
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(describeDifferent).not.toHaveBeenCalled();
      expect(publishDifferent).not.toHaveBeenCalled();
      await expect(listExternalSessionOperationRecords(
        activeServerDir,
      )).resolves.toEqual(recordsAfterFirstStart);
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
      const retry = await second.start({ request });
      expect(retry).toMatchObject({
        ok: true,
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(recaptureAfterAppend).not.toHaveBeenCalled();
      expect(publishRetry).toHaveBeenCalledOnce();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        retry.ok ? retry.progress.operationId : 'unexpected-failed-retry',
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
      for (const { change } of changedTakeoverPublicIntents) {
        await expect(second.start({
          request: change(request),
        })).resolves.toEqual({
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'Takeover idempotency request changed.',
          },
        });
      }
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
              takeoverRecordFor(
                semanticRequest,
                'external-takeover:converged-owner-fixture',
              ),
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
          operationId: 'external-takeover:converged-owner-fixture',
        }),
      });
      expect(publishProgress).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('returns invalid_state when a completion receipt appears while waiting for a converged owner', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-start-wait-receipt-',
    ));
    const completedAtMs = 25_000;
    const describeSession = vi.fn(async () => ({
      ...describedSession(),
      request: externalLinkedSemanticRequest,
    }));
    const sendHistoricalCommand = vi.fn();
    const validateProgressSelection = vi.fn();
    const publishProgress = vi.fn();
    const convergeProgress = vi.fn();
    const acquire = vi.fn(async (operationRequest) => ({
      status: 'converged' as const,
      active: {
        schemaVersion: 1 as const,
        claimId: 'private-claim-completed-during-wait',
        ownerId: 'other-start',
        request: operationRequest,
        acquiredAtMs: 1,
        renewedAtMs: 1,
        expiresAtMs: 20_001,
      },
      waitForRelease: async () => {
        await compactCompletedExternalLinkedTakeover({
          activeServerDir,
          completedAtMs,
        });
        return { status: 'ready' as const };
      },
    }));
    try {
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        describeSession,
        sendHistoricalCommand,
        validateProgressSelection,
        publishProgress,
        convergeProgress,
        nowMs: () => completedAtMs,
      });

      await expect(executor.start({ request: externalLinkedRequest }))
        .resolves.toMatchObject({
          ok: false,
          error: { code: 'invalid_state' },
        });
      expect(describeSession).toHaveBeenCalledOnce();
      expect(acquire).toHaveBeenCalledOnce();
      expect(sendHistoricalCommand).not.toHaveBeenCalled();
      expect(validateProgressSelection).not.toHaveBeenCalled();
      expect(publishProgress).not.toHaveBeenCalled();
      expect(convergeProgress).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('returns operation_conflict when changed intent appears while waiting for a converged owner', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-start-wait-conflict-',
    ));
    const conflictingRequest = {
      ...semanticRequest,
      targetStorageMode: 'external-linked',
    } satisfies Extract<
      ExternalSessionOperationSemanticRequestV1,
      { plan: 'takeover' }
    >;
    const describeSession = vi.fn(async () => describedSession());
    const sendHistoricalCommand = vi.fn();
    const validateProgressSelection = vi.fn();
    const publishProgress = vi.fn();
    const convergeProgress = vi.fn();
    const acquire = vi.fn(async (operationRequest) => ({
      status: 'converged' as const,
      active: {
        schemaVersion: 1 as const,
        claimId: 'private-claim-changed-intent-during-wait',
        ownerId: 'other-start',
        request: operationRequest,
        acquiredAtMs: 1,
        renewedAtMs: 1,
        expiresAtMs: 20_001,
      },
      waitForRelease: async () => {
        await writeExternalSessionOperationRecord(
          activeServerDir,
          takeoverRecordFor(
            conflictingRequest,
            'external-takeover:conflicting-record-fixture',
          ),
        );
        return { status: 'ready' as const };
      },
    }));
    try {
      const executor = createExternalSessionTakeoverStartActionExecutor({
        activeServerDir,
        operationExclusion: { acquire },
        describeSession,
        sendHistoricalCommand,
        validateProgressSelection,
        publishProgress,
        convergeProgress,
      });

      await expect(executor.start({ request })).resolves.toMatchObject({
        ok: false,
        error: { code: 'operation_conflict' },
      });
      expect(describeSession).toHaveBeenCalledOnce();
      expect(acquire).toHaveBeenCalledOnce();
      expect(sendHistoricalCommand).not.toHaveBeenCalled();
      expect(validateProgressSelection).not.toHaveBeenCalled();
      expect(publishProgress).not.toHaveBeenCalled();
      expect(convergeProgress).not.toHaveBeenCalled();
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

  it('cancels Start while passive repair still owns the claim mutation barrier', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-start-barrier-cancel-'));
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'barrier-cancelled-start',
      claimMutationLockAcquisitionTimeoutMs: 10_000,
    });
    let signalRepairStarted!: () => void;
    const repairStarted = new Promise<void>((resolve) => {
      signalRepairStarted = resolve;
    });
    let releaseRepair!: () => void;
    const repairRelease = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    const repair = operationExclusion.withPassiveRepairClaimBarrier({
      sessionId: semanticRequest.sessionId,
      operationClaimId: 'passive-repair-claim',
    }, async () => {
      signalRepairStarted();
      await repairRelease;
    });
    await repairStarted;

    const executor = createExternalSessionTakeoverStartActionExecutor({
      activeServerDir,
      operationExclusion,
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
          message: 'Takeover operation could not be started.',
        },
      });
    } finally {
      if (cancellationAssertionTimer) {
        clearTimeout(cancellationAssertionTimer);
      }
      releaseRepair();
      await repair;
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
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 40);
    });
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
          operationId: expect.stringMatching(/^external-takeover:/u),
        },
      });
      expect(sendHistoricalCommand).toHaveBeenCalledOnce();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  }, 3_000);

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
          operationId: expect.stringMatching(/^external-takeover:/u),
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
