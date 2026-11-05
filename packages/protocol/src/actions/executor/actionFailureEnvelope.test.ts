import { describe, expect, it } from 'vitest';
import { RpcError } from '../../rpc/errors.js';
import { readActionFailureEnvelope, readMachineActionRpcResult } from './actionFailureEnvelope.js';

describe('Machine RPC refusal admission before Action output validation', () => {
  it.each([
    [{ error: 'Whole-disk scan disabled', errorCode: 'storage_whole_disk_disabled' }, 'storage_whole_disk_disabled'],
    [{ error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' }, 'RPC_METHOD_NOT_FOUND'],
    // cli-v0.2.16 b8d1c449: RpcHandlerManager.handleRequest catch serializes
    // an ordinary Error as { error } without a code. Current daemons still can.
    [{ error: 'Unknown error' }, 'action_failed'],
    [{ error: 'Requester admission unavailable', errorCode: 'agent_isolation_unavailable', effectAttempted: false }, 'agent_isolation_unavailable'],
  ])('retains the serialized refusal %j', (reply, code) => {
    expect(() => readMachineActionRpcResult(reply)).toThrowError(expect.objectContaining({
      name: 'RpcError', message: reply.error, rpcErrorCode: code,
      ...('effectAttempted' in reply ? { effectAttempted: false } : {}),
    }));
    try { readMachineActionRpcResult(reply); } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      expect(error).toMatchObject({ rpcErrorCode: code });
      if ('effectAttempted' in reply) expect(error).toMatchObject({ effectAttempted: false });
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
