import { describe, expect, it } from 'vitest';

import type { RecordedHttpProxyRequest } from './httpRequestRecordingProxy';
import {
  readExternalSessionOperationCompletionReceipt,
  readImportingMaterializeProgressPatch,
  readPlainSessionOwnerOperationProgress,
} from './externalSessionOperationProgressPatch';

const sessionId = 'session-progress-latch';

function recordedSessionPatch(body: unknown): RecordedHttpProxyRequest {
  const text = JSON.stringify(body);
  return {
    id: 1,
    method: 'PATCH',
    path: `/v2/sessions/${encodeURIComponent(sessionId)}`,
    headers: { 'content-type': 'application/json' },
    startedAtMs: 1,
    endedAtMs: 2,
    statusCode: 200,
    upgraded: false,
    error: null,
    body: {
      text,
      byteLength: Buffer.byteLength(text),
      truncated: false,
      complete: true,
    },
  };
}

type Progress = Readonly<Record<string, unknown>>;

function materializeProgress(input: Readonly<{
  revision: number;
  acceptedThroughServerSeq?: number;
}>): Progress {
  const accepted = input.acceptedThroughServerSeq;
  return {
    v: 1,
    operationId: 'external-materialize:11111111-1111-4111-8111-111111111111',
    revision: input.revision,
    request: {
      plan: 'materialize',
      targetStorageMode: 'external-linked',
      targetRuntimeMode: null,
    },
    status: 'running',
    phase: 'importing',
    timeline: ['validating', 'staging', 'importing', 'publishing'],
    updatedAtMs: 100 + input.revision,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: accepted === undefined ? 'machine_only' : 'server_partial',
    checkpoint: {
      sourcePagesRead: 18,
      stagedItemCount: 241,
      importedItemCount: accepted ?? 0,
      requiredItemFailures: {
        total: 0,
        record: 0,
        media: 0,
        conversion: 0,
        diagnosticsTruncated: false,
      },
      ...(accepted === undefined
        ? {}
        : { acceptedThroughServerSeq: accepted }),
    },
    fence: accepted === undefined
      ? { kind: 'none' }
      : {
          kind: 'initial_server_partial',
          acceptedThroughServerSeq: accepted,
        },
  };
}

function ownerPatch(params: Readonly<{
  previousProgress?: Progress;
  nextProgress?: Progress;
  sharedMetadata: unknown;
}>): unknown {
  const ownerMetadata = (progress: Progress | undefined) => ({
    t: 'plain',
    v: {
      v: 1,
      ...(progress
        ? {
            runtime: {
              externalSessionOperationV1: { v: 1, progress },
            },
          }
        : {}),
    },
  });
  return {
    mode: 'owner',
    metadataLayoutVersion: 1,
    expectedOwnerMetadata: ownerMetadata(params.previousProgress),
    sharedMetadata: {
      expectedVersion: 3,
      ciphertext: JSON.stringify(params.sharedMetadata),
    },
    ownerMetadata: ownerMetadata(params.nextProgress),
    agentState: { expectedVersion: 2, ciphertext: null },
  };
}

function readPatch(request: RecordedHttpProxyRequest) {
  const input = {
    request,
    sessionId,
    acceptedThroughServerSeqExclusive: 241,
  };
  return readImportingMaterializeProgressPatch(input);
}

