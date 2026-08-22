import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  ExternalSessionOperationActionResponseV1,
  ExternalSessionOperationRecordV1,
  ExternalSessionOperationSemanticRequestV1,
} from '@happier-dev/protocol';
import {
  projectExternalSessionOperationProgressV1,
  resolveExternalSessionOperationTimelineV1,
} from '@happier-dev/protocol';

import type {
  ExternalSessionMaterializeActionExecutor,
} from './materializeAction';

import {
  createDefaultExternalSessionMaterializeStartActionExecutor,
  createExternalSessionMaterializeStartActionExecutor,
} from './materializeStartAction';
import {
  acknowledgeExternalSessionOperationProgressProjection,
  compactExternalSessionOperationRecordToCompletionReceipt,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';

const defaultDependencies = vi.hoisted(() => ({
  loadLinkedExternalSession: vi.fn(),
  readCredentials: vi.fn(),
  resolveCurrentAgent: vi.fn(),
  resolveGenerationBoundSurface: vi.fn(),
}));

vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
  loadLinkedExternalSession: defaultDependencies.loadLinkedExternalSession,
}));
vi.mock('@/api/session/external/linking/qualifiedLinkIdentityRegistry', () => ({
  resolveCurrentExternalSessionAgentIdentity:
    defaultDependencies.resolveCurrentAgent,
}));
vi.mock('@/persistence', () => ({
  readStoredCredentials: defaultDependencies.readCredentials,
}));
vi.mock('./providerOpsResolution', () => ({
  resolveGenerationBoundExternalSessionFollowSurface:
    defaultDependencies.resolveGenerationBoundSurface,
}));

const intent = {
  v: 1,
  idempotencyKey: 'materialize-1',
  sessionId: 'session-1',
  plan: 'materialize',
  targetStorageMode: 'external-linked',
  targetRuntimeMode: null,
} as const;

const semanticRequest = {
  ...intent,
  source: {
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
    linkGeneration: 'link-current',
    sourceGeneration: 'source-current',
    contributionGeneration: 'plugin-current',
  },
} satisfies ExternalSessionOperationSemanticRequestV1;

function activeTakeoverRecord(): ExternalSessionOperationRecordV1 {
  const request = {
    ...semanticRequest,
    idempotencyKey: 'takeover-1',
    plan: 'takeover' as const,
    targetStorageMode: 'persisted' as const,
    targetDirectory: '/local/selected/workspace',
    targetRuntimeMode: 'terminal' as const,
  };
  return {
    v: 1,
    operationId: 'external-takeover:active-takeover-fixture',
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
    bindings: { operationClaimId: 'takeover-claim-1' },
    progressProjection: { acknowledgedRevision: null },
    canonicalOwnerEvidence: {
      linkedSessionRevision: 1,
      sourceSnapshotEvidenceRef: 'takeover-source-cursor-1',
    },
    fence: { kind: 'none' },
    retryTargetPhase: 'validating',
  };
}

function materializeRecord(
  request: Extract<
    ExternalSessionOperationSemanticRequestV1,
    { plan: 'materialize' }
  > = semanticRequest,
): ExternalSessionOperationRecordV1 {
  return {
    ...activeTakeoverRecord(),
    operationId: 'external-materialize:materialize-record-fixture',
    request,
    timeline: resolveExternalSessionOperationTimelineV1(request),
  };
}

function configureDefaultLinkedSource(): void {
  const pageTranscript = vi.fn().mockResolvedValue({ tailCursor: 'tail-1' });
  defaultDependencies.readCredentials.mockResolvedValue({ token: 'credential' });
  defaultDependencies.loadLinkedExternalSession.mockResolvedValue({
    ok: true,
    session: {
      metadata: {
        externalSessionV1: {
          v: 1,
          agentId: 'example',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
          linkedAtMs: 1,
          qualifiedIdentity: {
            ...semanticRequest.source.qualifiedIdentity,
            source: { kind: 'claudeConfig', contractVersion: 1 },
          },
        },
      },
      agentId: 'example',
      machineId: 'machine-1',
      remoteSessionId: 'remote-1',
      linkGeneration: 'link-current',
      source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
    },
  });
  defaultDependencies.resolveCurrentAgent.mockResolvedValue({
    identity: semanticRequest.source.qualifiedIdentity.agent,
    sourceKinds: ['claudeConfig'],
  });
  defaultDependencies.resolveGenerationBoundSurface.mockResolvedValue({
    providerOps: { pageTranscript },
    resource: {
      pluginGeneration: 'plugin-current',
      retirementSignal: new AbortController().signal,
    },
  });
}

