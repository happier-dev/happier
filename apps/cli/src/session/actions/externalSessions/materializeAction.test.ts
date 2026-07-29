import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExternalSessionOperationActionResponseV1,
  ExternalSessionOperationProgressV1,
  ExternalSessionOperationRecordV1,
  ExternalSessionOperationSocketCommandV1,
  ExternalSessionOperationSocketResponseV1,
  ExternalSessionMaterializationPublicationV1,
  ExternalSessionPriorStableStorageV1,
  SessionMetadata,
} from '@happier-dev/protocol';
import {
  resolveExternalSessionOperationTimelineV1,
} from '@happier-dev/protocol';

import {
  createExternalSessionOperationExclusion,
  type ExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';
import {
  createExternalSessionOperationPrivateStagingStore,
  type ExternalSessionOperationPrivateStagingStore,
} from '@/session/external/staging/operationPrivateStaging';

import {
  createExternalSessionMaterializeActionExecutor as createExternalSessionMaterializeActionExecutorProduction,
  ExternalSessionMaterializeSourceInterruptionError,
  ExternalSessionPersistedTakeoverPreflightError,
} from './materializeAction';
import {
  externalSessionOperationIdForRequest,
  readExternalSessionOperationRecord,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';
import {
  selectExternalSessionOperationProgressMetadata,
} from './operationProgressPublisher';
import {
  createExternalSessionSourceGenerationAnchor,
} from './sourceGenerationAnchor';

type MaterializeExecutorDependencies = Parameters<
  typeof createExternalSessionMaterializeActionExecutorProduction
>[0];

function createExternalSessionMaterializeActionExecutor(
  dependencies: Omit<MaterializeExecutorDependencies, 'revalidateSource'>
    & Partial<Pick<MaterializeExecutorDependencies, 'revalidateSource'>>,
) {
  return createExternalSessionMaterializeActionExecutorProduction({
    revalidateSource: async () => undefined,
    ...dependencies,
  });
}

const roots: string[] = [];
const machineOnlyPriorStableStorage = {
  state: 'machine_only',
} satisfies ExternalSessionPriorStableStorageV1;

function snapshotCompletePriorStableStorage(
  publication: ExternalSessionMaterializationPublicationV1,
): ExternalSessionPriorStableStorageV1 {
  return { state: 'snapshot_complete', publication };
}

function inspectAuthorityResponse(
  command: ExternalSessionOperationSocketCommandV1,
  priorStableStorage: ExternalSessionPriorStableStorageV1,
): Extract<ExternalSessionOperationSocketResponseV1, { kind: 'authority' }> | null {
  if (command.kind !== 'inspect') return null;
  return {
    v: 1,
    kind: 'authority',
    claim: command.claim,
    revision: command.expectedRevision,
    priorStableStorage,
  };
}

function inspectOnlyCommandHandler(
  priorStableStorage: ExternalSessionPriorStableStorageV1,
): (command: ExternalSessionOperationSocketCommandV1) => Promise<ExternalSessionOperationSocketResponseV1> {
  return async (command) => {
    const authority = inspectAuthorityResponse(command, priorStableStorage);
    if (authority) return authority;
    throw new Error(`Unexpected effectful historical import command: ${command.kind}`);
  };
}

const qualifiedIdentity = {
  v: 1 as const,
  agent: { pluginId: 'example.plugin', localId: 'example' },
  source: { kind: 'jsonl', contractVersion: 1 as const },
};

function request() {
  return {
    v: 1 as const,
    idempotencyKey: 'materialize-request-1',
    sessionId: 'session-1',
    source: {
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      qualifiedIdentity,
      linkGeneration: 'link-1',
      sourceGeneration: 'source-1',
      contributionGeneration: 'contribution-1',
    },
    plan: 'materialize' as const,
    targetStorageMode: 'external-linked' as const,
    targetRuntimeMode: null,
  };
}

function persistedTakeoverRequest() {
  const sourceSnapshotEvidenceRef = 'takeover-source-cursor-1';
  return {
    v: 1 as const,
    idempotencyKey: 'takeover-request-1',
    sessionId: 'session-1',
    source: {
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      qualifiedIdentity,
      linkGeneration: 'link-1',
      sourceGeneration: createExternalSessionSourceGenerationAnchor(
        sourceSnapshotEvidenceRef,
      ),
      contributionGeneration: 'contribution-1',
    },
    plan: 'takeover' as const,
    targetStorageMode: 'persisted' as const,
    targetRuntimeMode: 'terminal' as const,
  };
}

function persistedTakeoverValidatingRecord(): ExternalSessionOperationRecordV1 {
  const takeoverRequest = persistedTakeoverRequest();
  return {
    v: 1,
    operationId: externalSessionOperationIdForRequest(takeoverRequest),
    revision: 0,
    request: takeoverRequest,
    status: 'awaiting_user_resume',
    phase: 'validating',
    timeline: resolveExternalSessionOperationTimelineV1(takeoverRequest),
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
    bindings: { operationClaimId: 'released-start-claim' },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: {
      linkedSessionRevision: 1,
      sourceSnapshotEvidenceRef: 'takeover-source-cursor-1',
    },
    fence: { kind: 'none' },
    retryTargetPhase: 'validating',
  };
}

function operationReference(
  result: Extract<ExternalSessionOperationActionResponseV1, { ok: true }>,
  revision = result.progress.revision,
) {
  return {
    sessionId: request().sessionId,
    operationId: result.progress.operationId,
    revision,
  };
}

function item(id: string) {
  return {
    localId: `history:${id}`,
    sidechainId: null,
    messageRole: 'user' as const,
    content: { t: 'plain' as const, v: { role: 'user', text: id } },
  };
}

async function* noFinalCatchUpPages() {
  // Most action-owner tests isolate another contract; source-specific final checks
  // are exercised through the default executor.
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('external session materialize action', () => {
  it('returns internal_error without effects when the canonical record is corrupt', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-action-'));
    roots.push(activeServerDir);
    const operationId = externalSessionOperationIdForRequest(request());
    const key = createHash('sha256').update(operationId, 'utf8').digest('hex');
    const recordsDir = join(
      activeServerDir,
      'external-session-operations',
      'records',
    );
    await mkdir(recordsDir, { recursive: true });
    const recordPath = join(recordsDir, `${key}.json`);
    await writeFile(recordPath, '{"v":', 'utf8');
    const acquireImplementation: ExternalSessionOperationExclusion['acquire'] = async () => ({
      status: 'conflict',
      reason: 'active_operation',
      active: null,
    });
    const acquire = vi.fn(acquireImplementation);
    const describeSource = vi.fn(async () => {
      throw new Error('describeSource must not run');
    });
    const sendHistoricalCommand = vi.fn(async () => {
      throw new Error('sendHistoricalCommand must not run');
    });
    const publishProgress = vi.fn(async () => undefined);
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: { acquire },
      staging: createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      }),
      describeSource,
      readNewestFirstPages: async function* () {
        throw new Error('readNewestFirstPages must not run');
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand,
      publishProgress,
    });

    await expect(executor.start({ request: request() })).resolves.toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Materialization operation record could not be read.',
      },
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(describeSource).not.toHaveBeenCalled();
    expect(sendHistoricalCommand).not.toHaveBeenCalled();
    expect(publishProgress).not.toHaveBeenCalled();
    await expect(readFile(recordPath, 'utf8')).resolves.toBe('{"v":');
  });

  it('blocks a hidden nonterminal operation before exclusion or source effects', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-action-'));
    roots.push(activeServerDir);
    const hidden = persistedTakeoverValidatingRecord();
    await writeExternalSessionOperationRecord(activeServerDir, hidden);
    const acquire = vi.fn();
    const describeSource = vi.fn();
    const publishProgress = vi.fn();
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: { acquire },
      staging: createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      }),
      describeSource,
      readNewestFirstPages: async function* () {
        throw new Error('readNewestFirstPages must not run');
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: inspectOnlyCommandHandler(
        machineOnlyPriorStableStorage,
      ),
      publishProgress,
    });

    await expect(executor.start({ request: request() })).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_conflict' },
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(describeSource).not.toHaveBeenCalled();
    expect(publishProgress).not.toHaveBeenCalled();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      externalSessionOperationIdForRequest(request()),
    )).resolves.toBeNull();
  });

  it('fails a conflicting shared selection before committing a new operation or beginning import effects', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-action-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-shared-selection-conflict-owner',
    });
    const describeSource = vi.fn(async () => ({
      capturedSource: {
        sourceIdentity: 'source-identity-1',
        sourceGeneration: 'source-1',
        revision: 'revision-1',
        boundary: 'boundary-1',
      },
      priorStableStorage: { state: 'machine_only' as const },
      linkedSessionRevision: 1,
    }));
    const validateProgressSelection = vi.fn(async () => {
      throw new Error('external_session_operation_projection_conflict');
    });
    const readNewestFirstPages = vi.fn(async function* () {
      throw new Error('shared selection conflict must prevent import');
    });
    const sendHistoricalCommand = vi.fn(
      inspectOnlyCommandHandler(machineOnlyPriorStableStorage),
    );
    const publishProgress = vi.fn(async () => undefined);
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging: createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      }),
      describeSource,
      validateProgressSelection,
      readNewestFirstPages,
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand,
      publishProgress,
    });

    await expect(executor.start({ request: request() })).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_conflict' },
    });
    expect(validateProgressSelection).toHaveBeenCalledOnce();
    expect(readNewestFirstPages).not.toHaveBeenCalled();
    expect(publishProgress).not.toHaveBeenCalled();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      externalSessionOperationIdForRequest(request()),
    )).resolves.toBeNull();
  });

  it('republishes the exact committed row when the same start retries after publication failure', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-action-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-republish-test-owner',
    });
    const describeSource = vi.fn(async () => ({
      capturedSource: {
        sourceIdentity: 'source-identity-1',
        sourceGeneration: 'source-1',
        revision: 'revision-1',
        boundary: 'boundary-1',
      },
      priorStableStorage: { state: 'machine_only' as const },
      linkedSessionRevision: 1,
    }));
    const publishProgress = vi.fn()
      .mockRejectedValueOnce(new Error('publish_failed'));
    const convergeProgress = vi.fn(async (
      record: ExternalSessionOperationRecordV1,
    ) => record);
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging: createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      }),
      describeSource,
      readNewestFirstPages: async function* () {
        throw new Error('readNewestFirstPages must not run');
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: inspectOnlyCommandHandler(
        machineOnlyPriorStableStorage,
      ),
      publishProgress,
      convergeProgress,
    });

    await expect(executor.start({ request: request() })).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    });
    await expect(executor.start({ request: request() })).resolves.toMatchObject({
      ok: true,
      progress: {
        operationId: externalSessionOperationIdForRequest(request()),
        revision: 0,
      },
    });
    expect(describeSource).toHaveBeenCalledOnce();
    expect(publishProgress).toHaveBeenCalledOnce();
    expect(convergeProgress).toHaveBeenCalledOnce();
  });

  it('claims, stages newest-first pages, replays oldest-first, publishes, and never spawns', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-action-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-test-owner',
    });
    const staging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    const serverOrder: string[] = [];
    let observedCommittedCheckpointBeforeNextGroup = false;
    let projectedMetadata: SessionMetadata = {};
    const publishProgress = vi.fn(async ({ progress }: Readonly<{
      progress: ExternalSessionOperationProgressV1;
    }>) => {
      projectedMetadata = selectExternalSessionOperationProgressMetadata(
        projectedMetadata,
        progress,
      );
      if (
        progress.status === 'running'
        && progress.phase === 'importing'
        && progress.currentStorageState === 'server_partial'
        && progress.checkpoint.importedItemCount === 2
        && progress.checkpoint.acceptedThroughServerSeq === 2
      ) {
        observedCommittedCheckpointBeforeNextGroup = true;
      }
    });
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
      if (authority) return authority;
      if (command.kind === 'begin' || command.kind === 'resume') {
        return {
          v: 1,
          kind: 'ready',
          claim: command.claim,
          revision: command.expectedRevision,
          historicalImportJobId: 'job-1',
          limits: { maxItems: 1, maxSerializedBytes: 524_288 },
          priorStableStorage: machineOnlyPriorStableStorage,
        };
      }
      if (command.kind === 'batch') {
        if (serverOrder.length === 2) {
          expect(observedCommittedCheckpointBeforeNextGroup).toBe(true);
        }
        serverOrder.push(...command.items.map((entry) => entry.localId));
        return {
          v: 1,
          kind: 'batch_accepted',
          claim: command.claim,
          revision: command.expectedRevision,
          batchId: command.batchId,
          acceptedThroughServerSeq: serverOrder.length,
        };
      }
      if (command.kind === 'finalize') {
        return {
          v: 1,
          kind: 'finalized',
          claim: command.claim,
          revision: command.expectedRevision,
          acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          publication: {
            materializationPublicationId: 'publication-1',
            materializedThroughSourceAt: 100,
            publishedThroughServerSeq: 5,
          },
        };
      }
      throw new Error(`unexpected command ${command.kind}`);
    });
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-1',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'newest-page',
          items: [item('new-1'), item('new-2')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-1',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: false,
          },
        } as const;
        yield {
          groupId: 'oldest-page',
          items: [item('old-1'), item('old-2')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-1',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
        yield {
          groupId: 'catch-up-page',
          replayOrder: -1,
          items: [item('appended-1')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-1',
            sourceGeneration: 'source-1',
            revision: 'revision-2',
            relationshipToCapture: 'appended',
            eof: false,
          },
        } as const;
        yield {
          groupId: 'final-source-validation',
          replayOrder: -2,
          items: [],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-1',
            sourceGeneration: 'source-1',
            revision: 'revision-2',
            relationshipToCapture: 'appended',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand,
      publishProgress,
      nowMs: (() => {
        let value = 100;
        return () => value++;
      })(),
    });

    const result = await executor.start({ request: request() });

    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        phase: 'publishing',
        currentStorageState: 'snapshot_complete',
        checkpoint: {
          sourcePagesRead: 4,
          stagedItemCount: 5,
          importedItemCount: 5,
          acceptedThroughServerSeq: 5,
        },
        publication: {
          materializationPublicationId: 'publication-1',
          materializedThroughSourceAt: 100,
          publishedThroughServerSeq: 5,
        },
      },
    });
    expect(serverOrder).toEqual([
      'history:old-1',
      'history:old-2',
      'history:new-1',
      'history:new-2',
      'history:appended-1',
    ]);
    expect(sendHistoricalCommand.mock.calls
      .map(([command]) => command.kind)
      .filter((kind) => kind !== 'inspect'))
      .toEqual(['begin', 'batch', 'batch', 'batch', 'batch', 'batch', 'finalize']);
    const serverCommandEpoch = sendHistoricalCommand.mock.calls
      .map(([command]) => command)
      .find((command) => command.kind !== 'inspect')
      ?.expectedRevision;
    expect(serverCommandEpoch).toBeTypeOf('number');
    expect(sendHistoricalCommand.mock.calls
      .map(([command]) => command)
      .filter((command) => command.kind === 'batch' || command.kind === 'finalize')
      .map((command) => command.expectedRevision))
      .toEqual(Array(6).fill(serverCommandEpoch));

    const callsAfterCompletion = sendHistoricalCommand.mock.calls.length;
    const restarted = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: vi.fn(),
      readNewestFirstPages: vi.fn(),
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand,
    });
    if (!result.ok) throw new Error('Expected completed materialization operation.');
    const status = await restarted.status(operationReference(result));
    expect(status).toMatchObject({ ok: true, progress: { status: 'completed' } });
    expect(sendHistoricalCommand).toHaveBeenCalledTimes(callsAfterCompletion);

    const mismatchedSemanticRetry = await executor.start({
      request: {
        ...request(),
        source: {
          ...request().source,
          remoteSessionId: 'remote-2',
        },
      },
    });
    expect(mismatchedSemanticRetry).toMatchObject({
      ok: false,
      error: { code: 'operation_conflict' },
    });
    expect(sendHistoricalCommand).toHaveBeenCalledTimes(callsAfterCompletion);
  });

  it('recovers a durably completed final catch-up capture before replaying it after restart', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-materialize-catch-up-complete-crash-',
    ));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-catch-up-complete-crash-owner',
    });
    const durableStaging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    let completeCaptureCalls = 0;
    const crashingStaging: ExternalSessionOperationPrivateStagingStore = {
      ...durableStaging,
      async completeCapture(input) {
        completeCaptureCalls += 1;
        await durableStaging.completeCapture(input);
        if (completeCaptureCalls === 2) {
          throw new Error('simulated crash after final catch-up capture completion');
        }
      },
    };
    const sourceEvidenceReads: string[] = [];
    const readFinalCatchUpPages: MaterializeExecutorDependencies['readFinalCatchUpPages'] =
      async function* (_request, sourceSnapshotEvidenceRef) {
        sourceEvidenceReads.push(sourceSnapshotEvidenceRef);
        if (sourceSnapshotEvidenceRef !== 'revision-1') return;
        yield {
          groupId: 'catch-up-after-crash',
          items: [item('catch-up-after-crash')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-catch-up-complete-crash',
            sourceGeneration: 'source-1',
            revision: 'revision-2',
            relationshipToCapture: 'appended',
            eof: true,
          },
        } as const;
      };
    let acceptedThroughServerSeq = 0;
    const commandKinds: string[] = [];
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
      if (authority) return authority;
      commandKinds.push(command.kind);
      if (command.kind === 'begin' || command.kind === 'resume') {
        return {
          v: 1,
          kind: 'ready',
          claim: command.claim,
          revision: command.expectedRevision,
          historicalImportJobId: 'job-catch-up-complete-crash',
          limits: { maxItems: 200, maxSerializedBytes: 524_288 },
          priorStableStorage: machineOnlyPriorStableStorage,
          ...(command.kind === 'resume' ? { acceptedThroughServerSeq } : {}),
        };
      }
      if (command.kind === 'batch') {
        acceptedThroughServerSeq += command.items.length;
        return {
          v: 1,
          kind: 'batch_accepted',
          claim: command.claim,
          revision: command.expectedRevision,
          batchId: command.batchId,
          acceptedThroughServerSeq,
        };
      }
      if (command.kind === 'finalize') {
        return {
          v: 1,
          kind: 'finalized',
          claim: command.claim,
          revision: command.expectedRevision,
          acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          publication: {
            materializationPublicationId: 'publication-catch-up-complete-crash',
            materializedThroughSourceAt: 2,
            publishedThroughServerSeq: 2,
          },
        };
      }
      return {
        v: 1,
        kind: 'error',
        errorCode: 'invalid_state',
        message: `unexpected ${command.kind}`,
      };
    });
    const createExecutor = (
      staging: ExternalSessionOperationPrivateStagingStore,
    ) => createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-catch-up-complete-crash',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'initial-before-catch-up-crash',
          items: [item('initial-before-catch-up-crash')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-catch-up-complete-crash',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages,
      sendHistoricalCommand,
    });
    const first = await createExecutor(crashingStaging).start({
      request: {
        ...request(),
        idempotencyKey: 'materialize-catch-up-complete-crash',
      },
    });
    expect(first).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        checkpoint: {
          sourcePagesRead: 1,
          stagedItemCount: 1,
          importedItemCount: 1,
          acceptedThroughServerSeq: 1,
        },
      },
    });
    if (!first.ok) throw new Error('Expected the simulated crash to remain resumable.');
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      first.progress.operationId,
    )).resolves.toMatchObject({
      canonicalOwnerEvidence: {
        sourceSnapshotEvidenceRef: 'revision-1',
      },
    });

    const resumed = await createExecutor(durableStaging).resume(
      operationReference(first),
    );

    expect(resumed).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        checkpoint: {
          sourcePagesRead: 2,
          stagedItemCount: 2,
          importedItemCount: 2,
          acceptedThroughServerSeq: 2,
        },
      },
    });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      first.progress.operationId,
    )).resolves.toMatchObject({
      canonicalOwnerEvidence: {
        sourceSnapshotEvidenceRef: 'revision-2',
      },
    });
    expect(sourceEvidenceReads).toEqual(['revision-1', 'revision-2']);
    expect(commandKinds).toEqual([
      'begin',
      'batch',
      'resume',
      'batch',
      'finalize',
    ]);
  });

  it('retains a committed per-group checkpoint when its progress publication fails', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-materialize-checkpoint-publish-failure-',
    ));
    roots.push(activeServerDir);
    const staging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    let rejectedCheckpointPublication = false;
    const publishProgress = vi.fn(async ({
      progress,
    }: Parameters<NonNullable<MaterializeExecutorDependencies['publishProgress']>>[0]) => {
      if (
        !rejectedCheckpointPublication
        && progress.status === 'running'
        && progress.phase === 'importing'
        && progress.checkpoint.importedItemCount === 1
        && progress.checkpoint.acceptedThroughServerSeq === 1
      ) {
        rejectedCheckpointPublication = true;
        throw new Error('injected per-group checkpoint publication failure');
      }
    });
    const commands: ExternalSessionOperationSocketCommandV1[] = [];
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'materialize-checkpoint-publish-failure-owner',
      }),
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-checkpoint-publish-failure',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'checkpoint-publish-failure-page',
          items: [item('checkpoint-publish-failure')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-checkpoint-publish-failure',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: async (command) => {
        const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
        if (authority) return authority;
        commands.push(command);
        if (command.kind === 'begin') {
          return {
            v: 1,
            kind: 'ready',
            claim: command.claim,
            revision: command.expectedRevision,
            historicalImportJobId: 'job-checkpoint-publish-failure',
            limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            priorStableStorage: machineOnlyPriorStableStorage,
          };
        }
        if (command.kind === 'batch') {
          return {
            v: 1,
            kind: 'batch_accepted',
            claim: command.claim,
            revision: command.expectedRevision,
            batchId: command.batchId,
            acceptedThroughServerSeq: 1,
          };
        }
        return {
          v: 1,
          kind: 'error',
          errorCode: 'invalid_state',
          message: `unexpected ${command.kind}`,
        };
      },
      publishProgress,
    });

    const interrupted = await executor.start({
      request: {
        ...request(),
        idempotencyKey: 'materialize-checkpoint-publish-failure',
      },
    });

    expect(interrupted).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'importing',
        currentStorageState: 'server_partial',
        checkpoint: {
          stagedItemCount: 1,
          importedItemCount: 1,
          acceptedThroughServerSeq: 1,
        },
        fence: {
          kind: 'initial_server_partial',
          acceptedThroughServerSeq: 1,
        },
      },
    });
    expect(rejectedCheckpointPublication).toBe(true);
    expect(commands.map((command) => command.kind)).toEqual(['begin', 'batch']);
    if (!interrupted.ok) throw new Error('Expected a recoverable publication interruption.');
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      interrupted.progress.operationId,
    )).resolves.toMatchObject({
      status: 'awaiting_user_resume',
      checkpoint: {
        importedItemCount: 1,
        acceptedThroughServerSeq: 1,
        acknowledgedBatchId: 'checkpoint-publish-failure-page',
      },
    });
  });

  it('persists exact required-item failure counts and never batches or finalizes an individually oversize row', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-required-failure-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-required-failure-owner',
    });
    const staging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
      if (authority) return authority;
      if (command.kind === 'begin' || command.kind === 'resume') {
        return {
          v: 1,
          kind: 'ready',
          claim: command.claim,
          revision: command.expectedRevision,
          historicalImportJobId: 'job-required-failure',
          limits: { maxItems: 200, maxSerializedBytes: 64 },
          priorStableStorage: machineOnlyPriorStableStorage,
        };
      }
      throw new Error(`required failure emitted forbidden ${command.kind} command`);
    });
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-required-failure',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'required-page',
          items: [item('required')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-required-failure',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand,
      nowMs: (() => {
        let value = 500;
        return () => value++;
      })(),
    });

    const result = await executor.start({
      request: {
        ...request(),
        idempotencyKey: 'materialize-required-failure',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'importing',
        currentStorageState: 'machine_only',
        checkpoint: {
          importedItemCount: 0,
          requiredItemFailures: {
            total: 1,
            record: 0,
            media: 0,
            conversion: 1,
            diagnosticsTruncated: false,
          },
        },
        fence: { kind: 'none' },
        error: {
          code: 'required_items_failed',
          retryable: true,
        },
      },
    });
    expect(sendHistoricalCommand.mock.calls
      .map(([command]) => command.kind)
      .filter((kind) => kind !== 'inspect'))
      .toEqual(['begin']);
    if (!result.ok) throw new Error('Expected required-item failure operation claim.');
    await expect(executor.resume(operationReference(result))).resolves.toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        checkpoint: {
          requiredItemFailures: {
            total: 1,
            conversion: 1,
          },
        },
      },
    });
    expect(sendHistoricalCommand.mock.calls
      .map(([command]) => command.kind)
      .filter((kind) => kind !== 'inspect'))
      .toEqual(['begin', 'resume']);
  });

  it('revalidates and rebuilds only private capture on correction Resume, while an unchanged bad source remains blocked', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-correction-resume-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-correction-resume-owner',
    });
    const staging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    let sourceCorrected = false;
    let captureAttempts = 0;
    const commandKinds: string[] = [];
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-correction-resume',
          sourceGeneration: 'source-1',
          revision: sourceCorrected ? 'revision-2' : 'revision-1',
          boundary: sourceCorrected ? 'boundary-2' : 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        captureAttempts += 1;
        yield {
          groupId: `correction-page-${captureAttempts}`,
          items: sourceCorrected ? [item('corrected')] : [],
          requiredItemFailures: sourceCorrected
            ? {
              total: 0,
              record: 0,
              media: 0,
              conversion: 0,
              diagnosticsTruncated: false,
            }
            : {
              total: 1,
              record: 0,
              media: 1,
              conversion: 0,
              diagnosticsTruncated: false,
              diagnostics: [{
                category: 'media',
                sourceGeneration: 'source-1',
                sourcePageIndex: 0,
                sourceItemIndex: 0,
              }],
            },
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-correction-resume',
            sourceGeneration: 'source-1',
            revision: sourceCorrected ? 'revision-2' : 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: async (command) => {
        const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
        if (authority) return authority;
        commandKinds.push(command.kind);
        if (command.kind === 'begin' || command.kind === 'resume') {
          return {
            v: 1,
            kind: 'ready',
            claim: command.claim,
            revision: command.expectedRevision,
            historicalImportJobId: 'job-correction-resume',
            limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            priorStableStorage: machineOnlyPriorStableStorage,
          };
        }
        if (command.kind === 'batch') {
          return {
            v: 1,
            kind: 'batch_accepted',
            claim: command.claim,
            revision: command.expectedRevision,
            batchId: command.batchId,
            acceptedThroughServerSeq: 1,
          };
        }
        if (command.kind === 'finalize') {
          return {
            v: 1,
            kind: 'finalized',
            claim: command.claim,
            revision: command.expectedRevision,
            acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
            publication: {
              materializationPublicationId: 'publication-correction-resume',
              materializedThroughSourceAt: 100,
              publishedThroughServerSeq: 1,
            },
          };
        }
        return {
          v: 1,
          kind: 'error',
          errorCode: 'invalid_state',
          message: 'Unexpected discard.',
        };
      },
    });

    const failed = await executor.start({
      request: {
        ...request(),
        idempotencyKey: 'materialize-correction-resume',
      },
    });
    expect(failed).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        checkpoint: {
          requiredItemFailures: { total: 1, media: 1 },
        },
      },
    });
    expect(commandKinds).toEqual([]);
    if (!failed.ok) throw new Error('Expected required-item correction claim.');

    const unchanged = await executor.resume(operationReference(failed));
    expect(unchanged).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        checkpoint: {
          requiredItemFailures: { total: 1, media: 1 },
        },
      },
    });
    expect(commandKinds).toEqual([]);
    if (!unchanged.ok) throw new Error('Expected unchanged source to remain resumable.');

    sourceCorrected = true;
    const completed = await executor.resume(operationReference(unchanged));
    expect(completed).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        checkpoint: {
          stagedItemCount: 1,
          importedItemCount: 1,
          requiredItemFailures: { total: 0 },
        },
      },
    });
    expect(captureAttempts).toBe(3);
    expect(commandKinds).toEqual(['begin', 'batch', 'finalize']);
  });

  it.each([
    ['deleted source', 'source_unavailable'],
    ['unreachable source', 'source_unavailable'],
    ['rewritten source', 'source_changed'],
    ['unknown source continuity', 'source_unavailable'],
  ] as const)(
    'blocks finalize for a post-ack %s and preserves the prior complete publication',
    async (_name, interruptionCode) => {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-post-ack-source-'));
      roots.push(activeServerDir);
      const operationExclusion = createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: `materialize-post-ack-${interruptionCode}`,
      });
      const staging = createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      });
      const priorPublication = {
        materializationPublicationId: 'publication-before-post-ack-change',
        materializedThroughSourceAt: 100,
        publishedThroughServerSeq: 20,
      } as const;
      const commandKinds: string[] = [];
      const executor = createExternalSessionMaterializeActionExecutor({
        activeServerDir,
        operationExclusion,
        staging,
        describeSource: async () => ({
          capturedSource: {
            sourceIdentity: 'source-identity-post-ack',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            boundary: 'boundary-1',
          },
          priorStableStorage: {
            state: 'snapshot_complete',
            publication: priorPublication,
          },
          linkedSessionRevision: 1,
        }),
        readNewestFirstPages: async function* () {
          yield {
            groupId: 'post-ack-page',
            items: [item('post-ack')],
            sourceRead: {
              availability: 'reachable',
              sourceIdentity: 'source-identity-post-ack',
              sourceGeneration: 'source-1',
              revision: 'revision-1',
              relationshipToCapture: 'same',
              eof: true,
            },
          } as const;
        },
        readFinalCatchUpPages: async function* () {
          throw new ExternalSessionMaterializeSourceInterruptionError(
            interruptionCode,
            'Source continuity failed after the import acknowledgment.',
          );
        },
        sendHistoricalCommand: async (command) => {
          const authority = inspectAuthorityResponse(
            command,
            snapshotCompletePriorStableStorage(priorPublication),
          );
          if (authority) return authority;
          commandKinds.push(command.kind);
          if (command.kind === 'begin') {
            return {
              v: 1,
              kind: 'ready',
              claim: command.claim,
              revision: command.expectedRevision,
              historicalImportJobId: 'job-post-ack-source',
              limits: { maxItems: 200, maxSerializedBytes: 524_288 },
              priorStableStorage: snapshotCompletePriorStableStorage(priorPublication),
            };
          }
          if (command.kind === 'batch') {
            return {
              v: 1,
              kind: 'batch_accepted',
              claim: command.claim,
              revision: command.expectedRevision,
              batchId: command.batchId,
              acceptedThroughServerSeq: 21,
            };
          }
          throw new Error(`post-ack source change emitted forbidden ${command.kind}`);
        },
      });

      const result = await executor.start({
        request: {
          ...request(),
          idempotencyKey: `materialize-post-ack-${interruptionCode}-${_name}`,
        },
      });

      expect(result).toMatchObject({
        ok: true,
        progress: {
          status: 'awaiting_user_resume',
          phase: 'importing',
          currentStorageState: 'snapshot_complete',
          publication: priorPublication,
          checkpoint: {
            acceptedThroughServerSeq: 21,
          },
          fence: {
            kind: 'incomplete_update',
            publication: priorPublication,
          },
          error: {
            code: interruptionCode,
            retryable: true,
          },
        },
      });
      expect(commandKinds).toEqual(['begin', 'batch']);
    },
  );

  it('does not invent initial-partial authority from an empty validation group', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-empty-ack-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-empty-ack-owner',
    });
    const staging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    const commandKinds: string[] = [];
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-empty-ack',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'empty-validation',
          items: [],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-empty-ack',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: async function* () {
        throw new ExternalSessionMaterializeSourceInterruptionError(
          'source_changed',
          'Source changed after empty validation.',
        );
      },
      sendHistoricalCommand: async (command) => {
        const authority = inspectAuthorityResponse(
          command,
          machineOnlyPriorStableStorage,
        );
        if (authority) return authority;
        commandKinds.push(command.kind);
        if (command.kind === 'begin') {
          return {
            v: 1,
            kind: 'ready',
            claim: command.claim,
            revision: command.expectedRevision,
            historicalImportJobId: 'job-empty-ack',
            limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            priorStableStorage: machineOnlyPriorStableStorage,
          };
        }
        throw new Error(`empty validation emitted forbidden ${command.kind}`);
      },
    });

    const result = await executor.start({
      request: {
        ...request(),
        idempotencyKey: 'materialize-empty-ack',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'importing',
        currentStorageState: 'machine_only',
        checkpoint: {
          stagedItemCount: 0,
          importedItemCount: 0,
        },
        fence: { kind: 'none' },
        error: { code: 'source_changed' },
      },
    });
    if (!result.ok) throw new Error('Expected interrupted materialization.');
    expect(result.progress.checkpoint).not.toHaveProperty(
      'acceptedThroughServerSeq',
    );
    expect(commandKinds).toEqual(['begin']);
    await expect(executor.discard(operationReference(result))).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_allowed' },
    });
  });

  it('recovers a durable server acknowledgment for a non-source interruption', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-generic-ack-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-generic-ack-owner',
    });
    const durableStaging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    let interruptAfterAcknowledgement = true;
    const staging: ExternalSessionOperationPrivateStagingStore = {
      ...durableStaging,
      async acknowledgeReplayGroup(input) {
        await durableStaging.acknowledgeReplayGroup(input);
        if (interruptAfterAcknowledgement) {
          interruptAfterAcknowledgement = false;
          throw new Error('injected interruption after durable acknowledgment');
        }
      },
    };
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-generic-ack',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'accepted-before-generic-interruption',
          items: [item('accepted-before-generic-interruption')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-generic-ack',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: async (command) => {
        const authority = inspectAuthorityResponse(
          command,
          machineOnlyPriorStableStorage,
        );
        if (authority) return authority;
        if (command.kind === 'begin') {
          return {
            v: 1,
            kind: 'ready',
            claim: command.claim,
            revision: command.expectedRevision,
            historicalImportJobId: 'job-generic-ack',
            limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            priorStableStorage: machineOnlyPriorStableStorage,
          };
        }
        if (command.kind === 'batch') {
          return {
            v: 1,
            kind: 'batch_accepted',
            claim: command.claim,
            revision: command.expectedRevision,
            batchId: command.batchId,
            acceptedThroughServerSeq: 1,
          };
        }
        throw new Error(`generic acknowledgment emitted forbidden ${command.kind}`);
      },
    });

    const result = await executor.start({
      request: {
        ...request(),
        idempotencyKey: 'materialize-generic-ack',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'importing',
        currentStorageState: 'server_partial',
        checkpoint: {
          stagedItemCount: 1,
          importedItemCount: 1,
          acceptedThroughServerSeq: 1,
        },
        fence: {
          kind: 'initial_server_partial',
          acceptedThroughServerSeq: 1,
        },
      },
    });
  });

  it('requires reconciliation when the operation checkpoint is ahead of the durable server receipt', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-receipt-conflict-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-receipt-conflict-owner',
    });
    const durableStaging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    let interruptAfterAcknowledgement = true;
    const interruptedStaging: ExternalSessionOperationPrivateStagingStore = {
      ...durableStaging,
      async acknowledgeReplayGroup(input) {
        await durableStaging.acknowledgeReplayGroup(input);
        if (interruptAfterAcknowledgement) {
          interruptAfterAcknowledgement = false;
          throw new Error('injected interruption after durable acknowledgment');
        }
      },
    };
    const started = await createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging: interruptedStaging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-receipt-conflict',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'receipt-conflict-group',
          items: [item('receipt-conflict-item')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-receipt-conflict',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: async (command) => {
        const authority = inspectAuthorityResponse(
          command,
          machineOnlyPriorStableStorage,
        );
        if (authority) return authority;
        if (command.kind === 'begin') {
          return {
            v: 1,
            kind: 'ready',
            claim: command.claim,
            revision: command.expectedRevision,
            historicalImportJobId: 'job-receipt-conflict',
            limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            priorStableStorage: machineOnlyPriorStableStorage,
          };
        }
        if (command.kind === 'batch') {
          return {
            v: 1,
            kind: 'batch_accepted',
            claim: command.claim,
            revision: command.expectedRevision,
            batchId: command.batchId,
            acceptedThroughServerSeq: 1,
          };
        }
        throw new Error(`receipt conflict setup emitted forbidden ${command.kind}`);
      },
    }).start({
      request: {
        ...request(),
        idempotencyKey: 'materialize-receipt-conflict',
      },
    });
    if (!started.ok) throw new Error('Expected interrupted materialization.');

    const operation = await readExternalSessionOperationRecord(
      activeServerDir,
      started.progress.operationId,
    );
    if (!operation) throw new Error('Expected durable materialization record.');
    const conflictingRevision = operation.revision + 1;
    await writeExternalSessionOperationRecord(activeServerDir, {
      ...operation,
      revision: conflictingRevision,
      updatedAtMs: operation.updatedAtMs + 1,
      checkpoint: {
        ...operation.checkpoint,
        acceptedThroughServerSeq: 2,
      },
      fence: {
        kind: 'initial_server_partial',
        acceptedThroughServerSeq: 2,
      },
    });

    const continuationCommands: ExternalSessionOperationSocketCommandV1[] = [];
    const restarted = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging: durableStaging,
      describeSource: vi.fn(),
      readNewestFirstPages: vi.fn(),
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: async (command) => {
        continuationCommands.push(command);
        throw new Error(`receipt conflict emitted forbidden ${command.kind}`);
      },
    });

    const reconciled = await restarted.resume(
      operationReference(started, conflictingRevision),
    );
    expect(reconciled).toMatchObject({
      ok: true,
      progress: {
        status: 'reconciliation_required',
        phase: 'importing',
        currentStorageState: 'server_partial',
        checkpoint: {
          importedItemCount: 1,
          acceptedThroughServerSeq: 2,
        },
        fence: {
          kind: 'initial_server_partial',
          acceptedThroughServerSeq: 2,
        },
        error: { code: 'reconciliation_required' },
      },
    });
    if (!reconciled.ok) throw new Error('Expected reconciliation-required progress.');
    expect(continuationCommands).toEqual([]);
    await expect(durableStaging.readReplayState(started.progress.operationId))
      .resolves.toMatchObject({
        status: 'ready',
        acknowledgedItemCount: 1,
        acceptedThroughServerSeq: 1,
      });

    const discardCommands: ExternalSessionOperationSocketCommandV1[] = [];
    const discardAfterRestart =
      createExternalSessionMaterializeActionExecutor({
        activeServerDir,
        operationExclusion,
        staging: durableStaging,
        describeSource: vi.fn(),
        readNewestFirstPages: vi.fn(),
        readFinalCatchUpPages: noFinalCatchUpPages,
        sendHistoricalCommand: async (command) => {
          discardCommands.push(command);
          if (command.kind === 'discard') {
            return {
              v: 1,
              kind: 'discarded',
              claim: command.claim,
              revision: command.expectedRevision,
            };
          }
          throw new Error(
            `reconciled discard emitted forbidden ${command.kind}`,
          );
        },
      });
    const discarded = await discardAfterRestart.discard(
      operationReference(reconciled),
    );
    expect(discarded).toMatchObject({
      ok: true,
      progress: {
        status: 'discarded',
        phase: 'importing',
        currentStorageState: 'machine_only',
        checkpoint: {
          sourcePagesRead: 0,
          stagedItemCount: 0,
          importedItemCount: 0,
        },
        fence: { kind: 'none' },
      },
    });
    const discardedRecord = await readExternalSessionOperationRecord(
      activeServerDir,
      started.progress.operationId,
    );
    expect(discardedRecord).toMatchObject({
      status: 'discarded',
      terminalResult: { kind: 'discarded' },
    });
    expect(discardedRecord?.canonicalOwnerEvidence.disagreement).toBeUndefined();
    expect(discardCommands.map((command) => command.kind)).toEqual([
      'discard',
    ]);
    await expect(durableStaging.readReplayState(started.progress.operationId))
      .resolves.toEqual({ status: 'missing' });
  });

  it('stops a continuously advancing final catch-up at the bounded round ceiling without finalizing', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-catch-up-bound-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-catch-up-bound-owner',
    });
    const staging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 100, maxBytes: 100_000 },
        aggregate: { maxItems: 200, maxBytes: 200_000 },
      },
    });
    let finalCatchUpRounds = 0;
    const commandKinds: string[] = [];
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-catch-up-bound',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'catch-up-bound-initial',
          items: [item('initial')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-catch-up-bound',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: async function* () {
        finalCatchUpRounds += 1;
        yield {
          groupId: `catch-up-bound-${finalCatchUpRounds}`,
          items: [],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-catch-up-bound',
            sourceGeneration: 'source-1',
            revision: `revision-${finalCatchUpRounds + 1}`,
            relationshipToCapture: 'appended',
            eof: true,
          },
        } as const;
      },
      sendHistoricalCommand: async (command) => {
        const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
        if (authority) return authority;
        commandKinds.push(command.kind);
        if (command.kind === 'begin') {
          return {
            v: 1,
            kind: 'ready',
            claim: command.claim,
            revision: command.expectedRevision,
            historicalImportJobId: 'job-catch-up-bound',
            limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            priorStableStorage: machineOnlyPriorStableStorage,
          };
        }
        if (command.kind === 'batch') {
          return {
            v: 1,
            kind: 'batch_accepted',
            claim: command.claim,
            revision: command.expectedRevision,
            batchId: command.batchId,
            acceptedThroughServerSeq: 1,
          };
        }
        throw new Error(`bounded catch-up emitted forbidden ${command.kind}`);
      },
    });

    const result = await executor.start({
      request: {
        ...request(),
        idempotencyKey: 'materialize-catch-up-bound',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'importing',
        currentStorageState: 'server_partial',
        checkpoint: {
          acceptedThroughServerSeq: 1,
        },
        fence: {
          kind: 'initial_server_partial',
          acceptedThroughServerSeq: 1,
        },
        error: {
          code: 'source_unavailable',
          retryable: true,
        },
      },
    });
    expect(finalCatchUpRounds).toBe(32);
    expect(commandKinds).toEqual(['begin', 'batch']);
  });

  it.each([
    {
      name: 'deleted or unreachable',
      sourceRead: { availability: 'unreachable' as const },
      errorCode: 'source_unavailable',
    },
    {
      name: 'replacement identity',
      sourceRead: {
        availability: 'reachable' as const,
        sourceIdentity: 'replacement-source',
        sourceGeneration: 'source-1',
        revision: 'revision-1',
        relationshipToCapture: 'same' as const,
        eof: true,
      },
      errorCode: 'source_changed',
    },
    {
      name: 'replacement generation',
      sourceRead: {
        availability: 'reachable' as const,
        sourceIdentity: 'source-identity-source-state',
        sourceGeneration: 'source-2',
        revision: 'revision-2',
        relationshipToCapture: 'appended' as const,
        eof: true,
      },
      errorCode: 'source_changed',
    },
    {
      name: 'rewrite',
      sourceRead: {
        availability: 'reachable' as const,
        sourceIdentity: 'source-identity-source-state',
        sourceGeneration: 'source-1',
        revision: 'revision-rewritten',
        relationshipToCapture: 'rewritten' as const,
        eof: false,
      },
      errorCode: 'source_changed',
    },
    {
      name: 'unknown continuity',
      sourceRead: { availability: 'unknown' as const },
      errorCode: 'source_unavailable',
    },
  ])(
    'blocks initial publication for $name instead of treating it as EOF',
    async ({ name, sourceRead, errorCode }) => {
      const activeServerDir = await mkdtemp(join(
        tmpdir(),
        `happier-materialize-source-${name.replaceAll(' ', '-')}-`,
      ));
      roots.push(activeServerDir);
      const operationExclusion = createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: `materialize-source-${name}`,
      });
      const staging = createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      });
      const sendHistoricalCommand = vi.fn(
        inspectOnlyCommandHandler(machineOnlyPriorStableStorage),
      );
      const executor = createExternalSessionMaterializeActionExecutor({
        activeServerDir,
        operationExclusion,
        staging,
        describeSource: async () => ({
          capturedSource: {
            sourceIdentity: 'source-identity-source-state',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            boundary: 'boundary-1',
          },
          priorStableStorage: { state: 'machine_only' },
          linkedSessionRevision: 1,
        }),
        readNewestFirstPages: async function* () {
          yield {
            groupId: 'newest-page',
            items: [item('kept-private')],
            sourceRead: {
              availability: 'reachable',
              sourceIdentity: 'source-identity-source-state',
              sourceGeneration: 'source-1',
              revision: 'revision-1',
              relationshipToCapture: 'same',
              eof: false,
            },
          } as const;
          yield {
            groupId: 'source-state',
            items: [],
            sourceRead,
          } as const;
        },
        readFinalCatchUpPages: noFinalCatchUpPages,
        sendHistoricalCommand,
      });

      const result = await executor.start({
        request: {
          ...request(),
          idempotencyKey: `materialize-source-${name}`,
        },
      });

      expect(result).toMatchObject({
        ok: true,
        progress: {
          status: 'awaiting_user_resume',
          phase: 'staging',
          currentStorageState: 'machine_only',
          fence: { kind: 'none' },
          error: {
            code: errorCode,
            retryable: true,
          },
        },
      });
      expect(sendHistoricalCommand).toHaveBeenCalledOnce();
      expect(sendHistoricalCommand.mock.calls[0]?.[0]).toMatchObject({ kind: 'inspect' });
      if (!result.ok) throw new Error('Expected interrupted materialization claim.');
      await expect(staging.readReplayState(result.progress.operationId)).resolves.toMatchObject({
        status: 'capture_incomplete',
        acceptedThroughServerSeq: null,
      });
    },
  );

  it('preserves the prior published bound on a catch-up source interruption and resumes the same claim at the current revision', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-source-resume-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-source-resume-owner',
    });
    const staging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    const priorPublication = {
      materializationPublicationId: 'publication-prior',
      materializedThroughSourceAt: 100,
      publishedThroughServerSeq: 20,
    } as const;
    let captureAttempt = 0;
    const commands: ExternalSessionOperationSocketCommandV1[] = [];
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-source-resume',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        // Public session JSON intentionally omits the private publication.
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        captureAttempt += 1;
        yield {
          groupId: 'captured-page',
          items: [item('captured')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-source-resume',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: false,
          },
        } as const;
        yield captureAttempt === 1
          ? {
            groupId: 'source-temporarily-unreachable',
            items: [],
            sourceRead: { availability: 'unreachable' as const },
          }
          : {
            groupId: 'oldest-page',
            items: [item('oldest')],
            sourceRead: {
              availability: 'reachable' as const,
              sourceIdentity: 'source-identity-source-resume',
              sourceGeneration: 'source-1',
              revision: 'revision-1',
              relationshipToCapture: 'same' as const,
              eof: true,
            },
          };
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: async (command) => {
        commands.push(command);
        if (command.kind === 'inspect') {
          return {
            v: 1,
            kind: 'authority',
            claim: command.claim,
            revision: command.expectedRevision,
            priorStableStorage: {
              state: 'snapshot_complete',
              publication: priorPublication,
            },
          };
        }
        if (command.kind === 'begin') {
          return {
            v: 1,
            kind: 'ready',
            claim: command.claim,
            revision: command.expectedRevision,
            historicalImportJobId: 'job-source-resume',
            limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            priorStableStorage: {
              state: 'snapshot_complete',
              publication: priorPublication,
            },
          };
        }
        if (command.kind === 'batch') {
          return {
            v: 1,
            kind: 'batch_accepted',
            claim: command.claim,
            revision: command.expectedRevision,
            batchId: command.batchId,
            acceptedThroughServerSeq: 22,
          };
        }
        if (command.kind === 'finalize') {
          return {
            v: 1,
            kind: 'finalized',
            claim: command.claim,
            revision: command.expectedRevision,
            acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
            publication: {
              materializationPublicationId: 'publication-next',
              materializedThroughSourceAt: 200,
              publishedThroughServerSeq: 22,
            },
          };
        }
        return {
          v: 1,
          kind: 'error',
          errorCode: 'invalid_state',
          message: 'Unexpected command.',
        };
      },
    });

    const interrupted = await executor.start({
      request: {
        ...request(),
        idempotencyKey: 'materialize-source-resume',
      },
    });
    expect(interrupted).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'staging',
        currentStorageState: 'snapshot_complete',
        publication: priorPublication,
        fence: {
          kind: 'incomplete_update',
          publication: priorPublication,
        },
        error: { code: 'source_unavailable' },
      },
    });
    expect(commands.map((command) => command.kind)).toEqual(['inspect']);
    if (!interrupted.ok) throw new Error('Expected interrupted materialization claim.');

    const completed = await executor.resume(operationReference(interrupted));
    expect(completed).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        publication: {
          materializationPublicationId: 'publication-next',
          publishedThroughServerSeq: 22,
        },
      },
    });
    expect(captureAttempt).toBe(2);
    expect(commands.map((command) => command.kind)).toEqual([
      'inspect',
      'inspect',
      'begin',
      'batch',
      'batch',
      'finalize',
    ]);
  });

  it.each(['resume', 'retry'] as const)(
    'records explicit revision-bound %s intent before continuing an interrupted import',
    async (intent) => {
      const activeServerDir = await mkdtemp(join(tmpdir(), `happier-materialize-${intent}-`));
      roots.push(activeServerDir);
      const operationExclusion = createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: `materialize-${intent}-owner`,
      });
      const staging = createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      });
      let rejectNextBatch = true;
      const commands: ExternalSessionOperationSocketCommandV1[] = [];
      const sendHistoricalCommand = vi.fn(async (
        command: ExternalSessionOperationSocketCommandV1,
      ): Promise<ExternalSessionOperationSocketResponseV1> => {
        const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
        if (authority) return authority;
        commands.push(command);
        if (command.kind === 'begin' || command.kind === 'resume') {
          return {
            v: 1,
            kind: 'ready',
            claim: command.claim,
            revision: command.expectedRevision,
            historicalImportJobId: 'job-resumable',
            limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            priorStableStorage: machineOnlyPriorStableStorage,
          };
        }
        if (command.kind === 'batch') {
          if (rejectNextBatch) {
            rejectNextBatch = false;
            return { v: 1, kind: 'error', errorCode: 'internal_error', message: 'interrupted' };
          }
          return {
            v: 1,
            kind: 'batch_accepted',
            claim: command.claim,
            revision: command.expectedRevision,
            batchId: command.batchId,
            acceptedThroughServerSeq: 1,
          };
        }
        if (command.kind === 'finalize') {
          return {
            v: 1,
            kind: 'finalized',
            claim: command.claim,
            revision: command.expectedRevision,
            acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
            publication: {
              materializationPublicationId: 'publication-resumed',
              materializedThroughSourceAt: 200,
              publishedThroughServerSeq: 1,
            },
          };
        }
        return {
          v: 1,
          kind: 'error',
          errorCode: 'invalid_state',
          message: 'Unexpected discard command.',
        };
      });
      const executor = createExternalSessionMaterializeActionExecutor({
        activeServerDir,
        operationExclusion,
        staging,
        describeSource: async () => ({
          capturedSource: {
            sourceIdentity: 'source-identity-resumable',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            boundary: 'boundary-1',
          },
          priorStableStorage: { state: 'machine_only' },
          linkedSessionRevision: 1,
        }),
        readNewestFirstPages: async function* () {
          yield {
            groupId: 'only-page',
            items: [item('only')],
            sourceRead: {
              availability: 'reachable',
              sourceIdentity: 'source-identity-resumable',
              sourceGeneration: 'source-1',
              revision: 'revision-1',
              relationshipToCapture: 'same',
              eof: true,
            },
          } as const;
        },
        readFinalCatchUpPages: noFinalCatchUpPages,
        sendHistoricalCommand,
      });
      const semanticRequest = {
        ...request(),
        idempotencyKey: `materialize-${intent}-request`,
      };
      const interrupted = await executor.start({ request: semanticRequest });
      expect(interrupted).toMatchObject({
        ok: true,
        progress: { status: 'awaiting_user_resume', phase: 'importing' },
      });
      if (!interrupted.ok) throw new Error('Expected interrupted operation claim.');
      const observedRevision = interrupted.progress.revision;

      const callsBeforePassiveRead = sendHistoricalCommand.mock.calls.length;
      await expect(executor.status(operationReference(interrupted))).resolves.toMatchObject({
        ok: true,
        progress: { revision: observedRevision, status: 'awaiting_user_resume' },
      });
      expect(sendHistoricalCommand).toHaveBeenCalledTimes(callsBeforePassiveRead);
      await expect(executor[intent](
        operationReference(interrupted, observedRevision - 1),
      )).resolves.toMatchObject({
        ok: false,
        error: { code: 'stale_revision' },
      });

      const completed = await executor[intent](
        operationReference(interrupted, observedRevision),
      );
      expect(completed).toMatchObject({
        ok: true,
        progress: {
          revision: observedRevision + 4,
          status: 'completed',
          checkpoint: { importedItemCount: 1, acceptedThroughServerSeq: 1 },
        },
      });
      expect(commands.map((command) => command.kind)).toEqual([
        'begin',
        'batch',
        'resume',
        'batch',
        'finalize',
      ]);
      expect(commands.at(-3)?.expectedRevision).toBe(observedRevision + 1);
    },
  );

  it.each(['resume', 'retry'] as const)(
    'revalidates the current source before import %s can issue a server or staging effect',
    async (intent) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-resume-source-fence-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-resume-source-fence-owner',
    });
    const durableStaging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    const resumeOperation = vi.fn(async (
      input: Parameters<ExternalSessionOperationPrivateStagingStore['resumeOperation']>[0],
    ) => await durableStaging.resumeOperation(input));
    const staging: ExternalSessionOperationPrivateStagingStore = {
      ...durableStaging,
      resumeOperation,
    };
    let rejectFirstBatch = true;
    let resumeRevalidationFails = false;
    const commandKinds: string[] = [];
    const priorPublication = {
      materializationPublicationId: 'publication-before-resume-source-fence',
      materializedThroughSourceAt: 100,
      publishedThroughServerSeq: 20,
    } as const;
    const revalidateSource = vi.fn(async () => {
      if (resumeRevalidationFails) {
        throw new ExternalSessionMaterializeSourceInterruptionError(
          'source_changed',
          'The source was rewritten before Resume.',
        );
      }
    });
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-resume-source-fence',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: {
          state: 'snapshot_complete',
          publication: priorPublication,
        },
        linkedSessionRevision: 1,
      }),
      revalidateSource,
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'resume-source-fence-page',
          items: [item('resume-source-fence')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-resume-source-fence',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: async (command) => {
        const authority = inspectAuthorityResponse(
          command,
          snapshotCompletePriorStableStorage(priorPublication),
        );
        if (authority) return authority;
        commandKinds.push(command.kind);
        if (command.kind === 'begin' || command.kind === 'resume') {
          return {
            v: 1,
            kind: 'ready',
            claim: command.claim,
            revision: command.expectedRevision,
            historicalImportJobId: 'job-resume-source-fence',
            limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            priorStableStorage: snapshotCompletePriorStableStorage(priorPublication),
          };
        }
        if (command.kind === 'batch') {
          if (rejectFirstBatch) {
            rejectFirstBatch = false;
            return {
              v: 1,
              kind: 'error',
              errorCode: 'internal_error',
              message: 'Interrupt after import admission.',
            };
          }
          return {
            v: 1,
            kind: 'batch_accepted',
            claim: command.claim,
            revision: command.expectedRevision,
            batchId: command.batchId,
            acceptedThroughServerSeq: 21,
          };
        }
        if (command.kind === 'finalize') {
          return {
            v: 1,
            kind: 'finalized',
            claim: command.claim,
            revision: command.expectedRevision,
            acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
            publication: {
              materializationPublicationId: 'publication-resumed',
              materializedThroughSourceAt: 200,
              publishedThroughServerSeq: 21,
            },
          };
        }
        return {
          v: 1,
          kind: 'error',
          errorCode: 'invalid_state',
          message: 'Unexpected command.',
        };
      },
    });

    const interrupted = await executor.start({
      request: {
        ...request(),
        idempotencyKey: 'materialize-resume-source-fence',
      },
    });
    expect(interrupted).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'importing',
        publication: {
          materializationPublicationId: 'publication-before-resume-source-fence',
          publishedThroughServerSeq: 20,
        },
      },
    });
    if (!interrupted.ok) throw new Error('Expected interrupted materialization.');
    const commandCountBeforeResume = commandKinds.length;
    resumeOperation.mockClear();
    resumeRevalidationFails = true;

    const refused = await executor[intent](operationReference(interrupted));

    expect(refused).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'importing',
        publication: {
          materializationPublicationId: 'publication-before-resume-source-fence',
          publishedThroughServerSeq: 20,
        },
        fence: {
          kind: 'incomplete_update',
          publication: {
            materializationPublicationId: 'publication-before-resume-source-fence',
            publishedThroughServerSeq: 20,
          },
        },
        error: { code: 'source_changed' },
      },
    });
    expect(revalidateSource).toHaveBeenCalledTimes(1);
    expect(commandKinds).toHaveLength(commandCountBeforeResume);
    expect(resumeOperation).not.toHaveBeenCalled();
    },
  );

  it('rejects a delayed stale Resume after exclusion acquisition without touching staging', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-delayed-resume-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-delayed-resume-owner',
    });
    const durableStaging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    const resumeOperation = vi.fn(async (
      input: Parameters<ExternalSessionOperationPrivateStagingStore['resumeOperation']>[0],
    ) => await durableStaging.resumeOperation(input));
    const staging: ExternalSessionOperationPrivateStagingStore = {
      ...durableStaging,
      resumeOperation,
    };
    let rejectFirstBatch = true;
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
      if (authority) return authority;
      if (command.kind === 'begin' || command.kind === 'resume') {
        return {
          v: 1,
          kind: 'ready',
          claim: command.claim,
          revision: command.expectedRevision,
          historicalImportJobId: 'job-delayed-resume',
          limits: { maxItems: 200, maxSerializedBytes: 524_288 },
          priorStableStorage: machineOnlyPriorStableStorage,
        };
      }
      if (command.kind === 'batch') {
        if (rejectFirstBatch) {
          rejectFirstBatch = false;
          return {
            v: 1,
            kind: 'error',
            errorCode: 'internal_error',
            message: 'interrupt before concurrent Resume',
          };
        }
        return {
          v: 1,
          kind: 'batch_accepted',
          claim: command.claim,
          revision: command.expectedRevision,
          batchId: command.batchId,
          acceptedThroughServerSeq: 1,
        };
      }
      if (command.kind === 'finalize') {
        return {
          v: 1,
          kind: 'finalized',
          claim: command.claim,
          revision: command.expectedRevision,
          acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
          publication: {
            materializationPublicationId: 'publication-delayed-resume',
            materializedThroughSourceAt: 200,
            publishedThroughServerSeq: 1,
          },
        };
      }
      return {
        v: 1,
        kind: 'error',
        errorCode: 'invalid_state',
        message: 'Unexpected discard command.',
      };
    });
    const commonDependencies = {
      activeServerDir,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-delayed-resume',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' as const },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'only-page',
          items: [item('only')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-delayed-resume',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand,
    };
    const winnerExecutor = createExternalSessionMaterializeActionExecutor({
      ...commonDependencies,
      operationExclusion,
    });
    const interrupted = await winnerExecutor.start({
      request: { ...request(), idempotencyKey: 'materialize-delayed-resume' },
    });
    expect(interrupted).toMatchObject({
      ok: true,
      progress: { status: 'awaiting_user_resume', phase: 'importing' },
    });
    if (!interrupted.ok) throw new Error('Expected interrupted operation.');

    let announceDelayedAcquire!: () => void;
    const delayedAcquireReached = new Promise<void>((resolve) => {
      announceDelayedAcquire = resolve;
    });
    let releaseDelayedAcquire!: () => void;
    const delayedAcquireGate = new Promise<void>((resolve) => {
      releaseDelayedAcquire = resolve;
    });
    const delayedExclusion: ExternalSessionOperationExclusion = {
      async acquire(input) {
        announceDelayedAcquire();
        await delayedAcquireGate;
        return await operationExclusion.acquire(input);
      },
    };
    const delayedExecutor = createExternalSessionMaterializeActionExecutor({
      ...commonDependencies,
      operationExclusion: delayedExclusion,
    });
    const delayedResume = delayedExecutor.resume(operationReference(interrupted));
    await delayedAcquireReached;

    const winner = await winnerExecutor.resume(operationReference(interrupted));
    expect(winner).toMatchObject({
      ok: true,
      progress: { status: 'completed' },
    });
    const stagingResumeCallsAfterWinner = resumeOperation.mock.calls.length;

    releaseDelayedAcquire();
    await expect(delayedResume).resolves.toMatchObject({
      ok: false,
      error: { code: 'stale_revision' },
    });
    expect(resumeOperation).toHaveBeenCalledTimes(stagingResumeCallsAfterWinner);
  });

  it.each([
    ['cleanup fails before removing staging', false],
    ['the daemon crashes after removing staging', true],
  ] as const)(
    'keeps finalized server truth explicitly recoverable when %s',
    async (_case, removeStagingBeforeFailure) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-cleanup-recovery-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-cleanup-recovery-owner',
    });
    const durableStaging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    let failCleanup = true;
    let inspectCurrentOperation:
      | (() => Promise<ExternalSessionOperationActionResponseV1>)
      | undefined;
    let progressObservedDuringFailedCleanup:
      | ExternalSessionOperationActionResponseV1
      | undefined;
    let latestPublishedReference:
      | Readonly<{ sessionId: string; operationId: string; revision: number }>
      | undefined;
    const cleanupTerminalOperation = vi.fn(async (
      input: Parameters<ExternalSessionOperationPrivateStagingStore['cleanupTerminalOperation']>[0],
    ) => {
      if (failCleanup) {
        failCleanup = false;
        progressObservedDuringFailedCleanup = await inspectCurrentOperation?.();
        if (removeStagingBeforeFailure) {
          await durableStaging.cleanupTerminalOperation(input);
        }
        throw new Error('injected private staging cleanup I/O failure');
      }
      return await durableStaging.cleanupTerminalOperation(input);
    });
    const staging: ExternalSessionOperationPrivateStagingStore = {
      ...durableStaging,
      cleanupTerminalOperation,
    };
    let serverFinalized = false;
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
      if (authority) return authority;
      if (command.kind === 'begin') {
        return {
          v: 1,
          kind: 'ready',
          claim: command.claim,
          revision: command.expectedRevision,
          historicalImportJobId: 'job-cleanup-recovery',
          limits: { maxItems: 200, maxSerializedBytes: 524_288 },
          priorStableStorage: machineOnlyPriorStableStorage,
        };
      }
      if (command.kind === 'resume' && serverFinalized) {
        return {
          v: 1,
          kind: 'finalized',
          claim: command.claim,
          revision: command.expectedRevision,
          acceptedThroughServerSeq: 1,
          publication: {
            materializationPublicationId: 'publication-cleanup-recovery',
            materializedThroughSourceAt: 300,
            publishedThroughServerSeq: 1,
          },
        };
      }
      if (command.kind === 'batch') {
        return {
          v: 1,
          kind: 'batch_accepted',
          claim: command.claim,
          revision: command.expectedRevision,
          batchId: command.batchId,
          acceptedThroughServerSeq: 1,
        };
      }
      if (command.kind === 'finalize') {
        serverFinalized = true;
        return {
          v: 1,
          kind: 'error',
          errorCode: 'internal_error',
          message: 'Finalize committed but its callback was lost.',
        };
      }
      return {
        v: 1,
        kind: 'error',
        errorCode: 'invalid_state',
        message: 'Unexpected discard command.',
      };
    });
    const dependencies = {
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-cleanup-recovery',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' as const },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'only-page',
          items: [item('only')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-cleanup-recovery',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand,
      publishProgress: async ({
        sessionId,
        progress,
      }: Parameters<NonNullable<MaterializeExecutorDependencies['publishProgress']>>[0]) => {
        latestPublishedReference = {
          sessionId,
          operationId: progress.operationId,
          revision: progress.revision,
        };
      },
    };
    const executor = createExternalSessionMaterializeActionExecutor(dependencies);
    const interrupted = await executor.start({
      request: { ...request(), idempotencyKey: 'materialize-cleanup-recovery' },
    });
    expect(interrupted).toMatchObject({
      ok: true,
      progress: { status: 'awaiting_user_resume', phase: 'importing' },
    });
    if (!interrupted.ok) throw new Error('Expected interrupted operation.');
    inspectCurrentOperation = async () => {
      if (!latestPublishedReference) {
        throw new Error('Expected a published current operation reference.');
      }
      return await executor.status(latestPublishedReference);
    };

    const cleanupFailed = await executor.resume(operationReference(interrupted));
    expect(cleanupFailed).toMatchObject({
      ok: true,
      progress: { status: 'awaiting_user_resume', phase: 'importing' },
    });
    expect(progressObservedDuringFailedCleanup).toMatchObject({
      ok: true,
      progress: { status: 'running', phase: 'importing' },
    });
    if (!cleanupFailed.ok) throw new Error('Expected recoverable cleanup failure.');
    if (removeStagingBeforeFailure) {
      await expect(
        durableStaging.readReplayState(cleanupFailed.progress.operationId),
      ).resolves.toEqual({ status: 'missing' });
    } else {
      await expect(
        durableStaging.readReplayState(cleanupFailed.progress.operationId),
      ).resolves.not.toEqual({ status: 'missing' });
    }

    const restarted = createExternalSessionMaterializeActionExecutor(dependencies);
    const completed = await restarted.resume(operationReference(cleanupFailed));
    expect(completed).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        currentStorageState: 'snapshot_complete',
      },
    });
    if (!completed.ok) throw new Error('Expected recovered completion.');
    await expect(durableStaging.readReplayState(completed.progress.operationId)).resolves.toEqual({
      status: 'missing',
    });
    expect(cleanupTerminalOperation).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['lost ownership', async (): Promise<boolean> => false],
    ['renewal error', async (): Promise<boolean> => {
      throw new Error('claim storage unavailable');
    }],
  ] as const)(
    'fails typed before staging or import when claim renewal reports %s',
    async (_case, renew) => {
      vi.useFakeTimers();
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-claim-loss-'));
      roots.push(activeServerDir);
      const staging = createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      });
      const release = vi.fn(async () => undefined);
      const sendHistoricalCommand = vi.fn();
      let markDescribeStarted!: () => void;
      const describeStarted = new Promise<void>((resolve) => {
        markDescribeStarted = resolve;
      });
      const executor = createExternalSessionMaterializeActionExecutor({
        activeServerDir,
        operationExclusion: {
          acquire: async () => ({
            status: 'acquired',
            claim: {
              renew: vi.fn(renew),
              release,
              record: { claimId: 'materialize-claim-1' },
            },
          }),
        } as never,
        staging,
        describeSource: async () => {
          markDescribeStarted();
          return await new Promise((resolve) => {
            setTimeout(() => resolve({
              capturedSource: {
                sourceIdentity: 'source-identity-claim-loss',
                sourceGeneration: 'source-1',
                revision: 'revision-claim-loss',
                boundary: 'boundary-claim-loss',
              },
              linkedSessionRevision: 1,
            }), 60_000);
          });
        },
        readNewestFirstPages: async function* () {
          return;
        },
        readFinalCatchUpPages: noFinalCatchUpPages,
        sendHistoricalCommand,
      });

      const resultPromise = executor.start({
        request: {
          ...request(),
          idempotencyKey: `materialize-claim-loss-${_case}`,
        },
      });
      let earlyResult: Awaited<typeof resultPromise> | null = null;
      void resultPromise.then((result) => {
        earlyResult = result;
      });
      await describeStarted;
      await vi.advanceTimersByTimeAsync(20_000);

      expect(earlyResult).toEqual({
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'external_session_operation_claim_lost',
        },
      });
      expect(sendHistoricalCommand).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it('retries the same validating operation only before staging or server acceptance', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-validating-retry-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-validating-retry-owner',
    });
    const durableStaging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    let failFirstBegin = true;
    const staging = {
      ...durableStaging,
      beginOperation: vi.fn(async (input: Parameters<typeof durableStaging.beginOperation>[0]) => {
        if (failFirstBegin) {
          failFirstBegin = false;
          throw new Error('transient staging open failure');
        }
        return await durableStaging.beginOperation(input);
      }),
    };
    const describeSource = vi.fn(async () => ({
      capturedSource: {
        sourceIdentity: 'source-identity-validating-retry',
        sourceGeneration: 'source-1',
        revision: 'revision-1',
        boundary: 'boundary-1',
      },
      priorStableStorage: { state: 'machine_only' as const },
      linkedSessionRevision: 1,
    }));
    const commands: ExternalSessionOperationSocketCommandV1[] = [];
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource,
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'only-page',
          items: [item('only')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-validating-retry',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: async (command) => {
        const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
        if (authority) return authority;
        commands.push(command);
        if (command.kind === 'begin') {
          return {
            v: 1,
            kind: 'ready',
            claim: command.claim,
            revision: command.expectedRevision,
            historicalImportJobId: 'job-validating-retry',
            limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            priorStableStorage: machineOnlyPriorStableStorage,
          };
        }
        if (command.kind === 'batch') {
          return {
            v: 1,
            kind: 'batch_accepted',
            claim: command.claim,
            revision: command.expectedRevision,
            batchId: command.batchId,
            acceptedThroughServerSeq: 1,
          };
        }
        if (command.kind === 'finalize') {
          return {
            v: 1,
            kind: 'finalized',
            claim: command.claim,
            revision: command.expectedRevision,
            acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
            publication: {
              materializationPublicationId: 'publication-validating-retry',
              materializedThroughSourceAt: 300,
              publishedThroughServerSeq: 1,
            },
          };
        }
        return { v: 1, kind: 'error', errorCode: 'invalid_state', message: 'unexpected discard' };
      },
    });

    const interrupted = await executor.start({
      request: { ...request(), idempotencyKey: 'materialize-validating-retry' },
    });
    expect(interrupted).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'validating',
        currentStorageState: 'machine_only',
        checkpoint: { stagedItemCount: 0 },
      },
    });
    if (!interrupted.ok) throw new Error('Expected validating operation claim.');

    const completed = await executor.retry(operationReference(interrupted));
    expect(completed).toMatchObject({
      ok: true,
      progress: {
        status: 'completed',
        currentStorageState: 'snapshot_complete',
        checkpoint: { importedItemCount: 1 },
      },
    });
    expect(describeSource).toHaveBeenCalledTimes(2);
    expect(commands.map((command) => command.kind)).toEqual([
      'begin',
      'batch',
      'finalize',
    ]);
  });

  it('refuses Retry from ambiguous partial staging without rereading the source', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-staging-retry-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-staging-retry-owner',
    });
    const staging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    const readNewestFirstPages = vi.fn(async function* () {
      yield {
        groupId: 'captured-before-interruption',
        items: [item('captured')],
        sourceRead: {
          availability: 'reachable',
          sourceIdentity: 'source-identity-staging-retry',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          relationshipToCapture: 'same',
          eof: false,
        },
      } as const;
      throw new Error('source read interrupted');
    });
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-staging-retry',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages,
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: vi.fn(
        inspectOnlyCommandHandler(machineOnlyPriorStableStorage),
      ),
    });

    const interrupted = await executor.start({
      request: { ...request(), idempotencyKey: 'materialize-staging-retry' },
    });
    expect(interrupted).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'staging',
        currentStorageState: 'machine_only',
      },
    });
    if (!interrupted.ok) throw new Error('Expected staging operation claim.');
    const readsBeforeRetry = readNewestFirstPages.mock.calls.length;

    await expect(executor.retry(operationReference(interrupted))).resolves.toEqual({
      ok: false,
      error: {
        code: 'not_allowed',
        message: 'Materialization staging Retry requires durable capture reset proof.',
      },
    });
    expect(readNewestFirstPages).toHaveBeenCalledTimes(readsBeforeRetry);
  });

  it('cancels interrupted staging durably, marks private bytes discard-required, and discards them idempotently', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-cancel-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-cancel-owner',
    });
    const staging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    const sendHistoricalCommand = vi.fn(
      inspectOnlyCommandHandler(machineOnlyPriorStableStorage),
    );
    const cleanupStagedItems = vi.fn(async () => undefined);
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      cleanupStagedItems,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-cancel',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'captured-before-cancel',
          items: [item('captured-before-cancel')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-cancel',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: false,
          },
        } as const;
        throw new Error('interrupted before EOF');
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand,
      nowMs: (() => {
        let value = 500;
        return () => value++;
      })(),
    });

    const interrupted = await executor.start({
      request: { ...request(), idempotencyKey: 'materialize-cancel' },
    });
    if (!interrupted.ok) throw new Error('Expected interrupted operation claim.');
    const staleRevision = interrupted.progress.revision;
    const cancelled = await executor.cancel(
      operationReference(interrupted, staleRevision),
    );
    expect(cancelled).toMatchObject({
      ok: true,
      progress: {
        status: 'cancelled',
        phase: 'staging',
        currentStorageState: 'machine_only',
      },
    });
    if (!cancelled.ok) throw new Error('Expected cancelled operation.');
    await expect(staging.readReplayState(cancelled.progress.operationId)).resolves.toMatchObject({
      status: 'discard_required',
    });
    await expect(executor.cancel(
      operationReference(interrupted, staleRevision),
    )).resolves.toMatchObject({
      ok: false,
      error: { code: 'stale_revision' },
    });

    const discarded = await executor.discard(operationReference(cancelled));
    expect(discarded).toMatchObject({
      ok: true,
      progress: { status: 'cancelled' },
    });
    if (!discarded.ok) throw new Error('Expected local discard result.');
    await expect(staging.readReplayState(discarded.progress.operationId)).resolves.toEqual({
      status: 'missing',
    });
    expect(sendHistoricalCommand).toHaveBeenCalledOnce();
    expect(sendHistoricalCommand.mock.calls[0]?.[0]).toMatchObject({ kind: 'inspect' });
    expect(cleanupStagedItems).not.toHaveBeenCalled();

    await expect(executor.discard(operationReference(discarded))).resolves.toMatchObject({
      ok: true,
      progress: { status: 'cancelled' },
    });
  });

  it('cooperatively stops an active capture after durable cancel intent without beginning the next staging effect', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-active-cancel-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-active-cancel-owner',
    });
    const staging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    let markWaitingForNextPage!: () => void;
    const waitingForNextPage = new Promise<void>((resolve) => {
      markWaitingForNextPage = resolve;
    });
    let releaseNextPage!: () => void;
    const nextPage = new Promise<void>((resolve) => {
      releaseNextPage = resolve;
    });
    const sendHistoricalCommand = vi.fn(
      inspectOnlyCommandHandler(machineOnlyPriorStableStorage),
    );
    const semanticRequest = {
      ...request(),
      idempotencyKey: 'materialize-active-cancel',
    };
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-active-cancel',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'first-page',
          items: [item('first-page')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-active-cancel',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: false,
          },
        } as const;
        markWaitingForNextPage();
        await nextPage;
        yield {
          groupId: 'must-not-be-staged',
          items: [item('must-not-be-staged')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-active-cancel',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand,
    });

    const runningPromise = executor.start({ request: semanticRequest });
    await waitingForNextPage;
    const observed = await executor.start({ request: semanticRequest });
    expect(observed).toMatchObject({
      ok: true,
      progress: { status: 'running', phase: 'staging' },
    });
    if (!observed.ok) throw new Error('Expected active operation claim.');

    const cancelRequested = await executor.cancel(operationReference(observed));
    expect(cancelRequested).toMatchObject({
      ok: true,
      progress: { status: 'cancel_requested' },
    });
    if (!cancelRequested.ok) throw new Error('Expected durable active cancellation intent.');
    await expect(executor.cancel(operationReference(cancelRequested)))
      .resolves.toEqual(cancelRequested);
    releaseNextPage();
    const cancelled = await runningPromise;
    expect(cancelled).toMatchObject({
      ok: true,
      progress: { status: 'cancelled', phase: 'staging' },
    });
    if (!cancelled.ok) throw new Error('Expected active cancellation to settle.');
    await expect(staging.readReplayState(cancelled.progress.operationId)).resolves.toMatchObject({
      status: 'discard_required',
    });
    const retainedGroups = [];
    for await (const group of staging.streamReplayGroups(cancelled.progress.operationId)) {
      retainedGroups.push(group);
    }
    expect(retainedGroups).toEqual([
      expect.objectContaining({ groupId: 'first-page' }),
    ]);
    expect(sendHistoricalCommand).toHaveBeenCalledOnce();
    expect(sendHistoricalCommand.mock.calls[0]?.[0]).toMatchObject({ kind: 'inspect' });
  });

  it('finishes a durable cancel_requested row exactly once after restart', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-materialize-restart-cancel-',
    ));
    roots.push(activeServerDir);
    const semanticRequest = {
      ...request(),
      idempotencyKey: 'materialize-restart-cancel',
    };
    const operationId = externalSessionOperationIdForRequest(semanticRequest);
    const interrupted = {
      v: 1 as const,
      operationId,
      revision: 7,
      request: semanticRequest,
      status: 'cancel_requested' as const,
      phase: 'staging' as const,
      timeline: resolveExternalSessionOperationTimelineV1(semanticRequest),
      createdAtMs: 1,
      updatedAtMs: 2,
      priorStableStorage: { state: 'machine_only' as const },
      currentStorageState: 'machine_only' as const,
      checkpoint: {
        sourcePagesRead: 1,
        stagedItemCount: 1,
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
      bindings: { operationClaimId: 'released-cancel-claim' },
      progressProjection: { acknowledgedRevision: null },
      canonicalOwnerEvidence: {
        linkedSessionRevision: 1,
        sourceSnapshotEvidenceRef: 'revision-1',
      },
      fence: { kind: 'none' as const },
      cancellation: {
        requestedAtMs: 2,
        requestedAtRevision: 6,
      },
    };
    await writeExternalSessionOperationRecord(activeServerDir, interrupted);
    const describeSource = vi.fn();
    const readNewestFirstPages = vi.fn();
    const sendHistoricalCommand = vi.fn(
      inspectOnlyCommandHandler(machineOnlyPriorStableStorage),
    );
    const publishProgress = vi.fn(async () => undefined);
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'materialize-restart-cancel-owner',
      }),
      staging: createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      }),
      describeSource,
      readNewestFirstPages,
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand,
      publishProgress,
      nowMs: () => 3,
    });
    const ref = {
      sessionId: semanticRequest.sessionId,
      operationId,
      revision: interrupted.revision,
    };

    const cancelled = await executor.cancel(ref);

    expect(cancelled).toMatchObject({
      ok: true,
      progress: {
        operationId,
        revision: interrupted.revision + 1,
        status: 'cancelled',
        phase: 'staging',
      },
    });
    await expect(executor.cancel(ref)).resolves.toMatchObject({
      ok: false,
      error: { code: 'stale_revision' },
    });
    expect(describeSource).not.toHaveBeenCalled();
    expect(readNewestFirstPages).not.toHaveBeenCalled();
    expect(sendHistoricalCommand).not.toHaveBeenCalled();
    expect(publishProgress).toHaveBeenCalledOnce();
  });

  it('reconciles an in-flight accepted batch before settling active Cancel as server_partial', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-import-cancel-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-import-cancel-owner',
    });
    const staging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    let markBatchInFlight!: () => void;
    const batchInFlight = new Promise<void>((resolve) => {
      markBatchInFlight = resolve;
    });
    let releaseBatch!: () => void;
    const batchRelease = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const commands: ExternalSessionOperationSocketCommandV1[] = [];
    const semanticRequest = {
      ...request(),
      idempotencyKey: 'materialize-import-cancel',
    };
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-import-cancel',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'second-page',
          items: [item('accepted-during-cancel-second')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-import-cancel',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: false,
          },
        } as const;
        yield {
          groupId: 'first-page',
          items: [item('accepted-before-cancel')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-import-cancel',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: async (command) => {
        const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
        if (authority) return authority;
        commands.push(command);
        if (command.kind === 'begin' || command.kind === 'resume') {
          return {
            v: 1,
            kind: 'ready',
            claim: command.claim,
            revision: command.expectedRevision,
            historicalImportJobId: 'job-import-cancel',
            limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            priorStableStorage: machineOnlyPriorStableStorage,
            ...(command.kind === 'resume' ? { acceptedThroughServerSeq: 2 } : {}),
          };
        }
        if (command.kind === 'batch') {
          if (command.items[0]?.localId === 'history:accepted-before-cancel') {
            return {
              v: 1,
              kind: 'batch_accepted',
              claim: command.claim,
              revision: command.expectedRevision,
              batchId: command.batchId,
              acceptedThroughServerSeq: 1,
            };
          }
          markBatchInFlight();
          await batchRelease;
          return {
            v: 1,
            kind: 'batch_accepted',
            claim: command.claim,
            revision: command.expectedRevision,
            batchId: command.batchId,
            acceptedThroughServerSeq: 2,
          };
        }
        return { v: 1, kind: 'error', errorCode: 'invalid_state', message: 'unexpected terminal command' };
      },
    });

    const runningPromise = executor.start({ request: semanticRequest });
    await batchInFlight;
    const observed = await executor.start({ request: semanticRequest });
    expect(observed).toMatchObject({
      ok: true,
      progress: {
        status: 'running',
        phase: 'importing',
        checkpoint: {
          importedItemCount: 1,
          acceptedThroughServerSeq: 1,
        },
      },
    });
    if (!observed.ok) throw new Error('Expected importing operation claim.');

    await expect(executor.cancel(operationReference(observed))).resolves.toMatchObject({
      ok: true,
      progress: { status: 'cancel_requested' },
    });
    releaseBatch();
    const cancelled = await runningPromise;
    expect(cancelled).toMatchObject({
      ok: true,
      progress: {
        status: 'cancelled',
        phase: 'importing',
        currentStorageState: 'server_partial',
        checkpoint: {
          importedItemCount: 1,
          acceptedThroughServerSeq: 2,
        },
        fence: { kind: 'initial_server_partial', acceptedThroughServerSeq: 2 },
      },
    });
    expect(commands.map((command) => command.kind)).toEqual([
      'begin',
      'batch',
      'batch',
      'resume',
    ]);
  });

  it('recovers an acknowledged initial partial from staging before source fencing and permits Discard', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-materialize-discard-partial-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-discard-partial-owner',
    });
    const durableStaging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    let failCleanup = true;
    const staging: ExternalSessionOperationPrivateStagingStore = {
      ...durableStaging,
      async cleanupTerminalOperation(input) {
        if (failCleanup) {
          failCleanup = false;
          throw new Error('injected discard cleanup I/O failure');
        }
        return await durableStaging.cleanupTerminalOperation(input);
      },
    };
    const commands: ExternalSessionOperationSocketCommandV1[] = [];
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-discard-partial',
          sourceGeneration: 'source-1',
          revision: 'revision-1',
          boundary: 'boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'newest-page',
          items: [item('discarded-row-newest')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-discard-partial',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: false,
          },
        } as const;
        yield {
          groupId: 'oldest-page',
          items: [item('discarded-row-oldest')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'source-identity-discard-partial',
            sourceGeneration: 'source-1',
            revision: 'revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: async (command) => {
        const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
        if (authority) return authority;
        commands.push(command);
        if (command.kind === 'begin') {
          return {
            v: 1,
            kind: 'ready',
            claim: command.claim,
            revision: command.expectedRevision,
            historicalImportJobId: 'job-discard-partial',
            limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            priorStableStorage: machineOnlyPriorStableStorage,
          };
        }
        if (command.kind === 'batch') {
          if (command.items[0]?.localId === 'history:discarded-row-newest') {
            return {
              v: 1,
              kind: 'error',
              errorCode: 'internal_error',
              message: 'import interrupted after the first accepted page',
            };
          }
          return {
            v: 1,
            kind: 'batch_accepted',
            claim: command.claim,
            revision: command.expectedRevision,
            batchId: command.batchId,
            acceptedThroughServerSeq: command.items.length,
          };
        }
        if (command.kind === 'discard') {
          return {
            v: 1,
            kind: 'discarded',
            claim: command.claim,
            revision: command.expectedRevision,
          };
        }
        return { v: 1, kind: 'error', errorCode: 'internal_error', message: 'publication interrupted' };
      },
    });

    const interrupted = await executor.start({
      request: { ...request(), idempotencyKey: 'materialize-discard-partial' },
    });
    expect(interrupted).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'importing',
        currentStorageState: 'server_partial',
        fence: { kind: 'initial_server_partial', acceptedThroughServerSeq: 1 },
      },
    });
    if (!interrupted.ok) throw new Error('Expected partial operation claim.');

    const acknowledgedRecord = await readExternalSessionOperationRecord(
      activeServerDir,
      interrupted.progress.operationId,
    );
    if (!acknowledgedRecord) throw new Error('Expected durable materialization record.');
    const {
      acceptedThroughServerSeq: _acceptedThroughServerSeq,
      acknowledgedBatchId: _acknowledgedBatchId,
      ...checkpointBeforeAcknowledgment
    } = acknowledgedRecord.checkpoint;
    const receiptRecoveryRevision = acknowledgedRecord.revision + 1;
    await writeExternalSessionOperationRecord(activeServerDir, {
      ...acknowledgedRecord,
      revision: receiptRecoveryRevision,
      updatedAtMs: acknowledgedRecord.updatedAtMs + 1,
      currentStorageState: 'machine_only',
      checkpoint: {
        ...checkpointBeforeAcknowledgment,
        importedItemCount: 0,
      },
      fence: { kind: 'none' },
    });
    const sourceChangedExecutor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      describeSource: vi.fn(),
      revalidateSource: async () => {
        throw new ExternalSessionMaterializeSourceInterruptionError(
          'source_changed',
          'The source was replaced after the durable server acknowledgment.',
        );
      },
      readNewestFirstPages: vi.fn(),
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: async () => {
        throw new Error('Source fencing must precede server continuation.');
      },
    });
    const sourceChanged = await sourceChangedExecutor.resume(
      operationReference(interrupted, receiptRecoveryRevision),
    );
    expect(sourceChanged).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'importing',
        currentStorageState: 'server_partial',
        checkpoint: {
          importedItemCount: 1,
          acceptedThroughServerSeq: 1,
        },
        fence: {
          kind: 'initial_server_partial',
          acceptedThroughServerSeq: 1,
        },
        error: { code: 'source_changed' },
      },
    });
    if (!sourceChanged.ok) throw new Error('Expected source-fenced operation claim.');

    await expect(executor.discard(operationReference(sourceChanged))).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    });
    await expect(executor.status(operationReference(sourceChanged))).resolves.toMatchObject({
      ok: true,
      progress: {
        revision: sourceChanged.progress.revision,
        status: 'awaiting_user_resume',
      },
    });

    const cleanupStagedItems = vi.fn(async () => undefined);
    const restarted = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      cleanupStagedItems,
      describeSource: vi.fn(),
      readNewestFirstPages: vi.fn(),
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: async (command) => {
        commands.push(command);
        if (command.kind === 'discard') {
          return {
            v: 1,
            kind: 'discarded',
            claim: command.claim,
            revision: command.expectedRevision,
          };
        }
        return {
          v: 1,
          kind: 'error',
          errorCode: 'invalid_state',
          message: 'Unexpected recovery command.',
        };
      },
    });
    const discarded = await restarted.discard(operationReference(sourceChanged));
    expect(discarded).toMatchObject({
      ok: true,
      progress: {
        status: 'discarded',
        currentStorageState: 'machine_only',
        checkpoint: {
          sourcePagesRead: 0,
          stagedItemCount: 0,
          importedItemCount: 0,
        },
        fence: { kind: 'none' },
      },
    });
    if (!discarded.ok) throw new Error('Expected discarded operation.');
    expect(commands.map((command) => command.kind)).toEqual([
      'begin',
      'batch',
      'batch',
      'discard',
      'discard',
    ]);
    expect(cleanupStagedItems).toHaveBeenCalledOnce();
    expect(cleanupStagedItems).toHaveBeenCalledWith(
      sourceChanged.progress.operationId,
      expect.objectContaining({
        sessionId: 'session-1',
        idempotencyKey: 'materialize-discard-partial',
      }),
    );
    await expect(durableStaging.readReplayState(discarded.progress.operationId)).resolves.toEqual({
      status: 'missing',
    });
    await expect(restarted.discard(operationReference(discarded))).resolves.toEqual(discarded);
  });

  it.each(['validating', 'quiescing'] as const)(
    'resumes a durable persisted takeover from %s through import and publication, then stops before admission even when projection publication fails',
    async (initialPhase) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-phase-runner-'));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'takeover-phase-runner-owner',
    });
    const staging = createExternalSessionOperationPrivateStagingStore({
      activeServerDir,
      limits: {
        perOperation: { maxItems: 20, maxBytes: 50_000 },
        aggregate: { maxItems: 40, maxBytes: 100_000 },
      },
    });
    const validating = persistedTakeoverValidatingRecord();
    const initial: ExternalSessionOperationRecordV1 = initialPhase === 'validating'
      ? validating
      : {
        ...validating,
        revision: validating.revision + 1,
        phase: 'quiescing',
        updatedAtMs: validating.updatedAtMs + 1,
      };
    await writeExternalSessionOperationRecord(activeServerDir, initial);
    const serverOrder: string[] = [];
    const commands: ExternalSessionOperationSocketCommandV1[] = [];
    const resumeFollowOnFailure = vi.fn(async () => undefined);
    const preparePersistedTakeover = vi.fn(async () => ({
      resumeFollowOnFailure,
    }));
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion,
      staging,
      preparePersistedTakeover,
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'takeover-source-identity',
          sourceGeneration: initial.request.source.sourceGeneration,
          revision: 'takeover-source-revision-1',
          boundary: 'takeover-source-boundary-1',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'takeover-page',
          items: [item('takeover-history')],
          sourceRead: {
            availability: 'reachable',
            sourceIdentity: 'takeover-source-identity',
            sourceGeneration: initial.request.source.sourceGeneration,
            revision: 'takeover-source-revision-1',
            relationshipToCapture: 'same',
            eof: true,
          },
        } as const;
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: async (command) => {
        const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
        if (authority) return authority;
        commands.push(command);
        if (command.kind === 'begin') {
          return {
            v: 1,
            kind: 'ready',
            claim: command.claim,
            revision: command.expectedRevision,
            historicalImportJobId: 'takeover-import-job',
            limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            priorStableStorage: machineOnlyPriorStableStorage,
          };
        }
        if (command.kind === 'batch') {
          serverOrder.push(...command.items.map((entry) => entry.localId));
          return {
            v: 1,
            kind: 'batch_accepted',
            claim: command.claim,
            revision: command.expectedRevision,
            batchId: command.batchId,
            acceptedThroughServerSeq: serverOrder.length,
          };
        }
        if (command.kind === 'finalize') {
          return {
            v: 1,
            kind: 'finalized',
            claim: command.claim,
            revision: command.expectedRevision,
            acceptedThroughServerSeq: command.expectedAcceptedThroughServerSeq,
            publication: {
              materializationPublicationId: 'takeover-publication-1',
              materializedThroughSourceAt: 101,
              publishedThroughServerSeq: 1,
            },
          };
        }
        return {
          v: 1,
          kind: 'error',
          errorCode: 'invalid_state',
          message: `Unexpected takeover command ${command.kind}.`,
        };
      },
      publishProgress: async ({ progress }) => {
        if (progress.phase === 'admitting') {
          throw new Error('injected projection publication failure');
        }
      },
      nowMs: (() => {
        let value = 100;
        return () => value++;
      })(),
    });

    const result = await executor.resumePersistedTakeover({
      sessionId: initial.request.sessionId,
      operationId: initial.operationId,
      revision: initial.revision,
    });

    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'admitting',
        currentStorageState: 'snapshot_complete',
        retryTargetPhase: 'admitting',
        publication: {
          materializationPublicationId: 'takeover-publication-1',
          publishedThroughServerSeq: 1,
        },
        fence: { kind: 'none' },
        checkpoint: {
          stagedItemCount: 1,
          importedItemCount: 1,
          acceptedThroughServerSeq: 1,
        },
      },
    });
    expect(serverOrder).toEqual(['history:takeover-history']);
    expect(commands.map((command) => command.kind)).toEqual([
      'begin',
      'batch',
      'finalize',
    ]);
    expect(preparePersistedTakeover).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: initial.operationId,
        revision: initial.revision,
      }),
    );
    expect(resumeFollowOnFailure).not.toHaveBeenCalled();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      initial.operationId,
    )).resolves.toMatchObject({
      status: 'awaiting_user_resume',
      phase: 'admitting',
      currentStorageState: 'snapshot_complete',
      retryTargetPhase: 'admitting',
    });
    const commandCountAfterResume = commands.length;
    if (!result.ok) throw new Error('Expected published takeover checkpoint.');
    await expect(executor.status({
      sessionId: initial.request.sessionId,
      operationId: initial.operationId,
      revision: result.progress.revision,
    })).resolves.toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'admitting',
      },
    });
    expect(commands).toHaveLength(commandCountAfterResume);
    expect(resumeFollowOnFailure).not.toHaveBeenCalled();
    },
  );

  it('fails persisted takeover preflight without describing, importing, or mutating the durable operation', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-preflight-'));
    roots.push(activeServerDir);
    const initial = persistedTakeoverValidatingRecord();
    await writeExternalSessionOperationRecord(activeServerDir, initial);
    const describeSource = vi.fn();
    const sendHistoricalCommand = vi.fn();
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'takeover-preflight-owner',
      }),
      staging: createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      }),
      preparePersistedTakeover: async () => {
        throw new ExternalSessionPersistedTakeoverPreflightError(
          'source_unavailable',
          'Source generation was replaced.',
        );
      },
      describeSource,
      readNewestFirstPages: async function* () {
        throw new Error('capture must not start');
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand,
    });

    await expect(executor.resumePersistedTakeover({
      sessionId: initial.request.sessionId,
      operationId: initial.operationId,
      revision: initial.revision,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'source_unavailable' },
    });
    expect(describeSource).not.toHaveBeenCalled();
    expect(sendHistoricalCommand).not.toHaveBeenCalled();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      initial.operationId,
    )).resolves.toEqual(initial);
  });

  it('refuses a replacement between persisted takeover preflight and source description before committing the new cursor or staging', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-takeover-source-bridge-'));
    roots.push(activeServerDir);
    const initial = persistedTakeoverValidatingRecord();
    await writeExternalSessionOperationRecord(activeServerDir, initial);
    const revalidateSource = vi.fn(async () => {
      throw new ExternalSessionMaterializeSourceInterruptionError(
        'source_changed',
        'The physical source was replaced after preflight.',
      );
    });
    const readNewestFirstPages = vi.fn(async function* () {
      throw new Error('replacement source must not be staged');
    });
    const sendHistoricalCommand = vi.fn(
      inspectOnlyCommandHandler(machineOnlyPriorStableStorage),
    );
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'takeover-source-bridge-owner',
      }),
      staging: createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      }),
      preparePersistedTakeover: async () => ({
        resumeFollowOnFailure: async () => undefined,
      }),
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'same-logical-path',
          sourceGeneration: initial.request.source.sourceGeneration,
          revision: 'replacement-source-cursor-b',
          boundary: 'replacement-source-boundary-b',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: 1,
      }),
      revalidateSource,
      readNewestFirstPages,
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand,
    });

    const result = await executor.resumePersistedTakeover({
      sessionId: initial.request.sessionId,
      operationId: initial.operationId,
      revision: initial.revision,
    });

    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'validating',
        error: { code: 'source_changed' },
      },
    });
    expect(revalidateSource).toHaveBeenCalledWith(
      initial.request,
      expect.objectContaining({ revision: 'replacement-source-cursor-b' }),
      'takeover-source-cursor-1',
    );
    expect(readNewestFirstPages).not.toHaveBeenCalled();
    expect(sendHistoricalCommand).toHaveBeenCalledOnce();
    expect(sendHistoricalCommand).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'inspect' }),
    );
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      initial.operationId,
    )).resolves.toMatchObject({
      canonicalOwnerEvidence: {
        sourceSnapshotEvidenceRef: 'takeover-source-cursor-1',
      },
      checkpoint: {
        sourcePagesRead: 0,
        stagedItemCount: 0,
        importedItemCount: 0,
      },
    });
  });

  it('allows persisted takeover Cancel/Discard only before snapshot publication', async () => {
    const createExecutor = (
      activeServerDir: string,
      ownerId: string,
    ) => createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId,
      }),
      staging: createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      }),
      describeSource: vi.fn(),
      readNewestFirstPages: async function* () {
        throw new Error('capture must not start');
      },
      readFinalCatchUpPages: noFinalCatchUpPages,
      sendHistoricalCommand: vi.fn(),
    });

    const precommitDir = await mkdtemp(join(tmpdir(), 'happier-takeover-cancel-'));
    roots.push(precommitDir);
    const precommit = persistedTakeoverValidatingRecord();
    await writeExternalSessionOperationRecord(precommitDir, precommit);
    const precommitExecutor = createExecutor(
      precommitDir,
      'takeover-cancel-owner',
    );
    const cancelled = await precommitExecutor.cancel({
      sessionId: precommit.request.sessionId,
      operationId: precommit.operationId,
      revision: precommit.revision,
    });
    expect(cancelled).toMatchObject({
      ok: true,
      progress: {
        status: 'cancelled',
        currentStorageState: 'machine_only',
      },
    });
    if (!cancelled.ok) throw new Error('Expected precommit takeover cancellation.');
    await expect(precommitExecutor.discard({
      sessionId: precommit.request.sessionId,
      operationId: precommit.operationId,
      revision: cancelled.progress.revision,
    })).resolves.toMatchObject({
      ok: true,
      progress: { status: 'cancelled' },
    });

    const publishedDir = await mkdtemp(join(tmpdir(), 'happier-takeover-published-'));
    roots.push(publishedDir);
    const validating = persistedTakeoverValidatingRecord();
    const published: ExternalSessionOperationRecordV1 = {
      ...validating,
      revision: 10,
      status: 'awaiting_user_resume',
      phase: 'admitting',
      currentStorageState: 'snapshot_complete',
      checkpoint: {
        ...validating.checkpoint,
        sourcePagesRead: 1,
        stagedItemCount: 1,
        importedItemCount: 1,
        acceptedThroughServerSeq: 1,
        acknowledgedBatchId: 'historical-import-complete',
      },
      publication: {
        materializationPublicationId: 'published-takeover',
        materializedThroughSourceAt: 1,
        publishedThroughServerSeq: 1,
      },
      fence: { kind: 'none' },
      retryTargetPhase: 'admitting',
    };
    await writeExternalSessionOperationRecord(publishedDir, published);
    const publishedExecutor = createExecutor(
      publishedDir,
      'takeover-published-owner',
    );
    const reference = {
      sessionId: published.request.sessionId,
      operationId: published.operationId,
      revision: published.revision,
    };
    await expect(publishedExecutor.cancel(reference)).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_allowed' },
    });
    await expect(publishedExecutor.discard(reference)).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_allowed' },
    });
  });
});
