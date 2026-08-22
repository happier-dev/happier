import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY,
  ExternalSessionOperationSharedPresentationV1Schema,
  openSessionOwnerMetadataEnvelopeV1,
  projectExternalSessionOperationProgressV1,
  resolveExternalSessionOperationTimelineV1,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationSharedPresentationV1,
  type ExternalSessionOperationSocketCommandV1,
  type ExternalSessionOperationSocketResponseV1,
  type ExternalSessionPriorStableStorageV1,
  type SessionOwnerMetadataEnvelopeV1,
  type SessionMetadataTuplePatchV1,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundaryMocks = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  fetchSessionByIdCompat: vi.fn(),
  patchSessionMetadata: vi.fn(),
  patchSessionMetadataEnvelopeTuple: vi.fn(),
  readCredentials: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: boundaryMocks.fetchSessionById,
  fetchSessionByIdCompat: boundaryMocks.fetchSessionByIdCompat,
  patchSessionMetadata: boundaryMocks.patchSessionMetadata,
  patchSessionMetadataEnvelopeTuple:
    boundaryMocks.patchSessionMetadataEnvelopeTuple,
}));

vi.mock('@/persistence', () => ({
  readStoredCredentials: boundaryMocks.readCredentials,
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness:
    boundaryMocks.fetchAccountEncryptionCurrentness,
}));

import {
  createExternalSessionMaterializeActionExecutor,
} from './materializeAction';
import {
  buildSessionMetadataEnvelopeFields,
} from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import {
  createExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';
import {
  createExternalSessionOperationPrivateStagingStore,
} from '@/session/external/staging/operationPrivateStaging';
import {
  assertExternalSessionOperationProgressCanBeSelected,
  publishExternalSessionOperationProgress,
  settlePriorTerminalExternalSessionOperationProgressProjections,
} from './operationProgressPublisher';
import {
  mutateExternalSessionOperationRecordAtRevision,
  readExternalSessionOperationRecord,
  readExternalSessionOperationStoredEntry,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';
import {
  createExternalSessionSourceGenerationAnchor,
} from './sourceGenerationAnchor';

type MutableRawSession = {
  metadata: string;
  metadataVersion: number;
  metadataLayoutVersion: 0 | 1;
  ownerMetadata: SessionOwnerMetadataEnvelopeV1 | null;
  agentState: string | null;
  agentStateVersion: number;
  encryptionMode: 'plain';
  dataEncryptionKey: null;
};

const roots: string[] = [];
const machineOnlyPriorStableStorage = {
  state: 'machine_only',
} satisfies ExternalSessionPriorStableStorageV1;

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

function validatingTakeoverRecord(): ExternalSessionOperationRecordV1 {
  const sourceSnapshotEvidenceRef = 'source-cursor-a';
  const request = {
    v: 1 as const,
    idempotencyKey: 'takeover-progress-currentness-1',
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
      sourceGeneration: createExternalSessionSourceGenerationAnchor(
        sourceSnapshotEvidenceRef,
      ),
      contributionGeneration: 'contribution-1',
    },
    plan: 'takeover' as const,
    targetStorageMode: 'persisted' as const,
    targetDirectory: '/local/selected/workspace',
    targetRuntimeMode: 'terminal' as const,
  };
  return {
    v: 1,
    operationId: 'external-takeover:progress-currentness-1',
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
    bindings: { operationClaimId: 'released-start-claim' },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: {
      linkedSessionRevision: 7,
      sourceSnapshotEvidenceRef,
    },
    fence: { kind: 'none' },
    retryTargetPhase: 'validating',
  };
}

function validatingMaterializeRecord(): ExternalSessionOperationRecordV1 {
  const sourceSnapshotEvidenceRef = 'source-cursor-materialize-a';
  const request = {
    v: 1 as const,
    idempotencyKey: 'materialize-progress-currentness-1',
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
      sourceGeneration: createExternalSessionSourceGenerationAnchor(
        sourceSnapshotEvidenceRef,
      ),
      contributionGeneration: 'contribution-1',
    },
    plan: 'materialize' as const,
    targetStorageMode: 'external-linked' as const,
    targetRuntimeMode: null,
  };
  return {
    v: 1,
    operationId: 'external-materialize:progress-currentness-1',
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
    bindings: { operationClaimId: 'private-claim-from-durable-record' },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: {
      linkedSessionRevision: 7,
      sourceSnapshotEvidenceRef,
    },
    fence: { kind: 'none' },
    retryTargetPhase: 'validating',
  };
}

