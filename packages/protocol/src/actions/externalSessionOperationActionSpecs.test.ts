import { describe, expect, it } from 'vitest';

import { serializeActionSpec } from './actionCatalog.js';
import { getActionSpec } from './actionSpecs.js';

describe('external-session operation ActionSpecs', () => {
  it('admits reference-only materialize receipt replay without weakening status or control results', async () => {
    const operation = {
      sessionId: 'session-1',
      operationId: 'operation-1',
      revision: 4,
    } as const;
    const referenceOnlyResult = {
      ok: true as const,
      operation,
    };
    const materialize = getActionSpec('sessions.external.materialize.start');
    const materializeInput = {
      request: {
        v: 1 as const,
        idempotencyKey: 'materialize-1',
        sessionId: operation.sessionId,
        plan: 'materialize' as const,
        targetStorageMode: 'external-linked' as const,
        targetRuntimeMode: null,
      },
    };

    expect(materialize.outputSchema?.parse(referenceOnlyResult)).toEqual(
      referenceOnlyResult,
    );
    expect(materialize.surfaceBindings?.plugin?.projectOutput?.(
      referenceOnlyResult,
      {
        actionId: materialize.id,
        surface: 'plugin',
        caller: { kind: 'plugin', pluginId: 'fixture' },
        input: materializeInput,
      },
    )).toEqual(referenceOnlyResult);

    for (const actionId of [
      'sessions.external.operation.status.get',
      'sessions.external.operation.cancel',
      'sessions.external.operation.resume',
      'sessions.external.operation.retry',
      'sessions.external.operation.discard',
    ] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.outputSchema?.safeParse(referenceOnlyResult).success).toBe(false);
    }
  });

  it('advertises only public-safe operation references for every operation control', () => {
    const operationControlIds = [
      'sessions.external.operation.status.get',
      'sessions.external.operation.cancel',
      'sessions.external.operation.resume',
      'sessions.external.operation.retry',
      'sessions.external.operation.discard',
    ] as const;
    const expectedFields = [
      { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'operationId', title: 'Operation id', widget: 'text', required: true },
      { path: 'revision', title: 'Revision', widget: 'text', required: true },
    ] as const;
    const publicReference = {
      sessionId: 'session-1',
      operationId: 'operation-1',
      revision: 4,
    } as const;

    for (const actionId of operationControlIds) {
      const spec = getActionSpec(actionId);
      const fields = spec.inputHints?.fields;
      const advertisedFields = serializeActionSpec(spec).inputHints?.fields;

      expect(fields).toEqual(expectedFields);
      expect(advertisedFields).toEqual(expectedFields);
      expect(fields?.map((field) => field.path)).not.toContain('claim');
      expect(fields?.map((field) => field.path)).not.toContain('operationClaimId');
      expect(fields?.map((field) => field.path)).not.toContain('expectedRevision');
      expect(spec.inputSchema.parse(publicReference)).toEqual(publicReference);

      for (const privateField of ['claim', 'operationClaimId', 'expectedRevision'] as const) {
        expect(spec.inputSchema.safeParse({
          ...publicReference,
          [privateField]: 'private-authority',
        }).success).toBe(false);
      }
    }
  });

  it('projects complete owner progress and rejects private fields for every plugin operation action', async () => {
    const operationActionIds = [
      'sessions.external.materialize.start',
      'sessions.external.operation.status.get',
      'sessions.external.operation.cancel',
      'sessions.external.operation.resume',
      'sessions.external.operation.retry',
      'sessions.external.operation.discard',
    ] as const;
    const operationRef = {
      sessionId: 'session-1',
      operationId: 'operation-1',
      revision: 4,
    } as const;
    const publicResult = {
      ok: true as const,
      operation: operationRef,
      presentation: {
        v: 1 as const,
        operationId: operationRef.operationId,
        revision: operationRef.revision,
        kind: 'materialize' as const,
        status: 'running' as const,
        phase: 'validating' as const,
      },
    };
    const completeOwnerResponse = {
      ok: true as const,
      progress: {
        v: 1 as const,
        operationId: operationRef.operationId,
        revision: operationRef.revision,
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
    };
    const privateFieldCases: readonly Readonly<{
      label: string;
      value: unknown;
    }>[] = [
      {
        label: 'timeline',
        value: {
          ...publicResult,
          presentation: { ...publicResult.presentation, timeline: ['validating'] },
        },
      },
      {
        label: 'prior storage',
        value: {
          ...publicResult,
          presentation: {
            ...publicResult.presentation,
            priorStableStorage: { state: 'machine_only' },
          },
        },
      },
      {
        label: 'current storage',
        value: {
          ...publicResult,
          presentation: {
            ...publicResult.presentation,
            currentStorageState: 'machine_only',
          },
        },
      },
      {
        label: 'checkpoint',
        value: {
          ...publicResult,
          presentation: {
            ...publicResult.presentation,
            checkpoint: { sourcePagesRead: 1 },
          },
        },
      },
      {
        label: 'fence',
        value: {
          ...publicResult,
          presentation: { ...publicResult.presentation, fence: { kind: 'none' } },
        },
      },
      {
        label: 'publication',
        value: {
          ...publicResult,
          presentation: {
            ...publicResult.presentation,
            publication: { materializationPublicationId: 'publication-1' },
          },
        },
      },
      {
        label: 'retry state',
        value: {
          ...publicResult,
          presentation: {
            ...publicResult.presentation,
            retryTargetPhase: 'validating',
          },
        },
      },
      {
        label: 'complete progress',
        value: { ...publicResult, progress: completeOwnerResponse.progress },
      },
      {
        label: 'machine identity',
        value: {
          ...publicResult,
          operation: { ...publicResult.operation, machineId: 'machine-1' },
        },
      },
      {
        label: 'source authority',
        value: {
          ...publicResult,
          operation: { ...publicResult.operation, source: { sourceId: 'private-source' } },
        },
      },
      {
        label: 'generation identity',
        value: {
          ...publicResult,
          operation: { ...publicResult.operation, generation: 'generation-1' },
        },
      },
      {
        label: 'operation claim',
        value: { ...publicResult, operationClaim: { operationClaimId: 'claim-1' } },
      },
      {
        label: 'custody path',
        value: { ...publicResult, privateStagingPath: '/private/staging/session-1' },
      },
      {
        label: 'operation rows',
        value: { ...publicResult, operationRows: [completeOwnerResponse.progress] },
      },
    ];

    for (const actionId of operationActionIds) {
      const spec = getActionSpec(actionId);
      const projectOutput = spec.surfaceBindings?.plugin?.projectOutput;
      const input = actionId === 'sessions.external.materialize.start'
        ? {
            request: {
              v: 1 as const,
              idempotencyKey: 'materialize-1',
              sessionId: operationRef.sessionId,
              plan: 'materialize' as const,
              targetStorageMode: 'external-linked' as const,
              targetRuntimeMode: null,
            },
          }
        : operationRef;
      expect(projectOutput, actionId).toBeTypeOf('function');
      expect(
        await projectOutput?.(completeOwnerResponse, {
          actionId,
          surface: 'plugin',
          caller: { kind: 'plugin', pluginId: 'fixture' },
          input,
        }),
        actionId,
      ).toEqual(actionId === 'sessions.external.materialize.start'
        ? { ok: true, operation: operationRef }
        : publicResult);

      for (const privateFieldCase of privateFieldCases) {
        expect(
          spec.outputSchema?.safeParse(privateFieldCase.value).success,
          `${actionId}: ${privateFieldCase.label}`,
        ).toBe(false);
        expect(
          () => projectOutput?.(privateFieldCase.value, {
            actionId,
            surface: 'plugin',
            caller: { kind: 'plugin', pluginId: 'fixture' },
            input,
          }),
          `${actionId}: ${privateFieldCase.label}`,
        ).toThrow();
      }
    }
  });
});
