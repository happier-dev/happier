import type {
  OpenCodeRuntimeFetch,
  OpenCodeRuntimeFetchResponse,
} from './openCodeServerClient.js';

export type OpenCodeNativeFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OpenCodeServerTransport = Readonly<{
  baseUrl: string;
  request: OpenCodeRuntimeFetch;
  fetch: OpenCodeNativeFetch;
}>;

type OpenCodeServerTransportSnapshot = Readonly<{
  instanceId?: string;
  state: string;
  baseUrl?: string | null;
}>;

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/u, '');
}

function isWithinBaseUrl(target: URL, base: URL): boolean {
  if (target.origin !== base.origin) return false;
  const basePath = base.pathname.replace(/\/+$/u, '');
  if (!basePath) return true;
  return target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
}

function headersToRecord(headers: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function normalizeRequestBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (
    typeof body === 'string'
    || body instanceof ArrayBuffer
    || body instanceof Blob
    || body instanceof FormData
    || body instanceof URLSearchParams
    || body instanceof ReadableStream
  ) {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.byteLength);
    bytes.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    return bytes;
  }
  return JSON.stringify(body);
}

function composeSignals(
  ownerSignal: AbortSignal | undefined,
  requestSignal: AbortSignal | null | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const signals = [
    ownerSignal,
    requestSignal ?? undefined,
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? AbortSignal.timeout(Math.trunc(timeoutMs))
      : undefined,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

export function createOpenCodeServerTransport(params: Readonly<{
  baseUrl: string;
  instanceId: string;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  readManagedServerSnapshot: () => OpenCodeServerTransportSnapshot | null | undefined;
  fetchImpl?: OpenCodeNativeFetch;
}>): OpenCodeServerTransport {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const base = new URL(`${baseUrl}/`);
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;

  const assertCurrentIncarnation = (): void => {
    const snapshot = params.readManagedServerSnapshot();
    if (
      !snapshot
      || snapshot.instanceId !== params.instanceId
      || snapshot.state !== 'healthy'
    ) {
      throw new Error('OpenCode managed server incarnation is stale');
    }
    const currentBaseUrl = typeof snapshot.baseUrl === 'string'
      ? normalizeBaseUrl(snapshot.baseUrl)
      : null;
    if (currentBaseUrl !== baseUrl) {
      throw new Error('OpenCode managed server endpoint is stale');
    }
  };

  const fetchBound: OpenCodeNativeFetch = async (input, init = {}) => {
    const target = new URL(input.toString());
    if (!isWithinBaseUrl(target, base)) {
      throw new Error('OpenCode request is outside its supervised endpoint');
    }
    if (target.username || target.password || target.hash) {
      throw new Error('OpenCode request contains unsupported URL credentials or fragments');
    }
    assertCurrentIncarnation();
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(params.headers ?? {})) {
      headers.set(name, value);
    }
    const signal = composeSignals(params.signal, init.signal, undefined);
    return await fetchImpl(target.toString(), {
      ...init,
      headers,
      redirect: 'error',
      ...(signal ? { signal } : {}),
    });
  };

  const request: OpenCodeRuntimeFetch = async (input) => {
    const signal = composeSignals(params.signal, input.signal, input.timeoutMs);
    const body = normalizeRequestBody(input.body);
    const response = await fetchBound(input.url, {
      method: input.method,
      headers: input.headers,
      ...(body === undefined ? {} : { body }),
      ...(signal ? { signal } : {}),
    });
    const runtimeResponse: OpenCodeRuntimeFetchResponse = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: headersToRecord(response.headers),
      text: async () => await response.text(),
      json: async () => await response.json(),
      arrayBuffer: async () => await response.arrayBuffer(),
    };
    return runtimeResponse;
  };

  return Object.freeze({
    baseUrl,
    request,
    fetch: fetchBound,
  });
}
