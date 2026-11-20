import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';

export const RECORDED_HTTP_PROXY_REQUEST_BODY_MAX_BYTES = 256 * 1024;

export type RecordedHttpProxyRequest = Readonly<{
  id: number;
  method: string;
  path: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Loopback source port of the caller's connection; lets a test attribute the request to its process. */
  clientPort: number | null;
  startedAtMs: number;
  endedAtMs: number | null;
  statusCode: number | null;
  upgraded: boolean;
  error: string | null;
  /** Encoded upstream HTTP body bytes, excluding HTTP headers and framing. */
  responseBodyWireBytes: number;
  responseContentEncoding: string | null;
  /** Raw upstream upgrade traffic, including the initial upgrade handshake. */
  upgradedResponseWireBytes: number;
  body: Readonly<{
    text: string;
    byteLength: number;
    truncated: boolean;
    complete: boolean;
  }> | null;
  /** Upstream response bytes, retained only when `captureResponseBody` is enabled. */
  responseBody: Readonly<{
    text: string;
    byteLength: number;
    truncated: boolean;
    complete: boolean;
  }> | null;
}>;

export type HttpRequestRecordingProxy = Readonly<{
  baseUrl: string;
  entries: () => readonly RecordedHttpProxyRequest[];
  clear: () => void;
  count: (predicate?: (request: RecordedHttpProxyRequest) => boolean) => number;
  maxConcurrent: (predicate?: (request: RecordedHttpProxyRequest) => boolean) => number;
  stop: () => Promise<void>;
}>;

type MutableRecordedHttpProxyRequest = {
  id: number;
  method: string;
  path: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  clientPort: number | null;
  startedAtMs: number;
  endedAtMs: number | null;
  statusCode: number | null;
  upgraded: boolean;
  error: string | null;
  responseBodyWireBytes: number;
  responseContentEncoding: string | null;
  upgradedResponseWireBytes: number;
  body: {
    text: string;
    byteLength: number;
    truncated: boolean;
    complete: boolean;
  } | null;
  responseBody: {
    text: string;
    byteLength: number;
    truncated: boolean;
    complete: boolean;
  } | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDelayMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), 60_000);
}

function cloneHeaders(headers: IncomingMessage['headers']): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

function headerLinesFromRawHeaders(rawHeaders: readonly string[]): string {
  let out = '';
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (!key || value === undefined) continue;
    out += `${key}: ${value}\r\n`;
  }
  return out;
}

