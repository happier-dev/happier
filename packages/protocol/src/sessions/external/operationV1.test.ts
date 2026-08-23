import { describe, expect, it } from 'vitest';
import {
  ExternalSessionOperationProgressV1Schema,
  ExternalSessionOperationRecordV1Schema,
  ExternalSessionOperationSharedPresentationV1Schema,
  ExternalSessionMaterializationPublicationV1Schema,
  classifyExternalSessionOperationIdempotencyV1,
  decideExternalSessionOperationUpdateV1,
  projectExternalSessionOperationProgressV1,
  projectExternalSessionOperationSharedPresentationV1,
  resolveExternalSessionOperationTimelineV1,
} from './index.js';

const qualifiedSource = {
  v: 1,
  agent: {
    pluginId: 'com.example.agent',
    localId: 'example',
  },
  source: {
    kind: 'jsonl',
    contractVersion: 1,
  },
} as const;

const publication = {
  materializationPublicationId: 'publication-1',
  materializedThroughSourceAt: 1_700_000_000_000,
  publishedThroughServerSeq: 120,
} as const;

function request(
  execution:
    | 'materialize'
    | 'takeover_external_linked'
    | 'takeover_persisted' = 'materialize',
) {
  const common = {
    v: 1 as const,
    idempotencyKey: 'idempotency-1',
    sessionId: 'session-1',
    source: {
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      qualifiedIdentity: qualifiedSource,
      linkGeneration: 'link-generation-1',
      sourceGeneration: 'source-generation-1',
      contributionGeneration: 'contribution-generation-1',
    },
  };

  if (execution === 'materialize') {
    return {
      ...common,
      plan: 'materialize' as const,
      targetStorageMode: 'external-linked' as const,
      targetRuntimeMode: null,
    };
  }

  return {
    ...common,
    plan: 'takeover' as const,
    targetStorageMode: execution === 'takeover_persisted'
      ? 'persisted' as const
      : 'external-linked' as const,
    targetDirectory: '/local/selected/workspace',
    targetRuntimeMode: 'terminal' as const,
  };
}

function baseRecord(
  execution:
    | 'materialize'
    | 'takeover_external_linked'
    | 'takeover_persisted' = 'materialize',
) {
  const semanticRequest = request(execution);
  return {
    v: 1 as const,
    operationId: 'operation-1',
    revision: 1,
    request: semanticRequest,
    status: 'running' as const,
    phase: 'validating' as const,
    timeline: resolveExternalSessionOperationTimelineV1(semanticRequest),
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    priorStableStorage: {
      state: 'machine_only' as const,
    },
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
      },
    },
    bindings: {
      operationClaimId: 'operation-claim-1',
    },
    progressProjection: {
      acknowledgedRevision: null,
    },
    canonicalOwnerEvidence: {
      linkedSessionRevision: 3,
    },
    fence: {
      kind: 'none' as const,
    },
  };
}

const takeoverAuthorIntent = {
  v: 1 as const,
  surface: 'plugin' as const,
  kind: 'takeover' as const,
  agentId: 'example',
  sourceId: 'codexHome:user:::',
  remoteSessionId: 'remote-1',
  targetStorageMode: 'persisted' as const,
};

const materializeAuthorIntent = {
  v: 1 as const,
  surface: 'plugin' as const,
  kind: 'materialize' as const,
  sessionId: 'session-1',
  targetStorageMode: 'external-linked' as const,
};

