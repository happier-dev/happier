import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Socket } from 'node:net';
import { createLocalSessionRpcAgent } from './localSessionRpcAgent';

// The native helper is the OS identity boundary. HTTP and socket delivery stay real.
const boundary = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock('@/subprocess/supervision/processCustody', async original => ({
  ...(await original<typeof import('@/subprocess/supervision/processCustody')>()),
  resolveProcessCustodyPeerIdentityExecutable: () => '/staged/processcustody',
  observeLocalIpcPeerIdentity: boundary.observe,
}));

afterEach(() => vi.clearAllMocks());

describe('Windows Session RPC connection admission', () => {
  it.each([true, false])('delivers private input only after same-user server identity is proven (%s)', async allowed => {
    const root = await mkdtemp(join(tmpdir(), 'happier-rpc-peer-'));
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\happier-session-rpc-test-${process.pid}-${Date.now()}` : join(root, 'rpc');
    const received: string[] = [];
    const server = createServer((incoming, response) => {
      let body = '';
      incoming.on('data', chunk => { body += String(chunk); });
      incoming.on('end', () => { received.push(body); response.end('{}'); });
    });
    await new Promise<void>(resolve => server.listen(endpoint, resolve));
    let release!: (identity: { pid: number; uid: null } | null) => void;
    boundary.observe.mockImplementation(({ socket }: { socket: Socket }) => {
      // On Windows, passing the connected socket to the helper pauses reads.
      socket.pause();
      return new Promise(resolve => { release = resolve; });
    });
    const agent = createLocalSessionRpcAgent(endpoint, 'win32');
    const outcome = new Promise<string>(resolve => {
      const outgoing = request({ socketPath: endpoint, method: 'POST', agent }, incoming => {
        incoming.resume(); incoming.once('end', () => resolve('delivered'));
      });
      outgoing.once('error', () => resolve('refused'));
      outgoing.setTimeout(1_000, () => { resolve('no response'); outgoing.destroy(); });
      outgoing.end('private transcript evidence');
    });
    try {
      await vi.waitFor(() => expect(boundary.observe).toHaveBeenCalledOnce());
      expect(received).toEqual([]);
      expect(boundary.observe.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ peer: 'server' }));
      release(allowed ? { pid: process.pid, uid: null } : null);
      expect(await outcome).toBe(allowed ? 'delivered' : 'refused');
      expect(received).toEqual(allowed ? ['private transcript evidence'] : []);
    } finally {
      release?.(null);
      agent.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
