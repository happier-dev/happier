import { readBoundedPluginHttpResponseBody } from '@happier-dev/cli-common/plugins/http';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { HttpService, HttpResponse } from '@happier-dev/plugin-sdk/http';
import {
  type PluginHttpRuntimeAdapter,
  type PluginHttpRuntimeRequestOptions,
} from './service';
import { createPluginWebSocketConnection } from './webSocket';
import { loadUndici } from '@/utils/loadUndici';
import { snapshotPluginHttpStreamRequest, wrapPluginHttpStream } from './stream';

let httpDispatcher: import('undici').Agent | undefined;

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

/** Normalize native Node/Bun peer representations once; unavailable capture is not HTTP failure. */
function readTlsPeer(url: string, fingerprint: unknown, validFrom: unknown, validTo: unknown): HttpResponse['tlsPeer'] {
    if (typeof fingerprint !== 'string' || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(fingerprint)
        || typeof validFrom !== 'string' || typeof validTo !== 'string') return;
    const notBefore = Date.parse(validFrom);
    const notAfter = Date.parse(validTo);
    if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notAfter <= notBefore) return;
    return Object.freeze({ url, fingerprint256: fingerprint, notBefore, notAfter });
}

export function createGlobalFetchRuntime(): PluginHttpRuntimeAdapter {
  const open = async (request: Parameters<HttpService['request']>[0], options: PluginHttpRuntimeRequestOptions) => {
    const requestAbort = createRequestAbortController(options.signal);
        let observationDispatcher: import('undici').Agent | undefined;
        let tlsPeer: HttpResponse['tlsPeer'];
        const dispose = async () => {
            requestAbort.dispose();
            await observationDispatcher?.destroy();
        };
    try {
      requestAbort.controller.signal.throwIfAborted();
            const { Agent, buildConnector } = await loadUndici();
      requestAbort.controller.signal.throwIfAborted();
            let nativeTlsValidation: Readonly<{
                rejectUnauthorized: true;
                checkServerIdentity(hostname: string, certificate: import('node:tls').PeerCertificate): Error | undefined;
            }> | undefined;
            if (request.observeTlsPeer && new URL(request.url).protocol === 'https:') {
                const observe = (fingerprint: unknown, validFrom: unknown, validTo: unknown) => {
                    if (requestAbort.controller.signal.aborted) return;
                    tlsPeer = readTlsPeer(request.url, fingerprint, validFrom, validTo);
                };
                if (process.versions.bun) {
                    const { checkServerIdentity } = await import('node:tls');
                    nativeTlsValidation = {
                        rejectUnauthorized: true,
                        checkServerIdentity(hostname, certificate) {
                            // Bun validates the chain before this callback, which replaces
                            // its hostname check. Preserve native hostname validation first.
                            const failure = checkServerIdentity(hostname, certificate);
                            if (failure) return failure;
                            observe(certificate.fingerprint256, certificate.valid_from, certificate.valid_to);
                            return undefined;
                        },
                    };
                } else {
                    // This request's own validated socket proves which peer was observed;
                    // reusing a shared pooled socket cannot establish that observation.
                    const connect = buildConnector({ rejectUnauthorized: true });
                    observationDispatcher = new Agent({
                        headersTimeout: 0, bodyTimeout: 0,
                        connect(connectOptions, callback) {
                            connect(connectOptions, (...result) => {
                                if (result[0]) { callback(result[0], null); return; }
                                const socket = result[1];
                                try {
                                    if ('getPeerX509Certificate' in socket && socket.authorized) {
                                        const certificate = socket.getPeerX509Certificate();
                                        if (certificate) observe(certificate.fingerprint256, certificate.validFrom, certificate.validTo);
                                    }
                                } catch { /* Missing native metadata leaves certificate evidence unknown. */ }
                                callback(null, socket);
                            });
                        },
                    });
                }
            }
            const dispatcher = observationDispatcher ?? (httpDispatcher ??= new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
      // Both body modes retain the invocation's deadline; Node/Bun add no shorter cutoff.
      const init = {
        method: request.method, headers: request.headers, body: toFetchBody(request.body),
        signal: requestAbort.controller.signal,
        redirect: request.redirect === 'follow' ? 'manual' : request.redirect,
        dispatcher, timeout: false,
                ...(nativeTlsValidation ? { tls: nativeTlsValidation } : {}),
            } satisfies RequestInit & { dispatcher: typeof dispatcher; timeout: false; tls?: typeof nativeTlsValidation };
      const response = await globalThis.fetch(request.url, init);
            return { response, requestAbort, tlsPeer, dispose };
        } catch (error) { await dispose(); throw error; }
  };
  return Object.freeze({
    async request(
      request: Parameters<HttpService['request']>[0],
      options: PluginHttpRuntimeRequestOptions = {},
    ) {
      const { response, requestAbort, tlsPeer, dispose } = await open(request, options);
      try {
        let body: Uint8Array;
        if (request.responseBody === 'discard') {
          await response.body?.cancel();
          body = new Uint8Array();
        } else {
          body = await readBoundedPluginHttpResponseBody(response, requestAbort.controller);
        }
        requestAbort.controller.signal.throwIfAborted();
        return Object.freeze({
          status: response.status,
          finalUrl: response.url || request.url,
          headers: headersToRecord(response.headers),
          body,
          ...(tlsPeer ? { tlsPeer } : {}),
        });
      } finally {
        await dispose();
      }
    },
    async requestStream(request: Parameters<NonNullable<PluginHttpRuntimeAdapter['requestStream']>>[0], options: PluginHttpRuntimeRequestOptions = {}) {
      const { response, requestAbort, dispose: disposeRequest } = await open(snapshotPluginHttpStreamRequest(request), options);
      const reader = response.body?.getReader();
      let disposal: Promise<void> | undefined;
      const dispose = (): Promise<void> => disposal ??= (async () => {
        requestAbort.controller.abort();
        try { await reader?.cancel(requestAbort.controller.signal.reason); }
        catch { /* Aborting the native fetch may already have closed its body. */ }
        finally { reader?.releaseLock(); await disposeRequest(); }
      })();
      return wrapPluginHttpStream({
        status: response.status, finalUrl: response.url || request.url, headers: headersToRecord(response.headers),
        chunks: { [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<Uint8Array>> => {
            if (!reader) return { done: true, value: undefined };
            const item = await reader.read();
            return item.done ? { done: true, value: undefined } : { done: false, value: item.value };
          },
        }) }, dispose,
      }, { signal: options.signal });
    },
    async openWebSocket(input, options = {}) {
      return await createPluginWebSocketConnection(input, options);
    },
  });
}
