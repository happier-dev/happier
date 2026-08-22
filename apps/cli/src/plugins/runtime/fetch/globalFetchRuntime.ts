import { PluginError } from '@happier-dev/plugin-sdk';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import {
  MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES,
  type PluginHttpRuntimeAdapter,
} from './service';
import { createPluginWebSocketConnection } from './webSocket';

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

function toFetchBody(body: Uint8Array | undefined): FetchBody | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  return body as FetchBody;
}

function createResponseTooLargeError(): PluginError {
  return new PluginError({
    code: 'plugin_fetch_response_too_large',
    message: 'Plugin fetch response exceeded the stable response-body limit',
  });
}

function hasOversizedDeclaredResponseBody(response: Response): boolean {
  const contentLength = response.headers.get('content-length');
  if (contentLength === null || !/^\d+$/.test(contentLength)) {
    return false;
  }
  const declaredBytes = Number(contentLength);
  return !Number.isSafeInteger(declaredBytes)
    || declaredBytes > MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES;
}

function createRequestAbortController(signal: AbortSignal | undefined): Readonly<{
  controller: AbortController;
  dispose(): void;
}> {
  const controller = new AbortController();
  if (!signal) {
    return { controller, dispose: () => undefined };
  }
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener('abort', abort, { once: true });
  }
  return {
    controller,
    dispose: () => signal.removeEventListener('abort', abort),
  };
}

async function readBoundedResponseBody(
  response: Response,
  requestAbort: AbortController,
): Promise<Uint8Array> {
  const responseBody = response.body;
  if (!responseBody) {
    return new Uint8Array();
  }
  if (hasOversizedDeclaredResponseBody(response)) {
    const error = createResponseTooLargeError();
    requestAbort.abort(error);
    void responseBody.cancel(error).catch(() => undefined);
    throw error;
  }
  const reader = responseBody.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES - byteLength) {
        const error = createResponseTooLargeError();
        requestAbort.abort(error);
        void reader.cancel(error).catch(() => undefined);
        throw error;
      }
      byteLength += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) return new Uint8Array();
  if (chunks.length === 1) return chunks[0]!;
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createGlobalFetchRuntime(): PluginHttpRuntimeAdapter {
  return Object.freeze({
    async request(
      request: Parameters<HttpService['request']>[0],
      options: Parameters<HttpService['request']>[1] = {},
    ) {
      const requestAbort = createRequestAbortController(options.signal);
      try {
        const response = await globalThis.fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: toFetchBody(request.body),
          signal: requestAbort.controller.signal,
          redirect: request.redirect,
        });
        const body = await readBoundedResponseBody(response, requestAbort.controller);
        return Object.freeze({
          status: response.status,
          finalUrl: response.url || request.url,
          headers: headersToRecord(response.headers),
          body,
        });
      } finally {
        requestAbort.dispose();
      }
    },
    async openWebSocket(input, options = {}) {
      return await createPluginWebSocketConnection(input, options);
    },
  });
}
