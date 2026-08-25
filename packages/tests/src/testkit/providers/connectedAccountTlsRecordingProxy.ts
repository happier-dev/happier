import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { TLSSocket } from 'node:tls';

import {
  createEphemeralTlsServerFixture,
} from '../tls/ephemeralTlsServerFixture.mjs';

const MAX_RECORDED_REQUEST_BYTES = 512 * 1024;

export type RecordedConnectedAccountTlsRequest = Readonly<{
  connectTarget: string;
  method: string;
  path: string;
  observedAtMs: number;
  body: string;
  authorizationFingerprint: string | null;
  accountHeader: string | null;
}>;

export type ConnectedAccountTlsResponse = Readonly<{
  statusCode: number;
  body: unknown;
}>;

export type ConnectedAccountTlsRecordingProxy = Readonly<{
  url: string;
  caCertPath: string;
  entries: () => readonly RecordedConnectedAccountTlsRequest[];
  connectTargets: () => readonly string[];
  holdNextRequestBodyContaining(value: string): Readonly<{
    release(): void;
    completed: Promise<void>;
  }>;
  clear(): void;
  stop(): Promise<void>;
}>;

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function scalarHeader(
  value: string | readonly string[] | undefined,
): string | null {
  return typeof value === 'string' ? value : value?.[0] ?? null;
}

function authorizationFingerprint(
  value: string | readonly string[] | undefined,
): string | null {
  const header = scalarHeader(value);
  if (!header) return null;
  const bearer = /^Bearer\s+(.+)$/iu.exec(header);
  return `sha256:${createHash('sha256')
    .update(bearer?.[1] ?? header, 'utf8')
    .digest('hex')}`;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    assert(
      length <= MAX_RECORDED_REQUEST_BYTES,
      'connected_account_tls_observer_request_too_large',
    );
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function startConnectedAccountTlsRecordingProxy(input: Readonly<{
  responseForRequest?: (
    request: RecordedConnectedAccountTlsRequest,
    context: Readonly<{ wasHeld: boolean }>,
  ) => ConnectedAccountTlsResponse | Promise<ConnectedAccountTlsResponse>;
}> = {}): Promise<ConnectedAccountTlsRecordingProxy> {
  const tlsFixture = await createEphemeralTlsServerFixture({
    additionalDnsNames: ['chatgpt.com'],
  });
  const requests: RecordedConnectedAccountTlsRequest[] = [];
  const connectTargets: string[] = [];
  const holds: Array<{
    bodyValue: string;
    matched: boolean;
    release(): void;
    released: Promise<void>;
    complete(): void;
    completed: Promise<void>;
  }> = [];
  const sockets = new Set<import('node:stream').Duplex>();
  const targetsBySocket = new WeakMap<object, string>();
  const decryptedServer = createServer(async (request, response) => {
    const body = await readRequestBody(request).catch(() => Buffer.alloc(0));
    const entry: RecordedConnectedAccountTlsRequest = {
      connectTarget: targetsBySocket.get(request.socket) ?? '',
      method: request.method ?? '',
      path: request.url ?? '',
      observedAtMs: Date.now(),
      body: body.toString('utf8'),
      authorizationFingerprint:
        authorizationFingerprint(request.headers.authorization),
      accountHeader:
        scalarHeader(request.headers['chatgpt-account-id'])
        ?? scalarHeader(request.headers['x-openai-account-id'])
        ?? scalarHeader(request.headers['openai-account-id']),
    };
    requests.push(entry);
    const hold = holds.find((candidate) => (
      !candidate.matched && entry.body.includes(candidate.bodyValue)
    ));
    if (hold) {
      hold.matched = true;
      await hold.released;
    }
    const result = input.responseForRequest
      ? await input.responseForRequest(entry, { wasHeld: Boolean(hold) })
      : {
          statusCode: hold ? 400 : 502,
          body: {
            error: {
              type: hold
                ? 'connected_account_tls_observer_held_attempt_completed'
                : 'connected_account_tls_observer_upstream_observed',
              message: 'The isolated test observer does not forward upstream.',
            },
          },
        };
    response.statusCode = result.statusCode;
    response.setHeader('content-type', 'application/json');
    const finished = once(response, 'finish').catch(() => {});
    response.end(JSON.stringify(result.body));
    await finished;
    hold?.complete();
  });
  const server = createServer((_request, response) => {
    response.statusCode = 400;
    response.end('CONNECT required');
  });
  let stopPromise: Promise<void> | null = null;
  const stopProxy = (): Promise<void> => {
    stopPromise ??= (async () => {
      for (const hold of holds) hold.release();
      const closed = server.listening
        ? new Promise<void>((resolveClosed) => {
            server.close(() => resolveClosed());
          })
        : Promise.resolve();
      for (const socket of sockets) socket.destroy();
      try {
        await closed;
      } finally {
        await tlsFixture.cleanup();
      }
    })().catch((error) => {
      stopPromise = null;
      throw error;
    });
    return stopPromise;
  };
  server.on('connect', (request, socket, head) => {
    const connectTarget = request.url ?? '';
    connectTargets.push(connectTarget);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) socket.unshift(head);
    const tlsSocket = new TLSSocket(socket, {
      isServer: true,
      secureContext: tlsFixture.secureContext,
      ALPNProtocols: ['http/1.1'],
    });
    sockets.add(tlsSocket);
    targetsBySocket.set(tlsSocket, connectTarget);
    tlsSocket.once('close', () => sockets.delete(tlsSocket));
    tlsSocket.once('secure', () => decryptedServer.emit('connection', tlsSocket));
    tlsSocket.once('error', () => tlsSocket.destroy());
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(
      address && typeof address === 'object',
      'connected_account_tls_observer_address_missing',
    );
    return {
      url: `http://127.0.0.1:${address.port}`,
      entries: () => requests.map((entry) => ({ ...entry })),
      connectTargets: () => [...connectTargets],
      caCertPath: tlsFixture.caCertificatePath,
      holdNextRequestBodyContaining: (bodyValue) => {
        assert(bodyValue.length > 0, 'connected_account_tls_observer_hold_value_missing');
        let release!: () => void;
        const released = new Promise<void>((resolveRelease) => {
          release = resolveRelease;
        });
        let complete!: () => void;
        const completed = new Promise<void>((resolveCompleted) => {
          complete = resolveCompleted;
        });
        holds.push({
          bodyValue,
          matched: false,
          release,
          released,
          complete,
          completed,
        });
        return { release, completed };
      },
      clear: () => {
        requests.length = 0;
        connectTargets.length = 0;
      },
      stop: stopProxy,
    };
  } catch (error) {
    await stopProxy();
    throw error;
  }
}