export async function startHttpRequestRecordingProxy(params: Readonly<{
  targetBaseUrl: string;
  /** Bind a real fixture ingress reachable from its guest network. */
  listenHost?: string;
  /** Expose the proxy through HTTPS while keeping its upstream target on loopback HTTP. */
  tls?: Readonly<{ key: string | Buffer; cert: string | Buffer }>;
  delayRequestMs?: (request: RecordedHttpProxyRequest) => number | Promise<number>;
  /**
   * Awaited once per request (HTTP and upgrade) while the caller's connection is still open, before
   * forwarding, so a test can attribute `clientPort` to the calling process.
   */
  onRequestStart?: (request: RecordedHttpProxyRequest) => void | Promise<void>;
  captureRequestBody?: boolean | ((request: RecordedHttpProxyRequest) => boolean);
  /** Opt in to the observed endpoint's body bound when the default capture would truncate it. */
  requestBodyMaxBytes?: number;
  /**
   * Retain the upstream response bytes each proxied request observed. Off by default so
   * ordinary proxy use keeps streaming responses without buffering credential material.
   */
  captureResponseBody?: boolean;
  /**
   * Replace selected upstream response bodies and optionally their status before forwarding,
   * modelling an endpoint that answers with something other than what the real target said.
   *
   * `when` decides eligibility from the request alone, before the request is forwarded. Enabling
   * rewrite therefore buffers only eligible responses — they are requested with
   * `accept-encoding: identity` and held in memory up to `maxBufferedBytes` (default
   * `RECORDED_HTTP_PROXY_REQUEST_BODY_MAX_BYTES`) so the hook sees decoded text. Every other
   * request keeps streaming untouched. An eligible response larger than the cap fails closed with
   * `502` instead of buffering without bound. `entries()` always records the genuine upstream bytes.
   */
  rewriteResponseBody?: Readonly<{
    when: (request: RecordedHttpProxyRequest) => boolean;
    rewrite: (request: RecordedHttpProxyRequest, upstreamBody: string) => string;
    /** Model a typed HTTP refusal while retaining the real upstream evidence. */
    statusCode?: number;
    maxBufferedBytes?: number;
  }>;
  beforeForwardResponse?: (
    request: RecordedHttpProxyRequest,
  ) => void | Promise<void>;
}>): Promise<HttpRequestRecordingProxy> {
  const target = new URL(params.targetBaseUrl);
  if (target.protocol !== 'http:') {
    throw new Error(`httpRequestRecordingProxy only supports http targets, got ${target.protocol}`);
  }

  let nextId = 1;
  const entries: MutableRecordedHttpProxyRequest[] = [];
  const sockets = new Set<Socket>();
  const trackSocket = (socket: Socket): Socket => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
    return socket;
  };

  const begin = (req: IncomingMessage, upgraded: boolean) => {
    const entry: MutableRecordedHttpProxyRequest = {
      id: nextId,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: cloneHeaders(req.headers),
      clientPort: req.socket.remotePort ?? null,
      startedAtMs: Date.now(),
      endedAtMs: null,
      statusCode: null,
      upgraded,
      error: null,
      responseBodyWireBytes: 0,
      responseContentEncoding: null,
      upgradedResponseWireBytes: 0,
      body: null,
      responseBody: null,
    };
    nextId += 1;
    entries.push(entry);
    return entry;
  };

  const observeRequestBody = (
    req: IncomingMessage,
    entry: MutableRecordedHttpProxyRequest,
  ): void => {
    const body = {
      text: '',
      byteLength: 0,
      truncated: false,
      complete: false,
    };
    entry.body = body;
    const bodyChunks: Buffer[] = [];
    let recordedBodyByteLength = 0;
    req.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      body.byteLength += bytes.byteLength;
      const remaining = (params.requestBodyMaxBytes ?? RECORDED_HTTP_PROXY_REQUEST_BODY_MAX_BYTES)
        - recordedBodyByteLength;
      if (remaining > 0) {
        const recorded = bytes.subarray(0, remaining);
        bodyChunks.push(recorded);
        recordedBodyByteLength += recorded.byteLength;
      }
      body.truncated =
        body.byteLength > (params.requestBodyMaxBytes ?? RECORDED_HTTP_PROXY_REQUEST_BODY_MAX_BYTES);
    });
    req.once('end', () => {
      body.text = Buffer.concat(bodyChunks).toString('utf8');
      body.complete = true;
    });
  };

  const observeResponseBody = (
    upstreamRes: IncomingMessage,
    entry: MutableRecordedHttpProxyRequest,
  ): void => {
    const body = {
      text: '',
      byteLength: 0,
      truncated: false,
      complete: false,
    };
    entry.responseBody = body;
    const bodyChunks: Buffer[] = [];
    let recordedBodyByteLength = 0;
    upstreamRes.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      body.byteLength += bytes.byteLength;
      const remaining = RECORDED_HTTP_PROXY_REQUEST_BODY_MAX_BYTES - recordedBodyByteLength;
      if (remaining > 0) {
        const recorded = bytes.subarray(0, remaining);
        bodyChunks.push(recorded);
        recordedBodyByteLength += recorded.byteLength;
      }
      body.truncated = body.byteLength > RECORDED_HTTP_PROXY_REQUEST_BODY_MAX_BYTES;
    });
    upstreamRes.once('end', () => {
      body.text = Buffer.concat(bodyChunks).toString('utf8');
      body.complete = true;
    });
  };

  const snapshot = (
    entry: MutableRecordedHttpProxyRequest,
  ): RecordedHttpProxyRequest => ({
    ...entry,
    headers: { ...entry.headers },
    body: entry.body ? { ...entry.body } : null,
    responseBody: entry.responseBody ? { ...entry.responseBody } : null,
  });

  /** Buffer an eligible upstream body up to the cap, rewrite it, and forward the replacement. */
  const forwardRewrittenResponse = (
    rewriter: NonNullable<typeof params.rewriteResponseBody>,
    upstreamRes: IncomingMessage,
    res: ServerResponse,
    entry: MutableRecordedHttpProxyRequest,
    statusCode: number,
  ): void => {
    if (params.captureResponseBody === true) observeResponseBody(upstreamRes, entry);
    const maxBufferedBytes = rewriter.maxBufferedBytes
      ?? RECORDED_HTTP_PROXY_REQUEST_BODY_MAX_BYTES;
    const chunks: Buffer[] = [];
    let bufferedByteLength = 0;
    let overflowed = false;
    upstreamRes.on('data', (chunk: Buffer | string) => {
      if (overflowed) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bufferedByteLength += bytes.byteLength;
      if (bufferedByteLength > maxBufferedBytes) {
        // Fail closed rather than growing the buffer without bound.
        overflowed = true;
        chunks.length = 0;
        upstreamRes.destroy();
        if (!res.headersSent) res.statusCode = 502;
        res.end('proxy response rewrite buffer exceeded');
        finish(entry, {
          statusCode: res.statusCode,
          error: `rewritten response exceeded ${maxBufferedBytes} bytes`,
        });
        return;
      }
      chunks.push(bytes);
    });
    upstreamRes.once('error', (error) => finish(entry, { error: error.message }));
    upstreamRes.once('end', () => {
      if (overflowed) return;
      const upstreamBody = Buffer.concat(chunks).toString('utf8');
      let forwarded = upstreamBody;
      try {
        forwarded = rewriter.rewrite(snapshot(entry), upstreamBody);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) res.statusCode = 502;
        res.end('proxy response rewrite failed');
        finish(entry, { statusCode: res.statusCode, error: message });
        return;
      }
      const forwardedBytes = Buffer.from(forwarded, 'utf8');
      const forwardedHeaders: Record<string, string | string[] | number> = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue;
        const lowered = key.toLowerCase();
        if (lowered === 'content-length' || lowered === 'transfer-encoding') continue;
        forwardedHeaders[key] = value;
      }
      forwardedHeaders['content-length'] = forwardedBytes.byteLength;
      res.writeHead(rewriter.statusCode ?? statusCode,
        rewriter.statusCode === undefined ? upstreamRes.statusMessage : undefined, forwardedHeaders);
      res.end(forwardedBytes);
      finish(entry, { statusCode });
    });
    upstreamRes.resume();
  };

  const finish = (entry: ReturnType<typeof begin>, patch?: { statusCode?: number | null; error?: string | null }) => {
    if (entry.endedAtMs !== null) return;
    if (patch && 'statusCode' in patch) entry.statusCode = patch.statusCode ?? null;
    if (patch && 'error' in patch) entry.error = patch.error ?? null;
    entry.endedAtMs = Date.now();
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const entry = begin(req, false);
    let captureRequestBody = false;
    try {
      await params.onRequestStart?.(snapshot(entry));
      const delayMs = normalizeDelayMs(await params.delayRequestMs?.(entry));
      if (delayMs > 0) await sleep(delayMs);
      captureRequestBody = params.captureRequestBody === true
        || (
          typeof params.captureRequestBody === 'function'
          && params.captureRequestBody(snapshot(entry))
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.statusCode = 502;
      res.end('proxy delay failed');
      finish(entry, { statusCode: 502, error: message });
      return;
    }

    const rewriter = params.rewriteResponseBody;
    let rewriteResponseBody: typeof rewriter = undefined;
    try {
      if (rewriter?.when(snapshot(entry))) rewriteResponseBody = rewriter;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.statusCode = 502;
      res.end('proxy rewrite eligibility failed');
      finish(entry, { statusCode: 502, error: message });
      return;
    }
    const headers = { ...req.headers, host: target.host };
    // A rewritten body is composed from decoded text, so ask upstream for identity encoding.
    // Only eligible requests pay that cost; every other request streams as it did before.
    if (rewriteResponseBody) headers['accept-encoding'] = 'identity';
    const upstream = httpRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
    }, (upstreamRes) => {
      const statusCode = upstreamRes.statusCode ?? 502;
      entry.statusCode = statusCode;
      upstreamRes.pause();
      const encoding = upstreamRes.headers['content-encoding'];
      entry.responseContentEncoding = Array.isArray(encoding) ? encoding.join(', ') : encoding ?? null;
      // Observe without retaining or changing negotiated compression.
      upstreamRes.on('data', (chunk: Buffer | string) => {
        entry.responseBodyWireBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
      });
      void (async () => {
        try {
          await params.beforeForwardResponse?.(snapshot(entry));
          if (res.destroyed) {
            upstreamRes.destroy();
            finish(entry, { statusCode });
            return;
          }
          if (rewriteResponseBody) {
            forwardRewrittenResponse(rewriteResponseBody, upstreamRes, res, entry, statusCode);
            return;
          }
          res.writeHead(statusCode, upstreamRes.statusMessage, upstreamRes.headers);
          if (params.captureResponseBody === true) observeResponseBody(upstreamRes, entry);
          upstreamRes.pipe(res);
          upstreamRes.once('end', () => finish(entry, { statusCode }));
          upstreamRes.once('error', (error) => finish(entry, { error: error.message }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A fixture hook failure becomes the client's 502; record why so the journey's
          // downstream refusal can be traced to it. Bodies are never logged.
          console.error('[http-recording-proxy] beforeForwardResponse failed; answering 502', {
            method: entry.method, path: entry.path, upstreamStatus: statusCode, message,
            stack: error instanceof Error ? error.stack : undefined,
          });
          upstreamRes.destroy();
          if (!res.headersSent) {
            res.statusCode = 502;
          }
          res.end('proxy response latch failed');
          finish(entry, { statusCode: res.statusCode, error: message });
        }
      })();
    });

    upstream.once('error', (error) => {
      if (!res.headersSent) {
        res.statusCode = 502;
      }
      res.end('proxy upstream failed');
      finish(entry, { statusCode: res.statusCode, error: error.message });
    });
    res.once('close', () => finish(entry, { statusCode: res.statusCode || null }));
    if (captureRequestBody) observeRequestBody(req, entry);
    req.pipe(upstream);
  };
  const server = params.tls
    ? createHttpsServer(params.tls, handleRequest)
    : createServer(handleRequest);

  server.on('connection', (socket) => {
    trackSocket(socket);
  });

  server.on('upgrade', (req, socket, head) => {
    const entry = begin(req, true);
    // Upgraded connections stay open, so attribution may complete while the tunnel is established.
    void Promise.resolve(params.onRequestStart?.(snapshot(entry))).catch(() => {});
    const targetSocket = trackSocket(connect({
      host: target.hostname,
      port: Number(target.port),
    }));
    targetSocket.on('data', (chunk: Buffer) => { entry.upgradedResponseWireBytes += chunk.byteLength; });
    targetSocket.once('connect', () => {
      targetSocket.write(`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}\r\n`);
      targetSocket.write(headerLinesFromRawHeaders(req.rawHeaders));
      targetSocket.write('\r\n');
      if (head.length > 0) targetSocket.write(head);
      socket.pipe(targetSocket);
      targetSocket.pipe(socket);
    });
    targetSocket.once('error', (error) => {
      finish(entry, { error: error.message });
      socket.destroy();
    });
    targetSocket.once('close', () => {
      socket.destroy();
    });
    socket.once('close', () => {
      finish(entry);
      targetSocket.destroy();
    });
    socket.once('error', () => targetSocket.destroy());
  });

  const listenHost = params.listenHost ?? '127.0.0.1';
  server.listen(0, listenHost);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('http request recording proxy missing address');

  return {
    baseUrl: `${params.tls ? 'https' : 'http'}://${listenHost.includes(':') ? `[${listenHost}]` : listenHost}:${address.port}`,
    entries: () => entries.map(snapshot),
    clear: () => {
      entries.length = 0;
    },
    count: (predicate) => entries.filter((entry) => predicate ? predicate(entry) : true).length,
    maxConcurrent: (predicate) => {
      const selected = entries.filter((entry) => predicate ? predicate(entry) : true);
      const events: Array<{ at: number; delta: 1 | -1 }> = [];
      for (const entry of selected) {
        events.push({ at: entry.startedAtMs, delta: 1 });
        events.push({ at: entry.endedAtMs ?? Date.now(), delta: -1 });
      }
      events.sort((a, b) => a.at === b.at ? b.delta - a.delta : a.at - b.at);
      let active = 0;
      let max = 0;
      for (const event of events) {
        active += event.delta;
        max = Math.max(max, active);
      }
      return max;
    },
    stop: async () => {
      const closed = once(server, 'close').catch(() => {});
      server.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await closed;
    },
  };
}