describe('readImportingMaterializeProgressPatch', () => {
  it('rejects an unrelated same-route Session patch and accepts only the strict importing materialize presentation', () => {
    const previousProgress = materializeProgress({ revision: 6 });
    const nextProgress = materializeProgress({
      revision: 7,
      acceptedThroughServerSeq: 5,
    });
    const presentation = {
      v: 1,
      operationId: 'external-materialize:11111111-1111-4111-8111-111111111111',
      revision: 7,
      kind: 'materialize',
      status: 'running',
      phase: 'importing',
    } as const;
    const unrelated = recordedSessionPatch(ownerPatch({
      sharedMetadata: {
        v: 1,
        summary: { text: 'unrelated metadata write', updatedAt: 1 },
      },
    }));
    const equalRevisionDecoy = recordedSessionPatch(ownerPatch({
      previousProgress: nextProgress,
      nextProgress,
      sharedMetadata: {
        v: 1,
        externalSessionOperationPresentationV1: presentation,
      },
    }));
    const exact = recordedSessionPatch(ownerPatch({
      previousProgress,
      nextProgress,
      sharedMetadata: {
        v: 1,
        externalSessionOperationPresentationV1: presentation,
      },
    }));
    const incomplete = {
      ...exact,
      body: exact.body && { ...exact.body, complete: false },
    };
    const truncated = {
      ...exact,
      body: exact.body && { ...exact.body, truncated: true },
    };
    const acceptedAtCeiling = recordedSessionPatch(ownerPatch({
      previousProgress,
      nextProgress: materializeProgress({
        revision: 7,
        acceptedThroughServerSeq: 241,
      }),
      sharedMetadata: {
        v: 1,
        externalSessionOperationPresentationV1: presentation,
      },
    }));

    expect(readPatch(unrelated)).toBeNull();
    expect(readPatch(equalRevisionDecoy)).toBeNull();
    expect(readPatch(incomplete)).toBeNull();
    expect(readPatch(truncated)).toBeNull();
    expect(readPatch(acceptedAtCeiling)).toBeNull();
    expect(readPatch(exact)).toEqual(presentation);
  });

  it('reads complete operation progress from the private owner envelope rather than the shared presentation', () => {
    const previousProgress = materializeProgress({ revision: 6 });
    const nextProgress = materializeProgress({
      revision: 7,
      acceptedThroughServerSeq: 5,
    });
    const presentation = {
      v: 1,
      operationId: 'external-materialize:11111111-1111-4111-8111-111111111111',
      revision: 7,
      kind: 'materialize',
      status: 'running',
      phase: 'importing',
    } as const;
    const patch = ownerPatch({
      previousProgress,
      nextProgress,
      sharedMetadata: {
        v: 1,
        externalSessionOperationPresentationV1: presentation,
      },
    }) as {
      ownerMetadata: unknown;
      sharedMetadata: { ciphertext: string };
    };

    expect(readPlainSessionOwnerOperationProgress({
      metadataLayoutVersion: 1,
      metadata: patch.sharedMetadata.ciphertext,
      ownerMetadata: patch.ownerMetadata,
    })).toEqual(nextProgress);
    expect(JSON.parse(patch.sharedMetadata.ciphertext)).toEqual({
      v: 1,
      externalSessionOperationPresentationV1: presentation,
    });
  });

  it('reads the strict minimal completion receipt without treating it as a full operation record', () => {
    const reference = {
      sessionId,
      operationId: 'external-materialize:11111111-1111-4111-8111-111111111111',
      revision: 24,
    } as const;
    const presentation = {
      v: 1,
      operationId: reference.operationId,
      revision: reference.revision,
      kind: 'materialize',
      status: 'completed',
      phase: 'publishing',
    } as const;
    const receipt = {
      v: 1,
      recordKind: 'completed_receipt',
      reference,
      presentation,
      durableIdempotencyKey: 'materialize-restart-receipt',
      idempotencyIntentDigest: 'a'.repeat(64),
      completedAtMs: 1_000,
      expiresAtMs: 1_000 + 24 * 60 * 60 * 1_000,
    } as const;

    expect(readExternalSessionOperationCompletionReceipt(receipt)).toEqual({
      reference,
      presentation,
      persistedKeys: Object.keys(receipt).sort(),
    });
    expect(() => readExternalSessionOperationCompletionReceipt({
      ...receipt,
      request: { sessionId },
    })).toThrow('strict minimal completion receipt');
    expect(() => readExternalSessionOperationCompletionReceipt({
      ...receipt,
      expiresAtMs: receipt.expiresAtMs + 1,
    })).toThrow('strict minimal completion receipt');
    expect(() => readExternalSessionOperationCompletionReceipt({
      ...receipt,
      authorIntent: {
        v: 1,
        surface: 'plugin',
        kind: 'materialize',
        sessionId: 'different-session',
        targetStorageMode: 'external-linked',
      },
    })).toThrow('strict minimal completion receipt');
  });
});
