import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';

export type RecordedHttpProxyRequest = Readonly<{
  id: number;
  method: string;
  path: string;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  startedAtMs: number;
  endedAtMs: number | null;
  statusCode: number | null;
  upgraded: boolean;
  error: string | null;
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
  startedAtMs: number;
  endedAtMs: number | null;
  statusCode: number | null;
  upgraded: boolean;
  error: string | null;
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
  delayRequestMs?: (request: RecordedHttpProxyRequest) => number | Promise<number>;
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
      startedAtMs: Date.now(),
      endedAtMs: null,
      statusCode: null,
      upgraded,
      error: null,
    };
    nextId += 1;
    entries.push(entry);
    return entry;
  };

  const finish = (entry: ReturnType<typeof begin>, patch?: { statusCode?: number | null; error?: string | null }) => {
    if (entry.endedAtMs !== null) return;
    if (patch && 'statusCode' in patch) entry.statusCode = patch.statusCode ?? null;
    if (patch && 'error' in patch) entry.error = patch.error ?? null;
    entry.endedAtMs = Date.now();
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const entry = begin(req, false);
    try {
      const delayMs = normalizeDelayMs(await params.delayRequestMs?.(entry));
      if (delayMs > 0) await sleep(delayMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.statusCode = 502;
      res.end('proxy delay failed');
      finish(entry, { statusCode: 502, error: message });
      return;
    }

    const headers = { ...req.headers, host: target.host };
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
      void (async () => {
        try {
          await params.beforeForwardResponse?.({
            ...entry,
            headers: { ...entry.headers },
          });
          if (res.destroyed) {
            upstreamRes.destroy();
            finish(entry, { statusCode });
            return;
          }
          res.writeHead(statusCode, upstreamRes.statusMessage, upstreamRes.headers);
          upstreamRes.pipe(res);
          upstreamRes.once('end', () => finish(entry, { statusCode }));
          upstreamRes.once('error', (error) => finish(entry, { error: error.message }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
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
    req.pipe(upstream);
  });

  server.on('connection', (socket) => {
    trackSocket(socket);
  });

  server.on('upgrade', (req, socket, head) => {
    const entry = begin(req, true);
    const targetSocket = trackSocket(connect({
      host: target.hostname,
      port: Number(target.port),
    }));
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

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('http request recording proxy missing address');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    entries: () => entries.map((entry) => ({ ...entry, headers: { ...entry.headers } })),
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
