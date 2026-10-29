import { describe, expect, it } from 'vitest';
import { readUnexpectedActionErrorDiagnosticV1 } from './actionExecutionResult.js';

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
