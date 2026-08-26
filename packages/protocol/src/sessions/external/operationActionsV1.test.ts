import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1,
  ExternalSessionMaterializeStartInputV1Schema,
  ExternalSessionHistoricalImportBatchIdV1Schema,
  ExternalSessionOperationActionResultV1Schema,
  ExternalSessionOperationActionResponseV1Schema,
  ExternalSessionOperationCancelInputV1Schema,
  ExternalSessionOperationDiscardInputV1Schema,
  ExternalSessionOperationResumeInputV1Schema,
  ExternalSessionOperationRetryInputV1Schema,
  ExternalSessionOperationSocketCommandV1Schema,
  ExternalSessionOperationSocketResponseV1Schema,
  ExternalSessionOperationStatusInputV1Schema,
  ExternalSessionTakeoverStartInputV1Schema,
  authorizeExternalSessionOperationSocketCommandV1,
  makeExternalSessionHistoricalImportBatchIdV1,
  projectExternalSessionOperationActionResultV1,
  resolveExternalSessionOperationSocketBatchLimitsV1,
  validateExternalSessionOperationSocketBatchV1,
} from './operationActionsV1.js';
import * as mixedOperationOwner from './operationActionsV1.js';
import * as portableActionSchemas from './operationActionSchemasV1.js';
import { SessionIndexedIdentifierMaxLengthV1 } from '../idsV1.js';
import { SESSION_TRANSCRIPT_SOURCE_TIMESTAMP_MAX_MS } from '../messages/transcriptSourceTimestampV1.js';

const claim = {
  sessionId: 'session-1',
  operationId: 'operation-1',
  operationClaimId: 'claim-1',
} as const;

const source = {
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
  linkGeneration: 'link-generation-1',
  sourceGeneration: 'source-generation-1',
  contributionGeneration: 'contribution-generation-1',
} as const;

