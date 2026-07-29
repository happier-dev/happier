import { describe, expect, it, vi } from 'vitest';
import {
  EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3,
  resolveExternalSessionOperationTimelineV1,
  type ExternalSessionOperationActionResponseV1,
  type ExternalSessionOperationRecordV1,
} from '@happier-dev/protocol';

import type { ExternalSessionMaterializeActionExecutor } from '@/session/actions/externalSessions/materializeAction';
import type {
  ExternalSessionExternalLinkedTakeoverPhaseRunner,
  ExternalSessionPersistedTakeoverPhaseRunner,
} from '@/session/actions/externalSessions/takeoverPhaseRunner';
import type { ExternalSessionTakeoverAdmissionActionExecutor } from '@/session/actions/externalSessions/takeoverAdmissionAction';

import {
  executeExternalSessionOperationContinuation,
  resolveExternalSessionOperationRequiredPublicationFenceVersion,
} from './rpcHandlers.externalSessions';

function takeoverRecord(): ExternalSessionOperationRecordV1 {
  const request = {
    v: 1 as const,
    idempotencyKey: 'takeover-request',
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
    targetStorageMode: 'persisted' as const,
    targetRuntimeMode: 'terminal' as const,
  };
  return {
    v: 1,
    operationId: 'operation-1',
    revision: 1,
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
    bindings: { operationClaimId: 'released-claim' },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: { linkedSessionRevision: 1 },
    fence: { kind: 'none' },
    retryTargetPhase: 'validating',
  };
}

function response(): ExternalSessionOperationActionResponseV1 {
  return {
    ok: false,
    error: { code: 'not_allowed', message: 'test response' },
  };
}

function externalLinkedTakeoverRecord(): ExternalSessionOperationRecordV1 {
  const persisted = takeoverRecord();
  const request = {
    ...persisted.request,
    targetStorageMode: 'external-linked' as const,
  };
  return {
    ...persisted,
    request,
    timeline: resolveExternalSessionOperationTimelineV1(request),
  };
}

function materializeExecutor() {
  const execute = vi.fn(async () => response());
  return {
    executor: {
      start: execute,
      status: execute,
      cancel: execute,
      resume: execute,
      retry: execute,
      discard: execute,
      resumePersistedTakeover: execute,
    } satisfies ExternalSessionMaterializeActionExecutor,
    execute,
  };
}

describe('persisted takeover operation continuation routing', () => {
  it('requires runtime-bound hosted-admission v3 again for takeover Resume/Retry after daemon rollback', () => {
    const takeover = takeoverRecord();
    expect(resolveExternalSessionOperationRequiredPublicationFenceVersion(
      'sessions.external.operation.resume',
      takeover,
    )).toBe(EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3);
    expect(resolveExternalSessionOperationRequiredPublicationFenceVersion(
      'sessions.external.operation.retry',
      takeover,
    )).toBe(EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3);
    expect(resolveExternalSessionOperationRequiredPublicationFenceVersion(
      'sessions.external.operation.status.get',
      takeover,
    )).toBeUndefined();
    expect(resolveExternalSessionOperationRequiredPublicationFenceVersion(
      'sessions.external.operation.resume',
      externalLinkedTakeoverRecord(),
    )).toBeUndefined();
  });

  it('routes external-linked Resume, Retry, and Cancel only to the durable external-linked runner', async () => {
    const materialize = materializeExecutor();
    const persistedResume = vi.fn(async () => response());
    const externalResume = vi.fn(async () => response());
    const externalRetry = vi.fn(async () => response());
    const externalCancel = vi.fn(async () => response());

    for (const actionId of [
      'sessions.external.operation.resume',
      'sessions.external.operation.retry',
      'sessions.external.operation.cancel',
    ] as const) {
      await executeExternalSessionOperationContinuation({
        actionId,
        raw: { operationId: 'operation-1' },
        record: externalLinkedTakeoverRecord(),
        materialize: materialize.executor,
        takeoverPhaseRunner: { resume: persistedResume },
        externalLinkedTakeoverPhaseRunner: {
          resume: externalResume,
          retry: externalRetry,
          cancel: externalCancel,
        } satisfies ExternalSessionExternalLinkedTakeoverPhaseRunner,
        takeoverAdmission: null,
      });
    }

    expect(externalResume).toHaveBeenCalledOnce();
    expect(externalRetry).toHaveBeenCalledOnce();
    expect(externalCancel).toHaveBeenCalledOnce();
    expect(persistedResume).not.toHaveBeenCalled();
    expect(materialize.execute).not.toHaveBeenCalled();
  });

  it('routes validating Resume to the phase runner and never to admission or materialization', async () => {
    const materialize = materializeExecutor();
    const phaseResume = vi.fn(async () => response());
    const admissionResume = vi.fn(async () => response());

    await executeExternalSessionOperationContinuation({
      actionId: 'sessions.external.operation.resume',
      raw: { operationId: 'operation-1' },
      record: takeoverRecord(),
      materialize: materialize.executor,
      takeoverPhaseRunner: {
        resume: phaseResume,
      } satisfies ExternalSessionPersistedTakeoverPhaseRunner,
      externalLinkedTakeoverPhaseRunner: null,
      takeoverAdmission: {
        resume: admissionResume,
        retry: admissionResume,
      } satisfies ExternalSessionTakeoverAdmissionActionExecutor,
    });

    expect(phaseResume).toHaveBeenCalledOnce();
    expect(admissionResume).not.toHaveBeenCalled();
    expect(materialize.execute).not.toHaveBeenCalled();
  });

  it('routes only the exact published admitting checkpoint to admission', async () => {
    const materialize = materializeExecutor();
    const phaseResume = vi.fn(async () => response());
    const admissionResume = vi.fn(async () => response());
    const validating = takeoverRecord();
    const admitting: ExternalSessionOperationRecordV1 = {
      ...validating,
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
        materializationPublicationId: 'publication-1',
        materializedThroughSourceAt: 10,
        publishedThroughServerSeq: 1,
      },
      retryTargetPhase: 'admitting',
      fence: { kind: 'none' },
    };

    await executeExternalSessionOperationContinuation({
      actionId: 'sessions.external.operation.resume',
      raw: { operationId: 'operation-1' },
      record: admitting,
      materialize: materialize.executor,
      takeoverPhaseRunner: { resume: phaseResume },
      externalLinkedTakeoverPhaseRunner: null,
      takeoverAdmission: { resume: admissionResume, retry: admissionResume },
    });

    expect(admissionResume).toHaveBeenCalledOnce();
    expect(phaseResume).not.toHaveBeenCalled();
    expect(materialize.execute).not.toHaveBeenCalled();
  });

  it('refuses pre-admission Retry without invoking any continuation owner', async () => {
    const materialize = materializeExecutor();
    const phaseResume = vi.fn(async () => response());
    const admissionResume = vi.fn(async () => response());

    await expect(executeExternalSessionOperationContinuation({
      actionId: 'sessions.external.operation.retry',
      raw: { operationId: 'operation-1' },
      record: takeoverRecord(),
      materialize: materialize.executor,
      takeoverPhaseRunner: { resume: phaseResume },
      externalLinkedTakeoverPhaseRunner: null,
      takeoverAdmission: { resume: admissionResume, retry: admissionResume },
    })).resolves.toMatchObject({
      ok: true,
      result: {
        ok: false,
        error: { code: 'not_allowed' },
      },
    });
    expect(phaseResume).not.toHaveBeenCalled();
    expect(admissionResume).not.toHaveBeenCalled();
    expect(materialize.execute).not.toHaveBeenCalled();
  });
});
