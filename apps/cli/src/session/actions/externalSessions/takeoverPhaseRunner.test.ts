import {
  resolveExternalSessionOperationTimelineV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type {
  ExternalSessionPersistedTakeoverImportRecord,
} from './materializeAction';
import {
  assertExternalSessionExternalLinkedTakeoverSourceContinuity,
  assertExternalSessionPersistedTakeoverSourceContinuity,
} from './takeoverSourceContinuity';
import {
  createExternalSessionSourceGenerationAnchor,
} from './sourceGenerationAnchor';
import {
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
    const metadata = {
      path: '/tmp/external-session',
      externalHistoryImportV1: {
        v: 1,
        agentId: 'example',
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
    })).toMatchObject({
      rawSession,
      metadata,
      sessionPath: '/tmp/external-session',
      agentId: 'example',
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      linkGeneration: 'link-1',
      source: { kind: 'jsonl' },
      linkData: { sourceFile: '/tmp/transcript.jsonl' },
    });
    expect(reconstructPersistedTakeoverTargetFromRetiredMetadata({
      record,
      rawSession,
      metadata: {
        ...metadata,
        externalSessionV1: {},
      },
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