function installMetadataMigrationCas(
  rawSession: MutableRawSession,
  beforeCommit?: () => Promise<void>,
): void {
  boundaryMocks.patchSessionMetadataEnvelopeTuple.mockImplementation(
    async (request: Readonly<{ patch: SessionMetadataTuplePatchV1 }>) => {
      await beforeCommit?.();
      const { patch } = request;
      if (patch.mode === 'owner') {
        if (
          rawSession.metadataLayoutVersion !== 1
          || JSON.stringify(patch.expectedOwnerMetadata)
            !== JSON.stringify(rawSession.ownerMetadata)
          || patch.sharedMetadata.expectedVersion
            !== rawSession.metadataVersion
          || patch.agentState.expectedVersion
            !== rawSession.agentStateVersion
        ) {
          return {
            success: false as const,
            error: 'session_metadata_version_conflict' as const,
            metadataLayoutVersion: rawSession.metadataLayoutVersion,
            sharedMetadata: { version: rawSession.metadataVersion },
            agentState: { version: rawSession.agentStateVersion },
          };
        }
        rawSession.metadata = patch.sharedMetadata.ciphertext;
        rawSession.metadataVersion += 1;
        rawSession.ownerMetadata = patch.ownerMetadata;
        rawSession.agentState = patch.agentState.ciphertext;
        rawSession.agentStateVersion += 1;
        return {
          success: true as const,
          metadataLayoutVersion: 1 as const,
          sharedMetadata: { version: rawSession.metadataVersion },
          ownerMetadata: { version: rawSession.metadataVersion },
          agentState: { version: rawSession.agentStateVersion },
        };
      }
      if (patch.mode !== 'owner_migration') {
        throw new Error(`expected owner mutation, received ${patch.mode}`);
      }
      if (
        rawSession.metadataLayoutVersion !== 0
        || patch.source.metadata.version !== rawSession.metadataVersion
        || patch.source.metadata.ciphertext !== rawSession.metadata
        || patch.source.ownerMetadata !== null
        || patch.source.agentState.version !== rawSession.agentStateVersion
        || patch.source.agentState.ciphertext !== rawSession.agentState
      ) {
        return {
          success: false as const,
          error: 'session_metadata_version_conflict' as const,
          metadataLayoutVersion: rawSession.metadataLayoutVersion,
          sharedMetadata: { version: rawSession.metadataVersion },
          agentState: { version: rawSession.agentStateVersion },
        };
      }
      rawSession.metadata = patch.target.sharedMetadata.ciphertext;
      rawSession.metadataVersion += 1;
      rawSession.metadataLayoutVersion = 1;
      rawSession.ownerMetadata = patch.target.ownerMetadata;
      rawSession.agentState = patch.target.agentState.ciphertext;
      rawSession.agentStateVersion += 1;
      return {
        success: true as const,
        metadataLayoutVersion: 1 as const,
        sharedMetadata: { version: rawSession.metadataVersion },
        agentState: { version: rawSession.agentStateVersion },
      };
    },
  );
  boundaryMocks.fetchSessionById.mockImplementation(async () => rawSession);
  boundaryMocks.fetchSessionByIdCompat.mockImplementation(
    async () => rawSession,
  );
}