async function compactCompletedTakeoverReceipt(
  activeServerDir: string,
): Promise<void> {
  const active = activeTakeoverRecord();
  const {
    retryTargetPhase: _retryTargetPhase,
    ...resumable
  } = active;
  const completedRequest = {
    ...active.request,
    idempotencyKey: intent.idempotencyKey,
    targetStorageMode: 'external-linked' as const,
  };
  const completed = {
    ...resumable,
    revision: 6,
    request: completedRequest,
    status: 'completed',
    phase: 'finalizing',
    timeline: resolveExternalSessionOperationTimelineV1(completedRequest),
    updatedAtMs: Date.now(),
    progressProjection: { acknowledgedRevision: null },
    terminalResult: { kind: 'completed' },
  } satisfies ExternalSessionOperationRecordV1;
  await writeExternalSessionOperationRecord(activeServerDir, completed);
  await acknowledgeExternalSessionOperationProgressProjection({
    activeServerDir,
    operationId: completed.operationId,
    projectedRevision: completed.revision,
  });
  await expect(compactExternalSessionOperationRecordToCompletionReceipt({
    activeServerDir,
    operationId: completed.operationId,
    expectedRevision: completed.revision,
    stagingDisposition: 'not_applicable',
  })).resolves.toMatchObject({ status: 'compacted' });
}