describe('external-session operation action contracts', () => {
  it('re-exports the portable action schema owner without recreating identities', () => {
    for (const exportName of [
      'ExternalSessionMaterializeActionInputV1Schema',
      'ExternalSessionMaterializeActionResultV1Schema',
      'ExternalSessionMaterializeStartInputV1Schema',
      'ExternalSessionOperationActionErrorCodeV1Schema',
      'ExternalSessionOperationActionErrorV1Schema',
      'ExternalSessionOperationActionResponseV1Schema',
      'ExternalSessionOperationActionResultV1Schema',
      'ExternalSessionOperationCancelInputV1Schema',
      'ExternalSessionOperationDiscardInputV1Schema',
      'ExternalSessionOperationReferenceV1Schema',
      'ExternalSessionOperationResumeInputV1Schema',
      'ExternalSessionOperationRetryInputV1Schema',
      'ExternalSessionOperationStatusInputV1Schema',
      'ExternalSessionOperationTransportReferenceV1Schema',
      'ExternalSessionTakeoverStartInputV1Schema',
      'projectExternalSessionMaterializeActionResultV1',
      'projectExternalSessionOperationActionResultV1',
    ] as const) {
      expect(mixedOperationOwner[exportName], exportName).toBe(
        portableActionSchemas[exportName],
      );
    }
  });

  it('keeps public start intent minimal and prevents callers from supplying daemon-owned generations', () => {
    const materialize = ExternalSessionMaterializeStartInputV1Schema.parse({
      request: {
        v: 1,
        idempotencyKey: 'materialize-1',
        sessionId: claim.sessionId,
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
      },
    });
    expect(materialize.request.plan).toBe('materialize');

    const takeoverRequest = {
      v: 1 as const,
      idempotencyKey: 'takeover-1',
      sessionId: claim.sessionId,
      source: {
        machineId: source.machineId,
        remoteSessionId: source.remoteSessionId,
        qualifiedIdentity: source.qualifiedIdentity,
        linkGeneration: source.linkGeneration,
      },
      plan: 'takeover' as const,
      targetStorageMode: 'persisted' as const,
      targetDirectory: '/local/selected/workspace',
      targetRuntimeMode: 'terminal' as const,
    };
    const takeover = ExternalSessionTakeoverStartInputV1Schema.parse({
      request: takeoverRequest,
    });
    expect(takeover.request.plan).toBe('takeover');
    expect(ExternalSessionTakeoverStartInputV1Schema.parse({
      request: {
        ...takeoverRequest,
        targetStorageMode: 'external-linked',
      },
    }).request.targetStorageMode).toBe('external-linked');
    expect(() => ExternalSessionTakeoverStartInputV1Schema.parse({
      request: {
        ...takeoverRequest,
        targetDirectory: '',
      },
    })).toThrow();
    for (const targetDirectory of [
      'relative/workspace',
      'C:relative\\workspace',
      '/local/workspace\0poisoned',
    ]) {
      expect(ExternalSessionTakeoverStartInputV1Schema.safeParse({
        request: {
          ...takeoverRequest,
          targetDirectory,
        },
      }).success).toBe(false);
    }
    for (const targetDirectory of [
      '/local/workspace',
      'C:\\Users\\tester\\workspace',
      '\\\\server\\share\\workspace',
    ]) {
      expect(ExternalSessionTakeoverStartInputV1Schema.safeParse({
        request: {
          ...takeoverRequest,
          targetDirectory,
        },
      }).success).toBe(true);
    }
    expect(ExternalSessionTakeoverStartInputV1Schema.parse({
      request: {
        ...takeoverRequest,
        targetDirectory: '/work/repo ',
      },
    }).request.targetDirectory).toBe('/work/repo ');
    expect(ExternalSessionTakeoverStartInputV1Schema.safeParse({
      request: {
        ...takeoverRequest,
        targetDirectory: ' /work/repo',
      },
    }).success).toBe(false);
    expect(() => ExternalSessionMaterializeStartInputV1Schema.parse({
      request: {
        ...materialize.request,
        source,
      },
    })).toThrow();
    expect(() => ExternalSessionTakeoverStartInputV1Schema.parse({
      request: {
        ...takeover.request,
        source: {
          ...takeover.request.source,
          sourceGeneration: source.sourceGeneration,
          contributionGeneration: source.contributionGeneration,
        },
      },
    })).toThrow();

    expect(() => ExternalSessionMaterializeStartInputV1Schema.parse({
      request: takeover.request,
    })).toThrow();
    expect(() => ExternalSessionTakeoverStartInputV1Schema.parse({
      request: materialize.request,
    })).toThrow();
  });

  it('makes status structurally passive and recovery/destructive intents explicit', () => {
    const reference = {
      sessionId: claim.sessionId,
      operationId: claim.operationId,
      revision: 4,
    };
    expect(ExternalSessionOperationStatusInputV1Schema.parse(reference)).toEqual(reference);
    expect(() => ExternalSessionOperationStatusInputV1Schema.parse({
      ...reference,
      intent: 'resume',
    })).toThrow();
    expect(() => ExternalSessionOperationStatusInputV1Schema.parse({
      ...reference,
      operationClaimId: claim.operationClaimId,
    })).toThrow();

    for (const schema of [
      ExternalSessionOperationCancelInputV1Schema,
      ExternalSessionOperationResumeInputV1Schema,
      ExternalSessionOperationRetryInputV1Schema,
      ExternalSessionOperationDiscardInputV1Schema,
    ]) {
      expect(schema.parse(reference)).toEqual(reference);
      expect(() => schema.parse({
        ...reference,
        operationClaimId: claim.operationClaimId,
      })).toThrow();
      expect(() => schema.parse({
        sessionId: reference.sessionId,
        operationId: reference.operationId,
      })).toThrow();
    }
  });

  it('returns a typed upgrade_required outcome before any operation result is needed', () => {
    expect(ExternalSessionOperationActionResponseV1Schema.parse({
      ok: false,
      error: {
        code: 'upgrade_required',
        message: 'Update the selected machine.',
      },
    })).toEqual({
      ok: false,
      error: {
        code: 'upgrade_required',
        message: 'Update the selected machine.',
      },
    });
  });

  it('returns a typed reconciliation outcome when canonical linked metadata disagrees', () => {
    expect(ExternalSessionOperationActionResponseV1Schema.parse({
      ok: false,
      error: {
        code: 'reconciliation_required',
        message: 'Review the linked session before importing.',
      },
    })).toEqual({
      ok: false,
      error: {
        code: 'reconciliation_required',
        message: 'Review the linked session before importing.',
      },
    });
  });

  it('requires the six-field presentation identity to match its public operation reference', () => {
    const result = {
      ok: true as const,
      operation: {
        sessionId: claim.sessionId,
        operationId: claim.operationId,
        revision: 4,
      },
      presentation: {
        v: 1 as const,
        operationId: claim.operationId,
        revision: 4,
        kind: 'materialize' as const,
        status: 'running' as const,
        phase: 'validating' as const,
      },
    };
    expect(ExternalSessionOperationActionResultV1Schema.parse(result)).toEqual(result);
    expect(ExternalSessionOperationActionResultV1Schema.safeParse({
      ...result,
      presentation: { ...result.presentation, operationId: 'operation-other' },
    }).success).toBe(false);
    expect(ExternalSessionOperationActionResultV1Schema.safeParse({
      ...result,
      presentation: { ...result.presentation, revision: 5 },
    }).success).toBe(false);
  });

  it('rejects every private operation field from the public result', () => {
    const result = {
      ok: true as const,
      operation: {
        sessionId: claim.sessionId,
        operationId: claim.operationId,
        revision: 4,
      },
      presentation: {
        v: 1 as const,
        operationId: claim.operationId,
        revision: 4,
        kind: 'materialize' as const,
        status: 'running' as const,
        phase: 'validating' as const,
      },
    };
    const privateFieldCases: readonly Readonly<{
      label: string;
      value: unknown;
    }>[] = [
      {
        label: 'timeline',
        value: { ...result, presentation: { ...result.presentation, timeline: ['validating'] } },
      },
      {
        label: 'prior storage',
        value: {
          ...result,
          presentation: {
            ...result.presentation,
            priorStableStorage: { state: 'machine_only' },
          },
        },
      },
      {
        label: 'current storage',
        value: {
          ...result,
          presentation: { ...result.presentation, currentStorageState: 'machine_only' },
        },
      },
      {
        label: 'checkpoint',
        value: {
          ...result,
          presentation: { ...result.presentation, checkpoint: { sourcePagesRead: 1 } },
        },
      },
      {
        label: 'fence',
        value: {
          ...result,
          presentation: { ...result.presentation, fence: { kind: 'none' } },
        },
      },
      {
        label: 'publication',
        value: {
          ...result,
          presentation: {
            ...result.presentation,
            publication: {
              materializationPublicationId: 'publication-1',
              materializedThroughSourceAt: 10,
              publishedThroughServerSeq: 2,
            },
          },
        },
      },
      {
        label: 'retry state',
        value: {
          ...result,
          presentation: { ...result.presentation, retryTargetPhase: 'validating' },
        },
      },
      {
        label: 'complete progress',
        value: { ...result, progress: { operationId: claim.operationId } },
      },
      {
        label: 'machine identity',
        value: { ...result, operation: { ...result.operation, machineId: source.machineId } },
      },
      {
        label: 'source authority',
        value: { ...result, operation: { ...result.operation, source } },
      },
      {
        label: 'generation identity',
        value: {
          ...result,
          operation: { ...result.operation, generation: source.sourceGeneration },
        },
      },
      {
        label: 'operation claim',
        value: { ...result, operationClaim: claim },
      },
      {
        label: 'custody path',
        value: { ...result, privateStagingPath: '/private/staging/session-1' },
      },
      {
        label: 'operation rows',
        value: { ...result, operationRows: [{ operationId: claim.operationId }] },
      },
    ];

    for (const privateFieldCase of privateFieldCases) {
      expect(
        ExternalSessionOperationActionResultV1Schema.safeParse(
          privateFieldCase.value,
        ).success,
        privateFieldCase.label,
      ).toBe(false);
    }
  });

  it('projects complete owner progress to only the operation reference and six-field presentation', () => {
    const privateProgressCases = [
      {
        label: 'running progress with storage, checkpoint, timeline, and fence',
        progress: {
          v: 1 as const,
          operationId: claim.operationId,
          revision: 4,
          request: {
            plan: 'materialize' as const,
            targetStorageMode: 'external-linked' as const,
            targetRuntimeMode: null,
          },
          timeline: ['validating', 'staging', 'importing', 'publishing'] as const,
          status: 'running' as const,
          phase: 'validating' as const,
          updatedAtMs: 10,
          priorStableStorage: { state: 'machine_only' as const },
          currentStorageState: 'machine_only' as const,
          checkpoint: {
            sourcePagesRead: 1,
            stagedItemCount: 2,
            importedItemCount: 1,
            requiredItemFailures: {
              total: 0,
              record: 0,
              media: 0,
              conversion: 0,
              diagnosticsTruncated: false,
            },
          },
          fence: { kind: 'none' as const },
        },
      },
      {
        label: 'recoverable progress with retry state',
        progress: {
          v: 1 as const,
          operationId: claim.operationId,
          revision: 4,
          request: {
            plan: 'materialize' as const,
            targetStorageMode: 'external-linked' as const,
            targetRuntimeMode: null,
          },
          timeline: ['validating', 'staging', 'importing', 'publishing'] as const,
          status: 'awaiting_user_resume' as const,
          phase: 'validating' as const,
          updatedAtMs: 10,
          priorStableStorage: { state: 'machine_only' as const },
          currentStorageState: 'machine_only' as const,
          checkpoint: {
            sourcePagesRead: 1,
            stagedItemCount: 2,
            importedItemCount: 1,
            requiredItemFailures: {
              total: 0,
              record: 0,
              media: 0,
              conversion: 0,
              diagnosticsTruncated: false,
            },
          },
          fence: { kind: 'none' as const },
          retryTargetPhase: 'validating' as const,
        },
      },
      {
        label: 'completed progress with publication',
        progress: {
          v: 1 as const,
          operationId: claim.operationId,
          revision: 4,
          request: {
            plan: 'materialize' as const,
            targetStorageMode: 'external-linked' as const,
            targetRuntimeMode: null,
          },
          timeline: ['validating', 'staging', 'importing', 'publishing'] as const,
          status: 'completed' as const,
          phase: 'publishing' as const,
          updatedAtMs: 10,
          priorStableStorage: { state: 'machine_only' as const },
          currentStorageState: 'snapshot_complete' as const,
          checkpoint: {
            sourcePagesRead: 1,
            stagedItemCount: 2,
            importedItemCount: 2,
            acceptedThroughServerSeq: 2,
            requiredItemFailures: {
              total: 0,
              record: 0,
              media: 0,
              conversion: 0,
              diagnosticsTruncated: false,
            },
          },
          fence: { kind: 'none' as const },
          publication: {
            materializationPublicationId: 'publication-1',
            materializedThroughSourceAt: 10,
            publishedThroughServerSeq: 2,
          },
        },
      },
    ] as const;

    for (const privateProgressCase of privateProgressCases) {
      const projected = projectExternalSessionOperationActionResultV1(
        { ok: true, progress: privateProgressCase.progress },
        claim.sessionId,
      );
      expect(projected, privateProgressCase.label).toEqual({
        ok: true,
        operation: {
          sessionId: claim.sessionId,
          operationId: claim.operationId,
          revision: 4,
        },
        presentation: {
          v: 1,
          operationId: claim.operationId,
          revision: 4,
          kind: 'materialize',
          status: privateProgressCase.progress.status,
          phase: privateProgressCase.progress.phase,
        },
      });
      if (projected.ok) {
        expect(Object.keys(projected.operation).sort()).toEqual([
          'operationId',
          'revision',
          'sessionId',
        ]);
        expect(Object.keys(projected.presentation).sort()).toEqual([
          'kind',
          'operationId',
          'phase',
          'revision',
          'status',
          'v',
        ]);
      }
    }
  });
});

