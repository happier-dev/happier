import { createServer, type ClientRequest } from 'node:http';
import type { Socket } from 'node:net';
import httpProxy from 'http-proxy';

type HomeCarrierOrigin = Readonly<{
  origin: string;
  setVerifiedUpstream(upstream: string): void;
  release(): Promise<void>;
}>;

/** The daemon's local origin outlives the verified upstream carrier leases. */
export async function createHomeCarrierOrigin(upstream: string): Promise<HomeCarrierOrigin> {
  let target = upstream;
  const sockets = new Set<Socket>();
  const requests = new Set<ClientRequest>();
  const proxy = httpProxy.createProxyServer({ changeOrigin: true, secure: true });
  const trackSocket = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const trackRequest = (request: ClientRequest) => {
    requests.add(request);
    request.once('close', () => requests.delete(request));
  };
  proxy.on('proxyReq', trackRequest);
  proxy.on('proxyReqWs', trackRequest);
  proxy.on('open', trackSocket);
  proxy.on('error', (_error, _request, response) => {
    // Preserve network failure without exposing native errors or request data.
    response.destroy();
  });
  const server = createServer((request, response) => proxy.web(request, response, { target }));
  server.on('connection', trackSocket);
  server.on('upgrade', (request, socket, head) => proxy.ws(request, socket, head, { target }));
  const disconnect = () => {
    for (const request of requests) request.destroy();
    for (const socket of sockets) socket.destroy();
  };
  const origin = await new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Home carrier listener has no local address'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return {
    origin,
    setVerifiedUpstream(upstream: string) {
      if (target === upstream) return;
      target = upstream;
      // Existing streams belong to the retired lease. Their ordinary clients
      // reconnect through this same listener, now reaching the verified lease.
      disconnect();
    },
    async release() {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      disconnect();
      await closed;
    },
  };
}
