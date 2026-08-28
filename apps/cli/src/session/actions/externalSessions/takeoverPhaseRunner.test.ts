import {
  resolveExternalSessionOperationTimelineV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type {
  ExternalSessionPersistedTakeoverImportRecord,
} from './materializeAction';
import type {
  LoadedLinkedExternalSession,
} from '@/api/session/external/takeover/loadLinkedExternalSession';
import {
  assertExternalSessionExternalLinkedTakeoverSourceContinuity,
  assertExternalSessionPersistedTakeoverSourceContinuity,
} from './takeoverSourceContinuity';
import {
  createExternalSessionSourceGenerationAnchor,
} from './sourceGenerationAnchor';
import {
  createExternalSessionPersistedTakeoverPreparation,
  reconstructPersistedTakeoverTargetFromRetiredMetadata,
} from './takeoverPhaseRunner';

function admittingRecord(
  currentSourceCursor: string,
): ExternalSessionPersistedTakeoverImportRecord {
  const initialSourceCursor = 'source-cursor-a';
  const request = {
    v: 1 as const,
    idempotencyKey: 'takeover-request-1',
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
        initialSourceCursor,
      ),
      contributionGeneration: 'contribution-1',
    },
    plan: 'takeover' as const,
    targetStorageMode: 'persisted' as const,
    targetDirectory: '/local/selected/workspace',
    targetRuntimeMode: 'terminal' as const,
  };
  const publication = {
    materializationPublicationId: 'publication-1',
    materializedThroughSourceAt: 10,
    publishedThroughServerSeq: 3,
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
      sourcePagesRead: 1,
      stagedItemCount: 1,
      importedItemCount: 1,
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
    bindings: { operationClaimId: 'released-import-claim' },
    progressProjection: {
      acknowledgedRevision: null,
    },
    canonicalOwnerEvidence: {
      linkedSessionRevision: 4,
      sourceSnapshotEvidenceRef: currentSourceCursor,
    },
    fence: { kind: 'none' },
    retryTargetPhase: 'admitting',
  };
}

