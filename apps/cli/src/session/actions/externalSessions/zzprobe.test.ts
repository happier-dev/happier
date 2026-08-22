import {
  ExternalSessionOperationRecordV1Schema,
  resolveExternalSessionOperationTimelineV1,
  type ExternalSessionOperationRecordV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

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
    status: 'failed',
    phase: 'spawning',
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
        total: 0, record: 0, media: 0, conversion: 0,
        diagnosticsTruncated: false, diagnostics: [],
      },
    },
    bindings: { operationClaimId: 'private-claim-1' },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: {
      linkedSessionRevision: 1,
      sourceSnapshotEvidenceRef: 'source-cursor-1',
    },
    fence: { kind: 'none' },
    retryTargetPhase: 'spawning',
    error: {
      code: 'admission_failed',
      message: 'x',
      retryable: true,
      occurredAtMs: 2,
    },
  };
}

describe('probe', () => {
  it('reports whether admission_failed@spawning parses', () => {
    const result = ExternalSessionOperationRecordV1Schema.safeParse(externalLinkedRecord());
    console.log('PROBE admission_failed@spawning success=', result.success);
    if (!result.success) console.log('PROBE issues=', JSON.stringify(result.error.issues));
    const spawnFailed = ExternalSessionOperationRecordV1Schema.safeParse({
      ...externalLinkedRecord(),
      error: { code: 'spawn_failed', message: 'x', retryable: true, occurredAtMs: 2 },
    });
    console.log('PROBE spawn_failed@spawning success=', spawnFailed.success);
    if (!spawnFailed.success) console.log('PROBE issues2=', JSON.stringify(spawnFailed.error.issues));
    expect(true).toBe(true);
  });
});
