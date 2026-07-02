import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonControlApp } from './controlServer';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';

describe('daemon control server: /spawn-session', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires a control token at startup', () => {
    expect(() => createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: '' as any,
    })).toThrow(/control token/i);
  });

  it('rejects requests without the control token', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({ directory: '/tmp' }),
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('passes canonical daemon spawn fields through to spawnSession and preserves fresh sessionId', async () => {
    let observed: any = null;

    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async (options: any) => {
        observed = options;
        return { type: 'success', sessionId: 'happy-test-123' };
      },
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp',
          sessionId: 'explicit-session',
          spawnNonce: 'spawn-nonce-1',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          experimentalCodexAcp: true,
          transcriptStorage: 'direct',
          mcpSelection: {
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['server-portable'],
            forceExcludeServerIds: ['server-disabled'],
          },
          terminal: {
            mode: 'tmux',
            tmux: { sessionName: 'happy-e2e', isolated: true, tmpDir: '/tmp/happy-tmux' },
          },
          environmentVariables: {
            FOO: 'bar',
            TMUX_SESSION_NAME: 'legacy-ignored',
          },
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              anthropic: { source: 'connected', profileId: 'work' },
            },
          },
        }),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({
        success: true,
        sessionId: 'happy-test-123',
        approvedNewDirectoryCreation: true,
      });

      expect(observed).toEqual({
        directory: '/tmp',
        sessionId: 'explicit-session',
        spawnNonce: 'spawn-nonce-1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        codexBackendMode: 'acp',
        transcriptStorage: 'direct',
        mcpSelection: {
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: ['server-portable'],
          forceExcludeServerIds: ['server-disabled'],
        },
        terminal: {
          mode: 'tmux',
          tmux: { sessionName: 'happy-e2e', isolated: true, tmpDir: '/tmp/happy-tmux' },
        },
        environmentVariables: {
          FOO: 'bar',
          TMUX_SESSION_NAME: 'legacy-ignored',
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'connected', profileId: 'work' },
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it('prefers explicit existingSessionId for attach spawns', async () => {
    let observed: any = null;

    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async (options: any) => {
        observed = options;
        return { type: 'success', sessionId: 'happy-test-123' };
      },
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp',
          sessionId: 'fresh-session-id',
          existingSessionId: 'existing-session-id',
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(observed).toEqual({
        directory: '/tmp',
        existingSessionId: 'existing-session-id',
      });
    } finally {
      await app.close();
    }
  });

  it('returns a structured 500 when spawnSession throws', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async () => {
        throw new Error('boom');
      },
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ directory: '/tmp' }),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        success: false,
        error: 'Failed to spawn session: boom',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      });
    } finally {
      await app.close();
    }
  });

  it('resolves spawn nonce to a canonical session id when the tracked session is ready', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [
        {
          startedBy: 'daemon',
          pid: 123,
          happySessionId: 'sess-ready',
          spawnOptions: { directory: '/tmp', spawnNonce: 'nonce-1' },
        } as any,
      ],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ spawnNonce: 'nonce-1' }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: true,
        status: 'success',
        sessionId: 'sess-ready',
      });
    } finally {
      await app.close();
    }
  });

  it('keeps deterministic spawn nonce correlation after spawn response even when tracked children are gone', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-from-response' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const spawnRes = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp',
          spawnNonce: 'nonce-durable-from-response',
        }),
      });
      expect(spawnRes.statusCode).toBe(200);
      expect(spawnRes.json()).toEqual({
        success: true,
        sessionId: 'sess-from-response',
        approvedNewDirectoryCreation: true,
      });

      const resolveRes = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ spawnNonce: 'nonce-durable-from-response' }),
      });
      expect(resolveRes.statusCode).toBe(200);
      expect(resolveRes.json()).toEqual({
        success: true,
        status: 'success',
        sessionId: 'sess-from-response',
      });
    } finally {
      await app.close();
    }
  });

  it('returns pending/not_found states for spawn nonce lookup when webhook is incomplete or absent', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [
        {
          startedBy: 'daemon',
          pid: 321,
          happySessionId: 'PID-321',
          spawnOptions: { directory: '/tmp', spawnNonce: 'nonce-pending' },
        } as any,
      ],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const pendingRes = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ spawnNonce: 'nonce-pending' }),
      });
      expect(pendingRes.statusCode).toBe(200);
      expect(pendingRes.json()).toEqual({
        success: true,
        status: 'pending',
      });

      const missingRes = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ spawnNonce: 'nonce-missing' }),
      });
      expect(missingRes.statusCode).toBe(200);
      expect(missingRes.json()).toEqual({
        success: true,
        status: 'not_found',
      });
    } finally {
      await app.close();
    }
  });

  it('does not pass unknown agent ids through to spawnSession', async () => {
    let observed: any = null;

    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async (options: any) => {
        observed = options;
        return { type: 'success', sessionId: 'happy-test-123' };
      },
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp',
          backendTarget: { kind: 'builtInAgent', agentId: 'unknown-agent' },
        }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        success: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      });
      expect(observed).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('accepts legacy V1 backendTarget carriers on the daemon compatibility ingress', async () => {
    let observed: any = null;

    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => false,
      spawnSession: async (options: any) => {
        observed = options;
        return { type: 'success', sessionId: 'happy-test-123' };
      },
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp',
          agent: 'codex',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: true,
        sessionId: 'happy-test-123',
        approvedNewDirectoryCreation: true,
      });
      expect(observed).toEqual({
        directory: '/tmp',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
      });
    } finally {
      await app.close();
    }
  });
});
