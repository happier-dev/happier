import type {
  HttpMethod } from '@happier-dev/plugin-sdk/http';
import type {
  ManagedServiceHandle,
  ManagedServiceResponse,
} from '@happier-dev/plugin-sdk/managed-services';

import type {
  OpenCodeRuntimeFetch,
  OpenCodeRuntimeFetchResponse,
} from './openCodeServerClient.js';

export type OpenCodeNativeFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OpenCodeServerTransport = Readonly<{
  request: OpenCodeRuntimeFetch;
  fetch: OpenCodeNativeFetch;
}>;

function headersToRecord(headers: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function normalizeRequestBody(body: unknown): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    );
  }
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString());
  return new TextEncoder().encode(JSON.stringify(body));
}

function normalizeHttpMethod(method: string | undefined): HttpMethod | undefined {
  if (method === undefined) return undefined;
  const normalized = method.toUpperCase();
  switch (normalized) {
    case 'GET':
    case 'HEAD':
    case 'POST':
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
    case 'OPTIONS':
      return normalized;
    default:
      throw new Error(`Unsupported OpenCode HTTP method: ${method}`);
  }
}

function composeSignals(
  ownerSignal: AbortSignal | undefined,
  requestSignal: AbortSignal | null | undefined,
): AbortSignal | undefined {
  const signals = [ownerSignal, requestSignal ?? undefined]
    .filter((signal): signal is AbortSignal => signal !== undefined);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function toNativeResponse(response: ManagedServiceResponse): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createOpenCodeServerTransport(params: Readonly<{
  managedService: ManagedServiceHandle;
  signal?: AbortSignal;
}>): OpenCodeServerTransport {
  const fetchBound: OpenCodeNativeFetch = async (input, init = {}) => {
    const body = await normalizeRequestBody(init.body);
    const signal = composeSignals(params.signal, init.signal);
    const response = await params.managedService.request({
      pathAndQuery: String(input),
      ...(init.method === undefined ? {} : { method: normalizeHttpMethod(init.method) }),
      ...(init.headers === undefined ? {} : { headers: headersToRecord(new Headers(init.headers)) }),
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
    });
    return toNativeResponse(response);
  };

  const request: OpenCodeRuntimeFetch = async (input) => {
    const body = await normalizeRequestBody(input.body);
    const signal = composeSignals(params.signal, input.signal);
    const response = await params.managedService.request({
      pathAndQuery: input.url,
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(body === undefined ? {} : { body }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    });
    const nativeResponse = toNativeResponse(response);
    const runtimeResponse: OpenCodeRuntimeFetchResponse = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: nativeResponse.body,
      text: async () => await nativeResponse.text(),
      json: async () => await nativeResponse.json(),
      arrayBuffer: async () => await nativeResponse.arrayBuffer(),
    };
    return runtimeResponse;
  };

  return Object.freeze({
    request,
    fetch: fetchBound,
  });
}
