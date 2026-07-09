import type {
  FetchRuntimeRequestV1,
  FetchRuntimeResponseV1,
  FetchRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

function headersToRecord(headers: Headers | undefined): Readonly<Record<string, string>> {
  if (!headers || typeof headers.forEach !== 'function') {
    return Object.freeze({});
  }
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return Object.freeze(out);
}

type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>;
type FetchBody = FetchInit['body'];

function toFetchBody(body: unknown): FetchBody | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (
    typeof body === 'string'
    || body instanceof URLSearchParams
    || body instanceof ArrayBuffer
    || body instanceof Blob
    || body instanceof FormData
  ) {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    return body as FetchBody;
  }
  return JSON.stringify(body);
}

export function createGlobalFetchRuntime(): FetchRuntimeServiceV1 {
  return async (request: FetchRuntimeRequestV1): Promise<FetchRuntimeResponseV1> => {
    const response = await globalThis.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: toFetchBody(request.body),
      signal: request.signal,
    });

    return Object.freeze({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: headersToRecord(response.headers),
      body: null,
      text: async () => await response.text(),
      json: async () => await response.json() as unknown,
      arrayBuffer: async () => await response.arrayBuffer(),
    });
  };
}
