import { describe, expect, it } from 'vitest';
import { RpcError } from '../../rpc/errors.js';
import { projectConfirmedActionHttpRefusal, readActionFailureEnvelope, readMachineActionRpcResult } from './actionFailureEnvelope.js';
import { normalizeActionExecutorThrownError } from './resultProjection.js';

describe('Machine RPC refusal admission before Action output validation', () => {
  it.each([
    [503, 'database_transaction_conflict_exhausted', false],
    [503, 'database_transaction_timeout', undefined],
    [503, 'database_connection_unavailable', undefined],
    [500, 'database_transaction_conflict_exhausted', undefined],
    [503, 'unrecognized_failure', undefined],
  ] as const)('preserves the exhausted transaction refusal without declaring arbitrary HTTP failures effect-free (%s %s)', (status, errorCode, effectAttempted) => {
    const result = projectConfirmedActionHttpRefusal({ ok: false, errorCode, error: errorCode }, status);
    expect('effectAttempted' in result ? result.effectAttempted : undefined).toBe(effectAttempted);
  });
  it('requires the Home rollback witness for a timeout and preserves existing effect evidence', () => {
    const failure = { ok: false, errorCode: 'database_transaction_timeout', error: 'database_transaction_timeout' };
    expect(projectConfirmedActionHttpRefusal(failure, 503, {
      error: failure.errorCode, statusCode: 503, transactionOutcome: 'rolled_back',
    })).toMatchObject({ effectAttempted: false, failureCause: { phase: 'home.database.transaction',
      errorClass: 'HttpStatusError', errorCode: failure.errorCode, httpStatus: 503 } });
    expect(projectConfirmedActionHttpRefusal({ ...failure, effectAttempted: true }, 503, {
      error: failure.errorCode, statusCode: 503, transactionOutcome: 'rolled_back',
    })).toMatchObject({ effectAttempted: true });
  });
  it('retains an Artifact wrapper code without treating connection loss as rollback', () => {
    const failure = { ok: false, errorCode: 'artifact_read_unavailable', error: 'artifact_read_unavailable',
      failureCause: { phase: 'artifacts.read', errorClass: 'HttpStatusError', errorCode: 'database_connection_unavailable', httpStatus: 503 } };
    expect(projectConfirmedActionHttpRefusal(failure, 503)).toMatchObject({
      errorCode: 'artifact_read_unavailable',
      failureCause: { ...failure.failureCause, phase: 'home.database.transaction' } });
    expect(projectConfirmedActionHttpRefusal(failure, 503)).not.toHaveProperty('effectAttempted');
    expect(projectConfirmedActionHttpRefusal({ ...failure, effectAttempted: true }, 503))
      .toMatchObject({ effectAttempted: true });
  });
  it('retains the request reference when classifying an Action refusal', () => {
    expect(readActionFailureEnvelope({ ok: false, errorCode: 'credential_scope_denied',
      error: 'Request refused', requestId: 'sync-refusal-403' })).toMatchObject({
      ok: false, errorCode: 'credential_scope_denied', requestId: 'sync-refusal-403',
    });
  });

  it.each([
    [{ error: 'Whole-disk scan disabled', errorCode: 'storage_whole_disk_disabled' }, 'storage_whole_disk_disabled'],
    [{ error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' }, 'RPC_METHOD_NOT_FOUND'],
    // cli-v0.2.16 b8d1c449: RpcHandlerManager.handleRequest catch serializes
    // an ordinary Error as { error } without a code. Current daemons still can.
    [{ error: 'Unknown error' }, 'action_failed'],
    [{ error: 'Requester admission unavailable', errorCode: 'agent_isolation_unavailable', effectAttempted: false }, 'agent_isolation_unavailable'],
    [{ error: 'Native effect failed', errorCode: 'native_failed', effectAttempted: true }, 'native_failed'],
  ])('retains the serialized refusal %j', (reply, code) => {
    expect(() => readMachineActionRpcResult(reply)).toThrowError(expect.objectContaining({
      name: 'RpcError', message: reply.error, rpcErrorCode: code,
      ...('effectAttempted' in reply ? { effectAttempted: reply.effectAttempted } : {}),
    }));
    try { readMachineActionRpcResult(reply); } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      expect(error).toMatchObject({ rpcErrorCode: code });
      if ('effectAttempted' in reply) {
        expect(error).toMatchObject({ effectAttempted: reply.effectAttempted });
        expect(normalizeActionExecutorThrownError(error)).toMatchObject({ effectAttempted: reply.effectAttempted });
      }
    }
  });

  it.each([
    { ok: true, error: 'display fact', errorCode: 'display_code' },
    { success: false, error: 'domain refusal', errorCode: 'domain_code' },
    { status: 'unavailable', error: 'domain fact' },
    { error: 'malformed', errorCode: 7 },
    { error: 'malformed', errorCode: '' },
    { error: 'malformed', errorCode: '   ' },
    { error: 7, errorCode: 'domain_code' },
    { error: 'unknown shape', errorCode: 'domain_code', result: {} },
    { error: 'malformed evidence', errorCode: 'domain_code', effectAttempted: 'false' },
    [{ error: 'not an envelope' }],
    null,
  ])('leaves explicit domain and malformed/unknown replies for strict output validation: %j', reply => {
    expect(readMachineActionRpcResult(reply)).toBe(reply);
  });

  it('retains explicit Action failures and the existing failure classifier semantics', () => {
    const failure = { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
      effectAttempted: false, details: { code: 'target_unavailable', reason: 'caller_depth_unavailable' } };
    expect(readMachineActionRpcResult(failure)).toBe(failure);
    expect(readActionFailureEnvelope(failure)).toEqual(failure);
    expect(readActionFailureEnvelope({ error: 'display fact', errorCode: 'display_code' })).toBeNull();
  });

  it('preserves the RPC manager paused-admission details', () => {
    const details = { field: 'encryptionMode' };
    expect(() => readMachineActionRpcResult({ error: 'RPC client temporarily unavailable',
      errorCode: 'RPC_CLIENT_NOT_AVAILABLE', details })).toThrowError(expect.objectContaining({
        rpcErrorCode: 'RPC_CLIENT_NOT_AVAILABLE', details,
      }));
  });

  it('retains only a valid exact Workflow retry reference on a Setup failure', () => {
    const failure = { ok: false, errorCode: 'native_effect_failed', error: 'native_effect_failed' };
    const setupRetry = {
      runId: '4d5dbe56-ada7-4fc8-afc6-f1f0a05b73d2',
      invocationId: 'c40618ca-7351-46ea-8928-4721c6d0c941',
    };
    expect(readActionFailureEnvelope({ ...failure, setupRetry })).toEqual({ ...failure, setupRetry });
    expect(readActionFailureEnvelope({ ...failure, setupRetry: { runId: setupRetry.runId } })).toEqual(failure);
  });

  it('retains the typed spawn refusal and remedy through Action classification', () => {
    const errorDetail = { kind: 'connected_service_ux_diagnostic', uxDiagnostic: {
      code: 'connected_service_credential_reconnect_required', failurePhase: 'materialization',
      source: 'spawn_resume', retryable: false, suggestedActions: ['reconnect_profile'],
    } };
    expect(readActionFailureEnvelope({ type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED',
      errorMessage: 'Validation refused', errorDetail })).toMatchObject({
      ok: false, errorCode: 'SPAWN_VALIDATION_FAILED', details: { errorDetail },
    });
  });
});
