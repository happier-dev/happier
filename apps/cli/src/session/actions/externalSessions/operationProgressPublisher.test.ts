import {
  EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY,
  EXTERNAL_SESSION_OPERATION_TIMELINES_V1,
  ExternalSessionOperationRecordV1Schema,
  ExternalSessionOperationReferenceV1Schema,
  ExternalSessionOperationProgressV1Schema,
  projectExternalSessionOperationProgressV1,
  projectExternalSessionOperationSharedPresentationV1,
  type ExternalSessionOperationProgressV1,
  type ExternalSessionOperationRecordV1,
} from '@happier-dev/protocol';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { repairDiagnosticMock } = vi.hoisted(() => ({
  repairDiagnosticMock: vi.fn(),
}));

const admissionBoundaryMocks = vi.hoisted(() => ({
  readStoredCredentials: vi.fn(),
  fetchSessionById: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
  readSessionMetadataTupleWriterSnapshot: vi.fn(),
}));

vi.mock('./responseErrors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./responseErrors')>();
  return {
    ...actual,
    logExternalSessionsInternalError: repairDiagnosticMock,
  };
});

vi.mock('@/persistence', () => ({
  readStoredCredentials: admissionBoundaryMocks.readStoredCredentials,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: admissionBoundaryMocks.fetchSessionById,
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness:
    admissionBoundaryMocks.fetchAccountEncryptionCurrentness,
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', async (
  importOriginal,
) => {
  const actual = await importOriginal<
    typeof import('@/session/metadata/updateSessionMetadataWithRetry')
  >();
  return {
    ...actual,
    readSessionMetadataTupleWriterSnapshot:
      admissionBoundaryMocks.readSessionMetadataTupleWriterSnapshot,
  };
});

import {
  assertExternalSessionOperationProgressCanBeSelected,
  convergeExternalSessionOperationProgressProjection,
  readExternalSessionOperationSharedPresentation,
  repairExternalSessionOperationProgressProjections as repairExternalSessionOperationProgressProjectionsWithClaimInspection,
  resolveExternalSessionOperationProjectionBarrierAcquisitionTimeoutMs,
  selectExternalSessionOperationPresentationMetadata,
  selectExternalSessionOperationProgressMetadata,
  selectExternalSessionOperationRecordsForPassiveRepair,
  settlePriorTerminalExternalSessionOperationProgressProjections,
} from './operationProgressPublisher';
import {
  createExternalSessionMaterializeActionExecutor,
} from './materializeAction';
import {
  createExternalSessionTakeoverStartActionExecutor,
} from './takeoverStartAction';
import {
  acknowledgeExternalSessionOperationProgressProjection,
  compactExternalSessionOperationRecordToCompletionReceipt,
  readExternalSessionOperationRecord,
  readExternalSessionOperationStoredEntry,
  resolveExternalSessionOperationStartAdmission,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';

import {
  createExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';
import {
  createExternalSessionOperationPrivateStagingStore,
} from '@/session/external/staging/operationPrivateStaging';

function vitestOperationRecordsDirectory(activeServerDir: string): string {
  return join(
    activeServerDir,
    'external-session-operations',
    'by-account',
    `sub-${createHash('sha256').update('vitest', 'utf8').digest('hex').slice(0, 32)}`,
    'records',
  );
}

const roots: string[] = [];

type RepairDependencies = Parameters<
  typeof repairExternalSessionOperationProgressProjectionsWithClaimInspection
>[1];

async function withInactiveOperationClaimBarrier<TResult>(
  _input: Readonly<{
    sessionId: string;
    operationClaimId: string;
  }>,
  effect: () => Promise<TResult>,
) {
  return {
    status: 'executed' as const,
    value: await effect(),
  };
}

function repairExternalSessionOperationProgressProjections(
  activeServerDir: string,
  dependencies: Omit<
    RepairDependencies,
    'inspectOperationClaim' | 'withOperationClaimBarrier'
  > & Partial<Pick<
    RepairDependencies,
    'inspectOperationClaim' | 'withOperationClaimBarrier'
  >>,
) {
  return repairExternalSessionOperationProgressProjectionsWithClaimInspection(
    activeServerDir,
    {
      inspectOperationClaim: async () => 'inactive',
      withOperationClaimBarrier: withInactiveOperationClaimBarrier,
      ...dependencies,
    },
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
  repairDiagnosticMock.mockClear();
  admissionBoundaryMocks.readStoredCredentials.mockReset();
  admissionBoundaryMocks.fetchSessionById.mockReset();
  admissionBoundaryMocks.fetchAccountEncryptionCurrentness.mockReset();
  admissionBoundaryMocks.readSessionMetadataTupleWriterSnapshot.mockReset();
});

function progress(input: Readonly<{
  operationId: string;
  revision: number;
  status: 'running' | 'completed';
  updatedAtMs: number;
  phase?: 'validating' | 'staging' | 'publishing';
}>) {
  return ExternalSessionOperationProgressV1Schema.parse({
    v: 1,
    operationId: input.operationId,
    revision: input.revision,
    request: {
      plan: 'materialize',
      targetStorageMode: 'external-linked',
      targetRuntimeMode: null,
    },
    status: input.status,
    phase: input.phase ?? 'publishing',
    timeline: EXTERNAL_SESSION_OPERATION_TIMELINES_V1.materialize,
    updatedAtMs: input.updatedAtMs,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: input.status === 'completed'
      ? 'snapshot_complete'
      : 'machine_only',
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
      ...(input.status === 'completed'
        ? {
          acceptedThroughServerSeq: 0,
        }
        : {}),
    },
    fence: { kind: 'none' },
    ...(input.status === 'completed'
      ? {
        publication: {
          materializationPublicationId: 'publication-1',
          materializedThroughSourceAt: input.updatedAtMs,
          publishedThroughServerSeq: 0,
        },
      }
      : {}),
  });
}

function privateRecord(input: Readonly<{
  operationId: string;
  sessionId: string;
  status:
    | 'running'
    | 'awaiting_user_resume'
    | 'cancel_requested'
    | 'completed'
    | 'cancelled'
    | 'discarded';
  operationClaimId?: string;
  targetRuntimeAttemptId?: string;
  phase?:
    | 'validating'
    | 'quiescing'
    | 'staging'
    | 'importing'
    | 'final_catch_up'
    | 'publishing'
    | 'admitting'
    | 'spawning'
    | 'finalizing';
  plan?: 'materialize' | 'takeover';
  targetStorageMode?: 'external-linked' | 'persisted';
}>) {
  const isCompleted = input.status === 'completed';
  const isCancelled = input.status === 'cancelled';
  const isDiscarded = input.status === 'discarded';
  const phase = input.phase ?? 'publishing';
  const plan = input.plan ?? 'materialize';
  const isExternalLinkedTakeover =
    plan === 'takeover'
    && input.targetStorageMode === 'external-linked';
  return ExternalSessionOperationRecordV1Schema.parse({
    v: 1,
    operationId: input.operationId,
    revision: isCompleted || isCancelled || isDiscarded ? 2 : 0,
    request: {
      v: 1,
      idempotencyKey: `key-${input.operationId}`,
      sessionId: input.sessionId,
      source: {
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        qualifiedIdentity: {
          v: 1,
          agent: { pluginId: 'com.example.agent', localId: 'example' },
          source: { kind: 'jsonl', contractVersion: 1 },
        },
        linkGeneration: 'link-1',
        sourceGeneration: 'source-1',
        contributionGeneration: 'contribution-1',
      },
      plan,
      targetStorageMode: input.targetStorageMode
        ?? (plan === 'takeover' ? 'persisted' : 'external-linked'),
      ...(plan === 'takeover'
        ? { targetDirectory: '/local/selected/workspace' }
        : {}),
      targetRuntimeMode: plan === 'takeover' ? 'terminal' : null,
    },
    status: input.status,
    phase,
    timeline: plan === 'takeover'
      ? (input.targetStorageMode === 'external-linked'
          ? EXTERNAL_SESSION_OPERATION_TIMELINES_V1.takeover_external_linked
          : EXTERNAL_SESSION_OPERATION_TIMELINES_V1.takeover_persisted)
      : EXTERNAL_SESSION_OPERATION_TIMELINES_V1.materialize,
    createdAtMs: 1,
    updatedAtMs: isCompleted || isCancelled || isDiscarded ? 2 : 1,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: isCompleted && !isExternalLinkedTakeover
      ? 'snapshot_complete'
      : 'machine_only',
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
      ...(isCompleted && !isExternalLinkedTakeover
        ? {
          acceptedThroughServerSeq: 0,
          acknowledgedBatchId: `batch-${input.operationId}`,
        }
        : {}),
    },
    bindings: {
      operationClaimId:
        input.operationClaimId ?? `claim-${input.operationId}`,
      ...(input.targetRuntimeAttemptId === undefined
        ? {}
        : { targetRuntimeAttemptId: input.targetRuntimeAttemptId }),
    },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: { linkedSessionRevision: 1 },
    fence: { kind: 'none' },
    ...(input.status === 'awaiting_user_resume'
      ? { retryTargetPhase: phase }
      : {}),
    ...(input.status === 'cancel_requested'
      ? {
        cancellation: {
          requestedAtMs: 1,
          requestedAtRevision: 0,
        },
      }
      : {}),
    ...(isCancelled
      ? {
        cancellation: {
          requestedAtMs: 1,
          requestedAtRevision: 1,
        },
      }
      : {}),
    ...(isCompleted
      ? {
        ...(!isExternalLinkedTakeover
          ? {
            publication: {
              materializationPublicationId:
                `publication-${input.operationId}`,
              materializedThroughSourceAt: 2,
              publishedThroughServerSeq: 0,
            },
          }
          : {}),
        terminalResult: { kind: 'completed' },
      }
      : {}),
    ...(isCancelled ? { terminalResult: { kind: 'cancelled' } } : {}),
    ...(isDiscarded ? { terminalResult: { kind: 'discarded' } } : {}),
  });
}

function persistedTakeoverRuntimeRecord(input: Readonly<{
  phase: 'admitting' | 'spawning';
  authorityPrepared?: boolean;
}>) {
  const publication = {
    materializationPublicationId: 'publication-takeover',
    materializedThroughSourceAt: 10,
    publishedThroughServerSeq: 3,
  };
  const isAdmitting = input.phase === 'admitting';
  return ExternalSessionOperationRecordV1Schema.parse({
    v: 1,
    operationId: `operation-takeover-${input.phase}`,
    revision: 9,
    request: {
      v: 1,
      idempotencyKey: `key-takeover-${input.phase}`,
      sessionId: `session-takeover-${input.phase}`,
      source: {
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        qualifiedIdentity: {
          v: 1,
          agent: { pluginId: 'com.example.agent', localId: 'example' },
          source: { kind: 'jsonl', contractVersion: 1 },
        },
        linkGeneration: 'link-1',
        sourceGeneration: 'source-1',
        contributionGeneration: 'contribution-1',
      },
      plan: 'takeover',
      targetStorageMode: 'persisted',
      targetDirectory: '/local/selected/workspace',
      targetRuntimeMode: 'terminal',
    },
    status: 'running',
    phase: input.phase,
    timeline: EXTERNAL_SESSION_OPERATION_TIMELINES_V1.takeover_persisted,
    createdAtMs: 1,
    updatedAtMs: 2,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: isAdmitting ? 'snapshot_complete' : 'hosted',
    checkpoint: {
      sourcePagesRead: 1,
      stagedItemCount: 1,
      importedItemCount: 1,
      requiredItemFailures: {
        total: 0,
        record: 0,
        media: 0,
        conversion: 0,
        diagnosticsTruncated: false,
        diagnostics: [],
      },
      ...(isAdmitting
        ? {
          acceptedThroughServerSeq: 3,
          acknowledgedBatchId: 'historical-import-complete',
        }
        : {}),
    },
    bindings: {
      operationClaimId: 'claim-1',
      targetRuntimeAttemptId: 'attempt-1',
    },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: {
      linkedSessionRevision: 7,
      ...(input.authorityPrepared
        ? {
          transcriptAuthorityRevision: 3,
          pendingAdmissionRevision: 4,
        }
        : {}),
    },
    fence: { kind: 'none' },
    ...(isAdmitting ? { publication } : {}),
  });
}

describe('external-session operation progress producer selection', () => {
  it('derives and saturates the finite projection barrier acquisition budget', () => {
    expect(resolveExternalSessionOperationProjectionBarrierAcquisitionTimeoutMs({
      sessionControlTimeoutMs: 1_000,
      connectedServicesTimeoutMs: 2_000,
    })).toBe(90_000);
    expect(resolveExternalSessionOperationProjectionBarrierAcquisitionTimeoutMs({
      sessionControlTimeoutMs: Number.MAX_SAFE_INTEGER,
      connectedServicesTimeoutMs: Number.MAX_SAFE_INTEGER,
    })).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('accepts only exact same-session completed receipt evidence for terminal replacement admission', async () => {
    const sessionId = 'session-receipt-predecessor-admission';
    const predecessor = progress({
      operationId: 'operation-receipt-predecessor-admission',
      revision: 7,
      status: 'completed',
      phase: 'publishing',
      updatedAtMs: 70,
    });
    const predecessorPresentation =
      projectExternalSessionOperationSharedPresentationV1(predecessor);
    const retainedButUnselected = progress({
      operationId: 'operation-receipt-unselected-admission',
      revision: 4,
      status: 'completed',
      phase: 'publishing',
      updatedAtMs: 60,
    });
    const retainedButUnselectedPresentation =
      projectExternalSessionOperationSharedPresentationV1(
        retainedButUnselected,
      );
    const incoming = progress({
      operationId: 'operation-receipt-successor-admission',
      revision: 0,
      status: 'running',
      phase: 'validating',
      updatedAtMs: 80,
    });
    admissionBoundaryMocks.readStoredCredentials.mockResolvedValue({
      token: 'token',
    });
    admissionBoundaryMocks.fetchSessionById.mockResolvedValue({ id: sessionId });
    admissionBoundaryMocks.fetchAccountEncryptionCurrentness.mockResolvedValue({});
    admissionBoundaryMocks.readSessionMetadataTupleWriterSnapshot.mockReturnValue({
      metadataLayoutVersion: 0,
      value: {
        metadata: {
          [EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY]:
            predecessorPresentation,
        },
      },
    });

    await expect(assertExternalSessionOperationProgressCanBeSelected({
      sessionId,
      progress: incoming,
      priorTerminalReceiptEvidence: [
        {
          reference: ExternalSessionOperationReferenceV1Schema.parse({
            sessionId,
            operationId: retainedButUnselected.operationId,
            revision: retainedButUnselected.revision,
          }),
          presentation: retainedButUnselectedPresentation,
        },
        {
          reference: ExternalSessionOperationReferenceV1Schema.parse({
            sessionId,
            operationId: predecessor.operationId,
            revision: predecessor.revision,
          }),
          presentation: predecessorPresentation,
        },
      ],
    })).resolves.toEqual(predecessorPresentation);
  });

  it.each([
    {
      name: 'different session',
      reference: { sessionId: 'session-other' },
      presentation: {},
    },
    {
      name: 'different operation',
      reference: { operationId: 'operation-other' },
      presentation: {},
    },
    {
      name: 'different revision',
      reference: { revision: 6 },
      presentation: {},
    },
    {
      name: 'non-completed presentation',
      reference: {},
      presentation: { status: 'discarded' },
    },
    {
      name: 'malformed presentation',
      reference: {},
      presentation: { unexpected: true },
    },
  ] as const)(
    'rejects $name receipt evidence for terminal replacement admission',
    async ({ reference: referenceOverride, presentation: presentationOverride }) => {
      const sessionId = 'session-invalid-receipt-predecessor';
      const predecessor = progress({
        operationId: 'operation-invalid-receipt-predecessor',
        revision: 7,
        status: 'completed',
        phase: 'publishing',
        updatedAtMs: 70,
      });
      const predecessorPresentation =
        projectExternalSessionOperationSharedPresentationV1(predecessor);
      admissionBoundaryMocks.readStoredCredentials.mockResolvedValue({
        token: 'token',
      });
      admissionBoundaryMocks.fetchSessionById.mockResolvedValue({ id: sessionId });
      admissionBoundaryMocks.fetchAccountEncryptionCurrentness.mockResolvedValue({});
      admissionBoundaryMocks.readSessionMetadataTupleWriterSnapshot.mockReturnValue({
        metadataLayoutVersion: 0,
        value: {
          metadata: {
            [EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY]:
              predecessorPresentation,
          },
        },
      });

      await expect(assertExternalSessionOperationProgressCanBeSelected({
        sessionId,
        progress: progress({
          operationId: 'operation-invalid-receipt-successor',
          revision: 0,
          status: 'running',
          phase: 'validating',
          updatedAtMs: 80,
        }),
        priorTerminalReceiptEvidence: [{
          reference: {
            sessionId,
            operationId: predecessor.operationId,
            revision: predecessor.revision,
            ...referenceOverride,
          },
          presentation: {
            ...predecessorPresentation,
            ...presentationOverride,
          },
        }],
      })).rejects.toThrow('external_session_operation_projection_conflict');
    },
  );

  it('rejects duplicate receipt evidence that exactly matches the selected predecessor', async () => {
    const sessionId = 'session-duplicate-receipt-predecessor';
    const predecessor = progress({
      operationId: 'operation-duplicate-receipt-predecessor',
      revision: 7,
      status: 'completed',
      phase: 'publishing',
      updatedAtMs: 70,
    });
    const presentation =
      projectExternalSessionOperationSharedPresentationV1(predecessor);
    const evidence = {
      reference: ExternalSessionOperationReferenceV1Schema.parse({
        sessionId,
        operationId: predecessor.operationId,
        revision: predecessor.revision,
      }),
      presentation,
    };
    admissionBoundaryMocks.readStoredCredentials.mockResolvedValue({
      token: 'token',
    });
    admissionBoundaryMocks.fetchSessionById.mockResolvedValue({ id: sessionId });
    admissionBoundaryMocks.fetchAccountEncryptionCurrentness.mockResolvedValue({});
    admissionBoundaryMocks.readSessionMetadataTupleWriterSnapshot.mockReturnValue({
      metadataLayoutVersion: 0,
      value: {
        metadata: {
          [EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY]: presentation,
        },
      },
    });

    await expect(assertExternalSessionOperationProgressCanBeSelected({
      sessionId,
      progress: progress({
        operationId: 'operation-duplicate-receipt-successor',
        revision: 0,
        status: 'running',
        phase: 'validating',
        updatedAtMs: 80,
      }),
      priorTerminalReceiptEvidence: [evidence, evidence],
    })).rejects.toThrow('external_session_operation_projection_conflict');
  });

  it('does not treat an unbound terminal-replacement flag as predecessor authority', () => {
    const terminal = progress({
      operationId: 'operation-1',
      revision: 8,
      status: 'completed',
      updatedAtMs: 100,
    });
    const next = progress({
      operationId: 'operation-2',
      revision: 0,
      status: 'running',
      updatedAtMs: 101,
    });
    const metadata = {
      externalSessionOperationV1: { v: 1 as const, progress: terminal },
    };
    const originalMetadata = structuredClone(metadata);

    expect(() => selectExternalSessionOperationProgressMetadata(metadata, next, {
      allowDifferentTerminalReplacement: true,
    })).toThrow('external_session_operation_projection_conflict');
    expect(metadata).toEqual(originalMetadata);
  });

  it('atomically replaces the exact settled terminal selected at admission', () => {
    const terminal = progress({
      operationId: 'operation-exact-predecessor',
      revision: 8,
      status: 'completed',
      updatedAtMs: 100,
    });
    const next = progress({
      operationId: 'operation-exact-successor',
      revision: 0,
      status: 'running',
      updatedAtMs: 101,
    });
    const expectedDifferentTerminalPresentation =
      projectExternalSessionOperationSharedPresentationV1(terminal);

    expect(selectExternalSessionOperationProgressMetadata({
      externalSessionOperationV1: { v: 1, progress: terminal },
    }, next, {
      allowDifferentTerminalReplacement: true,
      expectedDifferentTerminalPresentation,
    })).toEqual({
      externalSessionOperationV1: { v: 1, progress: next },
      externalSessionOperationPresentationV1:
        projectExternalSessionOperationSharedPresentationV1(next),
    });
  });

  it('does not let a stale complete publisher resurrect over a newer layout-zero terminal selection', () => {
    const older = progress({
      operationId: 'operation-layout-zero-older-terminal',
      revision: 4,
      status: 'completed',
      updatedAtMs: 4,
    });
    const newer = progress({
      operationId: 'operation-layout-zero-newer-terminal',
      revision: 2,
      status: 'completed',
      updatedAtMs: 8,
    });
    const selected = selectExternalSessionOperationPresentationMetadata(
      {},
      newer,
    );

    expect(() => selectExternalSessionOperationProgressMetadata(
      selected,
      older,
    )).toThrow('external_session_operation_projection_conflict');
    expect(selected[EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY])
      .toEqual(projectExternalSessionOperationSharedPresentationV1(newer));
  });

  it('does not overwrite a malformed layout-zero operation presentation', () => {
    const incoming = progress({
      operationId: 'operation-layout-zero-malformed-selection',
      revision: 1,
      status: 'running',
      updatedAtMs: 1,
      phase: 'validating',
    });

    expect(() => selectExternalSessionOperationProgressMetadata(
      {
        [EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY]: {
          v: 1,
          operationId: incoming.operationId,
          revision: incoming.revision,
          kind: 'materialize',
          status: 'unknown',
          phase: incoming.phase,
        },
      },
      incoming,
    )).toThrow('external_session_operation_projection_malformed');
  });

  it('does not overwrite a malformed layout-zero owner operation behind a valid presentation', () => {
    const incoming = progress({
      operationId: 'operation-layout-zero-malformed-owner-successor',
      revision: 0,
      status: 'running',
      updatedAtMs: 2,
      phase: 'validating',
    });
    const predecessor = progress({
      operationId: 'operation-layout-zero-malformed-owner-predecessor',
      revision: 1,
      status: 'completed',
      updatedAtMs: 1,
    });
    const metadata = {
      externalSessionOperationV1: {
        v: 1,
        progress: {
          operationId: predecessor.operationId,
        },
      },
      [EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY]:
        projectExternalSessionOperationSharedPresentationV1(predecessor),
    };

    expect(() => selectExternalSessionOperationPresentationMetadata(
      metadata,
      incoming,
      { allowDifferentTerminalReplacement: true },
    )).toThrow('external_session_operation_projection_malformed');
    expect(() => selectExternalSessionOperationProgressMetadata(
      metadata,
      incoming,
      { allowDifferentTerminalReplacement: true },
    )).toThrow('external_session_operation_projection_malformed');
  });

  it('does not replace a terminal that changed after predecessor validation', () => {
    const incoming = progress({
      operationId: 'operation-validated-successor',
      revision: 0,
      status: 'running',
      updatedAtMs: 3,
      phase: 'validating',
    });
    const changedTerminal = progress({
      operationId: 'operation-changed-terminal',
      revision: 2,
      status: 'completed',
      updatedAtMs: 2,
    });
    const selected = selectExternalSessionOperationPresentationMetadata(
      {},
      changedTerminal,
    );

    expect(() => selectExternalSessionOperationProgressMetadata(
      selected,
      incoming,
      {
        allowDifferentTerminalReplacement: true,
        expectedDifferentTerminalPresentation:
          projectExternalSessionOperationSharedPresentationV1(progress({
            operationId: 'operation-changed-terminal',
            revision: 1,
            status: 'completed',
            updatedAtMs: 1,
          })),
      },
    )).toThrow('external_session_operation_projection_conflict');
  });

  it.each(['layout0', 'layout1'] as const)(
    'rejects an in-flight stale terminal publisher after newer terminal selection in %s',
    (layout) => {
      const staleTerminal = progress({
        operationId: 'operation-terminal-a',
        revision: 2,
        status: 'completed',
        updatedAtMs: 20,
      });
      const selectedTerminal = progress({
        operationId: 'operation-terminal-b',
        revision: 2,
        status: 'completed',
        updatedAtMs: 30,
      });
      const metadata = layout === 'layout0'
        ? selectExternalSessionOperationPresentationMetadata(
          {},
          selectedTerminal,
        )
        : selectExternalSessionOperationProgressMetadata(
          {},
          selectedTerminal,
        );

      expect(() => layout === 'layout0'
        ? selectExternalSessionOperationPresentationMetadata(
          metadata,
          staleTerminal,
        )
        : selectExternalSessionOperationProgressMetadata(
          metadata,
          staleTerminal,
        )).toThrow('external_session_operation_projection_conflict');
      expect(metadata).toEqual(
        layout === 'layout0'
          ? selectExternalSessionOperationPresentationMetadata(
            {},
            selectedTerminal,
          )
          : selectExternalSessionOperationProgressMetadata(
            {},
            selectedTerminal,
          ),
      );
    },
  );

  it('writes only the exact shared presentation in layout-zero metadata', () => {
    const current = progress({
      operationId: 'operation-1',
      revision: 8,
      status: 'completed',
      phase: 'publishing',
      updatedAtMs: 100,
    });
    const next = progress({
      operationId: 'operation-2',
      revision: 0,
      status: 'running',
      phase: 'validating',
      updatedAtMs: 101,
    });

    expect(selectExternalSessionOperationPresentationMetadata({
      externalSessionOperationV1: { v: 1, progress: current },
    }, next, {
      allowDifferentTerminalReplacement: true,
      expectedDifferentTerminalPresentation:
        projectExternalSessionOperationSharedPresentationV1(current),
    })).toEqual({
      externalSessionOperationPresentationV1:
        projectExternalSessionOperationSharedPresentationV1(next),
    });
  });

  it('preserves newer layout-zero presentation currentness while stripping legacy owner state', () => {
    const current = progress({
      operationId: 'operation-1',
      revision: 8,
      status: 'running',
      phase: 'staging',
      updatedAtMs: 100,
    });
    const stale = progress({
      operationId: 'operation-1',
      revision: 7,
      status: 'running',
      phase: 'validating',
      updatedAtMs: 99,
    });

    expect(selectExternalSessionOperationPresentationMetadata({
      externalSessionOperationV1: { v: 1, progress: current },
    }, stale)).toEqual({
      externalSessionOperationPresentationV1:
        projectExternalSessionOperationSharedPresentationV1(current),
    });
  });

  it('fails closed when a different nonterminal operation is still selected', () => {
    const current = progress({
      operationId: 'operation-1',
      revision: 8,
      status: 'running',
      updatedAtMs: 100,
    });
    const conflicting = progress({
      operationId: 'operation-2',
      revision: 0,
      status: 'running',
      updatedAtMs: 101,
    });

    expect(() => selectExternalSessionOperationProgressMetadata({
      externalSessionOperationV1: { v: 1, progress: current },
    }, conflicting)).toThrow('external_session_operation_projection_conflict');
  });

  it('fails layout-zero selection closed without clearing a malformed presentation', () => {
    const incoming = progress({
      operationId: 'operation-malformed-presentation',
      revision: 0,
      status: 'running',
      updatedAtMs: 100,
    });
    const malformedMetadata = {
      externalSessionOperationPresentationV1: {
        v: 1,
        operationId: incoming.operationId,
      },
    };

    expect(() => selectExternalSessionOperationPresentationMetadata(
      malformedMetadata,
      incoming,
    )).toThrow('external_session_operation_projection_malformed');
    expect(malformedMetadata).toEqual({
      externalSessionOperationPresentationV1: {
        v: 1,
        operationId: incoming.operationId,
      },
    });
  });

  it('reports a missing Session as gone for receipt pruning while convergence fails closed', async () => {
    const record = privateRecord({
      operationId: 'operation-gone-session-convergence',
      sessionId: 'session-gone-convergence',
      status: 'running',
    });
    admissionBoundaryMocks.readStoredCredentials.mockResolvedValue({
      token: 'token',
    });
    admissionBoundaryMocks.fetchSessionById.mockResolvedValue(null);
    admissionBoundaryMocks.fetchAccountEncryptionCurrentness.mockResolvedValue({});

    await expect(readExternalSessionOperationSharedPresentation(
      record.request.sessionId,
    )).resolves.toEqual({ kind: 'gone' });
    const publish = vi.fn(async () => undefined);
    const acknowledge = vi.fn(async () => record);
    await expect(convergeExternalSessionOperationProgressProjection(
      '/unused-active-server-dir',
      record,
      {
        readPresentation: async () => ({ kind: 'gone' }),
        publish,
        acknowledge,
      },
    )).rejects.toThrow(
      'external_session_operation_publish_session_not_found',
    );
    expect(publish).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('fails convergence closed without publishing or acknowledging a malformed presentation', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-malformed-presentation-',
    ));
    roots.push(activeServerDir);
    const record = privateRecord({
      operationId: 'operation-malformed-presentation',
      sessionId: 'session-malformed-presentation',
      status: 'completed',
    });
    await writeExternalSessionOperationRecord(activeServerDir, record);
    const publish = vi.fn(async () => undefined);
    const acknowledge = vi.fn(async () => record);

    await expect(convergeExternalSessionOperationProgressProjection(
      activeServerDir,
      record,
      {
        readPresentation: async () => ({ kind: 'malformed' }),
        publish,
        acknowledge,
      },
    )).rejects.toThrow('external_session_operation_projection_malformed');
    expect(publish).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).resolves.toEqual(record);
  });

  it('acknowledges an equal remote presentation without republishing', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-equal-presentation-',
    ));
    roots.push(activeServerDir);
    const record = privateRecord({
      operationId: 'operation-equal-presentation',
      sessionId: 'session-equal-presentation',
      status: 'completed',
    });
    await writeExternalSessionOperationRecord(activeServerDir, record);
    const publish = vi.fn(async () => undefined);
    const presentation = projectExternalSessionOperationSharedPresentationV1(
      projectExternalSessionOperationProgressV1(record),
    );

    await expect(convergeExternalSessionOperationProgressProjection(
      activeServerDir,
      record,
      {
        readPresentation: async () => ({
          kind: 'valid',
          presentation,
        }),
        publish,
      },
    )).resolves.toBe('acknowledged');
    expect(publish).not.toHaveBeenCalled();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      record.operationId,
    )).resolves.toMatchObject({
      revision: record.revision,
      progressProjection: {
        acknowledgedRevision: record.revision,
      },
    });
  });

  it('publishes exact current progress for a missing or older same-operation presentation', async () => {
    for (const remoteKind of ['missing', 'older'] as const) {
      const activeServerDir = await mkdtemp(join(
        tmpdir(),
        `happier-operation-${remoteKind}-presentation-`,
      ));
      roots.push(activeServerDir);
      const record = privateRecord({
        operationId: `operation-${remoteKind}-presentation`,
        sessionId: `session-${remoteKind}-presentation`,
        status: 'completed',
      });
      await writeExternalSessionOperationRecord(activeServerDir, record);
      const currentPresentation =
        projectExternalSessionOperationSharedPresentationV1(
          projectExternalSessionOperationProgressV1(record),
        );
      const publish = vi.fn(async () => undefined);

      await expect(convergeExternalSessionOperationProgressProjection(
        activeServerDir,
        record,
        {
          readPresentation: async () => remoteKind === 'missing'
            ? { kind: 'absent' as const }
            : {
              kind: 'valid' as const,
              presentation: {
                ...currentPresentation,
                revision: record.revision - 1,
              },
            },
          publish,
        },
      )).resolves.toBe('published');
      expect(publish).toHaveBeenCalledWith({
        activeServerDir,
        sessionId: record.request.sessionId,
        progress: projectExternalSessionOperationProgressV1(record),
      });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).resolves.toMatchObject({
        progressProjection: {
          acknowledgedRevision: record.revision,
        },
      });
    }
  });

  it('selects one unsettled terminal receipt for bounded passive repair', () => {
    const terminal = privateRecord({
      operationId: 'operation-terminal-gap',
      sessionId: 'session-terminal-gap',
      status: 'completed',
    });
    expect(selectExternalSessionOperationRecordsForPassiveRepair([
      terminal,
    ])).toEqual([terminal]);
  });

  it('settles the only unacknowledged terminal projection before successor admission', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-terminal-admission-settlement-',
    ));
    roots.push(activeServerDir);
    const terminal = privateRecord({
      operationId: 'operation-terminal-admission',
      sessionId: 'session-terminal-admission',
      status: 'completed',
    });
    await writeExternalSessionOperationRecord(activeServerDir, terminal);
    const publish = vi.fn(async () => undefined);

    await expect(
      settlePriorTerminalExternalSessionOperationProgressProjections(
        activeServerDir,
        [terminal],
        {
          readPresentation: async () => ({ kind: 'absent' }),
          publish,
        },
      ),
    ).resolves.toBeUndefined();

    expect(publish).toHaveBeenCalledOnce();
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      terminal.operationId,
    )).resolves.toEqual({
      ...terminal,
      progressProjection: {
        acknowledgedRevision: terminal.revision,
      },
    });
  });

  it.each(['already-current', 'publish-required'] as const)(
    'settles an unacknowledged terminal and prunes its expired predecessor without re-entering the Session lock when projection is %s',
    async (mode) => {
      const activeServerDir = await mkdtemp(join(
        tmpdir(),
        `happier-operation-terminal-admission-lock-${mode}-`,
      ));
      roots.push(activeServerDir);
      const sessionId = `session-terminal-admission-lock-${mode}`;
      const predecessorInput = privateRecord({
        operationId: `operation-terminal-admission-lock-predecessor-${mode}`,
        sessionId,
        status: 'completed',
        plan: 'takeover',
        targetStorageMode: 'external-linked',
        phase: 'finalizing',
      });
      await writeExternalSessionOperationRecord(
        activeServerDir,
        predecessorInput,
      );
      const predecessor =
        await acknowledgeExternalSessionOperationProgressProjection({
          activeServerDir,
          operationId: predecessorInput.operationId,
          projectedRevision: predecessorInput.revision,
        });
      await expect(compactExternalSessionOperationRecordToCompletionReceipt({
        activeServerDir,
        operationId: predecessor.operationId,
        expectedRevision: predecessor.revision,
        stagingDisposition: 'not_applicable',
      })).resolves.toMatchObject({ status: 'compacted' });

      const terminal = privateRecord({
        operationId: `operation-terminal-admission-lock-terminal-${mode}`,
        sessionId,
        status: 'completed',
      });
      await writeExternalSessionOperationRecord(activeServerDir, terminal);
      const currentTerminalPresentation =
        projectExternalSessionOperationSharedPresentationV1(
          projectExternalSessionOperationProgressV1(terminal),
        );
      let selectedPresentation = mode === 'already-current'
        ? currentTerminalPresentation
        : {
          ...currentTerminalPresentation,
          revision: currentTerminalPresentation.revision - 1,
        };
      let failInitialPruneRead = true;
      const readPresentation = vi.fn(async () => {
        if (failInitialPruneRead) {
          failInitialPruneRead = false;
          throw new Error('transient_session_read_failure');
        }
        return {
          kind: 'valid' as const,
          presentation: selectedPresentation,
        };
      });
      const candidate = privateRecord({
        operationId: `operation-terminal-admission-lock-candidate-${mode}`,
        sessionId,
        status: 'running',
        phase: 'validating',
      });
      const admission = await resolveExternalSessionOperationStartAdmission({
        activeServerDir,
        durableIdempotencyKey: candidate.request.idempotencyKey,
        intent: candidate.request,
        nowMs: predecessor.updatedAtMs + 86_400_000,
        readSelectedPresentation: readPresentation,
      });
      expect(admission.kind).toBe('new_operation');
      if (admission.kind !== 'new_operation') {
        throw new Error('expected a fresh successor admission');
      }
      const successor = {
        ...candidate,
        operationId: admission.operationId,
      } satisfies ExternalSessionOperationRecordV1;
      const publish = vi.fn(async () => {
        selectedPresentation = currentTerminalPresentation;
      });

      const startedAtMs = Date.now();
      await expect(writeExternalSessionOperationRecord(
        activeServerDir,
        successor,
        {
          settlePriorTerminalProgressProjection: async (
            priorTerminalRecords,
          ) => {
            await settlePriorTerminalExternalSessionOperationProgressProjections(
              activeServerDir,
              priorTerminalRecords,
              {
                readPresentation,
                publish,
                sessionAdmissionLockHeld: true,
              },
            );
          },
          validateSessionAdmission: async () => undefined,
        },
      )).resolves.toEqual(successor);
      expect(Date.now() - startedAtMs).toBeLessThan(2_500);
      expect(publish).toHaveBeenCalledTimes(
        mode === 'publish-required' ? 1 : 0,
      );
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        terminal.operationId,
      )).resolves.toMatchObject({
        progressProjection: { acknowledgedRevision: terminal.revision },
      });
      await expect(readExternalSessionOperationStoredEntry(
        activeServerDir,
        predecessor.operationId,
      )).resolves.toBeNull();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        successor.operationId,
      )).resolves.toEqual(successor);
    },
  );

  it('converges a newly admitted successor after a crash before its first publication', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-successor-first-publication-crash-',
    ));
    roots.push(activeServerDir);
    const sessionId = 'session-successor-first-publication-crash';
    const predecessorInput = privateRecord({
      operationId: 'operation-successor-predecessor',
      sessionId,
      status: 'completed',
    });
    await writeExternalSessionOperationRecord(
      activeServerDir,
      predecessorInput,
    );
    const predecessor =
      await acknowledgeExternalSessionOperationProgressProjection({
        activeServerDir,
        operationId: predecessorInput.operationId,
        projectedRevision: predecessorInput.revision,
      });
    const successor = privateRecord({
      operationId: 'operation-successor-after-crash',
      sessionId,
      status: 'running',
      phase: 'validating',
    });
    await writeExternalSessionOperationRecord(activeServerDir, successor);
    const publish = vi.fn(async () => undefined);
    const dependencies = {
      allowSettledTerminalPredecessorReplacement: true,
      readPresentation: async () => ({
        kind: 'valid' as const,
        presentation:
          projectExternalSessionOperationSharedPresentationV1(
            projectExternalSessionOperationProgressV1(predecessor),
          ),
      }),
      publish,
    };

    await expect(convergeExternalSessionOperationProgressProjection(
      activeServerDir,
      successor,
      dependencies,
    )).resolves.toBe('published');
    expect(publish).toHaveBeenCalledWith({
      activeServerDir,
      sessionId,
      progress: projectExternalSessionOperationProgressV1(successor),
      allowDifferentTerminalReplacement: true,
      expectedDifferentTerminalPresentation:
        projectExternalSessionOperationSharedPresentationV1(
          projectExternalSessionOperationProgressV1(predecessor),
        ),
    });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      successor.operationId,
    )).resolves.toMatchObject({
      progressProjection: {
        acknowledgedRevision: successor.revision,
      },
    });
  });

  it('passively repairs a newly admitted successor after a crash before its first publication', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-successor-first-publication-passive-repair-',
    ));
    roots.push(activeServerDir);
    const sessionId =
      'session-successor-first-publication-passive-repair';
    const predecessorInput = privateRecord({
      operationId: 'operation-passive-repair-predecessor',
      sessionId,
      status: 'completed',
    });
    await writeExternalSessionOperationRecord(
      activeServerDir,
      predecessorInput,
    );
    const predecessor =
      await acknowledgeExternalSessionOperationProgressProjection({
        activeServerDir,
        operationId: predecessorInput.operationId,
        projectedRevision: predecessorInput.revision,
      });
    const successor = privateRecord({
      operationId: 'operation-passive-repair-successor',
      sessionId,
      status: 'running',
      phase: 'validating',
    });
    await writeExternalSessionOperationRecord(activeServerDir, successor);
    let selectedPresentation =
      projectExternalSessionOperationSharedPresentationV1(
        projectExternalSessionOperationProgressV1(predecessor),
      );
    const publish = vi.fn(async (input: Readonly<{
      progress: ExternalSessionOperationProgressV1;
    }>) => {
      selectedPresentation =
        projectExternalSessionOperationSharedPresentationV1(input.progress);
    });

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({
          kind: 'valid',
          presentation: selectedPresentation,
        }),
        publish,
        nowMs: () => 44,
      },
    )).resolves.toBe(1);

    const repaired = await readExternalSessionOperationRecord(
      activeServerDir,
      successor.operationId,
    );
    expect(repaired).toMatchObject({
      revision: successor.revision + 1,
      status: 'awaiting_user_resume',
      phase: successor.phase,
      updatedAtMs: 44,
      progressProjection: {
        acknowledgedRevision: successor.revision + 1,
      },
    });
    expect(publish).toHaveBeenNthCalledWith(1, {
      activeServerDir,
      sessionId,
      progress: projectExternalSessionOperationProgressV1(successor),
      allowDifferentTerminalReplacement: true,
      expectedDifferentTerminalPresentation:
        projectExternalSessionOperationSharedPresentationV1(
          projectExternalSessionOperationProgressV1(predecessor),
        ),
    });
    expect(publish).toHaveBeenNthCalledWith(2, {
      activeServerDir,
      sessionId,
      progress: projectExternalSessionOperationProgressV1(
        ExternalSessionOperationRecordV1Schema.parse(repaired),
      ),
    });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      predecessor.operationId,
    )).resolves.toEqual(predecessor);
  });

  it('passively publishes an awaiting takeover successor left behind before its first publication', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-awaiting-successor-first-publication-repair-',
    ));
    roots.push(activeServerDir);
    const sessionId =
      'session-awaiting-successor-first-publication-repair';
    const predecessorInput = privateRecord({
      operationId: 'operation-awaiting-successor-predecessor',
      sessionId,
      status: 'completed',
      plan: 'takeover',
      targetStorageMode: 'external-linked',
      phase: 'finalizing',
    });
    await writeExternalSessionOperationRecord(
      activeServerDir,
      predecessorInput,
    );
    const predecessor =
      await acknowledgeExternalSessionOperationProgressProjection({
        activeServerDir,
        operationId: predecessorInput.operationId,
        projectedRevision: predecessorInput.revision,
      });
    const successor = privateRecord({
      operationId: 'operation-awaiting-successor',
      sessionId,
      status: 'awaiting_user_resume',
      plan: 'takeover',
      targetStorageMode: 'external-linked',
      phase: 'validating',
    });
    await writeExternalSessionOperationRecord(activeServerDir, successor);
    const predecessorPresentation =
      projectExternalSessionOperationSharedPresentationV1(
        projectExternalSessionOperationProgressV1(predecessor),
      );
    let selectedPresentation = predecessorPresentation;
    const publish = vi.fn(async (input: Readonly<{
      progress: ExternalSessionOperationProgressV1;
    }>) => {
      selectedPresentation =
        projectExternalSessionOperationSharedPresentationV1(input.progress);
    });

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({
          kind: 'valid',
          presentation: selectedPresentation,
        }),
        publish,
      },
    )).resolves.toBe(1);

    expect(publish).toHaveBeenCalledExactlyOnceWith({
      activeServerDir,
      sessionId,
      progress: projectExternalSessionOperationProgressV1(successor),
      allowDifferentTerminalReplacement: true,
      expectedDifferentTerminalPresentation: predecessorPresentation,
    });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      successor.operationId,
    )).resolves.toEqual({
      ...successor,
      progressProjection: {
        acknowledgedRevision: successor.revision,
      },
    });
  });

  it('retries successor repair after the predecessor replacement response is lost', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-successor-predecessor-lost-response-',
    ));
    roots.push(activeServerDir);
    const sessionId = 'session-successor-predecessor-lost-response';
    const predecessorInput = privateRecord({
      operationId: 'operation-successor-lost-response-predecessor',
      sessionId,
      status: 'completed',
      plan: 'takeover',
      targetStorageMode: 'external-linked',
      phase: 'finalizing',
    });
    await writeExternalSessionOperationRecord(
      activeServerDir,
      predecessorInput,
    );
    const predecessor =
      await acknowledgeExternalSessionOperationProgressProjection({
        activeServerDir,
        operationId: predecessorInput.operationId,
        projectedRevision: predecessorInput.revision,
      });
    const successor = privateRecord({
      operationId: 'operation-successor-lost-response',
      sessionId,
      status: 'running',
      phase: 'validating',
    });
    await writeExternalSessionOperationRecord(activeServerDir, successor);
    await expect(compactExternalSessionOperationRecordToCompletionReceipt({
      activeServerDir,
      operationId: predecessor.operationId,
      expectedRevision: predecessor.revision,
      stagingDisposition: 'not_applicable',
    })).resolves.toMatchObject({ status: 'compacted' });
    let selectedPresentation =
      projectExternalSessionOperationSharedPresentationV1(
        projectExternalSessionOperationProgressV1(predecessor),
      );
    let loseResponse = true;
    const publish = vi.fn(async (input: Readonly<{
      progress: ExternalSessionOperationProgressV1;
    }>) => {
      selectedPresentation =
        projectExternalSessionOperationSharedPresentationV1(input.progress);
      if (loseResponse) {
        loseResponse = false;
        throw new Error('projection response lost');
      }
    });
    const repair = (nowMs: number) =>
      repairExternalSessionOperationProgressProjections(
        activeServerDir,
        {
          readPresentation: async () => ({
            kind: 'valid',
            presentation: selectedPresentation,
          }),
          publish,
          nowMs: () => nowMs,
        },
      );

    await expect(repair(44)).resolves.toBe(0);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      successor.operationId,
    )).resolves.toEqual(successor);
    expect(selectedPresentation).toEqual(
      projectExternalSessionOperationSharedPresentationV1(
        projectExternalSessionOperationProgressV1(successor),
      ),
    );
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      predecessor.operationId,
    )).resolves.toMatchObject({ kind: 'completion_receipt' });

    await expect(repair(55)).resolves.toBe(1);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      successor.operationId,
    )).resolves.toMatchObject({
      revision: successor.revision + 1,
      status: 'awaiting_user_resume',
      updatedAtMs: 55,
      progressProjection: {
        acknowledgedRevision: successor.revision + 1,
      },
    });
    expect(publish).toHaveBeenCalledTimes(2);
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      predecessor.operationId,
    )).resolves.toBeNull();
  });

  it('recovers an acknowledged successor by pruning its expired unselected predecessor receipt', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-successor-ack-before-predecessor-delete-',
    ));
    roots.push(activeServerDir);
    const sessionId =
      'session-successor-ack-before-predecessor-delete';
    const predecessorInput = privateRecord({
      operationId: 'operation-ack-before-delete-predecessor',
      sessionId,
      status: 'completed',
      plan: 'takeover',
      targetStorageMode: 'external-linked',
      phase: 'finalizing',
    });
    await writeExternalSessionOperationRecord(
      activeServerDir,
      predecessorInput,
    );
    const predecessor =
      await acknowledgeExternalSessionOperationProgressProjection({
        activeServerDir,
        operationId: predecessorInput.operationId,
        projectedRevision: predecessorInput.revision,
      });
    const successorInput = privateRecord({
      operationId: 'operation-ack-before-delete-successor',
      sessionId,
      status: 'running',
      phase: 'validating',
    });
    await writeExternalSessionOperationRecord(activeServerDir, successorInput);
    await expect(compactExternalSessionOperationRecordToCompletionReceipt({
      activeServerDir,
      operationId: predecessor.operationId,
      expectedRevision: predecessor.revision,
      stagingDisposition: 'not_applicable',
    })).resolves.toMatchObject({ status: 'compacted' });
    const successor =
      await acknowledgeExternalSessionOperationProgressProjection({
        activeServerDir,
        operationId: successorInput.operationId,
        projectedRevision: successorInput.revision,
      });
    const successorPresentation =
      projectExternalSessionOperationSharedPresentationV1(
        projectExternalSessionOperationProgressV1(successor),
      );

    await expect(convergeExternalSessionOperationProgressProjection(
      activeServerDir,
      successor,
      {
        readPresentation: async () => ({
          kind: 'valid',
          presentation: successorPresentation,
        }),
      },
    )).resolves.toBe('already_acknowledged');
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      predecessor.operationId,
    )).resolves.toBeNull();
  });

  it('does not treat an unknown selected terminal as the admitted predecessor', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-unknown-predecessor-',
    ));
    roots.push(activeServerDir);
    const sessionId = 'session-unknown-predecessor';
    const successor = privateRecord({
      operationId: 'operation-unknown-predecessor-successor',
      sessionId,
      status: 'running',
      phase: 'validating',
    });
    await writeExternalSessionOperationRecord(activeServerDir, successor);
    const unknownTerminal = privateRecord({
      operationId: 'operation-unknown-predecessor-terminal',
      sessionId,
      status: 'completed',
    });
    const publish = vi.fn(async () => undefined);

    await expect(convergeExternalSessionOperationProgressProjection(
      activeServerDir,
      successor,
      {
        allowSettledTerminalPredecessorReplacement: true,
        readPresentation: async () => ({
          kind: 'valid',
          presentation:
            projectExternalSessionOperationSharedPresentationV1(
              projectExternalSessionOperationProgressV1(unknownTerminal),
            ),
        }),
        publish,
      },
    )).rejects.toThrow(
      'external_session_operation_repair_different_selected_operation',
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it('fails successor admission closed when more than one terminal projection is unsettled', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-terminal-admission-ambiguous-',
    ));
    roots.push(activeServerDir);
    const terminalA = privateRecord({
      operationId: 'operation-terminal-admission-a',
      sessionId: 'session-terminal-admission-ambiguous',
      status: 'completed',
    });
    const terminalB = privateRecord({
      operationId: 'operation-terminal-admission-b',
      sessionId: 'session-terminal-admission-ambiguous',
      status: 'completed',
    });
    const readPresentation = vi.fn(async () => ({
      kind: 'valid' as const,
      presentation:
        projectExternalSessionOperationSharedPresentationV1(
          projectExternalSessionOperationProgressV1(terminalB),
        ),
    }));
    const publish = vi.fn(async () => undefined);

    await expect(
      settlePriorTerminalExternalSessionOperationProgressProjections(
        activeServerDir,
        [terminalA, terminalB],
        { readPresentation, publish },
      ),
    ).rejects.toThrow(
      'external_session_operation_repair_ambiguous_selected_operation',
    );

    expect(readPresentation).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('fails closed for a different or ambiguous selected presentation', async () => {
    for (const remoteKind of ['different', 'ambiguous'] as const) {
      const activeServerDir = await mkdtemp(join(
        tmpdir(),
        `happier-operation-${remoteKind}-selected-`,
      ));
      roots.push(activeServerDir);
      const record = privateRecord({
        operationId: `operation-${remoteKind}-selected`,
        sessionId: `session-${remoteKind}-selected`,
        status: 'completed',
      });
      await writeExternalSessionOperationRecord(activeServerDir, record);
      const currentPresentation =
        projectExternalSessionOperationSharedPresentationV1(
          projectExternalSessionOperationProgressV1(record),
        );
      const publish = vi.fn(async () => undefined);

      await expect(convergeExternalSessionOperationProgressProjection(
        activeServerDir,
        record,
        {
          readPresentation: async () => ({
            kind: 'valid',
            presentation: remoteKind === 'different'
              ? {
                ...currentPresentation,
                operationId: 'operation-other-selected',
              }
              : {
                ...currentPresentation,
                phase: 'validating',
              },
          }),
          publish,
        },
      )).rejects.toThrow(
        remoteKind === 'different'
          ? 'external_session_operation_repair_different_selected_operation'
          : 'external_session_operation_repair_ambiguous_selected_operation',
      );
      expect(publish).not.toHaveBeenCalled();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        record.operationId,
      )).resolves.toEqual(record);
    }
  });

  it.each([
    ['materialize', 'external-linked'],
    ['takeover', 'external-linked'],
  ] as const)(
    'does not resurrect an acknowledged older %s terminal over a newer selected terminal',
    async (plan, targetStorageMode) => {
      const activeServerDir = await mkdtemp(join(
        tmpdir(),
        `happier-operation-${plan}-terminal-no-resurrection-`,
      ));
      roots.push(activeServerDir);
      const sessionId = `session-${plan}-terminal-no-resurrection`;
      const terminalAInput = privateRecord({
        operationId: `operation-${plan}-terminal-a`,
        sessionId,
        status: 'completed',
        plan,
        targetStorageMode,
        ...(plan === 'takeover' ? { phase: 'finalizing' as const } : {}),
      });
      const terminalBInput = privateRecord({
        operationId: `operation-${plan}-terminal-b`,
        sessionId,
        status: 'completed',
        plan,
        targetStorageMode,
        ...(plan === 'takeover' ? { phase: 'finalizing' as const } : {}),
      });
      await writeExternalSessionOperationRecord(
        activeServerDir,
        terminalAInput,
      );
      await writeExternalSessionOperationRecord(
        activeServerDir,
        terminalBInput,
      );
      const terminalA =
        await acknowledgeExternalSessionOperationProgressProjection({
          activeServerDir,
          operationId: terminalAInput.operationId,
          projectedRevision: terminalAInput.revision,
        });
      const terminalB =
        await acknowledgeExternalSessionOperationProgressProjection({
          activeServerDir,
          operationId: terminalBInput.operationId,
          projectedRevision: terminalBInput.revision,
        });
      const publish = vi.fn(async () => undefined);

      await expect(convergeExternalSessionOperationProgressProjection(
        activeServerDir,
        terminalA,
        {
          readPresentation: async () => ({
            kind: 'valid',
            presentation:
              projectExternalSessionOperationSharedPresentationV1(
                projectExternalSessionOperationProgressV1(terminalB),
              ),
          }),
          publish,
        },
      )).rejects.toThrow(
        'external_session_operation_repair_different_selected_operation',
      );
      expect(publish).not.toHaveBeenCalled();
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        terminalA.operationId,
      )).resolves.toEqual(terminalA);
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        terminalB.operationId,
      )).resolves.toEqual(terminalB);
    },
  );

  it.each([
    ['layout0', 'materialize'],
    ['layout1', 'materialize'],
    ['layout0', 'takeover'],
    ['layout1', 'takeover'],
  ] as const)(
    'keeps newer terminal B selected when identical %s %s Start retries acknowledged terminal A',
    async (layout, actionKind) => {
      const activeServerDir = await mkdtemp(join(
        tmpdir(),
        `happier-operation-${layout}-${actionKind}-start-no-resurrection-`,
      ));
      roots.push(activeServerDir);
      const sessionId =
        `session-${layout}-${actionKind}-start-no-resurrection`;
      const plan = actionKind === 'materialize'
        ? 'materialize'
        : 'takeover';
      const phase = actionKind === 'materialize'
        ? 'publishing'
        : 'finalizing';
      const terminalATemplate = privateRecord({
        operationId: `operation-${layout}-${actionKind}-terminal-a`,
        sessionId,
        status: 'completed',
        phase,
        plan,
        targetStorageMode: 'external-linked',
      });
      const terminalAInput =
        ExternalSessionOperationRecordV1Schema.parse({
          ...terminalATemplate,
          operationId:
            `external-${plan}:${layout}-${actionKind}-terminal-a`,
        });
      const terminalBTemplate = privateRecord({
        operationId: `operation-${layout}-${actionKind}-terminal-b`,
        sessionId,
        status: 'completed',
        phase,
        plan,
        targetStorageMode: 'external-linked',
      });
      const terminalBInput =
        ExternalSessionOperationRecordV1Schema.parse({
          ...terminalBTemplate,
          operationId:
            `external-${plan}:${layout}-${actionKind}-terminal-b`,
        });
      await writeExternalSessionOperationRecord(
        activeServerDir,
        terminalAInput,
      );
      await writeExternalSessionOperationRecord(
        activeServerDir,
        terminalBInput,
      );
      const terminalA =
        await acknowledgeExternalSessionOperationProgressProjection({
          activeServerDir,
          operationId: terminalAInput.operationId,
          projectedRevision: terminalAInput.revision,
        });
      const terminalB =
        await acknowledgeExternalSessionOperationProgressProjection({
          activeServerDir,
          operationId: terminalBInput.operationId,
          projectedRevision: terminalBInput.revision,
        });
      const progressB =
        projectExternalSessionOperationProgressV1(terminalB);
      const selectedMetadata = layout === 'layout0'
        ? selectExternalSessionOperationPresentationMetadata(
          {},
          progressB,
        )
        : selectExternalSessionOperationProgressMetadata({}, progressB);
      const presentationB =
        projectExternalSessionOperationSharedPresentationV1(progressB);
      const publish = vi.fn(async () => undefined);
      const convergeProgress = vi.fn(async (
        record: ExternalSessionOperationRecordV1,
      ) => {
        await convergeExternalSessionOperationProgressProjection(
          activeServerDir,
          record,
          {
            readPresentation: async () => ({
              kind: 'valid',
              presentation: presentationB,
            }),
            publish,
          },
        );
        throw new Error('convergence unexpectedly selected terminal A');
      });
      const acquire = vi.fn(async () => {
        throw new Error('idempotent Start must not reacquire exclusion');
      });
      const describe = vi.fn(async () => {
        throw new Error('idempotent Start must not reread its source');
      });
      const sendHistoricalCommand = vi.fn(async () => {
        throw new Error('idempotent Start must not issue server effects');
      });
      const publishProgress = vi.fn(async () => undefined);

      if (actionKind === 'materialize') {
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
          describeSource: describe,
          revalidateSource: async () => undefined,
          readNewestFirstPages: async function* () {
            throw new Error('idempotent Start must not read transcript');
          },
          readFinalCatchUpPages: async function* () {},
          sendHistoricalCommand,
          publishProgress,
          convergeProgress,
        });
        await expect(executor.start({
          request: terminalA.request,
        })).resolves.toMatchObject({
          ok: false,
          error: { code: 'internal_error' },
        });
      } else {
        if (terminalA.request.plan !== 'takeover') {
          throw new Error('expected takeover request');
        }
        const {
          sourceGeneration: _sourceGeneration,
          contributionGeneration: _contributionGeneration,
          ...source
        } = terminalA.request.source;
        const executor = createExternalSessionTakeoverStartActionExecutor({
          activeServerDir,
          operationExclusion: { acquire },
          describeSession: describe,
          sendHistoricalCommand,
          validateProgressSelection: async () => undefined,
          publishProgress,
          convergeProgress,
        });
        await expect(executor.start({
          request: {
            ...terminalA.request,
            source,
          },
        })).resolves.toMatchObject({
          ok: false,
          error: { code: 'internal_error' },
        });
      }

      expect(convergeProgress).toHaveBeenCalledOnce();
      expect(publish).not.toHaveBeenCalled();
      expect(publishProgress).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(describe).not.toHaveBeenCalled();
      expect(sendHistoricalCommand).not.toHaveBeenCalled();
      expect(selectedMetadata).toEqual(
        layout === 'layout0'
          ? selectExternalSessionOperationPresentationMetadata(
            {},
            progressB,
          )
          : selectExternalSessionOperationProgressMetadata({}, progressB),
      );
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        terminalA.operationId,
      )).resolves.toEqual(terminalA);
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        terminalB.operationId,
      )).resolves.toEqual(terminalB);
    },
  );

  it.each([
    'validating',
    'staging',
    'importing',
    'publishing',
  ] as const)(
    'passively reconstructs interrupted materialize %s as the same exact operation awaiting_user_resume',
    async (phase) => {
      const activeServerDir = await mkdtemp(join(
        tmpdir(),
        `happier-operation-${phase}-repair-`,
      ));
      roots.push(activeServerDir);
      const running = privateRecord({
        operationId: `operation-running-${phase}`,
        sessionId: `session-running-${phase}`,
        status: 'running',
        phase,
      });
      const terminal = privateRecord({
        operationId: `operation-terminal-${phase}`,
        sessionId: `session-terminal-${phase}`,
        status: 'completed',
      });
      await writeExternalSessionOperationRecord(activeServerDir, running);
      await writeExternalSessionOperationRecord(activeServerDir, terminal);
      await acknowledgeExternalSessionOperationProgressProjection({
        activeServerDir,
        operationId: terminal.operationId,
        projectedRevision: terminal.revision,
      });
      expect(selectExternalSessionOperationRecordsForPassiveRepair([
        {
          ...terminal,
          progressProjection: {
            acknowledgedRevision: terminal.revision,
          },
        },
        running,
      ])).toEqual([running]);

      const publish = vi.fn(async () => undefined);
      await expect(repairExternalSessionOperationProgressProjections(
        activeServerDir,
        {
          readPresentation: async () => ({ kind: 'absent' }),
          publish,
          nowMs: () => 44,
        },
      )).resolves.toBe(1);
      const repaired = await readExternalSessionOperationRecord(
        activeServerDir,
        running.operationId,
      );
      expect(repaired).toEqual({
        ...running,
        revision: running.revision + 1,
        status: 'awaiting_user_resume',
        retryTargetPhase: phase,
        updatedAtMs: 44,
        progressProjection: {
          acknowledgedRevision: running.revision + 1,
        },
      });
      if (!repaired) throw new Error('Expected repaired operation record.');
      expect(publish).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledWith({
        activeServerDir,
        sessionId: running.request.sessionId,
        progress: expect.objectContaining({
          operationId: running.operationId,
          revision: running.revision + 1,
          status: 'awaiting_user_resume',
          phase,
          retryTargetPhase: phase,
        }),
      });
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        terminal.operationId,
      )).resolves.toEqual({
        ...terminal,
        progressProjection: {
          acknowledgedRevision: terminal.revision,
        },
      });

      publish.mockClear();
      await expect(repairExternalSessionOperationProgressProjections(
        activeServerDir,
        {
          readPresentation: async () => ({
            kind: 'valid',
            presentation:
              projectExternalSessionOperationSharedPresentationV1(
                projectExternalSessionOperationProgressV1(repaired),
              ),
          }),
          publish,
          nowMs: () => 99,
        },
      )).resolves.toBe(1);
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        running.operationId,
      )).resolves.toEqual(repaired);
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it('skips a live exact operation claim on connectivity repair and repairs once after release', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-live-claim-repair-',
    ));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'daemon:live-operation',
    });
    const claimResult = await operationExclusion.acquire({
      kind: 'materialize',
      sessionId: 'session-live-operation',
      requestId: 'key-operation-live-operation',
      sourceIdentity: JSON.stringify({
        v: 1,
        agent: { pluginId: 'com.example.agent', localId: 'example' },
        source: { kind: 'jsonl', contractVersion: 1 },
      }),
      sourceGeneration: 'source-1',
    });
    if (claimResult.status !== 'acquired') {
      throw new Error('Expected the live operation claim to be acquired.');
    }
    const running = privateRecord({
      operationId: 'operation-live-operation',
      sessionId: 'session-live-operation',
      status: 'running',
      phase: 'staging',
      operationClaimId: claimResult.claim.record.claimId,
    });
    await writeExternalSessionOperationRecord(activeServerDir, running);
    const readPresentation = vi.fn(async () => ({ kind: 'absent' as const }));
    const publish = vi.fn(async () => undefined);
    const repair = () => repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        inspectOperationClaim:
          operationExclusion.inspectPassiveRepairClaim,
        withOperationClaimBarrier:
          operationExclusion.withPassiveRepairClaimBarrier,
        readPresentation,
        publish,
        nowMs: () => 44,
      },
    );

    await expect(repair()).resolves.toBe(0);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      running.operationId,
    )).resolves.toEqual(running);
    expect(readPresentation).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();

    await claimResult.claim.release();
    await expect(repair()).resolves.toBe(1);
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      running.operationId,
    )).resolves.toMatchObject({
      revision: running.revision + 1,
      status: 'awaiting_user_resume',
      progressProjection: {
        acknowledgedRevision: running.revision + 1,
      },
    });
    expect(readPresentation).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('does not repair after an exact semantic claim is acquired during the presentation read', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-claim-race-repair-',
    ));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'daemon:claim-race-repair',
    });
    const running = privateRecord({
      operationId: 'operation-claim-race-repair',
      sessionId: 'session-claim-race-repair',
      status: 'running',
      phase: 'staging',
    });
    await writeExternalSessionOperationRecord(activeServerDir, running);
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead!: () => void;
    const readBarrier = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readPresentation = vi.fn(async () => {
      signalReadStarted();
      await readBarrier;
      return { kind: 'absent' as const };
    });
    const publish = vi.fn(async () => undefined);
    const acknowledge = vi.fn(async () => running);
    const repair = repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        inspectOperationClaim:
          operationExclusion.inspectPassiveRepairClaim,
        withOperationClaimBarrier:
          operationExclusion.withPassiveRepairClaimBarrier,
        readPresentation,
        publish,
        acknowledge,
        nowMs: () => 44,
      },
    );
    await readStarted;
    const acquired = await operationExclusion.acquire({
      kind: 'materialize',
      sessionId: running.request.sessionId,
      requestId: running.request.idempotencyKey,
      sourceIdentity: JSON.stringify(
        running.request.source.qualifiedIdentity,
      ),
      sourceGeneration: running.request.source.sourceGeneration,
    });
    if (acquired.status !== 'acquired') {
      throw new Error('Expected the racing operation claim to be acquired.');
    }

    try {
      releaseRead();
      await expect(repair).resolves.toBe(0);
      await expect(readExternalSessionOperationRecord(
        activeServerDir,
        running.operationId,
      )).resolves.toEqual(running);
      expect(readPresentation).toHaveBeenCalledOnce();
      expect(publish).not.toHaveBeenCalled();
      expect(acknowledge).not.toHaveBeenCalled();
    } finally {
      await acquired.claim.release();
    }
  });

  it('keeps claim acquisition pending past the former lock deadline until passive repair publishes and acknowledges', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-claim-projection-barrier-',
    ));
    roots.push(activeServerDir);
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'daemon:claim-projection-barrier',
      claimMutationLockAcquisitionTimeoutMs:
        resolveExternalSessionOperationProjectionBarrierAcquisitionTimeoutMs(),
    });
    const running = privateRecord({
      operationId: 'operation-claim-projection-barrier',
      sessionId: 'session-claim-projection-barrier',
      status: 'running',
      phase: 'staging',
    });
    await writeExternalSessionOperationRecord(activeServerDir, running);
    const events: string[] = [];
    let signalPublishStarted!: () => void;
    const publishStarted = new Promise<void>((resolve) => {
      signalPublishStarted = resolve;
    });
    let releasePublish!: () => void;
    const publishBarrier = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const publish = vi.fn(async () => {
      events.push('publish_started');
      signalPublishStarted();
      await publishBarrier;
      events.push('publish_completed');
    });
    const acknowledge = vi.fn(async (input) => {
      const acknowledged =
        await acknowledgeExternalSessionOperationProgressProjection(input);
      events.push('acknowledged');
      return acknowledged;
    });
    const repair = repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        inspectOperationClaim:
          operationExclusion.inspectPassiveRepairClaim,
        withOperationClaimBarrier:
          operationExclusion.withPassiveRepairClaimBarrier,
        readPresentation: async () => ({ kind: 'absent' }),
        publish,
        acknowledge,
        nowMs: () => 44,
      },
    );
    await publishStarted;
    let acquisitionSettled = false;
    const acquisition = operationExclusion.acquire({
      kind: 'materialize',
      sessionId: running.request.sessionId,
      requestId: running.request.idempotencyKey,
      sourceIdentity: JSON.stringify(
        running.request.source.qualifiedIdentity,
      ),
      sourceGeneration: running.request.source.sourceGeneration,
    }).then(
      (result) => {
        acquisitionSettled = true;
        if (result.status === 'acquired') events.push('claim_acquired');
        return { status: 'resolved' as const, result };
      },
      (error: unknown) => {
        acquisitionSettled = true;
        return { status: 'rejected' as const, error };
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const remainedPendingPastFormerDeadline = !acquisitionSettled;

    releasePublish();
    await expect(repair).resolves.toBe(1);
    const acquisitionOutcome = await acquisition;
    try {
      expect(remainedPendingPastFormerDeadline).toBe(true);
      expect(acquisitionOutcome.status).toBe('resolved');
      if (
        acquisitionOutcome.status !== 'resolved'
        || acquisitionOutcome.result.status !== 'acquired'
      ) {
        throw new Error('Expected claim acquisition after repair release.');
      }
      expect(events).toEqual([
        'publish_started',
        'publish_completed',
        'acknowledged',
        'claim_acquired',
      ]);
    } finally {
      if (
        acquisitionOutcome.status === 'resolved'
        && acquisitionOutcome.result.status === 'acquired'
      ) {
        await acquisitionOutcome.result.claim.release();
      }
    }
  }, 15_000);

  it('continues an interrupted publishing phase only after exact-current explicit Resume', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-materialize-publishing-resume-',
    ));
    roots.push(activeServerDir);
    const base = privateRecord({
      operationId: 'operation-materialize-publishing',
      sessionId: 'session-materialize-publishing',
      status: 'running',
      phase: 'publishing',
    });
    const publishing = ExternalSessionOperationRecordV1Schema.parse({
      ...base,
      currentStorageState: 'server_partial',
      checkpoint: {
        ...base.checkpoint,
        stagedItemCount: 1,
        importedItemCount: 1,
        acceptedThroughServerSeq: 3,
        acknowledgedBatchId: 'batch-publishing',
      },
      bindings: {
        ...base.bindings,
        historicalImportJobId: 'job-publishing',
      },
      fence: {
        kind: 'initial_server_partial',
        acceptedThroughServerSeq: 3,
      },
    });
    await writeExternalSessionOperationRecord(activeServerDir, publishing);

    const sendHistoricalCommand = vi.fn(async (command: Readonly<{
      kind: string;
      claim: {
        sessionId: string;
        operationId: string;
        operationClaimId: string;
      };
    }>) => ({
      v: 1 as const,
      kind: 'finalized' as const,
      claim: command.claim,
      revision: publishing.revision + 1,
      acceptedThroughServerSeq: 3,
      publication: {
        materializationPublicationId: 'publication-publishing',
        materializedThroughSourceAt: 44,
        publishedThroughServerSeq: 3,
      },
    }));
    const describeSource = vi.fn(async () => {
      throw new Error('publishing recovery must not reread the Agent source');
    });
    const revalidateSource = vi.fn(async () => {
      throw new Error('publishing recovery must not revalidate a missing finalized capture');
    });
    const readNewestFirstPages = vi.fn(async function* () {
      throw new Error('publishing recovery must not recapture source pages');
    });
    const readFinalCatchUpPages = vi.fn(async function* () {
      throw new Error('publishing recovery must not run catch-up');
    });
    const executor = createExternalSessionMaterializeActionExecutor({
      activeServerDir,
      operationExclusion: createExternalSessionOperationExclusion({
        activeServerDir,
        ownerId: 'materialize-publishing-resume-owner',
      }),
      staging: createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
          perOperation: { maxItems: 20, maxBytes: 50_000 },
          aggregate: { maxItems: 40, maxBytes: 100_000 },
        },
      }),
      describeSource,
      revalidateSource,
      readNewestFirstPages,
      readFinalCatchUpPages,
      sendHistoricalCommand,
      publishProgress: async () => undefined,
    });

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({ kind: 'absent' }),
        publish: async () => undefined,
        nowMs: () => 44,
      },
    )).resolves.toBe(1);
    expect(sendHistoricalCommand).not.toHaveBeenCalled();
    expect(describeSource).not.toHaveBeenCalled();
    expect(revalidateSource).not.toHaveBeenCalled();
    expect(readNewestFirstPages).not.toHaveBeenCalled();
    expect(readFinalCatchUpPages).not.toHaveBeenCalled();

    const repaired = await readExternalSessionOperationRecord(
      activeServerDir,
      publishing.operationId,
    );
    if (!repaired) throw new Error('Expected repaired publishing operation.');
    await expect(executor.resume({
      sessionId: repaired.request.sessionId,
      operationId: repaired.operationId,
      revision: repaired.revision - 1,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'stale_revision' },
    });
    expect(sendHistoricalCommand).not.toHaveBeenCalled();

    await expect(executor.resume({
      sessionId: repaired.request.sessionId,
      operationId: repaired.operationId,
      revision: repaired.revision,
    })).resolves.toMatchObject({
      ok: true,
      progress: {
        operationId: repaired.operationId,
        revision: repaired.revision + 2,
        status: 'completed',
        phase: 'publishing',
      },
    });
    expect(sendHistoricalCommand).toHaveBeenCalledOnce();
    expect(sendHistoricalCommand).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'resume',
      expectedRevision: repaired.revision + 1,
    }));
    expect(describeSource).not.toHaveBeenCalled();
    expect(revalidateSource).not.toHaveBeenCalled();
    expect(readNewestFirstPages).not.toHaveBeenCalled();
    expect(readFinalCatchUpPages).not.toHaveBeenCalled();
  });

  it('does not coerce an interrupted cancellation request into resumable work', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-cancel-repair-',
    ));
    roots.push(activeServerDir);
    const cancelRequested = privateRecord({
      operationId: 'operation-cancel-requested',
      sessionId: 'session-cancel-requested',
      status: 'cancel_requested',
      phase: 'staging',
    });
    await writeExternalSessionOperationRecord(activeServerDir, cancelRequested);
    const publish = vi.fn(async () => undefined);

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({ kind: 'absent' }),
        publish,
      },
    )).resolves.toBe(1);

    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      cancelRequested.operationId,
    )).resolves.toEqual({
      ...cancelRequested,
      progressProjection: {
        acknowledgedRevision: cancelRequested.revision,
      },
    });
    expect(publish).toHaveBeenCalledWith({
      activeServerDir,
      sessionId: cancelRequested.request.sessionId,
      progress: expect.objectContaining({
        status: 'cancel_requested',
        revision: cancelRequested.revision,
      }),
    });
  });

  it('reconstructs validating phases through their existing Retry or Resume owners', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-progress-repair-',
    ));
    roots.push(activeServerDir);
    const validating = privateRecord({
      operationId: 'operation-takeover-validating',
      sessionId: 'session-takeover-validating',
      status: 'running',
      phase: 'validating',
      plan: 'takeover',
    });
    const materializeValidating = privateRecord({
      operationId: 'operation-materialize-validating',
      sessionId: 'session-materialize-validating',
      status: 'running',
      phase: 'validating',
    });
    await writeExternalSessionOperationRecord(activeServerDir, validating);
    await writeExternalSessionOperationRecord(
      activeServerDir,
      materializeValidating,
    );
    const publish = vi.fn(async () => undefined);

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({ kind: 'absent' }),
        publish,
      },
    )).resolves.toBe(2);

    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      validating.operationId,
    )).resolves.toMatchObject({
      revision: validating.revision + 1,
      status: 'awaiting_user_resume',
      phase: 'validating',
      retryTargetPhase: 'validating',
    });
    expect(publish).toHaveBeenCalledWith({
      activeServerDir,
      sessionId: validating.request.sessionId,
      progress: expect.objectContaining({
        revision: validating.revision + 1,
        status: 'awaiting_user_resume',
        phase: 'validating',
      }),
    });
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      materializeValidating.operationId,
    )).resolves.toMatchObject({
      revision: materializeValidating.revision + 1,
      status: 'awaiting_user_resume',
      phase: 'validating',
      retryTargetPhase: 'validating',
    });
  });

  it('keeps interrupted persisted quiescing monotonic while requiring validating Resume checks', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-quiescing-repair-',
    ));
    roots.push(activeServerDir);
    const quiescing = privateRecord({
      operationId: 'operation-takeover-quiescing',
      sessionId: 'session-takeover-quiescing',
      status: 'running',
      phase: 'quiescing',
      plan: 'takeover',
    });
    await writeExternalSessionOperationRecord(activeServerDir, quiescing);
    const publish = vi.fn(async () => undefined);

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({ kind: 'absent' }),
        publish,
      },
    )).resolves.toBe(1);

    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      quiescing.operationId,
    )).resolves.toMatchObject({
      revision: quiescing.revision + 1,
      status: 'awaiting_user_resume',
      phase: 'quiescing',
      retryTargetPhase: 'validating',
      checkpoint: quiescing.checkpoint,
      currentStorageState: quiescing.currentStorageState,
    });
    expect(publish).toHaveBeenCalledWith({
      activeServerDir,
      sessionId: quiescing.request.sessionId,
      progress: expect.objectContaining({
        revision: quiescing.revision + 1,
        status: 'awaiting_user_resume',
        phase: 'quiescing',
        retryTargetPhase: 'validating',
      }),
    });
  });

  it('passively repairs interrupted external-linked takeover without running admission or spawn', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-external-linked-takeover-repair-',
    ));
    roots.push(activeServerDir);
    const spawning = privateRecord({
      operationId: 'operation-external-linked-spawning',
      sessionId: 'session-external-linked-spawning',
      status: 'running',
      phase: 'spawning',
      plan: 'takeover',
      targetStorageMode: 'external-linked',
      targetRuntimeAttemptId: 'attempt-external-linked-spawning-1',
    });
    await writeExternalSessionOperationRecord(activeServerDir, spawning);
    const publish = vi.fn(async () => undefined);

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({ kind: 'absent' }),
        publish,
        nowMs: () => 44,
      },
    )).resolves.toBe(1);

    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      spawning.operationId,
    )).resolves.toMatchObject({
      revision: spawning.revision + 1,
      status: 'failed',
      phase: 'spawning',
      retryTargetPhase: 'spawning',
      currentStorageState: 'machine_only',
      error: {
        code: 'spawn_failed',
        retryable: true,
      },
      updatedAtMs: 44,
    });
    expect(publish).toHaveBeenCalledOnce();
  });

  it('passively repairs a snapshot-backed external-linked spawning attempt and retains its publication tuple', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-external-linked-snapshot-takeover-repair-',
    ));
    roots.push(activeServerDir);
    const publication = {
      materializationPublicationId: 'publication-external-linked-snapshot',
      materializedThroughSourceAt: 41,
      publishedThroughServerSeq: 7,
    };
    const spawning = ExternalSessionOperationRecordV1Schema.parse({
      ...privateRecord({
        operationId: 'operation-external-linked-snapshot-spawning',
        sessionId: 'session-external-linked-snapshot-spawning',
        status: 'running',
        phase: 'spawning',
        plan: 'takeover',
        targetStorageMode: 'external-linked',
        targetRuntimeAttemptId: 'attempt-external-linked-snapshot-1',
      }),
      priorStableStorage: { state: 'snapshot_complete', publication },
      currentStorageState: 'snapshot_complete',
      publication,
    });
    await writeExternalSessionOperationRecord(activeServerDir, spawning);
    const publish = vi.fn(async () => undefined);

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({ kind: 'absent' }),
        publish,
        nowMs: () => 44,
      },
    )).resolves.toBe(1);

    const repaired = await readExternalSessionOperationRecord(
      activeServerDir,
      spawning.operationId,
    );
    expect(repaired).toMatchObject({
      revision: spawning.revision + 1,
      status: 'failed',
      phase: 'spawning',
      retryTargetPhase: 'spawning',
      currentStorageState: 'snapshot_complete',
      publication,
      error: {
        code: 'spawn_failed',
        retryable: true,
      },
      updatedAtMs: 44,
    });
    expect(repaired?.canonicalOwnerEvidence.disagreement).toBeUndefined();
    expect(publish).toHaveBeenCalledOnce();
  });

  it('reconstructs a pre-authority persisted takeover admission as awaiting explicit Resume', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-admitting-repair-',
    ));
    roots.push(activeServerDir);
    const admitting = persistedTakeoverRuntimeRecord({ phase: 'admitting' });
    await writeExternalSessionOperationRecord(activeServerDir, admitting);
    const publish = vi.fn(async () => undefined);

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({ kind: 'absent' }),
        publish,
      },
    )).resolves.toBe(1);

    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      admitting.operationId,
    )).resolves.toMatchObject({
      revision: admitting.revision + 1,
      status: 'awaiting_user_resume',
      phase: 'admitting',
      retryTargetPhase: 'admitting',
      currentStorageState: 'snapshot_complete',
      publication: admitting.publication,
    });
  });

  it('reconstructs an admitted runtime lost before runtime_bound as hosted-offline Retry', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-spawning-repair-',
    ));
    roots.push(activeServerDir);
    const spawning = persistedTakeoverRuntimeRecord({ phase: 'spawning' });
    await writeExternalSessionOperationRecord(activeServerDir, spawning);
    const publish = vi.fn(async () => undefined);

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({ kind: 'absent' }),
        publish,
      },
    )).resolves.toBe(1);

    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      spawning.operationId,
    )).resolves.toMatchObject({
      revision: spawning.revision + 1,
      status: 'failed',
      phase: 'spawning',
      retryTargetPhase: 'spawning',
      currentStorageState: 'hosted',
      error: { code: 'spawn_failed', retryable: true },
    });
  });

  it('repairs a prepared admission locally without consulting authority or source owners', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-prepared-admission-repair-',
    ));
    roots.push(activeServerDir);
    const admitting = persistedTakeoverRuntimeRecord({
      phase: 'admitting',
      authorityPrepared: true,
    });
    await writeExternalSessionOperationRecord(activeServerDir, admitting);
    const reconcilePersistedTakeoverAdmission = vi.fn(async () => {
      throw new Error('passive boot must not consult canonical authority owners');
    });
    const publish = vi.fn(async () => undefined);
    const passiveDependencies = {
      readPresentation: async () => ({ kind: 'absent' as const }),
      publish,
      reconcilePersistedTakeoverAdmission,
    };

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      passiveDependencies,
    )).resolves.toBe(1);

    expect(reconcilePersistedTakeoverAdmission).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith({
      activeServerDir,
      sessionId: admitting.request.sessionId,
      progress: expect.objectContaining({
        revision: admitting.revision + 1,
        status: 'failed',
        phase: 'admitting',
        currentStorageState: 'snapshot_complete',
        error: expect.objectContaining({
          code: 'admission_failed',
          retryable: true,
        }),
      }),
    });
  });

  it('fails incomplete legacy admission evidence closed as reconciliation_required', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-takeover-legacy-admission-repair-',
    ));
    roots.push(activeServerDir);
    const base = persistedTakeoverRuntimeRecord({ phase: 'admitting' });
    const ambiguous = ExternalSessionOperationRecordV1Schema.parse({
      ...base,
      canonicalOwnerEvidence: {
        ...base.canonicalOwnerEvidence,
        transcriptAuthorityRevision: 3,
      },
    });
    await writeExternalSessionOperationRecord(activeServerDir, ambiguous);
    const publish = vi.fn(async () => undefined);

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({ kind: 'absent' }),
        publish,
      },
    )).resolves.toBe(1);

    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      ambiguous.operationId,
    )).resolves.toMatchObject({
      revision: ambiguous.revision + 1,
      status: 'reconciliation_required',
      phase: 'admitting',
      retryTargetPhase: 'admitting',
      currentStorageState: 'snapshot_complete',
      error: { code: 'reconciliation_required', retryable: true },
      canonicalOwnerEvidence: {
        disagreement: {
          // The record captured a transcript-authority revision and nothing
          // from runtime control, so that is the owner the evidence names.
          owner: 'transcript_authority',
          expectedRevision: 3,
          observedRevision: 0,
        },
      },
    });
  });

  it('fails passive repair closed when legacy private rows have two nonterminal owners', () => {
    expect(() => selectExternalSessionOperationRecordsForPassiveRepair([
      privateRecord({
        operationId: 'operation-a',
        sessionId: 'session-1',
        status: 'running',
      }),
      privateRecord({
        operationId: 'operation-b',
        sessionId: 'session-1',
        status: 'running',
      }),
    ])).toThrow('external_session_operation_repair_conflicting_private_records');
  });

  it('retries an unacknowledged boot projection without another semantic transition and stays byte-stable after acknowledgement', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-projection-retry-',
    ));
    roots.push(activeServerDir);
    const running = privateRecord({
      operationId: 'operation-projection-retry',
      sessionId: 'session-projection-retry',
      status: 'running',
      phase: 'staging',
    });
    await writeExternalSessionOperationRecord(activeServerDir, running);
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error('server unavailable'))
      .mockResolvedValue(undefined);

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({ kind: 'absent' }),
        publish,
        nowMs: () => 44,
      },
    )).resolves.toBe(0);

    const interrupted = await readExternalSessionOperationRecord(
      activeServerDir,
      running.operationId,
    );
    expect(interrupted).toMatchObject({
      revision: running.revision + 1,
      status: 'awaiting_user_resume',
      updatedAtMs: 44,
      progressProjection: { acknowledgedRevision: null },
    });

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({ kind: 'absent' }),
        publish,
        nowMs: () => 99,
      },
    )).resolves.toBe(1);
    const acknowledged = await readExternalSessionOperationRecord(
      activeServerDir,
      running.operationId,
    );
    expect(acknowledged).toMatchObject({
      revision: running.revision + 1,
      status: 'awaiting_user_resume',
      updatedAtMs: 44,
      progressProjection: {
        acknowledgedRevision: running.revision + 1,
      },
    });
    const recordPath = join(
      vitestOperationRecordsDirectory(activeServerDir),
      `${createHash('sha256')
        .update(running.operationId, 'utf8')
        .digest('hex')}.json`,
    );
    const acknowledgedBytes = await readFile(recordPath, 'utf8');
    if (!acknowledged) throw new Error('Expected acknowledged operation.');

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({
          kind: 'valid',
          presentation:
            projectExternalSessionOperationSharedPresentationV1(
              projectExternalSessionOperationProgressV1(acknowledged),
            ),
        }),
        publish,
        nowMs: () => 123,
      },
    )).resolves.toBe(1);

    expect(publish).toHaveBeenCalledTimes(2);
    await expect(readFile(recordPath, 'utf8')).resolves.toBe(
      acknowledgedBytes,
    );
  });

  it('leaves a malformed selected presentation unchanged and continues later independent repairs', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-projection-malformed-isolation-',
    ));
    roots.push(activeServerDir);
    const malformed = privateRecord({
      operationId: 'operation-malformed-presentation',
      sessionId: 'session-malformed-presentation',
      status: 'running',
      phase: 'staging',
    });
    const repairable = privateRecord({
      operationId: 'operation-after-malformed-presentation',
      sessionId: 'session-after-malformed-presentation',
      status: 'running',
      phase: 'staging',
    });
    await writeExternalSessionOperationRecord(activeServerDir, malformed);
    await writeExternalSessionOperationRecord(activeServerDir, repairable);
    const malformedPath = join(
      vitestOperationRecordsDirectory(activeServerDir),
      `${createHash('sha256')
        .update(malformed.operationId, 'utf8')
        .digest('hex')}.json`,
    );
    const malformedBytes = await readFile(malformedPath, 'utf8');
    const publish = vi.fn(async () => undefined);

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async (sessionId) =>
          sessionId === malformed.request.sessionId
            ? { kind: 'malformed' }
            : { kind: 'absent' },
        publish,
        nowMs: () => 44,
      },
    )).resolves.toBe(1);

    await expect(readFile(malformedPath, 'utf8')).resolves.toBe(
      malformedBytes,
    );
    await expect(readExternalSessionOperationRecord(
      activeServerDir,
      repairable.operationId,
    )).resolves.toMatchObject({
      revision: repairable.revision + 1,
      status: 'awaiting_user_resume',
      progressProjection: {
        acknowledgedRevision: repairable.revision + 1,
      },
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      activeServerDir,
      sessionId: repairable.request.sessionId,
      progress: expect.objectContaining({
        operationId: repairable.operationId,
        revision: repairable.revision + 1,
      }),
    });
    expect(repairDiagnosticMock).toHaveBeenCalledExactlyOnceWith(
      'external_session.operation_projection_repair_session',
      expect.any(Error),
    );
  });

  it('isolates conflicting private rows to their session and repairs a later session', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-repair-session-isolation-',
    ));
    roots.push(activeServerDir);
    const conflictingA = privateRecord({
      operationId: 'operation-conflicting-a',
      sessionId: 'session-conflicting',
      status: 'running',
    });
    const conflictingB = privateRecord({
      operationId: 'operation-conflicting-b',
      sessionId: 'session-conflicting',
      status: 'running',
    });
    const repairable = privateRecord({
      operationId: 'operation-after-conflict',
      sessionId: 'session-after-conflict',
      status: 'awaiting_user_resume',
    });
    await writeExternalSessionOperationRecord(activeServerDir, repairable);
    const publish = vi.fn(async () => undefined);

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        listRecords: async () => [
          conflictingA,
          conflictingB,
          repairable,
        ],
        readPresentation: async () => ({ kind: 'absent' }),
        publish,
        acknowledge: async (input) => ({
          ...repairable,
          progressProjection: {
            acknowledgedRevision: input.projectedRevision,
          },
        }),
      },
    )).resolves.toBe(1);

    expect(publish).toHaveBeenCalledExactlyOnceWith({
      activeServerDir,
      sessionId: repairable.request.sessionId,
      progress: projectExternalSessionOperationProgressV1(repairable),
    });
  });

  it('ignores multiple retained terminal rows without resurrecting a projection', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-retained-terminal-history-',
    ));
    roots.push(activeServerDir);
    const terminalAInput = privateRecord({
      operationId: 'operation-terminal-a',
      sessionId: 'session-terminal-history',
      status: 'completed',
    });
    const terminalA = {
      ...terminalAInput,
      progressProjection: {
        acknowledgedRevision: terminalAInput.revision,
      },
    };
    const terminalBInput = privateRecord({
      operationId: 'operation-terminal-b',
      sessionId: 'session-terminal-history',
      status: 'completed',
    });
    const terminalB = {
      ...terminalBInput,
      progressProjection: {
        acknowledgedRevision: terminalBInput.revision,
      },
    };
    const publish = vi.fn(async () => undefined);

    expect(selectExternalSessionOperationRecordsForPassiveRepair([
      terminalA,
      terminalB,
    ])).toEqual([]);
    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        listRecords: async () => [terminalA, terminalB],
        publish,
      },
    )).resolves.toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps an external-linked completion full when publication acknowledgement is lost, then compacts on exact replay', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-external-linked-lost-ack-',
    ));
    roots.push(activeServerDir);
    const completed = privateRecord({
      operationId: 'operation-external-linked-lost-ack',
      sessionId: 'session-external-linked-lost-ack',
      status: 'completed',
      phase: 'finalizing',
      plan: 'takeover',
      targetStorageMode: 'external-linked',
    });
    await writeExternalSessionOperationRecord(activeServerDir, completed);
    const presentation =
      projectExternalSessionOperationSharedPresentationV1(
        projectExternalSessionOperationProgressV1(completed),
      );
    let selectedPresentation:
      typeof presentation | null = null;
    const publish = vi.fn(async () => {
      selectedPresentation = presentation;
    });

    await expect(convergeExternalSessionOperationProgressProjection(
      activeServerDir,
      completed,
      {
        readPresentation: async () => selectedPresentation
          ? { kind: 'valid', presentation: selectedPresentation }
          : { kind: 'absent' },
        publish,
        acknowledge: async () => {
          throw new Error('projection_ack_response_lost');
        },
      },
    )).rejects.toThrow('projection_ack_response_lost');
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      completed.operationId,
    )).resolves.toEqual({ kind: 'full_record', record: completed });

    await expect(convergeExternalSessionOperationProgressProjection(
      activeServerDir,
      completed,
      {
        readPresentation: async () => ({
          kind: 'valid',
          presentation,
        }),
        publish,
      },
    )).resolves.toBe('acknowledged');
    expect(publish).toHaveBeenCalledOnce();
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      completed.operationId,
    )).resolves.toMatchObject({ kind: 'completion_receipt' });
  });

  it.each(['cancelled', 'discarded'] as const)(
    'compacts a settled %s external-linked takeover on the live acknowledgement path, not only at boot repair',
    async (status) => {
      const activeServerDir = await mkdtemp(join(
        tmpdir(),
        'happier-operation-external-linked-live-settled-',
      ));
      roots.push(activeServerDir);
      const settled = privateRecord({
        operationId: `operation-external-linked-live-settled-${status}`,
        sessionId: `session-external-linked-live-settled-${status}`,
        status,
        phase: 'finalizing',
        plan: 'takeover',
        targetStorageMode: 'external-linked',
      });
      await writeExternalSessionOperationRecord(activeServerDir, settled);
      const presentation =
        projectExternalSessionOperationSharedPresentationV1(
          projectExternalSessionOperationProgressV1(settled),
        );

      await expect(convergeExternalSessionOperationProgressProjection(
        activeServerDir,
        settled,
        {
          readPresentation: async () => ({ kind: 'valid', presentation }),
          publish: async () => {},
        },
      )).resolves.toBe('acknowledged');

      // A settled external-linked takeover owns no private staging, so the
      // acknowledgement that settles it is the last event that can touch the
      // full record. Holding the inventory slot until the next daemon boot
      // repair is the same leak in a slower shape.
      await expect(readExternalSessionOperationStoredEntry(
        activeServerDir,
        settled.operationId,
      )).resolves.toMatchObject({
        kind: 'completion_receipt',
        receipt: { presentation: { status } },
      });
    },
  );

  it('compacts an acknowledged external-linked completion on boot and keeps raw Start full-record-only', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-completed-response-loss-repair-',
    ));
    roots.push(activeServerDir);
    const completedInput = privateRecord({
      operationId: 'operation-completed-response-loss-repair',
      sessionId: 'session-completed-response-loss-repair',
      status: 'completed',
      phase: 'finalizing',
      plan: 'takeover',
      targetStorageMode: 'external-linked',
    });
    await writeExternalSessionOperationRecord(activeServerDir, completedInput);
    const completed =
      await acknowledgeExternalSessionOperationProgressProjection({
        activeServerDir,
        operationId: completedInput.operationId,
        projectedRevision: completedInput.revision,
      });

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {},
    )).resolves.toBe(0);
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
        presentation:
          projectExternalSessionOperationSharedPresentationV1(
            projectExternalSessionOperationProgressV1(completed),
          ),
      },
    });

    const {
      sourceGeneration: _sourceGeneration,
      contributionGeneration: _contributionGeneration,
      ...rawSource
    } = completed.request.source;
    const describeSession = vi.fn();
    const acquire = vi.fn();
    const sendHistoricalCommand = vi.fn();
    const validateProgressSelection = vi.fn();
    const publishProgress = vi.fn(async () => undefined);
    const executor = createExternalSessionTakeoverStartActionExecutor({
      activeServerDir,
      operationExclusion: { acquire },
      describeSession,
      sendHistoricalCommand,
      validateProgressSelection,
      publishProgress,
      nowMs: () => completed.updatedAtMs + 1,
    });

    await expect(executor.start({
      request: {
        ...completed.request,
        source: rawSource,
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_state' },
    });
    expect(describeSession).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(sendHistoricalCommand).not.toHaveBeenCalled();
    expect(validateProgressSelection).not.toHaveBeenCalled();
    expect(publishProgress).not.toHaveBeenCalled();
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      completed.operationId,
    )).resolves.toMatchObject({ kind: 'completion_receipt' });
  });

  it('prunes an expired selected predecessor before boot compacts its already-acknowledged completed successor', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-completed-successor-predecessor-repair-',
    ));
    roots.push(activeServerDir);
    const sessionId = 'session-completed-successor-predecessor-repair';
    const predecessorInput = privateRecord({
      operationId: 'operation-completed-successor-predecessor',
      sessionId,
      status: 'completed',
      phase: 'finalizing',
      plan: 'takeover',
      targetStorageMode: 'external-linked',
    });
    await writeExternalSessionOperationRecord(
      activeServerDir,
      predecessorInput,
    );
    const predecessor =
      await acknowledgeExternalSessionOperationProgressProjection({
        activeServerDir,
        operationId: predecessorInput.operationId,
        projectedRevision: predecessorInput.revision,
      });
    await expect(compactExternalSessionOperationRecordToCompletionReceipt({
      activeServerDir,
      operationId: predecessor.operationId,
      expectedRevision: predecessor.revision,
      stagingDisposition: 'not_applicable',
    })).resolves.toMatchObject({ status: 'compacted' });

    const successorInput = privateRecord({
      operationId: 'operation-completed-successor-after-ack-crash',
      sessionId,
      status: 'completed',
      phase: 'finalizing',
      plan: 'takeover',
      targetStorageMode: 'external-linked',
    });
    await writeExternalSessionOperationRecord(activeServerDir, successorInput);
    const successor =
      await acknowledgeExternalSessionOperationProgressProjection({
        activeServerDir,
        operationId: successorInput.operationId,
        projectedRevision: successorInput.revision,
      });
    const successorPresentation =
      projectExternalSessionOperationSharedPresentationV1(
        projectExternalSessionOperationProgressV1(successor),
      );
    const repair = () => repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({
          kind: 'valid',
          presentation: successorPresentation,
        }),
        nowMs: () => predecessor.updatedAtMs + 86_400_000,
      },
    );

    await expect(repair()).resolves.toBe(0);
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      predecessor.operationId,
    )).resolves.toBeNull();
    const compactedSuccessor = await readExternalSessionOperationStoredEntry(
      activeServerDir,
      successor.operationId,
    );
    expect(compactedSuccessor).toMatchObject({
      kind: 'completion_receipt',
      receipt: {
        reference: {
          sessionId,
          operationId: successor.operationId,
          revision: successor.revision,
        },
        presentation: successorPresentation,
      },
    });

    await expect(repair()).resolves.toBe(0);
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      predecessor.operationId,
    )).resolves.toBeNull();
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      successor.operationId,
    )).resolves.toEqual(compactedSuccessor);
  });

  it.each(['cleaned', 'missing'] as const)(
    'compacts an acknowledged materialize completion after terminal staging is %s and repeat repair is byte-stable',
    async (stagingDisposition) => {
      const activeServerDir = await mkdtemp(join(
        tmpdir(),
        `happier-operation-materialize-completion-${stagingDisposition}-`,
      ));
      roots.push(activeServerDir);
      const completed = privateRecord({
        operationId:
          `operation-materialize-completion-${stagingDisposition}`,
        sessionId: `session-materialize-completion-${stagingDisposition}`,
        status: 'completed',
        phase: 'publishing',
        plan: 'materialize',
        targetStorageMode: 'external-linked',
      });
      await writeExternalSessionOperationRecord(activeServerDir, completed);
      const cleanupTerminalStaging = vi.fn(async () => stagingDisposition);
      const presentation =
        projectExternalSessionOperationSharedPresentationV1(
          projectExternalSessionOperationProgressV1(completed),
        );

      await expect(repairExternalSessionOperationProgressProjections(
        activeServerDir,
        {
          readPresentation: async () => ({
            kind: 'valid',
            presentation,
          }),
          cleanupTerminalStaging,
        },
      )).resolves.toBe(1);
      const stored = await readExternalSessionOperationStoredEntry(
        activeServerDir,
        completed.operationId,
      );
      expect(stored).toMatchObject({
        kind: 'completion_receipt',
        receipt: {
          reference: {
            sessionId: completed.request.sessionId,
            operationId: completed.operationId,
            revision: completed.revision,
          },
          presentation,
        },
      });
      const recordBytes = await readFile(join(
        vitestOperationRecordsDirectory(activeServerDir),
        `${createHash('sha256')
          .update(completed.operationId, 'utf8')
          .digest('hex')}.json`,
      ), 'utf8');

      cleanupTerminalStaging.mockClear();
      await expect(repairExternalSessionOperationProgressProjections(
        activeServerDir,
        { cleanupTerminalStaging },
      )).resolves.toBe(0);
      expect(cleanupTerminalStaging).not.toHaveBeenCalled();
      await expect(readFile(join(
        vitestOperationRecordsDirectory(activeServerDir),
        `${createHash('sha256')
          .update(completed.operationId, 'utf8')
          .digest('hex')}.json`,
      ), 'utf8')).resolves.toBe(recordBytes);
    },
  );

  it('compacts an acknowledged cancelled materialize operation once boot repair clears its private staging', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-materialize-cancelled-cleanup-',
    ));
    roots.push(activeServerDir);
    const cancelledInput = privateRecord({
      operationId: 'operation-materialize-cancelled-cleanup',
      sessionId: 'session-materialize-cancelled-cleanup',
      status: 'cancelled',
      phase: 'staging',
      plan: 'materialize',
      targetStorageMode: 'external-linked',
    });
    await writeExternalSessionOperationRecord(activeServerDir, cancelledInput);
    const cancelled =
      await acknowledgeExternalSessionOperationProgressProjection({
        activeServerDir,
        operationId: cancelledInput.operationId,
        projectedRevision: cancelledInput.revision,
      });
    const cleanupTerminalStaging = vi.fn(async () => 'missing' as const);

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      { cleanupTerminalStaging },
    )).resolves.toBe(0);

    // A settled cancellation with no remaining explicit-Discard recovery must
    // release its inventory slot; otherwise ordinary Cancel cycles grow the
    // Account inventory to its ceiling and brick every later operation.
    expect(cleanupTerminalStaging).toHaveBeenCalledWith(cancelled.operationId);
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      cancelled.operationId,
    )).resolves.toMatchObject({
      kind: 'completion_receipt',
      receipt: {
        reference: {
          sessionId: cancelled.request.sessionId,
          operationId: cancelled.operationId,
          revision: cancelled.revision,
        },
        presentation: { status: 'cancelled' },
      },
    });
  });

  it.each(['cancelled', 'discarded'] as const)(
    'compacts an acknowledged settled %s external-linked takeover whose staging is structurally absent',
    async (status) => {
      const activeServerDir = await mkdtemp(join(
        tmpdir(),
        'happier-operation-external-linked-settled-compaction-',
      ));
      roots.push(activeServerDir);
      const settledInput = privateRecord({
        operationId: `operation-external-linked-settled-${status}`,
        sessionId: `session-external-linked-settled-${status}`,
        status,
        phase: 'finalizing',
        plan: 'takeover',
        targetStorageMode: 'external-linked',
      });
      await writeExternalSessionOperationRecord(activeServerDir, settledInput);
      const settled =
        await acknowledgeExternalSessionOperationProgressProjection({
          activeServerDir,
          operationId: settledInput.operationId,
          projectedRevision: settledInput.revision,
        });
      const cleanupTerminalStaging = vi.fn(async () => 'missing' as const);

      await expect(repairExternalSessionOperationProgressProjections(
        activeServerDir,
        { cleanupTerminalStaging },
      )).resolves.toBe(0);

      // An external-linked takeover owns no private staging in any settled
      // state, so it must release its inventory slot without a staging owner.
      expect(cleanupTerminalStaging).not.toHaveBeenCalled();
      await expect(readExternalSessionOperationStoredEntry(
        activeServerDir,
        settled.operationId,
      )).resolves.toMatchObject({
        kind: 'completion_receipt',
        receipt: { presentation: { status } },
      });
    },
  );

  it('keeps an acknowledged cancelled initial partial full during boot repair until server Discard discharges it', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-materialize-cancelled-initial-partial-repair-',
    ));
    roots.push(activeServerDir);
    const cancelledInput = ExternalSessionOperationRecordV1Schema.parse({
      ...privateRecord({
        operationId: 'operation-materialize-cancelled-initial-partial',
        sessionId: 'session-materialize-cancelled-initial-partial',
        status: 'cancelled',
        phase: 'importing',
        plan: 'materialize',
        targetStorageMode: 'external-linked',
      }),
      currentStorageState: 'server_partial',
      checkpoint: {
        sourcePagesRead: 1,
        stagedItemCount: 1,
        importedItemCount: 1,
        acceptedThroughServerSeq: 3,
        acknowledgedBatchId: 'initial-partial-batch',
        requiredItemFailures: {
          total: 0,
          record: 0,
          media: 0,
          conversion: 0,
          diagnosticsTruncated: false,
          diagnostics: [],
        },
      },
      bindings: {
        operationClaimId: 'initial-partial-claim',
        historicalImportJobId: 'initial-partial-job',
      },
      fence: { kind: 'initial_server_partial', acceptedThroughServerSeq: 3 },
    });
    await writeExternalSessionOperationRecord(activeServerDir, cancelledInput);
    const cancelled =
      await acknowledgeExternalSessionOperationProgressProjection({
        activeServerDir,
        operationId: cancelledInput.operationId,
        projectedRevision: cancelledInput.revision,
      });
    const cleanupTerminalStaging = vi.fn(async () => 'missing' as const);

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      { cleanupTerminalStaging },
    )).resolves.toBe(0);

    expect(cleanupTerminalStaging).not.toHaveBeenCalled();
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      cancelled.operationId,
    )).resolves.toEqual({ kind: 'full_record', record: cancelled });
  });

  it('keeps a completed materialize full while canonical staging cleanup is not ready', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-materialize-completion-not-ready-',
    ));
    roots.push(activeServerDir);
    const completedInput = privateRecord({
      operationId: 'operation-materialize-completion-not-ready',
      sessionId: 'session-materialize-completion-not-ready',
      status: 'completed',
      phase: 'publishing',
      plan: 'materialize',
      targetStorageMode: 'external-linked',
    });
    await writeExternalSessionOperationRecord(activeServerDir, completedInput);
    const completed =
      await acknowledgeExternalSessionOperationProgressProjection({
        activeServerDir,
        operationId: completedInput.operationId,
        projectedRevision: completedInput.revision,
      });

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      { cleanupTerminalStaging: async () => 'not_ready' },
    )).resolves.toBe(0);
    await expect(readExternalSessionOperationStoredEntry(
      activeServerDir,
      completed.operationId,
    )).resolves.toEqual({ kind: 'full_record', record: completed });
  });

  it('hands an exact external-linked admission attempt to explicit Retry instead of reopening or stranding it', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-external-linked-admission-ack-ambiguous-boot-',
    ));
    roots.push(activeServerDir);
    const ambiguous = privateRecord({
      operationId: 'operation-external-linked-admission-ack-ambiguous',
      sessionId: 'session-external-linked-admission-ack-ambiguous',
      status: 'running',
      phase: 'admitting',
      plan: 'takeover',
      targetStorageMode: 'external-linked',
      targetRuntimeAttemptId: 'attempt-a',
    });
    await writeExternalSessionOperationRecord(activeServerDir, ambiguous);
    const publish = vi.fn(async () => undefined);

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      {
        readPresentation: async () => ({ kind: 'absent' }),
        publish,
        nowMs: () => 44,
      },
    )).resolves.toBe(1);

    const repaired = await readExternalSessionOperationRecord(
      activeServerDir,
      ambiguous.operationId,
    );
    // The process-local admission waiter does not survive a restart. Leaving the
    // record `running` left Resume, Retry, Cancel and Dismiss all refusing it,
    // so the retained attempt settles into the existing retryable
    // reconciliation state and waits for an explicit user Retry.
    expect(repaired).toMatchObject({
      revision: ambiguous.revision + 1,
      status: 'reconciliation_required',
      phase: 'admitting',
      retryTargetPhase: 'admitting',
      updatedAtMs: 44,
      error: {
        code: 'reconciliation_required',
        retryable: true,
        occurredAtMs: 44,
      },
    });
    // Nothing is reopened and nothing is invented: the exact attempt, the
    // checkpoint, the fence, the storage state and the canonical-owner evidence
    // are byte-identical, so Retry replays the same admission idempotently and
    // the state stays unresumable and uncancellable. A fabricated disagreement
    // here would make the same status unretryable and strand it again.
    expect(repaired?.bindings).toEqual(ambiguous.bindings);
    expect(repaired?.checkpoint).toEqual(ambiguous.checkpoint);
    expect(repaired?.fence).toEqual(ambiguous.fence);
    expect(repaired?.currentStorageState).toBe(ambiguous.currentStorageState);
    expect(repaired?.canonicalOwnerEvidence).toEqual(
      ambiguous.canonicalOwnerEvidence,
    );
    expect(repaired?.cancellation).toBeUndefined();
    expect(publish).toHaveBeenCalledWith({
      activeServerDir,
      sessionId: ambiguous.request.sessionId,
      progress: expect.objectContaining({
        status: 'reconciliation_required',
        phase: 'admitting',
        retryTargetPhase: 'admitting',
        error: expect.objectContaining({
          code: 'reconciliation_required',
          retryable: true,
        }),
      }),
    });
  });

  it('passively repairs exactly the supported phase and storage matrix without source, admission, or spawn effects', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-operation-passive-phase-storage-matrix-',
    ));
    roots.push(activeServerDir);
    const passiveCases = [
      ...EXTERNAL_SESSION_OPERATION_TIMELINES_V1.materialize.map((phase) => ({
        plan: 'materialize' as const,
        targetStorageMode: 'external-linked' as const,
        phase,
        retryTargetPhase: phase,
        expectedRepair: 'awaiting_user_resume' as const,
      })),
      ...EXTERNAL_SESSION_OPERATION_TIMELINES_V1.takeover_external_linked.map(
        (phase) => ({
          plan: 'takeover' as const,
          targetStorageMode: 'external-linked' as const,
          phase,
          retryTargetPhase: phase,
          expectedRepair: phase === 'spawning'
            ? 'reconciliation_required' as const
            : 'awaiting_user_resume' as const,
        }),
      ),
      ...([
        'validating',
        'quiescing',
        'staging',
        'importing',
        'final_catch_up',
      ] as const).map((phase) => ({
        plan: 'takeover' as const,
        targetStorageMode: 'persisted' as const,
        phase,
        retryTargetPhase: phase === 'quiescing'
          ? 'validating' as const
          : phase,
        expectedRepair: 'awaiting_user_resume' as const,
      })),
    ];
    const passiveRecords = passiveCases.map((testCase, index) => privateRecord({
      operationId: `operation-passive-matrix-${index}`,
      sessionId: `session-passive-matrix-${index}`,
      status: 'running',
      phase: testCase.phase,
      plan: testCase.plan,
      targetStorageMode: testCase.targetStorageMode,
    }));
    const neighboringRecords = [
      {
        record: persistedTakeoverRuntimeRecord({
          phase: 'admitting',
          authorityPrepared: true,
        }),
        expectedStatus: 'failed',
        expectedErrorCode: 'admission_failed',
      },
      {
        record: persistedTakeoverRuntimeRecord({ phase: 'spawning' }),
        expectedStatus: 'failed',
        expectedErrorCode: 'spawn_failed',
      },
      {
        record: privateRecord({
          operationId: 'operation-passive-matrix-finalizing',
          sessionId: 'session-passive-matrix-finalizing',
          status: 'running',
          phase: 'finalizing',
          plan: 'takeover',
          targetStorageMode: 'persisted',
        }),
        expectedStatus: 'running',
        expectedErrorCode: undefined,
      },
    ] as const;
    for (const record of [
      ...passiveRecords,
      ...neighboringRecords.map(({ record }) => record),
    ]) {
      await writeExternalSessionOperationRecord(activeServerDir, record);
    }
    const describeSource = vi.fn(async () => {
      throw new Error('passive repair must not read the Agent source');
    });
    const reconcilePersistedTakeoverAdmission = vi.fn(async () => {
      throw new Error('passive repair must not run admission');
    });
    const spawnRuntime = vi.fn(async () => {
      throw new Error('passive repair must not spawn a runtime');
    });
    const publish = vi.fn(async () => undefined);
    const passiveDependencies = {
      readPresentation: async () => ({ kind: 'absent' as const }),
      publish,
      nowMs: () => 44,
      describeSource,
      reconcilePersistedTakeoverAdmission,
      spawnRuntime,
    };

    await expect(repairExternalSessionOperationProgressProjections(
      activeServerDir,
      passiveDependencies,
    )).resolves.toBe(passiveRecords.length + neighboringRecords.length);

    for (const [index, original] of passiveRecords.entries()) {
      const repaired = await readExternalSessionOperationRecord(
        activeServerDir,
        original.operationId,
      );
      const testCase = passiveCases[index];
      if (testCase.expectedRepair === 'reconciliation_required') {
        expect(repaired, JSON.stringify(testCase)).toEqual({
          ...original,
          revision: original.revision + 1,
          status: 'reconciliation_required',
          retryTargetPhase: testCase.retryTargetPhase,
          updatedAtMs: 44,
          error: {
            code: 'reconciliation_required',
            message:
              'Persisted takeover admission evidence is incomplete or ambiguous after restart.',
            retryable: true,
            occurredAtMs: 44,
          },
          canonicalOwnerEvidence: {
            ...original.canonicalOwnerEvidence,
            disagreement: {
              // No admission-owner revision was ever captured, so the only
              // real owner revision this record holds is its linked Session
              // revision; it is never relabelled as runtime-control evidence.
              owner: 'linked_session',
              expectedRevision: 1,
              observedRevision: 0,
            },
          },
          progressProjection: {
            acknowledgedRevision: original.revision + 1,
          },
        });
      } else {
        expect(repaired, JSON.stringify(testCase)).toEqual({
          ...original,
          revision: original.revision + 1,
          status: 'awaiting_user_resume',
          retryTargetPhase: testCase.retryTargetPhase,
          updatedAtMs: 44,
          progressProjection: {
            acknowledgedRevision: original.revision + 1,
          },
        });
      }
    }
    for (const testCase of neighboringRecords) {
      const repaired = await readExternalSessionOperationRecord(
        activeServerDir,
        testCase.record.operationId,
      );
      expect(repaired?.status).toBe(testCase.expectedStatus);
      expect(repaired?.status).not.toBe('awaiting_user_resume');
      expect(repaired?.error?.code).toBe(testCase.expectedErrorCode);
    }
    expect(describeSource).not.toHaveBeenCalled();
    expect(reconcilePersistedTakeoverAdmission).not.toHaveBeenCalled();
    expect(spawnRuntime).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(
      passiveRecords.length + neighboringRecords.length,
    );
  });
});
