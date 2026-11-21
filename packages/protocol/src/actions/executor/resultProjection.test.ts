import { describe, expect, it } from 'vitest';
import { z } from '../../zodRuntimePolicy.js';
import { CODE_INTELLIGENCE_ACTION_IDS } from '../codeIntelligenceActionIdsV1.js';
import { RpcError } from '../../rpc/errors.js';
import { createActionExecuteFailureError } from '../actionExecutionResult.js';
import { completeActionResult, completeSpawnActionResult, normalizeActionExecutorThrownError, settleActionOutput } from './resultProjection.js';

describe('Session spawn Action settlement', () => {
  it.each([undefined, false, true])('settles a typed spawn refusal as failure and retains producer effect evidence (%s)', effectAttempted => {
    const failureCause = { phase: 'dispatch.requester_authentication', errorClass: 'RpcError' as const,
      errorCode: 'admission_unavailable', httpStatus: null };
    const refusal = { type: 'error' as const, code: 'spawn_failed' as const, retryable: true,
      launchError: { kind: 'launch_error' as const, code: 'admission_unavailable', message: 'admission_unavailable' },
      ...(effectAttempted === undefined ? {} : { failureCause, effectAttempted }) };
    const settled = settleActionOutput('session.spawn_new', completeSpawnActionResult(refusal));
    expect(settled).toMatchObject({ ok: false, errorCode: 'spawn_failed',
      details: refusal });
    if (settled.ok) throw new Error('Spawn refusal was reported as successful execution');
    expect(settled.error).toContain('admission_unavailable');
    expect(settled.effectAttempted).toBe(effectAttempted);
    expect(settled.failureCause).toEqual(effectAttempted === undefined ? undefined : failureCause);
  });

  it('keeps an accepted pending spawn successful without declaring effects', () => {
    expect(completeSpawnActionResult({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' }))
      .toEqual({ ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' } });
  });
});

describe('Action thrown-error classification', () => {
  it.each([true, false, undefined])('retains the complete typed child behind a code wrapper (effect %s)', effectAttempted => {
    const child = { ok: false as const, errorCode: 'database_transaction_timeout', error: 'database_transaction_timeout',
      requestId: 'child-request', failureCause: { phase: 'home.database.transaction', errorClass: 'HttpStatusError' as const,
        errorCode: 'database_transaction_timeout', httpStatus: 503 },
      ...(effectAttempted === undefined ? {} : { effectAttempted }) };
    const wrapper = Object.assign(createActionExecuteFailureError({ ok: false, errorCode: child.errorCode, error: child.errorCode }), { cause: child });
    expect(normalizeActionExecutorThrownError(wrapper)).toMatchObject(child);
    expect(normalizeActionExecutorThrownError(wrapper).effectAttempted).toBe(effectAttempted);
    const authored = Object.assign(createActionExecuteFailureError({ ...child, requestId: 'outer-request' }), { cause: child });
    expect(normalizeActionExecutorThrownError(authored).requestId).toBe('outer-request');
  });
  it.each(['code', 'errorCode'])('does not promote an ordinary Error %s into a domain refusal', field => {
    const failure = normalizeActionExecutorThrownError(Object.assign(new Error('Transport failed'), {
      [field]: 'role_read_only',
    }));
    expect(failure).toMatchObject({ errorCode: 'action_failed', error: 'Transport failed',
      failureCause: { errorClass: 'Error', errorCode: 'role_read_only' } });
  });

  it('preserves the same domain code when a typed RPC refusal carries it', () => {
    expect(normalizeActionExecutorThrownError(new RpcError('Role cannot be changed', 'role_read_only')))
      .toMatchObject({ errorCode: 'role_read_only', error: 'Role cannot be changed',
        failureCause: { errorClass: 'RpcError', errorCode: 'role_read_only' } });
  });
});

describe('declared typed Action failures', () => {
  it('carries an actionable Setup retry through final Action settlement', () => {
    const failure = { ok: false as const, errorCode: 'native_effect_failed', error: 'native_effect_failed' };
    const setupRetry = {
      runId: '4d5dbe56-ada7-4fc8-afc6-f1f0a05b73d2',
      invocationId: 'c40618ca-7351-46ea-8928-4721c6d0c941',
    };
    expect(settleActionOutput('machines.setup.apply', { ...failure, setupRetry }))
      .toEqual({ ...failure, setupRetry });
  });

  it.each([
    ['sessions.spawn.capabilities.preview', { ok: false, reason: 'machine_unreachable' }, 'machine_unreachable'],
    ['session.capabilities.get', { ok: false, code: 'preview_timeout' }, 'preview_timeout'],
    ['session.capabilities.set', { ok: false, code: 'conflict' }, 'conflict'],
    ['code.restart', { status: 'error', errorCode: 'request_failed' }, 'request_failed'],
    ['code.rename.apply', { ok: false, code: 'invalid_request' }, 'invalid_request'],
  ] as const)('projects %s refusal once and retains its typed details', (actionId, refusal, errorCode) => {
    const settled = settleActionOutput(actionId, completeActionResult(refusal));
    expect(settled).toMatchObject({ ok: false, errorCode, details: refusal });
    expect(settled).not.toHaveProperty('effectAttempted');
    expect(settled).not.toHaveProperty('failureCause');
  });

  it.each(CODE_INTELLIGENCE_ACTION_IDS)('projects the declared error branch of %s', actionId => {
    const refusal = { status: 'error', errorCode: 'request_failed' };
    expect(settleActionOutput(actionId, completeActionResult(refusal)))
      .toMatchObject({ ok: false, errorCode: 'request_failed', details: refusal });
  });

  it.each(['execution.run.wait', 'code.restart'] as const)('does not apply the legacy fallback to undeclared or unmatched %s output', actionId => {
    // The effective public output schema is an existing settlement boundary port.
    // This negative observation is valid data even though it resembles a legacy refusal.
    const observation = { type: 'error', errorCode: 'spawn_failed' };
    const outputSchema = z.strictObject({ type: z.literal('error'), errorCode: z.literal('spawn_failed') });
    expect(settleActionOutput(actionId, { ok: true, result: observation }, undefined, outputSchema))
      .toEqual({ ok: true, result: observation });
    const negative = { ok: false, errorCode: 'probe_unavailable' };
    const negativeSchema = z.strictObject({ ok: z.literal(false), errorCode: z.literal('probe_unavailable') });
    expect(settleActionOutput(actionId, { ok: true, result: negative }, undefined, negativeSchema))
      .toEqual({ ok: true, result: negative });
  });

  it('retains undeclared negative data and unavailable/loading answers as successful data', () => {
    const negative = { ok: false, code: 'cancelled' };
    expect(settleActionOutput('execution.run.wait', completeActionResult(negative)))
      .toEqual({ ok: true, result: negative });
    for (const result of [{ status: 'loading' }, { status: 'unavailable', reason: 'server_missing' }]) {
      expect(settleActionOutput('code.restart', completeActionResult(result))).toEqual({ ok: true, result });
    }
  });
});
