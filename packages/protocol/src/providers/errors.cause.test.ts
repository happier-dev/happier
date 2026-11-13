import { describe, expect, it } from 'vitest';
import { createProviderErrorV1, providerErrorFromRpcFailure, ProviderErrorV1Schema } from './errors.js';
import { RpcError, RPC_ERROR_CODES } from '../rpc/errors.js';

describe('Provider launch failure cause retention', () => {
  it('retains the source cause when a launch boundary chooses its recovery code', () => {
    const error = Object.assign(new TypeError('PRIVATE_ADAPTER_PROSE'), { code: 'EACCES' });
    const result = createProviderErrorV1('provider_materialization_failed', { connectionId: 'pc_test' }, error);
    expect(result).toMatchObject({ code: 'provider_materialization_failed',
      failureCause: { errorCode: 'EACCES', errorClass: 'TypeError', phase: 'dispatch' } });
    expect(JSON.stringify(result)).not.toContain(error.message);
  });

  it.each([
    [RPC_ERROR_CODES.FORBIDDEN, 'provider_machine_grant_stale'],
    [RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE, 'provider_machine_unavailable'],
    ['ECONNREFUSED', 'machine_offline'],
    ['provider_catalog_conflict', 'provider_connection_changed'],
  ])('retains the original %s cause when selecting %s recovery', (code, expected) => {
    const caught = code.startsWith('RPC_') ? new RpcError('PRIVATE_UPSTREAM_CONTEXT', code)
      : Object.assign(new Error('PRIVATE_UPSTREAM_CONTEXT'), { code });
    const result = providerErrorFromRpcFailure(caught, { connectionId: 'pc_test' });
    expect(ProviderErrorV1Schema.parse(JSON.parse(JSON.stringify(result)))).toMatchObject({
      code: expected, failureCause: { errorCode: code, phase: 'dispatch' },
    });
    expect(JSON.stringify(result)).not.toContain(caught.message);
  });

  it('keeps an uncoded exception class instead of dropping its cause entirely', () => {
    const error = new TypeError('PRIVATE_MATERIALIZATION_CONTEXT');
    const result = providerErrorFromRpcFailure(error);
    expect(result).toMatchObject({ code: 'agent_error', failureCause: { errorClass: 'TypeError', errorCode: null } });
    expect(JSON.stringify(result)).not.toContain(error.message);
  });
});
