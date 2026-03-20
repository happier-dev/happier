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
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          token: 'dummy-token',
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
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 'dummy-token',
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
      expect(observed).toBeNull();
    } finally {
      await app.close();
    }
  });
});
