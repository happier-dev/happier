import { describe, expect, it } from 'vitest';

import {
  normalizeExecutionRunRpcPayload,
  type ExecutionRunServiceResult,
} from '@/session/services/executionRuns';

import { normalizeExecutionRunToolResult } from './executionRunToolResult';

describe('normalizeExecutionRunToolResult', () => {
  it('preserves typed feature blocker details for CLI action callers', () => {
    const serviceResult = normalizeExecutionRunRpcPayload({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Voice feature disabled',
      details: {
        featureId: 'voice.agent',
        blockedBy: 'dependency',
        blockerCode: 'dependency_disabled',
      },
    });

    expect(normalizeExecutionRunToolResult(serviceResult)).toEqual({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Voice feature disabled',
      details: {
        featureId: 'voice.agent',
        blockedBy: 'dependency',
        blockerCode: 'dependency_disabled',
      },
    });
  });

  it('keeps failures from older peers valid when details are absent', () => {
    expect(normalizeExecutionRunToolResult({
      ok: false,
      code: 'execution_run_not_allowed',
      message: 'Voice feature disabled',
    })).toEqual({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Voice feature disabled',
    });
  });

  it('revalidates details so a structurally typed caller cannot project extra fields', () => {
    const callerDetails = {
      featureId: 'voice.agent' as const,
      blockedBy: 'dependency' as const,
      blockerCode: 'dependency_disabled' as const,
      secret: 'must-not-cross-the-tool-boundary',
    };
    const typeRejectedCallerFailure: ExecutionRunServiceResult<unknown> = {
      ok: false,
      code: 'execution_run_not_allowed',
      message: 'Voice feature disabled',
      // @ts-expect-error Details are opaque and must originate from the canonical RPC normalizer.
      details: callerDetails,
    };
    void typeRejectedCallerFailure;
    // A JavaScript caller can still bypass TypeScript, so the runtime boundary must revalidate too.
    const callerForgedFailure = {
      ok: false,
      code: 'execution_run_not_allowed',
      message: 'Voice feature disabled',
      details: callerDetails,
    } as unknown as ExecutionRunServiceResult<unknown>;

    expect(normalizeExecutionRunToolResult(callerForgedFailure)).toEqual({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Voice feature disabled',
      details: {
        featureId: 'voice.agent',
        blockedBy: 'dependency',
        blockerCode: 'dependency_disabled',
      },
    });
  });
});
