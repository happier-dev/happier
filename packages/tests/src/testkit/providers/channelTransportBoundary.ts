import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { createEphemeralTlsServerFixture } from '../tls/ephemeralTlsServerFixture.mjs';

export type ChannelBoundaryRequest = Readonly<{ host: string; path: string; method: string; body: string }>;

/** Replaces only the external Slack/Discord network peers; native TLS and ws remain real. */
export async function startChannelTransportBoundary(input: Readonly<{
  testDir: string;
  respond(request: ChannelBoundaryRequest): unknown;
  connected(socket: WebSocket, request: IncomingMessage): void;
}>) {
  const hosts = ['slack.com', 'socket.slack.com', 'discord.com', 'gateway.discord.gg'];
  const tls = await createEphemeralTlsServerFixture({ additionalDnsNames: hosts });
  const requests: ChannelBoundaryRequest[] = [];
  const sockets = new Set<import('node:stream').Duplex>();
  const server = createServer({ cert: await readFile(tls.leafCertificatePath), key: await readFile(tls.privateKeyPath) },
    async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const entry = { host: request.headers.host ?? '', path: request.url ?? '', method: request.method ?? '',
        body: Buffer.concat(chunks).toString('utf8') };
      requests.push(entry);
      try {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(input.respond(entry)));
      } catch (error) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const webSockets = new WebSocketServer({ server });
  webSockets.on('connection', input.connected);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Channel boundary did not bind TCP');
  const preload = join(input.testDir, 'channel-network-boundary.mjs');
  // Redirect only these third-party peers, retaining their original TLS
  // servername, certificate verification, HTTP Host and WebSocket handshake.
  await writeFile(preload, `import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const connect = tls.connect;
const hosts = new Set(${JSON.stringify(hosts)});
tls.connect = function (...args) {
  const options = args[0];
  if (options && typeof options === 'object') {
    const host = options.servername || options.host;
    if (hosts.has(host)) args[0] = { ...options, host: '127.0.0.1', port: ${address.port}, servername: host };
  }
  return Reflect.apply(connect, this, args);
};
syncBuiltinESMExports();
`);
  return {
    env: { NODE_EXTRA_CA_CERTS: tls.caCertificatePath,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() },
    requests: () => requests,
    async stop() {
      for (const socket of webSockets.clients) socket.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await tls.cleanup();
    },
  };
}
