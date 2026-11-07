import { describe, expect, it } from 'vitest';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { connectedAccountRuntime, nativeFetch } from './account.js';

function boundary(status = 200) {
  const staged: string[] = [];
  const calls: { url: string; headers?: Readonly<Record<string, string>> }[] = [];
  const context = { signal: new AbortController().signal, configuration: { values: {} },
    credentials: { get: async () => 'private-token' }, attemptCredentials: { set: async (_key: string, value: string) => { staged.push(value); } },
    services: { http: { request: async (request: { url: string; headers?: Readonly<Record<string, string>> }) => {
      calls.push(request);
      return { status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify({ vms: [], totalCount: 0, runningCount: 0, startingCount: 0, pausedCount: 0, stoppedCount: 0 })) };
    } } },
  };
  return { context, staged, calls };
}
describe('Freestyle Account token authentication', () => {
  it('verifies before staging the token and distinguishes credentials from vendor outages', async () => {
    const b = boundary();
    const complete = connectedAccountRuntime.authentication!.modes.token!;
    if (complete.kind !== 'manual') throw new Error('Expected token authentication');
    expect(await complete.complete({ fields: { token: ' private-token ' } }, b.context as unknown as ConnectedAccountAuthenticationContext)).toMatchObject({ status: 'connected' });
    expect(b.staged).toEqual(['private-token']);
    expect(await connectedAccountRuntime.status(boundary(401).context as unknown as ConnectedAccountReadContext)).toMatchObject({ status: 'reconnectRequired' });
    expect(await connectedAccountRuntime.status(boundary(503).context as unknown as ConnectedAccountReadContext)).toMatchObject({ status: 'unavailable' });
    const bad = boundary();
    expect(await complete.complete({ fields: { token: 'bad\r\ntoken' } }, bad.context as unknown as ConnectedAccountAuthenticationContext)).toMatchObject({ status: 'rejected' });
    expect(bad.calls).toHaveLength(0);
    expect(bad.staged).toEqual([]);
  });
  it('injects a captured purpose at the HTTP boundary and materializes only declared vendor origins', async () => {
    const b = boundary();
    await nativeFetch(b.context)('https://api.freestyle.sh/v5/vms');
    expect(b.calls[0]).toMatchObject({ credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'cloud-api', origin: 'https://api.freestyle.sh', method: 'GET', headerNames: ['authorization'] } });
    expect(new Headers(b.calls[0]?.headers).has('authorization')).toBe(false);
    expect(await connectedAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://api.freestyle.sh', headerNames: ['authorization'] }, b.context as unknown as ConnectedAccountReadContext)).toEqual({ kind: 'httpHeaders', headers: { authorization: 'Bearer private-token' } });
    await expect(connectedAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://unrelated.example', headerNames: ['authorization'] }, b.context as unknown as ConnectedAccountReadContext)).rejects.toThrow();
  });
  it('redacts credential-store failures as the existing typed credential refusal', async () => {
    const b = boundary();
    b.context.credentials.get = async () => { throw new Error('private-store-detail'); };
    await expect(connectedAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://api.freestyle.sh', headerNames: ['authorization'] },
      b.context as unknown as ConnectedAccountReadContext)).rejects.toMatchObject({ code: 'credential_unavailable', message: 'credential_unavailable' });
    expect(b.calls).toHaveLength(0);
  });
});
