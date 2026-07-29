import {
  EXTERNAL_SESSION_OPERATION_TIMELINES_V1,
  ExternalSessionOperationProgressV1Schema,
  ExternalSessionOperationStateV1Schema,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  readExternalSessionOperationState,
  writeExternalSessionOperationState,
} from './externalSessionOperation.js';

function progress(input: Readonly<{
  operationId?: string;
  revision: number;
  status?: 'running' | 'awaiting_user_resume' | 'cancelled';
  updatedAtMs?: number;
  importedItemCount?: number;
}>): ReturnType<typeof ExternalSessionOperationProgressV1Schema.parse> {
  return ExternalSessionOperationProgressV1Schema.parse({
    v: 1,
    operationId: input.operationId ?? 'operation-1',
    revision: input.revision,
    request: {
      plan: 'materialize',
      targetStorageMode: 'external-linked',
      targetRuntimeMode: null,
    },
    status: input.status ?? 'running',
    phase: 'importing',
    timeline: EXTERNAL_SESSION_OPERATION_TIMELINES_V1.materialize,
    updatedAtMs: input.updatedAtMs ?? 1_700_000_000_000 + input.revision,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: 'machine_only',
    checkpoint: {
      sourcePagesRead: 1,
      stagedItemCount: 2,
      importedItemCount: input.importedItemCount ?? 1,
      requiredItemFailures: {
        total: 0,
        record: 0,
        media: 0,
        conversion: 0,
        diagnosticsTruncated: false,
      },
    },
    fence: { kind: 'none' },
    ...(input.status === 'awaiting_user_resume'
      ? { retryTargetPhase: 'importing' }
      : {}),
  });
}

describe('external-session operation session-state binding', () => {
  it('strictly reads the public-safe wrapper and rejects private claim material', () => {
    const value = { v: 1 as const, progress: progress({ revision: 4 }) };
    expect(readExternalSessionOperationState({
      externalSessionOperationV1: value,
    })).toEqual({
      value,
      updatedAt: value.progress.updatedAtMs,
    });

    expect(ExternalSessionOperationStateV1Schema.safeParse({
      ...value,
      operationClaimId: 'private-claim',
    }).success).toBe(false);
    expect(readExternalSessionOperationState({
      externalSessionOperationV1: {
        ...value,
        progress: {
          ...value.progress,
          operationClaimId: 'private-claim',
        },
      },
    })).toEqual({ value: null, updatedAt: null });
  });

  it('accepts only strictly increasing revisions for the same operation', () => {
    const revision4 = { v: 1 as const, progress: progress({ revision: 4 }) };
    const revision5 = { v: 1 as const, progress: progress({ revision: 5 }) };
    const metadata = { externalSessionOperationV1: revision4 };

    expect(writeExternalSessionOperationState(metadata, revision5))
      .toEqual({ externalSessionOperationV1: revision5 });
    expect(writeExternalSessionOperationState(metadata, {
      v: 1,
      progress: progress({ revision: 3 }),
    })).toBe(metadata);
  });

  it('fails closed on unequal same-revision progress', () => {
    const current = { v: 1 as const, progress: progress({ revision: 4 }) };
    expect(() => writeExternalSessionOperationState(
      { externalSessionOperationV1: current },
      {
        v: 1,
        progress: progress({ revision: 4, importedItemCount: 2 }),
      },
    )).toThrow('external_session_operation_projection_conflict');
  });

  it('does not resurrect an older revision over retained terminal progress', () => {
    const terminal = {
      v: 1 as const,
      progress: progress({ revision: 8, status: 'cancelled' }),
    };
    const metadata = { externalSessionOperationV1: terminal };

    expect(writeExternalSessionOperationState(metadata, {
      v: 1,
      progress: progress({ revision: 7, status: 'awaiting_user_resume' }),
    })).toBe(metadata);
  });

  it('requires an explicit clear before selecting a different admitted operation', () => {
    const terminal = {
      v: 1 as const,
      progress: progress({ revision: 8, status: 'cancelled' }),
    };
    const next = {
      v: 1 as const,
      progress: progress({
        operationId: 'operation-2',
        revision: 0,
        updatedAtMs: terminal.progress.updatedAtMs + 1,
      }),
    };

    expect(() => writeExternalSessionOperationState(
      { externalSessionOperationV1: terminal },
      next,
    )).toThrow('external_session_operation_projection_conflict');

    const cleared = writeExternalSessionOperationState(
      { externalSessionOperationV1: terminal },
      null,
    );
    expect(writeExternalSessionOperationState(cleared, next)).toEqual({
      externalSessionOperationV1: next,
    });
  });
});