function installMetadataTupleCas(
  rawSession: MutableRawSession,
  beforeCommit?: () => Promise<void>,
): void {
  boundaryMocks.patchSessionMetadataEnvelopeTuple.mockImplementation(
    async (request: Readonly<{
      patch: Readonly<{
        expectedOwnerMetadata: SessionOwnerMetadataEnvelopeV1;
        sharedMetadata: Readonly<{
          ciphertext: string;
          expectedVersion: number;
        }>;
        ownerMetadata: SessionOwnerMetadataEnvelopeV1;
        agentState: Readonly<{
          ciphertext: string | null;
          expectedVersion: number;
        }>;
      }>;
    }>) => {
      await beforeCommit?.();
      if (
        JSON.stringify(request.patch.expectedOwnerMetadata)
          !== JSON.stringify(rawSession.ownerMetadata)
        || request.patch.sharedMetadata.expectedVersion
          !== rawSession.metadataVersion
        || request.patch.agentState.expectedVersion
          !== rawSession.agentStateVersion
      ) {
        return {
          success: false as const,
          error: 'session_metadata_version_conflict' as const,
          metadataLayoutVersion: 1 as const,
          sharedMetadata: { version: rawSession.metadataVersion },
          agentState: { version: rawSession.agentStateVersion },
        };
      }
      rawSession.metadata = request.patch.sharedMetadata.ciphertext;
      rawSession.metadataVersion += 1;
      rawSession.ownerMetadata = request.patch.ownerMetadata;
      rawSession.agentState = request.patch.agentState.ciphertext;
      rawSession.agentStateVersion += 1;
      return {
        success: true as const,
        metadataLayoutVersion: 1 as const,
        sharedMetadata: { version: rawSession.metadataVersion },
        ownerMetadata: { version: rawSession.metadataVersion },
        agentState: { version: rawSession.agentStateVersion },
      };
    },
  );
  boundaryMocks.fetchSessionById.mockImplementation(async () => rawSession);
  boundaryMocks.fetchSessionByIdCompat.mockImplementation(
    async () => rawSession,
  );
}

async function terminalizeMaterializeRecord(
  activeServerDir: string,
  initial: ExternalSessionOperationRecordV1,
  identity: string,
): Promise<ExternalSessionOperationRecordV1> {
  const result = await mutateExternalSessionOperationRecordAtRevision(
    activeServerDir,
    initial.operationId,
    initial.revision,
    (current) => {
      const {
        retryTargetPhase: _retryTargetPhase,
        error: _error,
        ...withoutRetry
      } = current;
      return {
        ...withoutRetry,
        revision: current.revision + 1,
        status: 'completed',
        phase: 'publishing',
        updatedAtMs: current.updatedAtMs + 1,
        currentStorageState: 'snapshot_complete',
        checkpoint: {
          ...current.checkpoint,
          acceptedThroughServerSeq: 0,
          acknowledgedBatchId: `historical-import-${identity}`,
        },
        bindings: {
          ...current.bindings,
          historicalImportJobId: `historical-import-${identity}`,
        },
        publication: {
          materializationPublicationId: `publication-${identity}`,
          materializedThroughSourceAt: current.updatedAtMs + 1,
          publishedThroughServerSeq: 0,
        },
        terminalResult: { kind: 'completed' },
      };
    },
  );
  if (!result.ok) {
    throw new Error(`failed to terminalize ${identity}: ${result.code}`);
  }
  return result.record;
}

