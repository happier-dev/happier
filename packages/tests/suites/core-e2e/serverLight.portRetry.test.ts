import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';

function listenEphemeral(server: Server, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate a port'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function allocatePort(): Promise<number> {
  const srv = createServer();
  try {
    const port = await listenEphemeral(srv, '127.0.0.1');
    return port;
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: server-light port selection retry', () => {
  let busy: Server | null = null;

  afterAll(async () => {
    if (!busy) return;
    await Promise.race([
      new Promise<void>((resolve) => busy!.close(() => resolve())),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Timed out closing busy port server')), 5_000)),
    ]).catch(() => {});
  }, 10_000);

  it('retries when the chosen port is already in use', async () => {
    const testDir = run.testDir('server-light-port-retry');

    busy = createServer();
    const busyPort = await listenEphemeral(busy, '127.0.0.1');

    const portsRequested: number[] = [];
    let server: StartedServer | null = null;
    try {
      server = await startServerLight({
        testDir,
        __portAllocator: async () => {
          const port = portsRequested.length === 0 ? busyPort : await allocatePort();
          portsRequested.push(port);
          return port;
        },
      });

      expect(portsRequested[0]).toBe(busyPort);
      expect(portsRequested.length).toBeGreaterThanOrEqual(2);
      if (!server) throw new Error('Expected server-light to have started');
      expect(server.port).not.toBe(busyPort);
    } finally {
      await Promise.race([
        server?.stop().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
      ]);
      if (busy) {
        await Promise.race([
          new Promise<void>((resolve) => busy!.close(() => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
        busy = null;
      }
    }
  }, 180_000);
});
