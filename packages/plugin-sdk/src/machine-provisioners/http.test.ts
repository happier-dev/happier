import { describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '../http.js';
import { createMachineProvisionerFetch, createMachineProvisionerMaterializedFetch } from './http.js';

const origin = 'https://api.example.test';
function boundary() {
  const request = vi.fn(async (input: HttpRequest, _options?: { signal?: AbortSignal }) => ({
    status: 200, finalUrl: input.url, headers: {}, body: new Uint8Array([0, 255, 128]),
  }));
  const role = new AbortController();
  return { request, role, context: { signal: role.signal, services: { http: { request } } } };
}

describe('machine provisioner host HTTP bridge', () => {
  it('preserves Request bytes and binds the purpose without forwarding the native client sentinel', async () => {
    const b = boundary();
    const request = createMachineProvisionerFetch(b.context, { purpose: 'cloud-api', origins: [origin], headerName: 'authorization' });
    const bytes = new Uint8Array([9, 0, 255, 128, 9]).subarray(1, 4);
    const response = await request(new Request(origin + '/file', { method: 'POST', body: bytes, headers: { authorization: 'host-bound' } }));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(b.request.mock.calls[0]?.[0]).toMatchObject({ body: bytes, headers: {}, redirect: 'error',
      credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'cloud-api', origin, method: 'POST', headerNames: ['authorization'] } });
  });

  it('uses explicit authentication-attempt headers without adding a bound credential', async () => {
    const b = boundary();
    const request = createMachineProvisionerFetch(b.context, { purpose: 'cloud-api', origins: [origin], headerName: 'x-api-key',
      credential: { 'x-api-key': 'attempt-key' } });
    await request(origin);
    expect(b.request.mock.calls[0]?.[0].headers).toEqual({ 'x-api-key': 'attempt-key' });
    expect(b.request.mock.calls[0]?.[0].credentialBinding).toBeUndefined();
  });

  it('retains role cancellation while a separate request signal is active', async () => {
    const b = boundary();
    const request = createMachineProvisionerFetch(b.context, { purpose: 'cloud-api', origins: [origin], headerName: 'authorization' });
    b.request.mockImplementationOnce(async (input, options) => {
      b.role.abort(new Error('role-ended'));
      expect(options?.signal?.aborted).toBe(true);
      return { status: 200, finalUrl: input.url, headers: {}, body: new Uint8Array() };
    });
    await expect(request(origin, { signal: new AbortController().signal })).rejects.toThrow('role-ended');
  });

  it('refuses credential forwarding to another origin or a redirect response', async () => {
    const b = boundary();
    const request = createMachineProvisionerFetch(b.context, { purpose: 'cloud-api', origins: [origin], headerName: 'authorization' });
    await expect(request('https://other.example.test')).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(b.request).not.toHaveBeenCalled();
    b.request.mockResolvedValueOnce({ status: 302, finalUrl: origin + '/', headers: {}, body: new Uint8Array() });
    await expect(request(origin)).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('materializes once per role and keeps API credentials out of guest requests', async () => {
    const b = boundary();
    const materialize = vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { 'x-api-key': 'captured-api-key' } }));
    const request = createMachineProvisionerMaterializedFetch({ ...b.context, services: { ...b.context.services, connectedAccounts: { materialize } } }, {
      purpose: 'cloud-api', origin, headerName: 'x-api-key', methods: ['GET', 'POST'],
      isGuestUrl: url => url.origin === 'https://guest.example.test',
    });
    await request('https://guest.example.test/file', { headers: { 'x-api-key': 'client-sentinel', 'x-access-token': 'guest-key' } });
    expect(materialize).not.toHaveBeenCalled();
    expect(b.request.mock.calls[0]?.[0].headers).toEqual({ 'x-access-token': 'guest-key' });
    await Promise.all([request(origin + '/one'), request(origin + '/two')]);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(b.request.mock.calls.slice(1).map(([input]) => input.headers)).toEqual([
      { 'x-api-key': 'captured-api-key' }, { 'x-api-key': 'captured-api-key' },
    ]);
  });

  it('redacts materialization and transport failures without retrying', async () => {
    const b = boundary();
    const materialize = vi.fn(async () => { throw new Error('private-materialization-detail'); });
    const request = createMachineProvisionerMaterializedFetch({ ...b.context, services: { ...b.context.services, connectedAccounts: { materialize } } }, {
      purpose: 'cloud-api', origin, headerName: 'authorization', methods: ['GET'],
    });
    await expect(request(origin)).rejects.toMatchObject({ message: 'credential_unavailable', code: 'credential_unavailable' });
    await expect(request(origin)).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(b.request).not.toHaveBeenCalled();
    const guestRequest = createMachineProvisionerMaterializedFetch({ ...b.context, services: { ...b.context.services, connectedAccounts: { materialize } } }, {
      purpose: 'cloud-api', origin, headerName: 'authorization', methods: ['GET'], isGuestUrl: () => true,
    });
    b.request.mockRejectedValueOnce(new Error('private-transport-detail'));
    await expect(guestRequest('https://guest.example.test')).rejects.toMatchObject({ message: 'provider_unavailable', code: 'provider_unavailable' });
    expect(b.request).toHaveBeenCalledTimes(1);
  });
});