beforeEach(() => {
  boundaryMocks.fetchSessionById.mockReset();
  boundaryMocks.fetchSessionByIdCompat.mockReset();
  boundaryMocks.patchSessionMetadata.mockReset();
  boundaryMocks.patchSessionMetadata.mockRejectedValue(
    new Error('HTTP fallback must not run'),
  );
  boundaryMocks.patchSessionMetadataEnvelopeTuple.mockReset();
  boundaryMocks.patchSessionMetadataEnvelopeTuple.mockRejectedValue(
    new Error('owner tuple fallback must not run'),
  );
  boundaryMocks.readCredentials.mockReset();
  boundaryMocks.readCredentials.mockResolvedValue({
    token: 'token-1',
    encryption: null,
  });
  boundaryMocks.fetchAccountEncryptionCurrentness.mockReset();
  boundaryMocks.fetchAccountEncryptionCurrentness.mockResolvedValue({
    mode: 'plain', version: 1, signingKeyFingerprint: null,
    contentKeyFingerprint: null, updatedAt: 1,
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('materialize semantic currentness after operation progress publication', () => {
  it('compacts an external-linked takeover only after the canonical publisher durably acknowledges its completed presentation', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-external-linked-completion-publication-',
    ));
    roots.push(activeServerDir);
    const base = validatingTakeoverRecord();
    const request = {
      ...base.request,
      targetStorageMode: 'external-linked' as const,
    };
    const {
      retryTargetPhase: _retryTargetPhase,
      ...baseWithoutRetryTarget
    } = base;
    const completed: ExternalSessionOperationRecordV1 = {
      ...baseWithoutRetryTarget,
      request,
      revision: 1,
      status: 'completed',
      phase: 'finalizing',
      timeline: resolveExternalSessionOperationTimelineV1(request),
      updatedAtMs: 2,
      terminalResult: { kind: 'completed' },
    };
    await writeExternalSessionOperationRecord(activeServerDir, completed);
    const rawSession: MutableRawSession = {
      metadata: '{}',
      metadataVersion: 7,
      metadataLayoutVersion: 0,
      ownerMetadata: null,
      agentState: null,
      agentStateVersion: 0,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    };
    installMetadataMigrationCas(rawSession);

    await publishExternalSessionOperationProgress({
      activeServerDir,
      sessionId: completed.request.sessionId,
      progress: projectExternalSessionOperationProgressV1(completed),
    });

    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      completed.operationId,
    )).resolves.toMatchObject({
      kind: 'completion_receipt',
      receipt: {
        reference: {
          sessionId: completed.request.sessionId,
          operationId: completed.operationId,
          revision: completed.revision,
        },
        presentation: {
          operationId: completed.operationId,
          revision: completed.revision,
          status: 'completed',
        },
      },
    });
  });

  it('migrates one layout-0 publish into an exact shared presentation and complete owner operation before acknowledging it', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-materialize-public-reference-',
    ));
    roots.push(activeServerDir);
    const initial = validatingMaterializeRecord();
    await writeExternalSessionOperationRecord(activeServerDir, initial);
    const rawSession: MutableRawSession = {
      metadata: '{}',
      metadataVersion: 7,
      metadataLayoutVersion: 0,
      ownerMetadata: null,
      agentState: null,
      agentStateVersion: 0,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    };
    installMetadataMigrationCas(rawSession);

    const expectedProgress = projectExternalSessionOperationProgressV1(initial);
    await publishExternalSessionOperationProgress({
      activeServerDir,
      sessionId: initial.request.sessionId,
      progress: expectedProgress,
    });
    const publishedMetadata = JSON.parse(rawSession.metadata);
    const pushedState =
      ExternalSessionOperationSharedPresentationV1Schema.parse(
        publishedMetadata[
          EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY
        ],
      );
    expect(publishedMetadata).not.toHaveProperty(
      'externalSessionOperationV1',
    );
    expect(pushedState).toEqual({
      v: 1,
      operationId: expectedProgress.operationId,
      revision: expectedProgress.revision,
      kind: expectedProgress.request.plan,
      status: expectedProgress.status,
      phase: expectedProgress.phase,
    });
    expect(Object.keys(pushedState).sort()).toEqual([
      'kind',
      'operationId',
      'phase',
      'revision',
      'status',
      'v',
    ]);
    if (!rawSession.ownerMetadata) {
      throw new Error('expected layout-1 owner metadata');
    }
    const ownerMetadata = openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'plain',
      envelope: rawSession.ownerMetadata,
    });
    expect(ownerMetadata.ok && ownerMetadata.ownerMetadata.runtime?.externalSessionOperationV1).toEqual({
      v: 1,
      progress: expectedProgress,
    });
    expect(boundaryMocks.patchSessionMetadataEnvelopeTuple).toHaveBeenCalledOnce();
    expect(boundaryMocks.patchSessionMetadata).not.toHaveBeenCalled();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      initial.operationId,
    )).resolves.toMatchObject({
      progressProjection: {
        acknowledgedRevision: expectedProgress.revision,
      },
    });
    const publicReference = {
      sessionId: initial.request.sessionId,
      operationId: pushedState.operationId,
      revision: pushedState.revision,
    };

    const exclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'materialize-public-reference-owner',
    });
    const acquire = vi.fn((...args: Parameters<typeof exclusion.acquire>) =>
      exclusion.acquire(...args)
    );
    const describeSource = vi.fn(async () => {
      throw new Error('stop after owner-side private claim resolution');
    });
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, machineOnlyPriorStableStorage);
      if (authority) return authority;
      throw new Error(`Unexpected effectful historical import command: ${command.kind}`);
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
      revalidateSource: async () => undefined,
      readNewestFirstPages: async function* () {
        throw new Error('source pages must not be read');
      },
      readFinalCatchUpPages: async function* () {},
      sendHistoricalCommand,
      publishProgress,
    });

    const publicActions = [
      executor.resume,
      executor.retry,
      executor.cancel,
      executor.discard,
    ] as const;
    for (const action of publicActions) {
      await expect(action({
        ...publicReference,
        revision: publicReference.revision + 1,
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'stale_revision' },
      });
      await expect(action({
        ...publicReference,
        sessionId: 'session-other',
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'operation_not_found' },
      });
    }
    expect(acquire).not.toHaveBeenCalled();
    expect(describeSource).not.toHaveBeenCalled();
    expect(sendHistoricalCommand).not.toHaveBeenCalled();
    expect(publishProgress).not.toHaveBeenCalled();

    await expect(executor.retry(publicReference)).resolves.toMatchObject({
      ok: true,
      progress: {
        operationId: initial.operationId,
        revision: initial.revision + 1,
        status: 'awaiting_user_resume',
        phase: 'validating',
      },
    });
    expect(acquire).toHaveBeenCalledOnce();
    expect(sendHistoricalCommand).toHaveBeenCalledOnce();
    expect(sendHistoricalCommand.mock.calls[0]?.[0]).toMatchObject({
      kind: 'inspect',
      claim: {
        sessionId: initial.request.sessionId,
        operationId: initial.operationId,
        operationClaimId: initial.bindings.operationClaimId,
      },
      expectedRevision: publicReference.revision,
    });
    expect(describeSource).toHaveBeenCalledOnce();
    expect(publishProgress).toHaveBeenCalledOnce();
  });

  it('continues an unchanged persisted takeover after the real progress publisher increments metadataVersion', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-progress-currentness-',
    ));
    roots.push(activeServerDir);
    const initial = validatingTakeoverRecord();
    await writeExternalSessionOperationRecord(activeServerDir, initial);
    const rawSession: MutableRawSession = {
      metadata: JSON.stringify({
        externalSessionV1: {
          v: 1,
          agentId: 'example',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source: { kind: 'jsonl' },
          linkedAtMs: 1,
        },
      }),
      metadataVersion: 7,
      metadataLayoutVersion: 0,
      ownerMetadata: null,
      agentState: null,
      agentStateVersion: 0,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    };
    installMetadataMigrationCas(rawSession);

    await publishExternalSessionOperationProgress({
      activeServerDir,
      sessionId: initial.request.sessionId,
      progress: projectExternalSessionOperationProgressV1(initial),
    });
    expect(rawSession.metadataVersion).toBe(8);

    const commands: ExternalSessionOperationSocketCommandV1[] = [];
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'takeover-progress-currentness-owner',
      }),
      staging: createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      }),
      preparePersistedTakeover: async () => ({
        workingDirectory: '/workspace',
        resumeFollowOnFailure: async () => undefined,
      }),
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-1',
          sourceGeneration: initial.request.source.sourceGeneration,
          revision: 'source-cursor-b',
          boundary: 'source-boundary-b',
        },
        priorStableStorage: { state: 'machine_only' },
        linkedSessionRevision: rawSession.metadataVersion,
      }),
      revalidateSource: async () => undefined,
      readNewestFirstPages: async function* () {
        yield {
          groupId: 'page-1',
          items: [{
            localId: 'history:one',
            sidechainId: null,
            messageRole: 'user' as const,
            content: {
              t: 'plain' as const,
              v: { role: 'user', text: 'one' },
            },
          }],
          sourceRead: {
            availability: 'reachable' as const,
            sourceIdentity: 'source-identity-1',
            sourceGeneration: initial.request.source.sourceGeneration,
            revision: 'source-cursor-b',
            relationshipToCapture: 'same' as const,
            eof: true,
          },
        };
      },
      readFinalCatchUpPages: async function* () {},
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
            historicalImportJobId: 'job-1',
            limits: { maxItems: 20, maxSerializedBytes: 50_000 },
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
            acceptedThroughServerSeq: command.items.length,
          };
        }
        if (command.kind === 'finalize') {
          return {
            v: 1,
            kind: 'finalized',
            claim: command.claim,
            revision: command.expectedRevision,
            acceptedThroughServerSeq:
              command.expectedAcceptedThroughServerSeq,
            publication: {
              materializationPublicationId: 'publication-1',
              materializedThroughSourceAt: 10,
              publishedThroughServerSeq:
                command.expectedAcceptedThroughServerSeq,
            },
          };
        }
        return {
          v: 1,
          kind: 'error',
          errorCode: 'invalid_state',
          message: `unexpected command ${command.kind}`,
        };
      },
      publishProgress: async (input) =>
        await publishExternalSessionOperationProgress({
          ...input,
          activeServerDir,
        }),
    });

    const result = await executor.resumePersistedTakeover({
      sessionId: initial.request.sessionId,
      operationId: initial.operationId,
      revision: initial.revision,
    });

    if (
      !result.ok
      || result.progress.phase !== 'admitting'
      || result.progress.currentStorageState !== 'snapshot_complete'
    ) {
      throw new Error(`unexpected progress: ${JSON.stringify(result)}`);
    }
    expect(result).toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'admitting',
        currentStorageState: 'snapshot_complete',
      },
    });
    expect(commands.map((command) => command.kind)).toEqual([
      'begin',
      'batch',
      'finalize',
    ]);
    expect(rawSession.metadataVersion).toBeGreaterThan(8);
  });

  it('still rejects a real storage mutation after progress publication before staging', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-progress-storage-mutation-',
    ));
    roots.push(activeServerDir);
    const initial = validatingTakeoverRecord();
    await writeExternalSessionOperationRecord(activeServerDir, initial);
    const rawSession: MutableRawSession = {
      metadata: '{}',
      metadataVersion: 7,
      metadataLayoutVersion: 0,
      ownerMetadata: null,
      agentState: null,
      agentStateVersion: 0,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    };
    installMetadataMigrationCas(rawSession);
    await publishExternalSessionOperationProgress({
      activeServerDir,
      sessionId: initial.request.sessionId,
      progress: projectExternalSessionOperationProgressV1(initial),
    });
    const readNewestFirstPages = vi.fn(async function* () {
      throw new Error('mutated storage must not be staged');
    });
    const mutatedPriorStableStorage = {
      state: 'snapshot_complete',
      publication: {
        materializationPublicationId: 'unexpected-publication',
        materializedThroughSourceAt: 9,
        publishedThroughServerSeq: 1,
      },
    } satisfies ExternalSessionPriorStableStorageV1;
    const sendHistoricalCommand = vi.fn(async (
      command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> => {
      const authority = inspectAuthorityResponse(command, mutatedPriorStableStorage);
      if (authority) return authority;
      throw new Error(`Unexpected effectful historical import command: ${command.kind}`);
    });
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'takeover-progress-storage-mutation-owner',
      }),
      staging: createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      }),
      preparePersistedTakeover: async () => ({
        workingDirectory: '/workspace',
        resumeFollowOnFailure: async () => undefined,
      }),
      describeSource: async () => ({
        capturedSource: {
          sourceIdentity: 'source-identity-1',
          sourceGeneration: initial.request.source.sourceGeneration,
          revision: 'source-cursor-b',
          boundary: 'source-boundary-b',
        },
        linkedSessionRevision: rawSession.metadataVersion,
      }),
      revalidateSource: async () => undefined,
      readNewestFirstPages,
      readFinalCatchUpPages: async function* () {},
      sendHistoricalCommand,
    });

    await expect(executor.resumePersistedTakeover({
      sessionId: initial.request.sessionId,
      operationId: initial.operationId,
      revision: initial.revision,
    })).resolves.toMatchObject({
      ok: true,
      progress: {
        status: 'awaiting_user_resume',
        phase: 'validating',
        currentStorageState: 'machine_only',
        error: { code: 'source_changed', retryable: true },
      },
    });
    expect(readNewestFirstPages).not.toHaveBeenCalled();
    expect(sendHistoricalCommand).toHaveBeenCalledOnce();
    expect(sendHistoricalCommand.mock.calls[0]?.[0]).toMatchObject({ kind: 'inspect' });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      initial.operationId,
    )).resolves.toMatchObject({
      status: 'awaiting_user_resume',
      phase: 'validating',
      currentStorageState: 'machine_only',
      error: { code: 'source_changed', retryable: true },
    });
  });

  it.each([0, 1] as const)(
    'serializes an in-flight initial publisher with terminal replacement admission in metadata layout %s',
    async (metadataLayoutVersion) => {
      const activeServerDir = await mkdtemp(join(
        tmpdir(),
        `happier-progress-admission-layout-${metadataLayoutVersion}-`,
      ));
      roots.push(activeServerDir);
      const credentials = {
        token: 'token-1',
        encryption: null,
      };
      boundaryMocks.readCredentials.mockResolvedValue(credentials);
      boundaryMocks.fetchAccountEncryptionCurrentness.mockResolvedValue({
        mode: 'plain', version: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 1,
      });
      const initialA = validatingMaterializeRecord();
      await writeExternalSessionOperationRecord(activeServerDir, initialA);
      const layout1Fields = buildSessionMetadataEnvelopeFields({
        credentials,
        accountEncryptionMode: 'plain',
        metadata: {},
        agentState: null,
        storedContentMode: 'plain',
      });
      const rawSession: MutableRawSession = metadataLayoutVersion === 0
        ? {
            metadata: '{}',
            metadataVersion: 7,
            metadataLayoutVersion: 0,
            ownerMetadata: null,
            agentState: null,
            agentStateVersion: 0,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
          }
        : {
            metadata: layout1Fields.sharedMetadata.ciphertext,
            metadataVersion: 7,
            metadataLayoutVersion: 1,
            ownerMetadata: layout1Fields.ownerMetadata,
            agentState: layout1Fields.agentState,
            agentStateVersion: 0,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
          };
      let reachFirstCommit!: () => void;
      const firstCommitReached = new Promise<void>((resolve) => {
        reachFirstCommit = resolve;
      });
      let releaseFirstCommit!: () => void;
      const firstCommitRelease = new Promise<void>((resolve) => {
        releaseFirstCommit = resolve;
      });
      let stallFirstCommit = true;
      const beforeCommit = async () => {
        if (!stallFirstCommit) return;
        stallFirstCommit = false;
        reachFirstCommit();
        await firstCommitRelease;
      };
      if (metadataLayoutVersion === 0) {
        installMetadataMigrationCas(rawSession, beforeCommit);
      } else {
        installMetadataTupleCas(rawSession, beforeCommit);
      }

      const stalePublishA = publishExternalSessionOperationProgress({
        activeServerDir,
        sessionId: initialA.request.sessionId,
        progress: projectExternalSessionOperationProgressV1(initialA),
        allowDifferentTerminalReplacement: true,
      });
      const stalePublishAResult = stalePublishA.then(
        () => ({ kind: 'fulfilled' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
      await firstCommitReached;
      const terminalA = await terminalizeMaterializeRecord(
        activeServerDir,
        initialA,
        `a-layout-${metadataLayoutVersion}`,
      );

      const requestB = {
        ...initialA.request,
        idempotencyKey:
          `materialize-progress-currentness-b-${metadataLayoutVersion}`,
      };
      const initialB = {
        ...initialA,
        operationId:
          `external-materialize:progress-currentness-b-${metadataLayoutVersion}`,
        request: requestB,
        createdAtMs: 3,
        updatedAtMs: 3,
        bindings: { operationClaimId: 'private-claim-b' },
        progressProjection: { acknowledgedRevision: null },
      } satisfies ExternalSessionOperationRecordV1;
      const successorB = (async () => {
        let expectedDifferentTerminalPresentation:
          ExternalSessionOperationSharedPresentationV1 | undefined;
        const admittedB = await writeExternalSessionOperationRecord(
          activeServerDir,
          initialB,
          {
            settlePriorTerminalProgressProjection: async (
              priorTerminalRecords,
            ) => {
              await settlePriorTerminalExternalSessionOperationProgressProjections(
                activeServerDir,
                priorTerminalRecords,
              );
            },
            validateSessionAdmission: async (
              _current,
              incoming,
              priorTerminalRecords,
            ) => {
              expectedDifferentTerminalPresentation =
                await assertExternalSessionOperationProgressCanBeSelected({
                  sessionId: incoming.request.sessionId,
                  progress:
                    projectExternalSessionOperationProgressV1(incoming),
                  priorTerminalRecords,
                });
            },
          },
        );
        await publishExternalSessionOperationProgress({
          activeServerDir,
          sessionId: admittedB.request.sessionId,
          progress: projectExternalSessionOperationProgressV1(admittedB),
          ...(expectedDifferentTerminalPresentation
            ? {
              allowDifferentTerminalReplacement: true,
              expectedDifferentTerminalPresentation,
            }
            : {}),
        });
        const terminalB = await terminalizeMaterializeRecord(
          activeServerDir,
          admittedB,
          `b-layout-${metadataLayoutVersion}`,
        );
        return await publishExternalSessionOperationProgress({
          activeServerDir,
          sessionId: terminalB.request.sessionId,
          progress: projectExternalSessionOperationProgressV1(terminalB),
        });
      })();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const successorCompletedBeforeRelease = await Promise.race([
        successorB.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), 1_000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      releaseFirstCommit();

      const [staleAResult, publishedB] = await Promise.all([
        stalePublishAResult,
        successorB,
      ]);
      expect(successorCompletedBeforeRelease).toBe(false);
      expect(staleAResult).toMatchObject({
        kind: 'rejected',
        error: {
          message: 'external_session_operation_projection_stale_private_record',
        },
      });
      await expect(publishExternalSessionOperationProgress({
        activeServerDir,
        sessionId: initialA.request.sessionId,
        progress: projectExternalSessionOperationProgressV1(initialA),
        allowDifferentTerminalReplacement: true,
      })).rejects.toThrow(
        'external_session_operation_projection_stale_private_record',
      );

      const sharedMetadata = JSON.parse(rawSession.metadata) as Record<
        string,
        unknown
      >;
      expect(ExternalSessionOperationSharedPresentationV1Schema.parse(
        sharedMetadata[
          EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY
        ],
      )).toMatchObject({
        operationId: initialB.operationId,
        revision: publishedB.revision,
        status: 'completed',
      });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        initialB.operationId,
      )).resolves.toMatchObject({
        revision: publishedB.revision,
        status: 'completed',
        progressProjection: {
          acknowledgedRevision: publishedB.revision,
        },
      });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        initialA.operationId,
      )).resolves.toMatchObject({
        status: 'completed',
        progressProjection: {
          acknowledgedRevision: terminalA.revision,
        },
      });
    },
  );
});