describe('external-session operation machine-socket contract', () => {
  const boundClaim = {
    ...claim,
    machineId: 'machine-1',
    revision: 7,
  } as const;

  const commandBase = {
    v: 1,
    claim,
    expectedRevision: 7,
  } as const;

  const begin = {
    ...commandBase,
    kind: 'begin',
    expectedPriorStableStorage: { state: 'machine_only' },
  } as const;

  it('inspects private storage authority without beginning a historical job', () => {
    const inspect = { ...commandBase, kind: 'inspect' } as const;
    expect(ExternalSessionOperationSocketCommandV1Schema.parse(inspect))
      .toEqual(inspect);
    const authority = {
      v: 1,
      kind: 'authority',
      claim,
      revision: 7,
      priorStableStorage: {
        state: 'snapshot_complete',
        publication: {
          materializationPublicationId: 'publication-prior',
          materializedThroughSourceAt: 1_699_999_999_000,
          publishedThroughServerSeq: 11,
        },
      },
    } as const;
    expect(ExternalSessionOperationSocketResponseV1Schema.parse(authority))
      .toEqual(authority);
  });

  it('is feature-specific and derives machine/client identity from transport', () => {
    expect(EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1).toBe(
      'externalSessions.operation.v1',
    );
    expect(ExternalSessionOperationSocketCommandV1Schema.parse(begin)).toEqual(begin);

    for (const forbiddenIdentity of [
      { machineId: 'machine-1' },
      { accountId: 'account-1' },
      { socketId: 'socket-1' },
      { clientId: 'client-1' },
    ]) {
      expect(() => ExternalSessionOperationSocketCommandV1Schema.parse({
        ...begin,
        ...forbiddenIdentity,
      })).toThrow();
    }
  });

  it('rejects the wrong socket, session, operation, claim, and revision', () => {
    expect(authorizeExternalSessionOperationSocketCommandV1({
      transportMachineId: 'machine-2',
      boundClaim,
      command: begin,
    })).toEqual({ ok: false, errorCode: 'wrong_machine_socket' });

    expect(authorizeExternalSessionOperationSocketCommandV1({
      transportMachineId: 'machine-1',
      boundClaim,
      command: {
        ...begin,
        claim: { ...claim, sessionId: 'session-2' },
      },
    })).toEqual({ ok: false, errorCode: 'wrong_session' });

    expect(authorizeExternalSessionOperationSocketCommandV1({
      transportMachineId: 'machine-1',
      boundClaim,
      command: {
        ...begin,
        claim: { ...claim, operationId: 'operation-2' },
      },
    })).toEqual({ ok: false, errorCode: 'wrong_operation' });

    expect(authorizeExternalSessionOperationSocketCommandV1({
      transportMachineId: 'machine-1',
      boundClaim,
      command: {
        ...begin,
        claim: { ...claim, operationClaimId: 'claim-2' },
      },
    })).toEqual({ ok: false, errorCode: 'wrong_operation_claim' });

    expect(authorizeExternalSessionOperationSocketCommandV1({
      transportMachineId: 'machine-1',
      boundClaim,
      command: { ...begin, expectedRevision: 6 },
    })).toEqual({ ok: false, errorCode: 'stale_revision' });
  });

  it('allows two clients and a reconnected socket to converge through the same claim', () => {
    const parsedByClientOne = ExternalSessionOperationSocketCommandV1Schema.parse(begin);
    const parsedByClientTwo = ExternalSessionOperationSocketCommandV1Schema.parse(begin);
    expect(parsedByClientOne).toEqual(parsedByClientTwo);

    expect(authorizeExternalSessionOperationSocketCommandV1({
      transportMachineId: 'machine-1',
      boundClaim,
      command: parsedByClientOne,
    })).toEqual({ ok: true });
    expect(authorizeExternalSessionOperationSocketCommandV1({
      transportMachineId: 'machine-1',
      boundClaim,
      command: parsedByClientTwo,
    })).toEqual({ ok: true });
  });

  it('carries the typed storage-authority conflict used by predecessor-link repair', () => {
    expect(ExternalSessionOperationSocketResponseV1Schema.parse({
      v: 1,
      kind: 'error',
      errorCode: 'storage_mode_conflict',
      message: 'Hosted session already contains server-owned state.',
    })).toEqual({
      v: 1,
      kind: 'error',
      errorCode: 'storage_mode_conflict',
      message: 'Hosted session already contains server-owned state.',
    });
  });

  it('carries the server-owned publication identity on a finalized historical import', () => {
    expect(ExternalSessionOperationSocketResponseV1Schema.parse({
      v: 1,
      kind: 'finalized',
      claim,
      revision: 7,
      acceptedThroughServerSeq: 12,
      publication: {
        materializationPublicationId: 'publication-1',
        materializedThroughSourceAt: 1_700_000_000_000,
        publishedThroughServerSeq: 12,
      },
    })).toEqual({
      v: 1,
      kind: 'finalized',
      claim,
      revision: 7,
      acceptedThroughServerSeq: 12,
      publication: {
        materializationPublicationId: 'publication-1',
        materializedThroughSourceAt: 1_700_000_000_000,
        publishedThroughServerSeq: 12,
      },
    });
    expect(() => ExternalSessionOperationSocketResponseV1Schema.parse({
      v: 1,
      kind: 'finalized',
      claim,
      revision: 7,
      acceptedThroughServerSeq: 12,
    })).toThrow();
  });

  it('carries exact prior storage authority on every ready historical import', () => {
    const ready = {
      v: 1,
      kind: 'ready',
      claim,
      revision: 7,
      historicalImportJobId: 'import-job-1',
      limits: {
        maxItems: 5,
        maxSerializedBytes: 800,
      },
      priorStableStorage: {
        state: 'snapshot_complete',
        publication: {
          materializationPublicationId: 'publication-prior',
          materializedThroughSourceAt: 1_699_999_999_000,
          publishedThroughServerSeq: 11,
        },
      },
    } as const;
    expect(ExternalSessionOperationSocketResponseV1Schema.parse(ready))
      .toEqual(ready);
    expect(() => ExternalSessionOperationSocketResponseV1Schema.parse({
      ...ready,
      priorStableStorage: undefined,
    })).toThrow();
  });

  it('negotiates effective limits below the live socket max including low configured maxima', () => {
    const negotiated = resolveExternalSessionOperationSocketBatchLimitsV1({
      socketMaxSerializedBytes: 1_000,
      envelopeOverheadBytes: 200,
      configuredMaxSerializedBytes: 900,
      configuredMaxItems: 5,
    });
    expect(negotiated).toEqual({
      ok: true,
      limits: {
        maxItems: 5,
        maxSerializedBytes: 800,
      },
    });
    expect(ExternalSessionOperationSocketResponseV1Schema.parse({
      v: 1,
      kind: 'ready',
      claim,
      revision: 7,
      historicalImportJobId: 'import-job-1',
      limits: negotiated.ok ? negotiated.limits : undefined,
      priorStableStorage: { state: 'machine_only' },
    }).limits).toEqual({
      maxItems: 5,
      maxSerializedBytes: 800,
    });

    expect(resolveExternalSessionOperationSocketBatchLimitsV1({
      socketMaxSerializedBytes: 1_000,
      envelopeOverheadBytes: 200,
      configuredMaxSerializedBytes: 300,
      configuredMaxItems: 2,
    })).toEqual({
      ok: true,
      limits: {
        maxItems: 2,
        maxSerializedBytes: 300,
      },
    });

    expect(resolveExternalSessionOperationSocketBatchLimitsV1({
      socketMaxSerializedBytes: 200,
      envelopeOverheadBytes: 200,
      configuredMaxSerializedBytes: 300,
      configuredMaxItems: 2,
    })).toEqual({
      ok: false,
      errorCode: 'socket_capacity_insufficient',
    });
  });

  it('bounds batch item count and serialized bytes using the negotiated response', () => {
    const batch = ExternalSessionOperationSocketCommandV1Schema.parse({
      v: 1,
      kind: 'batch',
      claim,
      expectedRevision: 7,
      batchId:
        'historical-import-batch:v1:6e37b9e9d632936753ccc075050cd99675da4bf7f3fa808cc95b2e4968419cfd',
      items: [{
        localId: 'external:item-1',
        sidechainId: null,
        messageRole: 'agent',
        content: { t: 'encrypted', c: 'ciphertext' },
        sourceCreatedAtMs: 100,
      }],
    });

    expect(validateExternalSessionOperationSocketBatchV1(batch, {
      maxItems: 1,
      maxSerializedBytes: 10_000,
    })).toEqual({ ok: true });
    expect(validateExternalSessionOperationSocketBatchV1(batch, {
      maxItems: 0,
      maxSerializedBytes: 10_000,
    })).toEqual({ ok: false, errorCode: 'too_many_items' });
    expect(validateExternalSessionOperationSocketBatchV1(batch, {
      maxItems: 1,
      maxSerializedBytes: 10,
    })).toEqual({ ok: false, errorCode: 'serialized_bytes_exceeded' });

    expect(() => ExternalSessionOperationSocketCommandV1Schema.parse({
      ...batch,
      items: [{ ...batch.items[0], content: 'legacy-ciphertext' }],
    })).toThrow();
  });

  it('keeps historical-import sidechain identities within the indexed storage bound', () => {
    const sidechainId = 's'.repeat(SessionIndexedIdentifierMaxLengthV1);
    const batch = {
      ...commandBase,
      kind: 'batch' as const,
      batchId: makeExternalSessionHistoricalImportBatchIdV1(['external:sidechain']),
      items: [{
        localId: 'external:sidechain',
        sidechainId,
        messageRole: 'agent' as const,
        content: { t: 'plain' as const, v: { text: 'sidechain' } },
      }],
    };

    expect(ExternalSessionOperationSocketCommandV1Schema.parse(batch)).toMatchObject({
      items: [{ sidechainId }],
    });
    expect(ExternalSessionOperationSocketCommandV1Schema.parse({
      ...batch,
      items: [{ ...batch.items[0], sidechainId: ` ${sidechainId} ` }],
    })).toMatchObject({
      items: [{ sidechainId }],
    });
    expect(ExternalSessionOperationSocketCommandV1Schema.safeParse({
      ...batch,
      items: [{ ...batch.items[0], sidechainId: `${sidechainId}s` }],
    }).success).toBe(false);
  });

  it('accepts only JavaScript-Date-valid historical source timestamps while preserving their ordering', () => {
    const maxSourceTimestampMs = SESSION_TRANSCRIPT_SOURCE_TIMESTAMP_MAX_MS;
    const batch = {
      ...commandBase,
      kind: 'batch' as const,
      batchId: makeExternalSessionHistoricalImportBatchIdV1(['external:timestamp']),
      items: [{
        localId: 'external:timestamp',
        sidechainId: null,
        messageRole: 'agent' as const,
        content: { t: 'plain' as const, v: { text: 'timestamp' } },
        sourceCreatedAtMs: maxSourceTimestampMs,
        sourceUpdatedAtMs: maxSourceTimestampMs,
      }],
    };

    expect(ExternalSessionOperationSocketCommandV1Schema.parse(batch)).toMatchObject(batch);
    expect(ExternalSessionOperationSocketCommandV1Schema.safeParse({
      ...batch,
      items: [{ ...batch.items[0], sourceCreatedAtMs: maxSourceTimestampMs + 1 }],
    }).success).toBe(false);
    expect(ExternalSessionOperationSocketCommandV1Schema.safeParse({
      ...batch,
      items: [{ ...batch.items[0], sourceUpdatedAtMs: maxSourceTimestampMs + 1 }],
    }).success).toBe(false);
    expect(ExternalSessionOperationSocketCommandV1Schema.safeParse({
      ...batch,
      items: [{
        ...batch.items[0],
        sourceCreatedAtMs: maxSourceTimestampMs,
        sourceUpdatedAtMs: maxSourceTimestampMs - 1,
      }],
    }).success).toBe(false);
  });

  it('accepts only the content-addressed historical batch identity shape', () => {
    const contentAddressedBatchId =
      'historical-import-batch:v1:6e37b9e9d632936753ccc075050cd99675da4bf7f3fa808cc95b2e4968419cfd';
    expect(makeExternalSessionHistoricalImportBatchIdV1([
      'external:item-1',
    ])).toBe(contentAddressedBatchId);
    expect(makeExternalSessionHistoricalImportBatchIdV1([
      'external:item-2',
      'external:item-1',
    ])).not.toBe(makeExternalSessionHistoricalImportBatchIdV1([
      'external:item-1',
      'external:item-2',
    ]));
    expect(ExternalSessionHistoricalImportBatchIdV1Schema.parse(
      contentAddressedBatchId,
    )).toBe(contentAddressedBatchId);
    expect(ExternalSessionOperationSocketCommandV1Schema.parse({
      ...commandBase,
      kind: 'batch',
      batchId: contentAddressedBatchId,
      items: [{
        localId: 'external:item-1',
        sidechainId: null,
        messageRole: null,
        content: { t: 'plain', v: { text: 'hello' } },
      }],
    })).toMatchObject({ batchId: contentAddressedBatchId });
    expect(() => ExternalSessionOperationSocketCommandV1Schema.parse({
      ...commandBase,
      kind: 'batch',
      batchId: 'caller-chosen-batch-id',
      items: [{
        localId: 'external:item-1',
        sidechainId: null,
        messageRole: null,
        content: { t: 'plain', v: { text: 'hello' } },
      }],
    })).toThrow();
  });

  it('defines explicit inspect/begin/resume/batch/finalize/discard commands', () => {
    const commands = [
      { ...commandBase, kind: 'inspect' },
      begin,
      { ...commandBase, kind: 'resume' },
      {
        ...commandBase,
        kind: 'batch',
        batchId:
          'historical-import-batch:v1:6e37b9e9d632936753ccc075050cd99675da4bf7f3fa808cc95b2e4968419cfd',
        items: [{
          localId: 'external:item-1',
          sidechainId: null,
          messageRole: null,
          content: { t: 'plain', v: { text: 'hello' } },
        }],
      },
      {
        ...commandBase,
        kind: 'finalize',
        expectedAcceptedThroughServerSeq: 3,
      },
      { ...commandBase, kind: 'discard' },
    ];

    expect(commands.map((command) => (
      ExternalSessionOperationSocketCommandV1Schema.parse(command).kind
    ))).toEqual(['inspect', 'begin', 'resume', 'batch', 'finalize', 'discard']);
  });

  it('parses persisted takeover admission with exact publication, Pending, and metadata fences', () => {
    const ownerMetadataCiphertext =
      'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==';
    const migrationPatch = {
      mode: 'owner_migration',
      expectedAccountEncryptionMode: 'e2ee',
      expectedAccountContentPublicKeyFingerprint:
        `content-public-key-sha256:${'a'.repeat(64)}`,
      source: {
        metadataLayoutVersion: 0,
        metadata: {
          version: 11,
          ciphertext: 'linked-owner-metadata',
        },
        ownerMetadata: null,
        agentState: {
          version: 3,
          ciphertext: null,
        },
      },
      target: {
        metadataLayoutVersion: 1,
        sharedMetadata: {
          ciphertext: 'recipient-safe-metadata',
        },
        ownerMetadata: {
          t: 'encrypted',
          c: ownerMetadataCiphertext,
        },
        agentState: {
          ciphertext: null,
        },
      },
    } as const;
    const command = {
      ...commandBase,
      kind: 'admit_persisted_takeover',
      mode: 'persisted',
      attemptId: 'attempt-1',
      publisherPrecondition: {
        machineId: 'machine-1',
        committedFenceMs: 1_234,
      },
      expectedSessionMetadataVersion: 11,
      metadataPatch: {
        mode: 'owner',
        metadataLayoutVersion: 1,
        expectedOwnerMetadata: {
          t: 'encrypted',
          c: ownerMetadataCiphertext,
        },
        sharedMetadata: {
          ciphertext: 'recipient-safe-metadata',
          expectedVersion: 11,
        },
        ownerMetadata: {
          t: 'encrypted',
          c: ownerMetadataCiphertext,
        },
        agentState: {
          ciphertext: null,
          expectedVersion: 3,
        },
      },
      expectedSessionSeq: 19,
      expectedPending: {
        version: 4,
        count: 2,
        blockedCount: 1,
      },
      expectedPublication: {
        materializationPublicationId: 'publication-1',
        materializedThroughSourceAt: 1234,
        publishedThroughServerSeq: 19,
      },
    } as const;

    expect(ExternalSessionOperationSocketCommandV1Schema.parse(command)).toEqual(command);
    expect(ExternalSessionOperationSocketCommandV1Schema.safeParse({
      ...command,
      metadataPatch: migrationPatch,
    }).success).toBe(false);
    expect(ExternalSessionOperationSocketCommandV1Schema.safeParse({
      ...command,
      metadataPatch: {
        mode: 'shared_editor',
        metadataLayoutVersion: 1,
        sharedMetadata: {
          ciphertext: 'not-owner-authority',
          expectedVersion: 11,
        },
      },
    }).success).toBe(false);
  });

  it('parses external-linked takeover admission only with its retained storage and exact publisher fences', () => {
    const command = {
      ...commandBase,
      kind: 'admit_persisted_takeover',
      mode: 'external_linked',
      attemptId: 'attempt-1',
      publisherPrecondition: {
        machineId: 'machine-1',
        committedFenceMs: 1_234,
      },
      expectedSessionMetadataVersion: 11,
      expectedSessionSeq: 19,
      expectedPending: {
        version: 4,
        count: 2,
        blockedCount: 1,
      },
      expectedPriorStableStorage: {
        state: 'snapshot_complete',
        publication: {
          materializationPublicationId: 'publication-1',
          materializedThroughSourceAt: 1_000,
          publishedThroughServerSeq: 19,
        },
      },
    } as const;

    expect(ExternalSessionOperationSocketCommandV1Schema.parse(command)).toEqual(command);
    expect(ExternalSessionOperationSocketCommandV1Schema.safeParse({
      ...command,
      metadataPatch: {
        mode: 'owner',
      },
    }).success).toBe(false);
    expect(ExternalSessionOperationSocketCommandV1Schema.safeParse({
      ...command,
      publisherPrecondition: {
        machineId: 'machine-1',
      },
    }).success).toBe(false);
  });

});
