import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));
const { stopDaemonSessionMock } = vi.hoisted(() => ({
  stopDaemonSessionMock: vi.fn(),
}));
const { listSessionMarkersMock, removeSessionMarkerMock, isPidSafeHappySessionProcessMock } = vi.hoisted(() => ({
  listSessionMarkersMock: vi.fn(),
  removeSessionMarkerMock: vi.fn(),
  isPidSafeHappySessionProcessMock: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));
vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    stopDaemonSession: stopDaemonSessionMock,
  };
});
vi.mock('@/daemon/sessionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/sessionRegistry')>();
  return {
    ...actual,
    listSessionMarkers: listSessionMarkersMock,
    removeSessionMarker: removeSessionMarkerMock,
  };
});
vi.mock('@/daemon/pidSafety', () => ({
  isPidSafeHappySessionProcess: isPidSafeHappySessionProcessMock,
}));

describe('happier session stop (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  let sessionActive = true;
  let sessionStatusFetchCount = 0;
  let sessionStatusShouldFail = false;

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-stop-');
    sessionActive = true;
    sessionStatusFetchCount = 0;
    sessionStatusShouldFail = false;

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname.startsWith('/v2/sessions/')) {
        const sessionId = url.pathname.slice('/v2/sessions/'.length).trim();
        sessionStatusFetchCount += 1;
        if (sessionStatusShouldFail) {
          res.statusCode = 503;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'temporary_unavailable' }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            session: {
              id: sessionId,
              seq: 1,
              createdAt: 1,
              updatedAt: 2,
              active: sessionActive,
              activeAt: sessionActive ? 10 : 0,
              metadata: 'metadata_ciphertext',
              metadataVersion: 0,
              agentState: null,
              agentStateVersion: 0,
              pendingCount: 0,
              pendingVersion: 0,
              dataEncryptionKey: null,
              share: null,
            },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve integration server address');

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    mockIo.mockReset();
    stopDaemonSessionMock.mockReset();
    listSessionMarkersMock.mockReset();
    listSessionMarkersMock.mockResolvedValue([]);
    removeSessionMarkerMock.mockReset();
    removeSessionMarkerMock.mockResolvedValue(undefined);
    isPidSafeHappySessionProcessMock.mockReset();
    isPidSafeHappySessionProcessMock.mockResolvedValue(true);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = null;

    if (happyHomeDir) {
      await removeTempDir(happyHomeDir);
      happyHomeDir = '';
    }

    envScope.restore();
    envScope = createEnvKeyScope(envKeys);

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('uses the daemon-owned stop path and avoids emitting session-end when the daemon reports success', async () => {
    const sessionId = 'sess_integration_stop_123';
    const emitSpy = vi.fn((...args: any[]) => {
      const cb = args[2];
      sessionActive = false;
      if (typeof cb === 'function') cb();
    });
    stopDaemonSessionMock.mockImplementation(async (requestedSessionId: string) => {
      expect(requestedSessionId).toBe(sessionId);
      sessionActive = false;
      return true;
    });

    const socket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => emitSpy(event, ...args),
    });
    bindApiSessionSocketMock(mockIo, socket);

    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['stop', sessionId, '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      expect(stopDaemonSessionMock).toHaveBeenCalledWith(sessionId);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(sessionStatusFetchCount).toBeGreaterThanOrEqual(2);

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_stop');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(parsed.data?.stopped).toBe(true);
    } finally {
      output.restore();
    }
  });

  it('reports stopped false when the daemon stop path is unavailable instead of falling back to session-end', async () => {
    const sessionId = 'sess_integration_stop_timeout';
    const emitSpy = vi.fn((...args: any[]) => {
      const cb = args[2];
      if (typeof cb === 'function') cb();
    });
    stopDaemonSessionMock.mockResolvedValue(false);

    const socket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => emitSpy(event, ...args),
    });
    bindApiSessionSocketMock(mockIo, socket);

    process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS = '20';
    process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS = '1';

    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['stop', sessionId, '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      expect(stopDaemonSessionMock).toHaveBeenCalledWith(sessionId);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(sessionStatusFetchCount).toBeGreaterThanOrEqual(2);

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_stop');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(parsed.data?.stopped).toBe(false);
    } finally {
      delete process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS;
      delete process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS;
      output.restore();
    }
  });

  it('falls back to marker-backed process stop when the daemon stop path is unavailable', async () => {
    const sessionId = 'sess_integration_stop_marker_fallback';
    const markerPid = 12345;
    const emitSpy = vi.fn((...args: any[]) => {
      const cb = args[2];
      if (typeof cb === 'function') cb();
    });
    stopDaemonSessionMock.mockResolvedValue(false);
    listSessionMarkersMock.mockResolvedValue([
      {
        pid: markerPid,
        happySessionId: sessionId,
        happyHomeDir: happyHomeDir,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedBy: 'daemon',
        processCommandHash: 'a'.repeat(64),
      },
    ]);

    const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 'SIGTERM' && Math.abs(pid) === markerPid) {
        sessionActive = false;
      }
      return true;
    }) as typeof process.kill);

    const socket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => emitSpy(event, ...args),
    });
    bindApiSessionSocketMock(mockIo, socket);

    process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS = '50';
    process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS = '1';

    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['stop', sessionId, '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      expect(stopDaemonSessionMock).toHaveBeenCalledWith(sessionId);
      expect(listSessionMarkersMock).toHaveBeenCalledTimes(2);
      expect(isPidSafeHappySessionProcessMock).toHaveBeenCalledWith({
        pid: markerPid,
        expectedProcessCommandHash: 'a'.repeat(64),
      });
      expect(processKillSpy).toHaveBeenCalledWith(markerPid, 'SIGTERM');
      expect(removeSessionMarkerMock).toHaveBeenCalledWith(markerPid);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(sessionStatusFetchCount).toBeGreaterThanOrEqual(2);

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_stop');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(parsed.data?.stopped).toBe(true);
    } finally {
      delete process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS;
      delete process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS;
      processKillSpy.mockRestore();
      output.restore();
    }
  });

  it('reports stopped false when session status polling fails after a successful daemon stop request', async () => {
    const sessionId = 'sess_integration_stop_fetch_failure';
    stopDaemonSessionMock.mockImplementation(async (requestedSessionId: string) => {
      expect(requestedSessionId).toBe(sessionId);
      sessionStatusShouldFail = true;
      return true;
    });

    const socket = createApiSessionSocketStub();
    bindApiSessionSocketMock(mockIo, socket);

    process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS = '20';
    process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS = '1';

    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['stop', sessionId, '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      expect(stopDaemonSessionMock).toHaveBeenCalledWith(sessionId);
      expect(sessionStatusFetchCount).toBeGreaterThanOrEqual(1);

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_stop');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(parsed.data?.stopped).toBe(false);
    } finally {
      delete process.env.HAPPIER_SESSION_STOP_TIMEOUT_MS;
      delete process.env.HAPPIER_SESSION_STOP_POLL_INTERVAL_MS;
      output.restore();
    }
  });
});
