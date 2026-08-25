import { PluginError } from '@happier-dev/plugin-sdk';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import {
  openPinnedHttpStream,
  type PinnedHttpStreamTransport,
} from '@/network/pinnedHttp';
import {
  MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES,
  type PluginHttpRuntimeAdapter,
  type PluginHttpRuntimeRequestOptions,
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

function createRedirectRefusedError(): PluginError {
  return new PluginError({
    code: 'plugin_fetch_redirect_follow_unavailable',
    message: 'Plugin fetch redirect following is unavailable until each redirect hop can be reauthorized',
  });
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

async function readBoundedPinnedResponseBody(
  response: Awaited<ReturnType<typeof openPinnedHttpStream>>,
): Promise<Uint8Array> {
  if (
    response.contentLength !== null
    && response.contentLength > MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES
  ) {
    response.cancel();
    throw createResponseTooLargeError();
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const chunk = await response.read();
    if (chunk === null) break;
    if (chunk.byteLength > MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES - byteLength) {
      response.cancel();
      throw createResponseTooLargeError();
    }
    byteLength += chunk.byteLength;
    chunks.push(chunk);
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

function pinnedHeadersToRecord(
  headers: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) => (
      value === undefined ? [] : [[key, value]]
    )),
  ));
}

export type GlobalFetchRuntimeDependencies = Readonly<{
  /**
   * Socket boundary for an already-admitted origin. It defaults to the process
   * HTTP owner; a composed host substitutes it so the terminal boundary stays
   * as replaceable as `globalThis.fetch` is on the unpinned path.
   */
  openPinnedStream?: PinnedHttpStreamTransport;
}>;

export function createGlobalFetchRuntime(
  dependencies: GlobalFetchRuntimeDependencies = {},
): PluginHttpRuntimeAdapter {
  const openPinnedStream = dependencies.openPinnedStream ?? openPinnedHttpStream;
  return Object.freeze({
    async request(
      request: Parameters<HttpService['request']>[0],
      options: PluginHttpRuntimeRequestOptions = {},
    ) {
      const requestAbort = createRequestAbortController(options.signal);
      try {
        if (options.validatedAddresses && options.validatedAddresses.length > 0) {
          const response = await openPinnedStream({
            url: request.url,
            validatedAddresses: options.validatedAddresses,
            headers: request.headers ?? Object.freeze({}),
            method: request.method,
            ...(request.body === undefined ? {} : { body: request.body }),
            signal: requestAbort.controller.signal,
          });
          if (response.status >= 300 && response.status < 400 && request.redirect !== 'manual') {
            response.cancel();
            throw createRedirectRefusedError();
          }
          const body = await readBoundedPinnedResponseBody(response);
          return Object.freeze({
            status: response.status,
            finalUrl: request.url,
            headers: pinnedHeadersToRecord(response.headers),
            body,
          });
        }
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