describe('persisted takeover source continuity', () => {
  it('resolves the canonical spawn working directory before persisted historical import', async () => {
    const record = admittingRecord('source-cursor-b');
    const linked: LoadedLinkedExternalSession = {
      rawSession: {
        id: record.request.sessionId,
        encryptionMode: 'plain',
      } as LoadedLinkedExternalSession['rawSession'],
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'example',
          machineId: record.request.source.machineId,
          remoteSessionId: record.request.source.remoteSessionId,
          linkedAtMs: 1,
          source: { kind: 'jsonl' },
          qualifiedIdentity: record.request.source.qualifiedIdentity,
        },
      },
      sessionPath: '/stale/link/workspace',
      agentId: 'example',
      machineId: record.request.source.machineId,
      remoteSessionId: record.request.source.remoteSessionId,
      linkGeneration: record.request.source.linkGeneration,
      source: { kind: 'jsonl' },
    };
    const preparedSource = {
      linked,
      pluginGeneration: record.request.source.contributionGeneration,
      quiescenceIdentity: 'quiescence-1',
    };
    const followLeaseManager = {
      suspendSession: vi.fn(async () => true),
      resumeSession: vi.fn(async () => ({
        resumed: true as const,
        leaseAcquired: false,
      })),
    } satisfies Parameters<
      typeof createExternalSessionPersistedTakeoverPreparation
    >[0]['followLeaseManager'];
    const loadCurrent = vi.fn(async () => preparedSource);
    const resolveSpawn = vi.fn(async () => ({
      ok: true as const,
      value: {
        options: {
          directory: '/canonical/takeover/workspace',
        },
        remoteSessionId: record.request.source.remoteSessionId,
        origin: {
          agentId: 'example',
          pluginId: 'example.plugin',
          generation: record.request.source.contributionGeneration,
        },
      },
    }));
    const prepare = createExternalSessionPersistedTakeoverPreparation({
      followLeaseManager,
      loadCurrent,
      resolveSpawn,
    });

    const result = await prepare(record);

    expect(result.workingDirectory).toBe('/canonical/takeover/workspace');
    expect(loadCurrent).toHaveBeenCalledTimes(2);
    expect(resolveSpawn).toHaveBeenCalledWith({
      linked,
      sessionId: record.request.sessionId,
      targetDirectory: record.request.targetDirectory,
    });
    expect(followLeaseManager.suspendSession).toHaveBeenCalledOnce();
    expect(followLeaseManager.resumeSession).not.toHaveBeenCalled();

    await result.resumeFollowOnFailure();
    expect(followLeaseManager.resumeSession).toHaveBeenCalledOnce();
  });

  it('reconstructs only the exact hosted takeover target from retired-link provenance', () => {
    const record = admittingRecord('source-cursor-b');
    const rawSession = {
      id: 'session-1',
      currentStorageState: 'hosted',
      metadataVersion: 5,
      active: false,
      thinking: false,
    } as unknown as Parameters<
      typeof reconstructPersistedTakeoverTargetFromRetiredMetadata
    >[0]['rawSession'];
    // An installed Agent's retired tombstone persists the qualified routing id
    // the registry assigned, never the manifest-local id.
    const expectedAgentRoutingId = 'example.plugin/example';
    const metadata = {
      path: '/tmp/external-session',
      externalHistoryImportV1: {
        v: 1,
        agentId: expectedAgentRoutingId,
        remoteSessionId: 'remote-1',
        importedAtMs: 100,
        source: { kind: 'jsonl' },
        linkData: { sourceFile: '/tmp/transcript.jsonl' },
      },
    };

    expect(reconstructPersistedTakeoverTargetFromRetiredMetadata({
      record,
      rawSession,
      metadata,
      expectedAgentRoutingId,
    })).toMatchObject({
      rawSession,
      metadata,
      sessionPath: '/tmp/external-session',
      agentId: expectedAgentRoutingId,
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      linkGeneration: 'link-1',
      source: { kind: 'jsonl' },
      linkData: { sourceFile: '/tmp/transcript.jsonl' },
    });
    // The record's bare `localId` never addresses an installed Agent, so a
    // caller that passed one instead of the registry's routing id must not
    // reconstruct this target.
    expect(reconstructPersistedTakeoverTargetFromRetiredMetadata({
      record,
      rawSession,
      metadata,
      expectedAgentRoutingId: record.request.source.qualifiedIdentity.agent.localId,
    })).toBeNull();
    expect(reconstructPersistedTakeoverTargetFromRetiredMetadata({
      record,
      rawSession,
      metadata: {
        ...metadata,
        externalSessionV1: {},
      },
      expectedAgentRoutingId,
    })).toBeNull();
    expect(reconstructPersistedTakeoverTargetFromRetiredMetadata({
      record,
      rawSession,
      metadata: {
        ...metadata,
        externalHistoryImportV1: {
          ...metadata.externalHistoryImportV1,
          remoteSessionId: 'other-remote',
        },
      },
      expectedAgentRoutingId,
    })).toBeNull();
  });

  it('accepts exact admission currentness at catch-up cursor B without comparing B to immutable generation anchor A', async () => {
    const record = admittingRecord('source-cursor-b');
    const readAfterTranscript = vi.fn(async () => ({
      outcome: 'already_current' as const,
    }));

    await expect(assertExternalSessionPersistedTakeoverSourceContinuity({
      record,
      providerOps: { readAfterTranscript },
      source: { kind: 'jsonl' },
      requirement: 'already_current_for_admission',
    })).resolves.toBeUndefined();
    expect(readAfterTranscript).toHaveBeenCalledWith(expect.objectContaining({
      cursor: 'source-cursor-b',
    }));
  });

  it('fails exact admission currentness when the source advances beyond catch-up cursor B', async () => {
    const record = admittingRecord('source-cursor-b');
    const readAfterTranscript = vi.fn(async () => ({
      outcome: 'advanced' as const,
      items: [],
      nextCursor: 'source-cursor-c',
      boundary: 'source-boundary-c',
      hasMore: false,
    }));

    await expect(assertExternalSessionPersistedTakeoverSourceContinuity({
      record,
      providerOps: { readAfterTranscript },
      source: { kind: 'jsonl' },
      requirement: 'already_current_for_admission',
    })).rejects.toMatchObject({
      actionCode: 'source_unavailable',
    });
  });

  it('rejects validating evidence that does not match immutable initial generation anchor A', async () => {
    const record: ExternalSessionPersistedTakeoverImportRecord = {
      ...admittingRecord('source-cursor-b'),
      phase: 'validating',
      currentStorageState: 'machine_only',
      retryTargetPhase: 'validating',
    };
    const readAfterTranscript = vi.fn(async () => ({
      outcome: 'already_current' as const,
    }));

    await expect(assertExternalSessionPersistedTakeoverSourceContinuity({
      record,
      providerOps: { readAfterTranscript },
      source: { kind: 'jsonl' },
      requirement: 'allow_advanced_for_catch_up',
    })).rejects.toMatchObject({
      actionCode: 'source_unavailable',
    });
    expect(readAfterTranscript).not.toHaveBeenCalled();
  });
});

describe('external-linked takeover source continuity', () => {
  it('rejects captured source replacement before spawn through the canonical continuity owner', async () => {
    const persisted = admittingRecord('source-cursor-a');
    const record = {
      ...persisted,
      request: {
        ...persisted.request,
        targetStorageMode: 'external-linked' as const,
      },
    };
    const readAfterTranscript = vi.fn(async () => ({
      outcome: 'gap_or_cursor_expired' as const,
    }));

    await expect(
      assertExternalSessionExternalLinkedTakeoverSourceContinuity({
        record,
        providerOps: { readAfterTranscript },
        source: { kind: 'jsonl' },
      }),
    ).rejects.toMatchObject({
      actionCode: 'source_unavailable',
    });
    expect(readAfterTranscript).toHaveBeenCalledWith(expect.objectContaining({
      cursor: 'source-cursor-a',
    }));
  });
});
