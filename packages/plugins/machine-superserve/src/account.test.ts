import { describe, expect, it } from 'vitest';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { connectedAccountRuntime } from './account.js';

function boundary(status = 200) {
  const staged: string[] = [], calls: { url: string; headers?: Readonly<Record<string, string>> }[] = [];
  const context = { signal: new AbortController().signal, configuration: { values: {} },
    credentials: { get: async () => 'private-account-key' }, attemptCredentials: { set: async (_key: string, value: string) => { staged.push(value); } },
    services: { http: { request: async (request: { url: string; headers?: Readonly<Record<string, string>> }) => {
      calls.push(request); return { status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(status === 200 ? [] : { error: { message: 'private-vendor-detail' } })) };
    } } },
  };
  return { context, staged, calls };
}
describe('Superserve Account token authentication', () => {
  it('verifies a key by passive HTTP before saving and distinguishes rejected credentials from outages', async () => {
    const mode = connectedAccountRuntime.authentication!.modes.token!;
    if (mode.kind !== 'manual') throw new Error('Expected manual token');
    const b = boundary();
    expect(await mode.complete({ fields: { token: ' private-account-key ' } }, b.context as unknown as ConnectedAccountAuthenticationContext)).toMatchObject({ status: 'connected' });
    expect(b.staged).toEqual(['private-account-key']);
    expect(b.calls[0]).toMatchObject({ url: 'https://api.superserve.ai/sandboxes', headers: { 'x-api-key': 'private-account-key' } });
    for (const [httpStatus, status] of [[401, 'rejected'], [503, 'unavailable']] as const) {
      const failed = boundary(httpStatus);
      const result = await mode.complete({ fields: { token: 'private-account-key' } }, failed.context as unknown as ConnectedAccountAuthenticationContext);
      expect(result).toMatchObject({ status }); expect(failed.staged).toEqual([]); expect(JSON.stringify(result)).not.toContain('private-');
    }
    const bad = boundary();
    expect(await mode.complete({ fields: { token: 'bad\r\nkey' } }, bad.context as unknown as ConnectedAccountAuthenticationContext)).toMatchObject({ status: 'rejected' });
    expect(bad.calls).toHaveLength(0);
  });
  it('materializes only the Account API header and redacts credential-store failures', async () => {
    const b = boundary(), context = b.context as unknown as ConnectedAccountReadContext;
    expect(await connectedAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://api.superserve.ai', headerNames: ['x-api-key'] }, context)).toEqual({ kind: 'httpHeaders', headers: { 'x-api-key': 'private-account-key' } });
    await expect(connectedAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://sandbox.superserve.ai', headerNames: ['x-api-key'] }, context)).rejects.toMatchObject({ code: 'credential_unavailable' });
    b.context.credentials.get = async () => { throw new Error('private-store-detail'); };
    await expect(connectedAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://api.superserve.ai', headerNames: ['x-api-key'] }, context)).rejects.toMatchObject({ code: 'credential_unavailable', message: 'credential_unavailable' });
  });
});
