import { afterEach, describe, expect, it, vi } from 'vitest';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { isPidAlive, spawnInlineNodeParentWithChild } from '@/testkit/process/spawn';
import { AcpBackend } from '../../AcpBackend';

const sdkBoundary = vi.hoisted(() => {
  const close = vi.fn();
  const controller = new AbortController();
  const app = {
    onRequest: vi.fn(),
    onNotification: vi.fn(),
    connect: vi.fn(),
  };
  app.onRequest.mockReturnValue(app);
  app.onNotification.mockReturnValue(app);
  return {
    app,
    close,
    controller,
    closed: new Promise<void>(() => {}),
  };
});

vi.mock('@agentclientprotocol/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentclientprotocol/sdk')>();
  sdkBoundary.app.connect.mockReturnValue({
    agent: {
      request: vi.fn(),
      notify: vi.fn(),
    },
    signal: sdkBoundary.controller.signal,
    closed: sdkBoundary.closed,
    close: sdkBoundary.close,
  });
  return {
    ...actual,
    client: () => sdkBoundary.app,
  };
});

import { createAcpClientConnection } from '../createAcpClientConnection';

afterEach(() => {
  vi.useRealTimers();
  sdkBoundary.close.mockClear();
});

describe('createAcpClientConnection explicit close deadline', () => {
  it('settles the connection lifecycle after the caller deadline when SDK closed never settles', async () => {
    vi.useFakeTimers();
    const connection = createAcpClientConnection({
      name: 'close-deadline-client',
      transport: {
        readable: new ReadableStream(),
        writable: new WritableStream(),
      },
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
    });
    let settled = false;
    void connection.closed.then(() => {
      settled = true;
    });

    connection.close(undefined, { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(24);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(sdkBoundary.close).toHaveBeenCalledTimes(1);
  });

  it('allows backend disposal to finish after its process grace period when SDK closed never settles', async () => {
    if (process.platform === 'win32') return;

    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    const connection = createAcpClientConnection({
      name: 'backend-close-deadline-client',
      transport: {
        readable: new ReadableStream(),
        writable: new WritableStream(),
      },
      handlers: {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        sessionUpdate: () => {},
      },
    });
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: 'noop',
    });

    try {
      (backend as any).connection = connection;
      (backend as any).process = parent;

      expect(isPidAlive(parent.pid!)).toBe(true);
      expect(isPidAlive(childPid)).toBe(true);

      await backend.dispose();

      expect(isPidAlive(parent.pid!)).toBe(false);
      expect(sdkBoundary.close).toHaveBeenCalledTimes(1);
    } finally {
      await killProcessTree(parent, { graceMs: 250 });
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // process already exited
      }
    }
  }, 15_000);
});
