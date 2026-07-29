import {
  EXTERNAL_SESSION_OPERATION_TIMELINES_V1,
  ExternalSessionOperationRecordV1Schema,
  ExternalSessionOperationProgressV1Schema,
  projectExternalSessionOperationProgressV1,
  projectExternalSessionOperationSharedPresentationV1,
  type ExternalSessionOperationRecordV1,
} from '@happier-dev/protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  convergeExternalSessionOperationProgressProjection,
  repairExternalSessionOperationProgressProjections,
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
  externalSessionOperationIdForRequest,
  readExternalSessionOperationRecord,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';
import {
  createExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';
import {
  createExternalSessionOperationPrivateStagingStore,
} from '@/session/external/staging/operationPrivateStaging';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
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
  status: 'running' | 'awaiting_user_resume' | 'cancel_requested' | 'completed';
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
  const phase = input.phase ?? 'publishing';
  const plan = input.plan ?? 'materialize';
  const isExternalLinkedTakeover =
    plan === 'takeover'
    && input.targetStorageMode === 'external-linked';
  return ExternalSessionOperationRecordV1Schema.parse({
    v: 1,
    operationId: input.operationId,
    revision: isCompleted ? 2 : 0,
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
    updatedAtMs: isCompleted ? 2 : 1,
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
    bindings: { operationClaimId: `claim-${input.operationId}` },
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
  it('atomically clears a retained terminal before selecting a newly admitted operation', () => {
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

    expect(selectExternalSessionOperationProgressMetadata({
      externalSessionOperationV1: { v: 1, progress: terminal },
    }, next, {
      allowDifferentTerminalReplacement: true,
    })).toEqual({
      externalSessionOperationV1: { v: 1, progress: next },
      externalSessionOperationPresentationV1:
        projectExternalSessionOperationSharedPresentationV1(next),
    });
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
            externalSessionOperationIdForRequest(
              terminalATemplate.request,
            ),
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
            externalSessionOperationIdForRequest(
              terminalBTemplate.request,
            ),
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
      status: 'awaiting_user_resume',
      phase: 'spawning',
      retryTargetPhase: 'spawning',
      currentStorageState: 'machine_only',
      updatedAtMs: 44,
    });
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
          owner: 'runtime_control',
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

  it('ignores multiple retained terminal rows without resurrecting a projection', async () => {
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
      '/unused-active-server-dir',
      {
        listRecords: async () => [terminalA, terminalB],
        publish,
      },
    )).resolves.toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });
});
