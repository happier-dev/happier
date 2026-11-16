import type { MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

export class NativeError extends Error {
  constructor(readonly code: string, readonly status?: number, readonly nativeCause?: MachineProvisionerNativeCauseV1) { super(code); }
}

/** Management and guest transports retain the same native HTTP failure owner. */
export function createSuperserveHttp(request: typeof fetch, signal?: AbortSignal) {
  return async (url: string, method = 'GET', body?: unknown, headers?: Record<string, string>, bytes?: Uint8Array) => {
    signal?.throwIfAborted();
    const response = await request(url, { method, signal, redirect: 'error',
      headers: { 'content-type': bytes ? 'application/octet-stream' : 'application/json', ...headers },
      ...(bytes ? { body: new Uint8Array(bytes) } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new NativeError(response.status === 401 || response.status === 403
      ? 'credential_unavailable' : 'superserve_http_' + response.status, response.status);
    if (response.status === 204) return { status: response.status, value: null };
    try { return { status: response.status, value: await response.json() as unknown }; }
    catch { throw new NativeError('superserve_invalid_response'); }
  };
}
