import { describe, expect, it } from 'vitest';
import { normalizeActionExecutorThrownError } from './executor/resultProjection.js';
import { ActionOperationFailureV1Schema } from './operations/v1.js';
import { ActionFailureCauseV1Schema, projectActionFailureCauseV1, readUnexpectedActionErrorDiagnosticV1 } from './actionExecutionResult.js';
import * as actionResults from './actionExecutionResult.js';

describe('Action failure cause projection', () => {
  it('retains the captured Account retirement refusal without disclosing its error payload', () => {
    const error = Object.assign(new Error('PRIVATE_MESSAGE'), {
      code: 'action_account_scope_changed', details: { token: 'PRIVATE_TOKEN' },
    });
    const result = normalizeActionExecutorThrownError(error, 'usage.recap.private.deliver');
    expect(result).toMatchObject({ errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_MESSAGE|PRIVATE_TOKEN/);
  });
  it('reads only one immediate cause and never carries text or traverses a deeper wrap', () => {
    let reads = 0;
    const error = new TypeError('token=PRIVATE_TOKEN');
    Object.defineProperty(error, 'cause', { get() { reads++; return Object.assign(new Error('private'), {
      code: 'ECONNRESET', status: 503, cause: Object.assign(new Error('deeper'), { code: 'ENOSPC' }),
    }); } });
    expect(actionResults.projectActionFailureCauseV1(error, 'rpc.handler')).toEqual({
      phase: 'rpc.handler', errorClass: 'TypeError', errorCode: 'ECONNRESET', httpStatus: 503,
    });
    expect(reads).toBe(1);
  });
  it('keeps an outer code without reading the immediate cause', () => {
    const error = Object.assign(new Error('private'), { code: 'ENOSPC' });
    Object.defineProperty(error, 'cause', { get() { throw new Error('must not read'); } });
    expect(actionResults.projectActionFailureCauseV1(error, 'machines.setup.apply')).toMatchObject({ errorCode: 'ENOSPC' });
    expect(normalizeActionExecutorThrownError(error, 'machines.setup.apply')).toMatchObject({
      failureCause: { phase: 'machines.setup.apply', errorClass: 'Error', errorCode: 'ENOSPC', httpStatus: null },
    });
  });
  it('accepts its one-hop JSON-RPC code while retaining the outer exception class', () => {
    const error = new TypeError('request failed', { cause: Object.assign(new Error('native failure'), {
      name: 'JsonRpcApplicationError', code: -32603,
    }) });
    const cause = projectActionFailureCauseV1(error, 'rpc.handler');
    expect(cause).toEqual({ phase: 'rpc.handler', errorClass: 'TypeError', errorCode: '-32603', httpStatus: null });
    expect(ActionFailureCauseV1Schema.safeParse(cause).success).toBe(true);
  });
});

describe('code-only JSON-RPC failure diagnostics', () => {
  it.each(['database_transaction_conflict_exhausted', 'database_connection_unavailable', 'database_transaction_timeout'])('retains the known Home refusal %s without its body', code => {
    const result = readUnexpectedActionErrorDiagnosticV1({ code: 'ERR_BAD_RESPONSE',
      response: { status: 503, data: { error: code, message: 'PRIVATE_MESSAGE', token: 'PRIVATE_TOKEN' } } });
    expect(result).toMatchObject({ errorCode: code, httpStatus: 503 });
    expect(readUnexpectedActionErrorDiagnosticV1({ code }).errorCode).toBe(code);
    expect(readUnexpectedActionErrorDiagnosticV1({ response: {
      status: 503, data: { error: 'invalid_request', code, message: 'PRIVATE_MESSAGE' },
    } })).toMatchObject({ errorCode: code, httpStatus: 503 });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_MESSAGE|PRIVATE_TOKEN/);
    expect(readUnexpectedActionErrorDiagnosticV1({ response: { status: 503, data: { error: 'PRIVATE_TOKEN' } } }).errorCode).toBeNull();
  });
  it.each([-32700, -32600, -32601, -32602, -32603, -32000, -32099])('retains protocol code %s without native data', code => {
    const error = Object.assign(new Error('PRIVATE_MESSAGE'), {
      name: 'JsonRpcApplicationError', code, data: { token: 'PRIVATE_TOKEN' },
    });
    const result = readUnexpectedActionErrorDiagnosticV1(error);
    expect(result).toMatchObject({ errorClass: 'JsonRpcApplicationError', errorCode: String(code) });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_MESSAGE|PRIVATE_TOKEN/);
  });
  it.each([
    { name: 'JsonRpcApplicationError', code: 123456 },
    { name: 'JsonRpcApplicationError', code: 'PRIVATE_TOKEN' },
    { name: 'Error', code: -32600 },
  ])('rejects arbitrary numeric or private string codes (%j)', fields => {
    expect(readUnexpectedActionErrorDiagnosticV1(Object.assign(new Error('private'), fields)).errorCode).toBeNull();
  });
});

describe('managed controller failure causes', () => {
  it('retains a managed controller code and never its message or other fields', () => {
    const error = Object.assign(new Error('PRIVATE_MESSAGE'), { name: 'ManagedMachineControllerError',
      code: 'native_acquisition_unconfirmed', data: { token: 'PRIVATE_TOKEN' } });
    const result = readUnexpectedActionErrorDiagnosticV1(error);
    expect(result).toMatchObject({ errorClass: 'ManagedMachineControllerError', errorCode: 'native_acquisition_unconfirmed' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/);
    expect(projectActionFailureCauseV1(error, 'machines.managed.acquire')).toEqual({
      phase: 'machines.managed.acquire', errorClass: 'ManagedMachineControllerError',
      errorCode: 'native_acquisition_unconfirmed', httpStatus: null });
    expect(ActionFailureCauseV1Schema.safeParse(projectActionFailureCauseV1(error, 'machines.managed.acquire')).success).toBe(true);
    // The detached operation stores exactly this projection, so its readers see the code.
    const failure = normalizeActionExecutorThrownError(error, 'machines.managed.acquire');
    expect(ActionOperationFailureV1Schema.parse(failure)).toMatchObject({ errorCode: 'native_acquisition_unconfirmed',
      failureCause: { errorClass: 'ManagedMachineControllerError', errorCode: 'native_acquisition_unconfirmed' } });
  });
  it.each([
    { name: 'ManagedMachineControllerError', code: 'Has Spaces And PRIVATE_TOKEN' },
    { name: 'ManagedMachineControllerError', code: 'x'.repeat(201) },
    { name: 'Error', code: 'native_acquisition_unconfirmed' },
  ])('rejects prose-shaped or foreign-class codes (%j)', fields => {
    expect(readUnexpectedActionErrorDiagnosticV1(Object.assign(new Error('private'), fields)).errorCode).toBeNull();
  });
});