describe('external-session materialize start intent', () => {
  it('stamps the plugin author intent onto the direct durable Start request', async () => {
    const startSemanticRequest = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'internal_error' as const, message: 'fixture' },
    }));
    const executor = createExternalSessionMaterializeStartActionExecutor({
      resolveAdmission: async () => ({
        kind: 'new_operation',
        operationId: 'external-materialize:test-plugin-start',
      }),
      describeSession: async (startIntent) => ({
        ...semanticRequest,
        idempotencyKey: startIntent.idempotencyKey,
      }),
      startSemanticRequest,
    });
    const authorIntent = {
      v: 1,
      surface: 'plugin',
      kind: 'materialize',
      sessionId: 'session-1',
      targetStorageMode: 'external-linked',
    } as const;
    const signal = new AbortController().signal;

    await executor.startPluginMaterialize({
      sessionId: 'session-1',
      durableIdempotencyKey: 'plugin-operation:v1:materialize:derived',
      authorIntent,
      signal,
    });

    expect(startSemanticRequest).toHaveBeenCalledWith(
      {
        request: {
          ...semanticRequest,
          idempotencyKey: 'plugin-operation:v1:materialize:derived',
        },
      },
      { signal, authorIntent, onAdmitted: expect.any(Function) },
    );
  });

  it('derives the private semantic request before invoking the materializer', async () => {
    const startSemanticRequest = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'internal_error' as const, message: 'fixture' },
    }));
    const describeSession = vi.fn(async () => semanticRequest);
    const executor = createExternalSessionMaterializeStartActionExecutor({
      resolveAdmission: async () => ({
        kind: 'new_operation',
        operationId: 'external-materialize:test-new',
      }),
      describeSession,
      startSemanticRequest,
    });

    const controller = new AbortController();
    await executor.start(
      { request: intent },
      { signal: controller.signal },
    );

    expect(describeSession).toHaveBeenCalledWith(intent);
    expect(startSemanticRequest).toHaveBeenCalledWith(
      { request: semanticRequest },
      { signal: controller.signal, onAdmitted: expect.any(Function) },
    );
  });

  it('fails closed without materialization effects when the linked source cannot be derived', async () => {
    const startSemanticRequest = vi.fn();
    const executor = createExternalSessionMaterializeStartActionExecutor({
      resolveAdmission: async () => ({
        kind: 'new_operation',
        operationId: 'external-materialize:test-unavailable',
      }),
      describeSession: async () => {
        throw new Error('external_session_materialize_start_source_unavailable');
      },
      startSemanticRequest,
    });

    await expect(executor.start({ request: intent })).resolves.toEqual({
      ok: false,
      error: {
        code: 'source_unavailable',
        message: 'Linked external session identity changed.',
      },
    });
    expect(startSemanticRequest).not.toHaveBeenCalled();
  });

  it('surfaces dual-row metadata disagreement as reconciliation required before materialization effects', async () => {
    const startSemanticRequest = vi.fn();
    const executor = createExternalSessionMaterializeStartActionExecutor({
      resolveAdmission: async () => ({
        kind: 'new_operation',
        operationId: 'external-materialize:test-reconciliation',
      }),
      describeSession: async () => {
        throw new Error('linked_session_reconciliation_required');
      },
      startSemanticRequest,
    });

    await expect(executor.start({ request: intent })).resolves.toEqual({
      ok: false,
      error: {
        code: 'reconciliation_required',
        message: 'Linked external session metadata requires reconciliation.',
      },
    });
    expect(startSemanticRequest).not.toHaveBeenCalled();
  });

  it('authorizes the source before reusing the durable semantic request for an idempotent retry', async () => {
    const startSemanticRequest = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'internal_error' as const, message: 'fixture' },
    }));
    const describeSession = vi.fn(async () => ({
      ...semanticRequest,
      source: {
        ...semanticRequest.source,
        sourceGeneration: 'source-advanced',
      },
    }));
    const executor = createExternalSessionMaterializeStartActionExecutor({
      resolveAdmission: async () => ({
        kind: 'existing_record',
        record: materializeRecord(),
      }),
      describeSession,
      startSemanticRequest,
    });

    await executor.start({ request: intent });

    expect(describeSession).toHaveBeenCalledWith(intent);
    expect(startSemanticRequest).toHaveBeenCalledWith(
      { request: semanticRequest },
      { onAdmitted: expect.any(Function) },
    );
  });

  it('rejects a reused idempotency key whose public materialization intent changed', async () => {
    const startSemanticRequest = vi.fn();
    const executor = createExternalSessionMaterializeStartActionExecutor({
      resolveAdmission: async () => ({
        kind: 'existing_record',
        record: materializeRecord(),
      }),
      describeSession: vi.fn(),
      startSemanticRequest,
    });

    await expect(executor.start({
      request: {
        ...intent,
        targetStorageMode: 'persisted',
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_state' },
    });
    expect(startSemanticRequest).not.toHaveBeenCalled();
  });

  it('authorizes the linked source before reporting a different active operation', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-materialize-start-admission-',
    ));
    const start = vi.fn();
    vi.clearAllMocks();
    configureDefaultLinkedSource();

    try {
      await writeExternalSessionOperationRecord(
        activeServerDir,
        activeTakeoverRecord(),
      );
      const executor = createDefaultExternalSessionMaterializeStartActionExecutor({
        activeServerDir,
        machineId: 'machine-1',
        materialize: { start } as never,
      });

      await expect(executor.start({ request: intent })).resolves.toMatchObject({
        ok: false,
        error: { code: 'operation_conflict' },
      });
      expect(defaultDependencies.readCredentials).toHaveBeenCalled();
      expect(defaultDependencies.loadLinkedExternalSession).toHaveBeenCalled();
      expect(defaultDependencies.resolveCurrentAgent).toHaveBeenCalled();
      expect(defaultDependencies.resolveGenerationBoundSurface).toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('authorizes the linked source before rejecting a cross-session receipt conflict', async () => {
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-materialize-start-receipt-conflict-',
    ));
    const start = vi.fn();
    vi.clearAllMocks();
    configureDefaultLinkedSource();

    try {
      await compactCompletedTakeoverReceipt(activeServerDir);
      const executor = createDefaultExternalSessionMaterializeStartActionExecutor({
        activeServerDir,
        machineId: 'machine-1',
        materialize: { start } as never,
      });

      await expect(executor.start({
        request: {
          ...intent,
          sessionId: 'session-2',
        },
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'operation_conflict' },
      });
      expect(defaultDependencies.readCredentials).toHaveBeenCalled();
      expect(defaultDependencies.loadLinkedExternalSession).toHaveBeenCalled();
      expect(defaultDependencies.resolveCurrentAgent).toHaveBeenCalled();
      expect(defaultDependencies.resolveGenerationBoundSurface).toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('rejects a replacement plugin before reading the source or starting effects', async () => {
    const pageTranscript = vi.fn();
    const start = vi.fn();
    defaultDependencies.readCredentials.mockResolvedValue({
      token: 'credential',
    });
    defaultDependencies.loadLinkedExternalSession.mockResolvedValue({
      ok: true,
      session: {
        metadata: {
          externalSessionV1: {
            v: 1,
            agentId: 'example',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
            linkedAtMs: 1,
            qualifiedIdentity: {
              ...semanticRequest.source.qualifiedIdentity,
              source: { kind: 'claudeConfig', contractVersion: 1 },
            },
          },
        },
        agentId: 'example',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        linkGeneration: 'link-current',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      },
    });
    defaultDependencies.resolveCurrentAgent.mockResolvedValue({
      identity: {
        pluginId: 'com.example.replacement',
        localId: 'example',
      },
      sourceKinds: ['claudeConfig'],
    });
    defaultDependencies.resolveGenerationBoundSurface.mockResolvedValue({
      providerOps: { pageTranscript },
      resource: {
        pluginGeneration: 'plugin-current',
        retirementSignal: new AbortController().signal,
      },
    });
    const executor = createDefaultExternalSessionMaterializeStartActionExecutor({
      activeServerDir: '/tmp/happier-materialize-start-replacement-plugin',
      machineId: 'machine-1',
      materialize: {
        start,
      } as never,
    });

    await expect(executor.start({ request: intent })).resolves.toEqual({
      ok: false,
      error: {
        code: 'source_unavailable',
        message: 'Linked external session identity changed.',
      },
    });
    expect(pageTranscript).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('returns the admitted durable operation without awaiting the historical import', async () => {
    const { retryTargetPhase: _retryTargetPhase, ...resumable } = materializeRecord();
    const admitted: ExternalSessionOperationRecordV1 = {
      ...resumable,
      status: 'running',
      phase: 'validating',
    };
    let releaseImport!: () => void;
    const importReleased = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    let importSettled = false;
    const startSemanticRequest: ExternalSessionMaterializeActionExecutor['start'] =
      async (_input, context) => {
        context?.onAdmitted?.(admitted);
        await importReleased;
        importSettled = true;
        return {
          ok: false,
          error: { code: 'internal_error', message: 'import outcome' },
        } satisfies ExternalSessionOperationActionResponseV1;
      };
    const executor = createExternalSessionMaterializeStartActionExecutor({
      resolveAdmission: async () => ({
        kind: 'new_operation',
        operationId: admitted.operationId,
      }),
      describeSession: async () => semanticRequest,
      startSemanticRequest,
    });

    const started = executor.start({ request: intent });
    try {
      const settledFirst = await Promise.race([
        started.then((response) => ({ kind: 'started' as const, response })),
        new Promise<{ kind: 'import_still_running' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'import_still_running' }), 0);
        }),
      ]);

      expect(settledFirst).toEqual({
        kind: 'started',
        response: {
          ok: true,
          progress: projectExternalSessionOperationProgressV1(admitted),
        },
      });
      expect(importSettled).toBe(false);
    } finally {
      releaseImport();
      await started.catch(() => undefined);
    }
  });
});