describe('External Sessions durable operation contract', () => {
  it('persists the exact bounded private plugin author-intent union while retaining native rows', () => {
    const takeover = ExternalSessionOperationRecordV1Schema.safeParse({
      ...baseRecord('takeover_persisted'),
      authorIntent: takeoverAuthorIntent,
    });
    expect(takeover.success).toBe(true);
    if (takeover.success) {
      expect(takeover.data).toHaveProperty(
        'authorIntent',
        takeoverAuthorIntent,
      );
    }

    const materialize = ExternalSessionOperationRecordV1Schema.safeParse({
      ...baseRecord('materialize'),
      authorIntent: materializeAuthorIntent,
    });
    expect(materialize.success).toBe(true);
    if (materialize.success) {
      expect(materialize.data).toHaveProperty(
        'authorIntent',
        materializeAuthorIntent,
      );
    }

    // Optionality is read compatibility only: an existing native/exact-owner
    // row remains readable and is not promoted to plugin-authored state.
    const native = ExternalSessionOperationRecordV1Schema.parse(baseRecord());
    expect(native).not.toHaveProperty('authorIntent');

    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...baseRecord('takeover_persisted'),
      request: {
        ...baseRecord('takeover_persisted').request,
        source: {
          ...baseRecord('takeover_persisted').request.source,
          remoteSessionId: 'r'.repeat(2_000),
          qualifiedIdentity: {
            ...baseRecord('takeover_persisted').request.source
              .qualifiedIdentity,
            agent: {
              ...baseRecord('takeover_persisted').request.source
                .qualifiedIdentity.agent,
              localId: 'a'.repeat(128),
            },
          },
        },
      },
      authorIntent: {
        ...takeoverAuthorIntent,
        agentId: 'a'.repeat(128),
        sourceId: 's'.repeat(2_000),
        remoteSessionId: 'r'.repeat(2_000),
      },
    }).success).toBe(true);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...baseRecord('materialize'),
      request: {
        ...baseRecord('materialize').request,
        sessionId: 's'.repeat(191),
      },
      authorIntent: {
        ...materializeAuthorIntent,
        sessionId: 's'.repeat(191),
      },
    }).success).toBe(true);

    for (const invalidAuthorIntent of [
      { ...takeoverAuthorIntent, generation: 'must-not-persist' },
      { ...takeoverAuthorIntent, targetDirectory: '/caller-selected/workspace' },
      { ...takeoverAuthorIntent, agentId: ' codex' },
      { ...takeoverAuthorIntent, agentId: 'a'.repeat(129) },
      { ...takeoverAuthorIntent, sourceId: 'codexHome:user::: ' },
      { ...takeoverAuthorIntent, sourceId: 's'.repeat(2_001) },
      { ...takeoverAuthorIntent, remoteSessionId: '' },
      { ...takeoverAuthorIntent, remoteSessionId: 'r'.repeat(2_001) },
      { ...materializeAuthorIntent, targetStorageMode: 'persisted' },
      { ...materializeAuthorIntent, remoteSessionId: 'must-not-persist' },
      { ...materializeAuthorIntent, sessionId: 's'.repeat(192) },
    ]) {
      expect(ExternalSessionOperationRecordV1Schema.safeParse({
        ...baseRecord(
          invalidAuthorIntent.kind === 'takeover'
            ? 'takeover_persisted'
            : 'materialize',
        ),
        authorIntent: invalidAuthorIntent,
      }).success).toBe(false);
    }
  });

  it('fails closed for a legacy durable takeover record without an explicit host target directory', () => {
    const persistedRequest = request('takeover_persisted');
    if (persistedRequest.plan !== 'takeover') {
      throw new Error('expected persisted takeover request');
    }
    const { targetDirectory: removedTargetDirectory, ...legacyRequest } = persistedRequest;
    expect(removedTargetDirectory).toBe('/local/selected/workspace');

    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...baseRecord('takeover_persisted'),
      request: legacyRequest,
    }).success).toBe(false);
  });

  it('rejects plugin author intent that disagrees with its retained semantic request', () => {
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...baseRecord('takeover_persisted'),
      authorIntent: takeoverAuthorIntent,
    }).success).toBe(true);

    for (const incoherent of [
      {
        ...baseRecord('takeover_persisted'),
        authorIntent: {
          ...takeoverAuthorIntent,
          remoteSessionId: 'different-remote',
        },
      },
      {
        ...baseRecord('takeover_persisted'),
        authorIntent: {
          ...takeoverAuthorIntent,
          agentId: 'different-agent',
        },
      },
      {
        ...baseRecord('takeover_external_linked'),
        authorIntent: takeoverAuthorIntent,
      },
      {
        ...baseRecord('materialize'),
        authorIntent: {
          ...materializeAuthorIntent,
          sessionId: 'different-session',
        },
      },
      {
        ...baseRecord('takeover_persisted'),
        authorIntent: materializeAuthorIntent,
      },
    ]) {
      expect(
        ExternalSessionOperationRecordV1Schema.safeParse(incoherent).success,
      ).toBe(false);
    }
  });

  it('keeps author intent immutable when the retained request changes coherently', () => {
    const previous = ExternalSessionOperationRecordV1Schema.parse({
      ...baseRecord('takeover_persisted'),
      authorIntent: takeoverAuthorIntent,
    });
    const next = ExternalSessionOperationRecordV1Schema.parse({
      ...previous,
      revision: previous.revision + 1,
      updatedAtMs: previous.updatedAtMs + 1,
      request: {
        ...previous.request,
        source: {
          ...previous.request.source,
          remoteSessionId: 'remote-2',
        },
      },
      authorIntent: {
        ...takeoverAuthorIntent,
        remoteSessionId: 'remote-2',
      },
    });

    expect(decideExternalSessionOperationUpdateV1(previous, next)).toEqual({
      kind: 'semantic_mismatch',
    });
  });

  it('removes private plugin author intent from complete and shared projections', () => {
    const record = ExternalSessionOperationRecordV1Schema.parse({
      ...baseRecord('takeover_persisted'),
      authorIntent: takeoverAuthorIntent,
    });
    const progress = projectExternalSessionOperationProgressV1(record);
    expect(progress).not.toHaveProperty('authorIntent');
    expect(ExternalSessionOperationProgressV1Schema.safeParse({
      ...progress,
      authorIntent: takeoverAuthorIntent,
    }).success).toBe(false);

    const shared = projectExternalSessionOperationSharedPresentationV1(progress);
    expect(shared).not.toHaveProperty('authorIntent');
    expect(ExternalSessionOperationSharedPresentationV1Schema.safeParse({
      ...shared,
      authorIntent: takeoverAuthorIntent,
    }).success).toBe(false);
  });

  it('writes the takeover directory to owner progress while accepting the prior owner projection', () => {
    const record = ExternalSessionOperationRecordV1Schema.parse(
      baseRecord('takeover_persisted'),
    );
    const progress = projectExternalSessionOperationProgressV1(record);
    if (progress.request.plan !== 'takeover') {
      throw new Error('expected takeover progress');
    }
    expect(progress.request.targetDirectory).toBe('/local/selected/workspace');

    const {
      targetDirectory: omittedTargetDirectory,
      ...priorOwnerRequest
    } = progress.request;
    expect(omittedTargetDirectory).toBe('/local/selected/workspace');
    expect(ExternalSessionOperationProgressV1Schema.safeParse({
      ...progress,
      request: priorOwnerRequest,
    }).success).toBe(true);

    const shared = projectExternalSessionOperationSharedPresentationV1(progress);
    expect(JSON.stringify(shared)).not.toContain(omittedTargetDirectory);
  });

  it('projects Retry only for an exact external-linked admission acknowledgement reconciliation', () => {
    const exact = ExternalSessionOperationRecordV1Schema.parse({
      ...baseRecord('takeover_external_linked'),
      revision: 2,
      status: 'reconciliation_required' as const,
      phase: 'admitting' as const,
      updatedAtMs: 1_700_000_000_001,
      retryTargetPhase: 'admitting' as const,
      error: {
        code: 'reconciliation_required' as const,
        message: 'External-linked takeover admission acknowledgement remains ambiguous after bounded exact-attempt replay.',
        retryable: true,
        occurredAtMs: 1_700_000_000_001,
      },
      bindings: {
        operationClaimId: 'operation-claim-1',
        targetRuntimeAttemptId: 'admission-attempt-1',
      },
    });
    expect(projectExternalSessionOperationProgressV1(exact).error).toEqual({
      code: 'reconciliation_required',
      retryable: true,
      occurredAtMs: 1_700_000_000_001,
    });
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...exact,
      bindings: {
        operationClaimId: 'operation-claim-1',
      },
    }).success).toBe(false);

    const genericDisagreement = ExternalSessionOperationRecordV1Schema.parse({
      ...exact,
      canonicalOwnerEvidence: {
        linkedSessionRevision: 3,
        disagreement: {
          owner: 'runtime_control' as const,
          expectedRevision: 3,
          observedRevision: 4,
        },
      },
    });
    expect(projectExternalSessionOperationProgressV1(genericDisagreement).error).toEqual({
      code: 'reconciliation_required',
      retryable: false,
      occurredAtMs: 1_700_000_000_001,
    });
  });

  it('requires a bounded progress-projection receipt that cannot acknowledge a future revision', () => {
    const record = baseRecord();
    expect(ExternalSessionOperationRecordV1Schema.safeParse(record).success).toBe(true);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...record,
      progressProjection: {
        acknowledgedRevision: record.revision,
      },
    }).success).toBe(true);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...record,
      progressProjection: {
        acknowledgedRevision: record.revision + 1,
      },
    }).success).toBe(false);
    const {
      progressProjection: _progressProjection,
      ...missingReceipt
    } = record;
    expect(ExternalSessionOperationRecordV1Schema.safeParse(
      missingReceipt,
    ).success).toBe(false);
  });

  it('admits retryable source failures at external-linked pre-spawn phases', () => {
    for (const phase of ['quiescing', 'admitting', 'spawning'] as const) {
      expect(ExternalSessionOperationRecordV1Schema.safeParse({
        ...baseRecord('takeover_external_linked'),
        revision: 2,
        status: 'failed',
        phase,
        retryTargetPhase: phase,
        error: {
          code: 'source_unavailable',
          message: 'Captured external source is no longer current.',
          retryable: true,
          occurredAtMs: 1_700_000_000_001,
        },
      }).success).toBe(true);
    }
  });

  it('bounds private source cursor evidence independently from ordinary references', () => {
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...baseRecord(),
      canonicalOwnerEvidence: {
        linkedSessionRevision: 3,
        sourceSnapshotEvidenceRef: 'c'.repeat(4_096),
      },
    }).success).toBe(true);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...baseRecord(),
      canonicalOwnerEvidence: {
        linkedSessionRevision: 3,
        sourceSnapshotEvidenceRef: 'c'.repeat(4_097),
      },
    }).success).toBe(false);
  });

  it('accepts only the three approved plan/target combinations with their exact timelines', () => {
    const materialize = ExternalSessionOperationRecordV1Schema.parse(baseRecord('materialize'));
    const externalLinked = ExternalSessionOperationRecordV1Schema.parse(
      baseRecord('takeover_external_linked'),
    );
    const persisted = ExternalSessionOperationRecordV1Schema.parse(baseRecord('takeover_persisted'));

    expect(materialize.timeline).toEqual(['validating', 'staging', 'importing', 'publishing']);
    expect(externalLinked.timeline).toEqual([
      'validating',
      'quiescing',
      'admitting',
      'spawning',
      'finalizing',
    ]);
    expect(persisted.timeline).toEqual([
      'validating',
      'quiescing',
      'staging',
      'importing',
      'final_catch_up',
      'admitting',
      'spawning',
      'finalizing',
    ]);

    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...materialize,
      revision: 2,
      status: 'completed',
      phase: 'publishing',
      currentStorageState: 'snapshot_complete',
      checkpoint: {
        ...materialize.checkpoint,
        importedItemCount: 120,
        acceptedThroughServerSeq: 120,
        acknowledgedBatchId: 'batch-completed',
      },
      publication,
      terminalResult: { kind: 'completed' },
    }).success).toBe(true);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...materialize,
      revision: 2,
      status: 'completed',
      phase: 'publishing',
      currentStorageState: 'snapshot_complete',
      publication: {
        materializationPublicationId: 'empty-publication',
        materializedThroughSourceAt: 1_700_000_000_000,
        publishedThroughServerSeq: 0,
      },
      terminalResult: { kind: 'completed' },
    }).success).toBe(true);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...externalLinked,
      revision: 2,
      status: 'completed',
      phase: 'finalizing',
      currentStorageState: 'machine_only',
      terminalResult: { kind: 'completed' },
    }).success).toBe(true);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...persisted,
      revision: 2,
      status: 'completed',
      phase: 'finalizing',
      currentStorageState: 'hosted',
      terminalResult: { kind: 'completed' },
    }).success).toBe(true);

    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...baseRecord(),
      request: {
        ...request('materialize'),
        targetStorageMode: 'persisted',
      },
    }).success).toBe(false);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...baseRecord('takeover_persisted'),
      request: {
        ...request('takeover_persisted'),
        targetRuntimeMode: 'remote',
      },
    }).success).toBe(false);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...externalLinked,
      checkpoint: {
        ...externalLinked.checkpoint,
        importedItemCount: 1,
        acceptedThroughServerSeq: 1,
        acknowledgedBatchId: 'forbidden-batch',
      },
      bindings: {
        ...externalLinked.bindings,
        historicalImportJobId: 'forbidden-import-job',
      },
    }).success).toBe(false);
  });

  it('accepts the published persisted-takeover checkpoint that waits for explicit admission Resume', () => {
    const initial = baseRecord('takeover_persisted');
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...initial,
      revision: 2,
      status: 'awaiting_user_resume',
      phase: 'admitting',
      currentStorageState: 'snapshot_complete',
      checkpoint: {
        ...initial.checkpoint,
        sourcePagesRead: 1,
        stagedItemCount: 1,
        importedItemCount: 1,
        acceptedThroughServerSeq: 120,
        acknowledgedBatchId: 'historical-import-complete',
      },
      publication,
      retryTargetPhase: 'admitting',
      fence: { kind: 'none' },
    }).success).toBe(true);
  });

  it('enforces monotonic phase/revision updates and immutable semantic identity', () => {
    const previous = ExternalSessionOperationRecordV1Schema.parse(baseRecord('takeover_persisted'));
    const next = ExternalSessionOperationRecordV1Schema.parse({
      ...previous,
      revision: 2,
      phase: 'staging',
      updatedAtMs: previous.updatedAtMs + 1,
    });
    expect(decideExternalSessionOperationUpdateV1(previous, next)).toEqual({ kind: 'accept' });

    const regression = ExternalSessionOperationRecordV1Schema.parse({
      ...next,
      revision: 3,
      phase: 'quiescing',
      updatedAtMs: next.updatedAtMs + 1,
    });
    expect(decideExternalSessionOperationUpdateV1(next, regression)).toEqual({
      kind: 'phase_regression',
    });
    expect(decideExternalSessionOperationUpdateV1(previous, {
      ...next,
      revision: 3,
    })).toEqual({ kind: 'revision_gap' });

    const interrupted = ExternalSessionOperationRecordV1Schema.parse({
      ...next,
      status: 'awaiting_user_resume',
      retryTargetPhase: 'staging',
    });
    const resumed = ExternalSessionOperationRecordV1Schema.parse({
      ...interrupted,
      revision: 3,
      status: 'running',
      retryTargetPhase: undefined,
      updatedAtMs: interrupted.updatedAtMs + 1,
    });
    expect(decideExternalSessionOperationUpdateV1(interrupted, resumed)).toEqual({
      kind: 'accept',
    });
  });

  it('returns the same operation only for the same key and semantic request', () => {
    const existing = baseRecord();
    expect(classifyExternalSessionOperationIdempotencyV1(
      existing.request,
      { ...request() },
    )).toEqual({ kind: 'same_operation' });

    expect(classifyExternalSessionOperationIdempotencyV1(
      existing.request,
      {
        ...request(),
        source: {
          ...request().source,
          remoteSessionId: 'different-source',
        },
      },
    )).toEqual({ kind: 'semantic_mismatch' });
    expect(classifyExternalSessionOperationIdempotencyV1(
      existing.request,
      request('takeover_external_linked'),
    )).toEqual({ kind: 'semantic_mismatch' });
    expect(classifyExternalSessionOperationIdempotencyV1(
      request('takeover_external_linked'),
      request('takeover_persisted'),
    )).toEqual({ kind: 'semantic_mismatch' });
    expect(classifyExternalSessionOperationIdempotencyV1(
      request('takeover_persisted'),
      {
        ...request('takeover_persisted'),
        targetDirectory: '/local/different/workspace',
      },
    )).toEqual({ kind: 'semantic_mismatch' });
    expect(classifyExternalSessionOperationIdempotencyV1(
      existing.request,
      {
        ...request(),
        idempotencyKey: 'different-key',
      },
    )).toEqual({ kind: 'different_idempotency_key' });
  });

  it('distinguishes initial server_partial from an incomplete snapshot update', () => {
    const initialPartial = {
      ...baseRecord(),
      revision: 2,
      status: 'awaiting_user_resume' as const,
      phase: 'importing' as const,
      currentStorageState: 'server_partial' as const,
      checkpoint: {
        ...baseRecord().checkpoint,
        importedItemCount: 12,
        acceptedThroughServerSeq: 12,
        acknowledgedBatchId: 'batch-1',
      },
      fence: {
        kind: 'initial_server_partial' as const,
        acceptedThroughServerSeq: 12,
      },
      retryTargetPhase: 'importing' as const,
    };
    expect(ExternalSessionOperationRecordV1Schema.safeParse(initialPartial).success).toBe(true);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...initialPartial,
      status: 'cancelled',
      retryTargetPhase: undefined,
      cancellation: {
        requestedAtMs: 1_700_000_000_001,
        requestedAtRevision: 1,
      },
      terminalResult: {
        kind: 'cancelled',
      },
    }).success).toBe(true);

    const incompleteUpdate = {
      ...baseRecord(),
      revision: 2,
      status: 'awaiting_user_resume' as const,
      phase: 'importing' as const,
      priorStableStorage: {
        state: 'snapshot_complete' as const,
        publication,
      },
      currentStorageState: 'snapshot_complete' as const,
      publication,
      checkpoint: {
        ...baseRecord().checkpoint,
        importedItemCount: 10,
        acceptedThroughServerSeq: 130,
        acknowledgedBatchId: 'batch-2',
      },
      fence: {
        kind: 'incomplete_update' as const,
        publication,
      },
      retryTargetPhase: 'importing' as const,
    };
    expect(ExternalSessionOperationRecordV1Schema.safeParse(incompleteUpdate).success).toBe(true);

    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...incompleteUpdate,
      fence: {
        kind: 'initial_server_partial',
        acceptedThroughServerSeq: 130,
      },
    }).success).toBe(false);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...initialPartial,
      fence: {
        kind: 'incomplete_update',
        publication,
      },
      publication,
    }).success).toBe(false);
  });

  it('permits only exact same-claim cancelled Discard transitions', () => {
    const cancelledInitialPartial = ExternalSessionOperationRecordV1Schema.parse({
      ...baseRecord(),
      revision: 2,
      status: 'cancelled',
      phase: 'importing',
      updatedAtMs: 1_700_000_000_001,
      currentStorageState: 'server_partial',
      checkpoint: {
        ...baseRecord().checkpoint,
        importedItemCount: 12,
        acceptedThroughServerSeq: 12,
        acknowledgedBatchId: 'batch-1',
      },
      bindings: {
        ...baseRecord().bindings,
        historicalImportJobId: 'initial-partial-job',
      },
      fence: {
        kind: 'initial_server_partial',
        acceptedThroughServerSeq: 12,
      },
      cancellation: {
        requestedAtMs: 1_700_000_000_001,
        requestedAtRevision: 1,
      },
      terminalResult: {
        kind: 'cancelled',
      },
    });
    const discarded = ExternalSessionOperationRecordV1Schema.parse({
      ...cancelledInitialPartial,
      revision: 3,
      status: 'discarded',
      updatedAtMs: 1_700_000_000_002,
      currentStorageState: 'machine_only',
      checkpoint: baseRecord().checkpoint,
      bindings: {
        operationClaimId: cancelledInitialPartial.bindings.operationClaimId,
      },
      fence: { kind: 'none' },
      cancellation: undefined,
      terminalResult: {
        kind: 'discarded',
      },
    });

    expect(decideExternalSessionOperationUpdateV1(
      cancelledInitialPartial,
      discarded,
    )).toEqual({ kind: 'accept' });

    const differentClaim = ExternalSessionOperationRecordV1Schema.parse({
      ...discarded,
      bindings: {
        operationClaimId: 'replacement-claim',
      },
    });
    expect(decideExternalSessionOperationUpdateV1(
      cancelledInitialPartial,
      differentClaim,
    )).toEqual({ kind: 'terminal_operation' });

    const cancelledLocal = ExternalSessionOperationRecordV1Schema.parse({
      ...baseRecord(),
      revision: 2,
      status: 'cancelled',
      phase: 'staging',
      updatedAtMs: 1_700_000_000_001,
      cancellation: {
        requestedAtMs: 1_700_000_000_001,
        requestedAtRevision: 1,
      },
      terminalResult: { kind: 'cancelled' },
    });
    const discardedLocal = ExternalSessionOperationRecordV1Schema.parse({
      ...cancelledLocal,
      revision: 3,
      status: 'discarded',
      updatedAtMs: 1_700_000_000_002,
      checkpoint: baseRecord().checkpoint,
      bindings: {
        operationClaimId: cancelledLocal.bindings.operationClaimId,
      },
      cancellation: undefined,
      terminalResult: { kind: 'discarded' },
    });

    expect(decideExternalSessionOperationUpdateV1(
      cancelledLocal,
      discardedLocal,
    )).toEqual({ kind: 'accept' });
    expect(decideExternalSessionOperationUpdateV1(
      cancelledLocal,
      ExternalSessionOperationRecordV1Schema.parse({
        ...discardedLocal,
        bindings: { operationClaimId: 'replacement-local-claim' },
      }),
    )).toEqual({ kind: 'terminal_operation' });
  });

  it('models cancellation, explicit resume targets, discard, and crash reconciliation without authority', () => {
    const cancelled = {
      ...baseRecord(),
      revision: 2,
      status: 'cancelled' as const,
      phase: 'staging' as const,
      cancellation: {
        requestedAtMs: 1_700_000_000_001,
        requestedAtRevision: 1,
      },
      terminalResult: {
        kind: 'cancelled' as const,
      },
    };
    expect(ExternalSessionOperationRecordV1Schema.safeParse(cancelled).success).toBe(true);

    const resumable = {
      ...baseRecord(),
      revision: 2,
      status: 'awaiting_user_resume' as const,
      phase: 'staging' as const,
      retryTargetPhase: 'staging' as const,
    };
    expect(ExternalSessionOperationRecordV1Schema.safeParse(resumable).success).toBe(true);

    const discarded = {
      ...baseRecord(),
      revision: 3,
      status: 'discarded' as const,
      phase: 'importing' as const,
      currentStorageState: 'server_partial' as const,
      checkpoint: {
        ...baseRecord().checkpoint,
        importedItemCount: 4,
        acceptedThroughServerSeq: 4,
        acknowledgedBatchId: 'batch-discarded',
      },
      fence: {
        kind: 'initial_server_partial' as const,
        acceptedThroughServerSeq: 4,
      },
      terminalResult: {
        kind: 'discarded' as const,
      },
    };
    expect(ExternalSessionOperationRecordV1Schema.safeParse(discarded).success).toBe(false);

    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...discarded,
      currentStorageState: 'machine_only',
      checkpoint: baseRecord().checkpoint,
      bindings: {
        operationClaimId: discarded.bindings.operationClaimId,
      },
      fence: { kind: 'none' },
    }).success).toBe(true);

    const reconciliation = {
      ...baseRecord('takeover_persisted'),
      revision: 2,
      status: 'reconciliation_required' as const,
      phase: 'admitting' as const,
      retryTargetPhase: 'admitting' as const,
      error: {
        code: 'reconciliation_required' as const,
        message: 'Canonical runtime authority no longer matches the recorded reference.',
        retryable: false,
        occurredAtMs: 1_700_000_000_001,
      },
      canonicalOwnerEvidence: {
        linkedSessionRevision: 3,
        disagreement: {
          owner: 'runtime_control' as const,
          expectedRevision: 7,
          observedRevision: 8,
        },
      },
    };
    const parsed = ExternalSessionOperationRecordV1Schema.parse(reconciliation);
    expect(parsed.status).toBe('reconciliation_required');
    expect(parsed).not.toHaveProperty('authorityGranted');
    expect(parsed).not.toHaveProperty('rollbackAuthority');
  });

  it('blocks completion/publication when required items failed', () => {
    const failed = {
      ...baseRecord(),
      revision: 2,
      status: 'failed' as const,
      phase: 'publishing' as const,
      checkpoint: {
        ...baseRecord().checkpoint,
        sourcePagesRead: 3,
        stagedItemCount: 20,
        importedItemCount: 18,
        acceptedThroughServerSeq: 18,
        acknowledgedBatchId: 'batch-required-failure',
        requiredItemFailures: {
          total: 2,
          record: 1,
          media: 1,
          conversion: 0,
          diagnosticsTruncated: true,
        },
      },
      currentStorageState: 'server_partial' as const,
      fence: {
        kind: 'initial_server_partial' as const,
        acceptedThroughServerSeq: 18,
      },
      retryTargetPhase: 'importing' as const,
      error: {
        code: 'required_items_failed' as const,
        message: 'Two required source items could not be imported.',
        retryable: true,
        occurredAtMs: 1_700_000_000_001,
      },
    };
    expect(ExternalSessionOperationRecordV1Schema.safeParse(failed).success).toBe(true);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...failed,
      status: 'completed',
      currentStorageState: 'snapshot_complete',
      publication,
      fence: { kind: 'none' },
      retryTargetPhase: undefined,
      error: undefined,
      terminalResult: { kind: 'completed' },
    }).success).toBe(false);

    const failedCatchUp = {
      ...failed,
      priorStableStorage: {
        state: 'snapshot_complete' as const,
        publication,
      },
      currentStorageState: 'snapshot_complete' as const,
      publication,
      checkpoint: {
        ...failed.checkpoint,
        acceptedThroughServerSeq: 130,
        acknowledgedBatchId: 'batch-required-failure-catch-up',
      },
      fence: {
        kind: 'incomplete_update' as const,
        publication,
      },
    };
    expect(ExternalSessionOperationRecordV1Schema.safeParse(failedCatchUp).success).toBe(true);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...failedCatchUp,
      publication: {
        ...publication,
        materializationPublicationId: 'illegally-advanced',
        publishedThroughServerSeq: 130,
      },
    }).success).toBe(false);
  });

  it('admits only bounded sanitized source ordinals for required-item correction', () => {
    const requiredItemFailures = {
      total: 1,
      record: 0,
      media: 1,
      conversion: 0,
      diagnosticsTruncated: false,
      diagnostics: [{
        category: 'media',
        sourceGeneration: 'source-generation-1',
        sourcePageIndex: 3,
        sourceItemIndex: 7,
      }],
    } as const;
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...baseRecord(),
      checkpoint: {
        ...baseRecord().checkpoint,
        requiredItemFailures,
      },
    }).success).toBe(true);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...baseRecord(),
      checkpoint: {
        ...baseRecord().checkpoint,
        requiredItemFailures: {
          ...requiredItemFailures,
          diagnostics: [{
            ...requiredItemFailures.diagnostics[0],
            path: '/private/source/transcript.jsonl',
          }],
        },
      },
    }).success).toBe(false);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...baseRecord(),
      checkpoint: {
        ...baseRecord().checkpoint,
        requiredItemFailures: {
          ...requiredItemFailures,
          diagnostics: Array.from({ length: 33 }, (_, sourceItemIndex) => ({
            category: 'record',
            sourceGeneration: 'source-generation-1',
            sourcePageIndex: 0,
            sourceItemIndex,
          })),
        },
      },
    }).success).toBe(false);
  });

  it('publishes only content-free progress and rejects raw watermarks/digests', () => {
    const record = ExternalSessionOperationRecordV1Schema.parse({
      ...baseRecord(),
      status: 'awaiting_user_resume',
      retryTargetPhase: 'validating',
      currentStorageState: 'server_partial',
      fence: {
        kind: 'initial_server_partial',
        acceptedThroughServerSeq: 7,
      },
      error: {
        code: 'internal_error',
        message: 'private path /Users/alice/transcript.jsonl token=secret',
        retryable: true,
        occurredAtMs: 1_700_000_000_000,
      },
      checkpoint: {
        ...baseRecord().checkpoint,
        acceptedThroughServerSeq: 7,
        acknowledgedBatchId: 'private-batch-reference-1',
        requiredItemFailures: {
          total: 1,
          record: 0,
          media: 1,
          conversion: 0,
          diagnosticsTruncated: false,
          diagnostics: [{
            category: 'media',
            sourceGeneration: 'private-source-generation-1',
            sourcePageIndex: 3,
            sourceItemIndex: 7,
          }],
        },
      },
      canonicalOwnerEvidence: {
        linkedSessionRevision: 3,
        sourceSnapshotEvidenceRef: 'private-source-evidence-1',
      },
      bindings: {
        operationClaimId: 'operation-claim-1',
        historicalImportJobId: 'historical-import-job-1',
        privateStagingId: 'private-staging-1',
      },
    });
    const progress = projectExternalSessionOperationProgressV1(record);

    expect(progress).not.toHaveProperty('canonicalOwnerEvidence');
    expect(progress).not.toHaveProperty('bindings');
    expect(progress).not.toHaveProperty('transcript');
    expect(progress.checkpoint).toMatchObject({
      acceptedThroughServerSeq: 7,
      requiredItemFailures: {
        total: 1,
        media: 1,
        diagnosticsTruncated: false,
      },
    });
    expect(progress.checkpoint).not.toHaveProperty('acknowledgedBatchId');
    expect(progress.checkpoint.requiredItemFailures).not.toHaveProperty('diagnostics');
    expect(progress.error).toEqual({
      code: 'internal_error',
      retryable: true,
      occurredAtMs: 1_700_000_000_000,
    });
    expect(progress.error).not.toHaveProperty('message');
    const serializedProgress = JSON.stringify(progress);
    for (const privateSentinel of [
      '/Users/alice/transcript.jsonl',
      'token=secret',
      'machine-1',
      'remote-1',
      'source-generation-1',
      'private-batch-reference-1',
      'private-source-generation-1',
      'private-source-evidence-1',
      'operation-claim-1',
      'historical-import-job-1',
      'private-staging-1',
    ]) {
      expect(serializedProgress).not.toContain(privateSentinel);
    }
    for (const privateField of [
      'operationClaimId',
      'historicalImportJobId',
      'privateStagingId',
      'canonicalOwnerEvidence',
      'acknowledgedBatchId',
      'diagnostics',
      'message',
    ]) {
      expect(serializedProgress).not.toContain(`"${privateField}"`);
    }
    expect(ExternalSessionOperationProgressV1Schema.safeParse({
      ...progress,
      error: record.error,
    }).success).toBe(false);
    expect(ExternalSessionOperationProgressV1Schema.safeParse({
      ...progress,
      checkpoint: {
        ...progress.checkpoint,
        acknowledgedBatchId: 'private-batch-reference-1',
      },
    }).success).toBe(false);
    expect(ExternalSessionOperationProgressV1Schema.safeParse({
      ...progress,
      checkpoint: {
        ...progress.checkpoint,
        requiredItemFailures: {
          ...progress.checkpoint.requiredItemFailures,
          diagnostics: record.checkpoint.requiredItemFailures.diagnostics,
        },
      },
    }).success).toBe(false);
    expect(ExternalSessionOperationProgressV1Schema.safeParse({
      ...progress,
      rawAgentSourceWatermark: 'byte-offset:123',
    }).success).toBe(false);
    expect(ExternalSessionOperationProgressV1Schema.safeParse({
      ...progress,
      sourceWatermarkDigest: 'sha256:secret-derived',
    }).success).toBe(false);
    expect(ExternalSessionOperationRecordV1Schema.safeParse({
      ...record,
      rawAgentSourceWatermark: 'byte-offset:123',
    }).success).toBe(false);
    expect(ExternalSessionMaterializationPublicationV1Schema.safeParse({
      ...publication,
      sourceWatermarkDigest: 'sha256:secret-derived',
    }).success).toBe(false);
  });

  it.each([
    ['materialize', 'materialize'],
    ['takeover_external_linked', 'takeover_external_linked'],
    ['takeover_persisted', 'takeover_persisted'],
  ] as const)(
    'projects a poisoned complete %s record to the exact shared presentation fields',
    (execution, expectedKind) => {
      const complete = projectExternalSessionOperationProgressV1(
        ExternalSessionOperationRecordV1Schema.parse(baseRecord(execution)),
      );
      const projected = projectExternalSessionOperationSharedPresentationV1({
        ...complete,
        operationClaimId: 'must-not-cross',
        privateStagingId: 'must-not-cross',
      });

      expect(projected).toEqual({
        v: 1,
        operationId: 'operation-1',
        revision: 1,
        kind: expectedKind,
        status: 'running',
        phase: 'validating',
      });
      expect(Object.keys(projected as object)).toEqual([
        'v',
        'operationId',
        'revision',
        'kind',
        'status',
        'phase',
      ]);
      expect(ExternalSessionOperationSharedPresentationV1Schema.safeParse({
        ...projected,
        checkpoint: complete.checkpoint,
      }).success).toBe(false);
      expect(ExternalSessionOperationSharedPresentationV1Schema.safeParse({
        ...projected,
        request: complete.request,
      }).success).toBe(false);
    },
  );
});
