import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonControlApp } from './controlServer';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { logger } from '@/ui/logger';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('daemon control server: /spawn-session', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires a control token at startup', () => {
    expect(() => createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
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
      stopSession: async () => ({ status: 'not_found' as const }),
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

  it('does not persist private spawn directory or session identity at control ingress', async () => {
    const privateDirectory = '/Users/private-user/work/client-project';
    const privateSessionId = 'session-private-identity';
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: privateSessionId }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      vi.mocked(logger.debug).mockClear();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: {
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'test-token',
        },
        payload: JSON.stringify({
          directory: privateDirectory,
          sessionId: privateSessionId,
          backendTarget: {
            kind: 'backend',
            backendId: 'codex',
            sourceKind: 'built_in',
          },
        }),
      });

      expect(res.statusCode).toBe(200);
      const diagnostics = vi.mocked(logger.debug).mock.calls
        .flatMap((call) => call)
        .map((value) => value instanceof Error
          ? `${value.name}:${value.message}:${value.stack ?? ''}`
          : String(value))
        .join('|');
      expect(diagnostics).not.toContain(privateDirectory);
      expect(diagnostics).not.toContain(privateSessionId);
    } finally {
      await app.close();
    }
  });

  it('does not persist session identity or raw errors at session-started ingress', async () => {
    const privateSessionId = 'session-private-startup-identity';
    const privateStartupError = `startup failed for ${privateSessionId}`;
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: privateSessionId }),
      requestShutdown: () => {},
      onHappySessionWebhook: async () => {
        throw new Error(privateStartupError);
      },
      admitPersistedTakeover: async () => {
        throw new Error(privateStartupError);
      },
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      vi.mocked(logger.debug).mockClear();
      const ordinary = await app.inject({
        method: 'POST',
        url: '/session-started',
        headers: {
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'test-token',
        },
        payload: JSON.stringify({ sessionId: privateSessionId, metadata: {} }),
      });
      const persistedTakeover = await app.inject({
        method: 'POST',
        url: '/session-started',
        headers: {
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'test-token',
        },
        payload: JSON.stringify({
          sessionId: privateSessionId,
          metadata: {},
          persistedTakeoverAdmission: {
            mode: 'persisted',
            operationId: 'private-operation',
            attemptId: 'private-attempt',
            phase: 'admit',
            publisherPrecondition: {
              machineId: 'machine_local',
              committedFenceMs: 1,
            },
          },
        }),
      });

      expect(ordinary.statusCode).toBe(503);
      expect(ordinary.json()).toEqual({
        status: 'error',
        errorCode: 'session_startup_reconciliation_failed',
      });
      expect(persistedTakeover.statusCode).toBe(503);
      expect(persistedTakeover.json()).toEqual({
        status: 'error',
        errorCode: 'persisted_takeover_admission_failed',
      });
      const diagnostics = vi.mocked(logger.debug).mock.calls
        .flatMap((call) => call)
        .map((value) => value instanceof Error
          ? `${value.name}:${value.message}:${value.stack ?? ''}`
          : String(value))
        .join('|');
      expect(diagnostics).not.toContain(privateSessionId);
      expect(diagnostics).not.toContain(privateStartupError);
    } finally {
      await app.close();
    }
  });

  it('routes the strict terminal creation failure through the existing session-started callback', async () => {
    const onHappySessionWebhook = vi.fn();
    const onSessionStartupFailure = vi.fn(() => true);
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook,
      onSessionStartupFailure,
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-started',
        headers: {
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'test-token',
        },
        payload: JSON.stringify({
          result: 'failure',
          spawnNonce: 'creation-attempt-1',
          errorDetail: {
            kind: 'session_creation_organization_invalid',
            code: 'organization_invalid',
          },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
      expect(onSessionStartupFailure).toHaveBeenCalledWith({
        spawnNonce: 'creation-attempt-1',
        errorDetail: {
          kind: 'session_creation_organization_invalid',
          code: 'organization_invalid',
        },
      });
      expect(onHappySessionWebhook).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('preserves the full existing spawn-nonce grammar for terminal failures', async () => {
    const onSessionStartupFailure = vi.fn(() => true);
    const spawnNonce = 'n'.repeat(1_025);
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      onSessionStartupFailure,
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-started',
        headers: {
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'test-token',
        },
        payload: JSON.stringify({
          result: 'failure',
          spawnNonce,
          errorDetail: {
            kind: 'session_creation_organization_invalid',
            code: 'organization_invalid',
          },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(onSessionStartupFailure).toHaveBeenCalledWith({
        spawnNonce,
        errorDetail: {
          kind: 'session_creation_organization_invalid',
          code: 'organization_invalid',
        },
      });
    } finally {
      await app.close();
    }
  });

  it('preserves the terminal organization refusal on the original spawn response', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'error' as const,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'Session creation organization placement is invalid',
        errorDetail: {
          kind: 'session_creation_organization_invalid' as const,
          code: 'organization_invalid' as const,
        },
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: {
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'test-token',
        },
        payload: JSON.stringify({ directory: '/tmp' }),
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        success: false,
        error: 'Session creation organization placement is invalid',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorDetail: {
          kind: 'session_creation_organization_invalid',
          code: 'organization_invalid',
        },
      });
    } finally {
      await app.close();
    }
  });

  it('rejects retired first-turn and public Action fields from daemon control spawn requests', async () => {
    const spawnSession = vi.fn<Parameters<typeof createDaemonControlApp>[0]['spawnSession']>(async () => ({
      type: 'success' as const,
      sessionId: 'happy-test-123',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession,
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      for (const syntheticActionFields of [
        { initialPrompt: 'send this first turn' },
        { tag: 'predecessor metadata label' },
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: '/spawn-session',
          headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
          payload: JSON.stringify({
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            ...syntheticActionFields,
          }),
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({
          success: false,
          error: 'Invalid params',
          errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        });
      }

      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('passes canonical daemon spawn fields through to spawnSession and preserves fresh sessionId', async () => {
    let observed: any = null;

    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
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
      stopSession: async () => ({ status: 'not_found' as const }),
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
      stopSession: async () => ({ status: 'not_found' as const }),
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

  it('preserves recognized spawn error codes when spawnSession throws coded errors', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => {
        const error = new Error('provider preflight failed');
        (error as Error & { code: string }).code = SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED;
        throw error;
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
        error: 'Failed to spawn session: provider preflight failed',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
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
      stopSession: async () => ({ status: 'not_found' as const }),
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
      stopSession: async () => ({ status: 'not_found' as const }),
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

  it('preserves create-or-rejoin outcome in direct and nonce-settled spawn responses', async () => {
    const sessionCreationOutcome = {
      disposition: 'rejoined' as const,
      organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1'] },
    };
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'sess-outcome',
      sessionCreationOutcome,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession,
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
        payload: JSON.stringify({ directory: '/tmp', spawnNonce: 'nonce-outcome' }),
      });
      expect(spawnRes.json()).toEqual({
        success: true,
        sessionId: 'sess-outcome',
        approvedNewDirectoryCreation: true,
        sessionCreationOutcome,
      });

      const retryRes = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ directory: '/tmp/retry', spawnNonce: 'nonce-outcome' }),
      });
      expect(retryRes.json()).toEqual({
        success: true,
        sessionId: 'sess-outcome',
        approvedNewDirectoryCreation: true,
        sessionCreationOutcome,
      });
      expect(spawnSession).toHaveBeenCalledTimes(1);

      const resolveRes = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ spawnNonce: 'nonce-outcome' }),
      });
      expect(resolveRes.json()).toEqual({
        success: true,
        status: 'success',
        sessionId: 'sess-outcome',
        sessionCreationOutcome,
      });
    } finally {
      await app.close();
    }
  });

  it('returns cached spawn nonce success without starting another session', async () => {
    const spawnSession = vi
      .fn()
      .mockResolvedValueOnce({ type: 'success' as const, sessionId: 'sess-original' })
      .mockResolvedValueOnce({ type: 'success' as const, sessionId: 'sess-duplicate' });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession,
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const firstRes = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp/one',
          spawnNonce: 'nonce-cached-success',
        }),
      });
      expect(firstRes.statusCode).toBe(200);
      expect(firstRes.json()).toEqual({
        success: true,
        sessionId: 'sess-original',
        approvedNewDirectoryCreation: true,
      });

      const secondRes = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp/two',
          spawnNonce: 'nonce-cached-success',
        }),
      });
      expect(secondRes.statusCode).toBe(200);
      expect(secondRes.json()).toEqual({
        success: true,
        sessionId: 'sess-original',
        approvedNewDirectoryCreation: true,
      });
      expect(spawnSession).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns pending for duplicate in-flight spawn nonce without starting another session', async () => {
    let resolveStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const resolvers: Array<() => void> = [];
    const spawnSession = vi.fn(async () => {
      resolveStarted?.();
      return await new Promise<{ type: 'success'; sessionId: string }>((resolve) => {
        resolvers.push(() => resolve({ type: 'success', sessionId: 'sess-in-flight' }));
      });
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession,
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const firstSpawn = app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp/one',
          spawnNonce: 'nonce-in-flight',
        }),
      });
      await started;

      const duplicateSpawn = app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp/two',
          spawnNonce: 'nonce-in-flight',
        }),
      });
      const duplicateResult = await Promise.race([
        duplicateSpawn,
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
      ]);
      expect(duplicateResult).not.toBe('timed-out');
      if (duplicateResult === 'timed-out') throw new Error('duplicate spawn timed out');
      expect(duplicateResult.statusCode).toBe(202);
      expect(duplicateResult.json()).toEqual({
        success: false,
        status: 'pending',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      });
      expect(spawnSession).toHaveBeenCalledTimes(1);

      for (const resolve of resolvers) resolve();
      const firstResult = await firstSpawn;
      expect(firstResult.statusCode).toBe(200);
    } finally {
      for (const resolve of resolvers) resolve();
      await app.close();
    }
  });

  it('rejoins a reattached pre-webhook child on a direct same-nonce retry without launching a competitor', async () => {
    const trackedChildren = [
      {
        startedBy: 'daemon',
        pid: 124,
        happySessionId: 'PID-124',
        spawnOptions: { directory: '/tmp/original', spawnNonce: 'nonce-reattached-pending' },
        reattachedFromDiskMarker: true,
      },
    ];
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'sess-duplicate' }));
    const onHappySessionWebhook = vi.fn((sessionId: string) => {
      trackedChildren[0]!.happySessionId = sessionId;
    });
    const app = createDaemonControlApp({
      getChildren: () => trackedChildren,
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession,
      requestShutdown: () => {},
      onHappySessionWebhook,
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const retryRes = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp/retry',
          spawnNonce: 'nonce-reattached-pending',
        }),
      });

      expect(retryRes.statusCode).toBe(202);
      expect(retryRes.json()).toEqual({
        success: false,
        status: 'pending',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      });
      expect(spawnSession).not.toHaveBeenCalled();
      expect(trackedChildren).toHaveLength(1);

      const webhookRes = await app.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ sessionId: 'sess-original', metadata: {} }),
      });
      expect(webhookRes.statusCode).toBe(200);
      expect(onHappySessionWebhook).toHaveBeenCalledTimes(1);
      const resolvedRetryRes = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp/retry-again',
          spawnNonce: 'nonce-reattached-pending',
        }),
      });
      expect(resolvedRetryRes.statusCode).toBe(200);
      expect(resolvedRetryRes.json()).toEqual({
        success: true,
        sessionId: 'sess-original',
        approvedNewDirectoryCreation: true,
      });
      expect(spawnSession).not.toHaveBeenCalled();
      expect(trackedChildren).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('marks spawn-nonce success only after async session-started readiness adopts the canonical id', async () => {
    const trackedChildren = [{
      startedBy: 'daemon',
      pid: 125,
      happySessionId: 'PID-125',
      spawnOptions: {
        directory: '/tmp/original',
        spawnNonce: 'nonce-async-readiness',
      },
    }];
    let resolveReadiness!: () => void;
    const readiness = new Promise<void>((resolve) => {
      resolveReadiness = resolve;
    });
    const onHappySessionWebhook = vi.fn(
      async (sessionId: string) => {
        await readiness;
        trackedChildren[0]!.happySessionId = sessionId;
      },
    );
    const app = createDaemonControlApp({
      getChildren: () => trackedChildren,
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: vi.fn(),
      requestShutdown: () => {},
      onHappySessionWebhook,
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const webhook = app.inject({
        method: 'POST',
        url: '/session-started',
        headers: {
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'test-token',
        },
        payload: JSON.stringify({
          sessionId: 'sess-async-readiness',
          metadata: {},
        }),
      });
      await vi.waitFor(() => {
        expect(onHappySessionWebhook).toHaveBeenCalledOnce();
      });
      const pending = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: {
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'test-token',
        },
        payload: JSON.stringify({
          spawnNonce: 'nonce-async-readiness',
        }),
      });
      expect(pending.json()).toEqual({
        success: true,
        status: 'pending',
      });

      resolveReadiness();
      expect((await webhook).statusCode).toBe(200);
      trackedChildren.splice(0);
      const resolved = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: {
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'test-token',
        },
        payload: JSON.stringify({
          spawnNonce: 'nonce-async-readiness',
        }),
      });
      expect(resolved.json()).toEqual({
        success: true,
        status: 'success',
        sessionId: 'sess-async-readiness',
      });
    } finally {
      resolveReadiness();
      await app.close();
    }
  });

  it('does not mark spawn-nonce success when async session-started readiness refuses', async () => {
    const trackedChildren = [{
      startedBy: 'daemon',
      pid: 126,
      happySessionId: 'PID-126',
      spawnOptions: {
        directory: '/tmp/original',
        spawnNonce: 'nonce-refused-readiness',
      },
    }];
    const app = createDaemonControlApp({
      getChildren: () => trackedChildren,
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: vi.fn(),
      requestShutdown: () => {},
      onHappySessionWebhook: async (sessionId) => {
        trackedChildren[0]!.happySessionId = sessionId;
        await Promise.resolve();
        trackedChildren.splice(0);
        throw new Error('custody refused');
      },
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const webhook = await app.inject({
        method: 'POST',
        url: '/session-started',
        headers: {
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'test-token',
        },
        payload: JSON.stringify({
          sessionId: 'sess-refused-readiness',
          metadata: {},
        }),
      });
      expect(webhook.statusCode).toBe(503);

      const resolved = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: {
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'test-token',
        },
        payload: JSON.stringify({
          spawnNonce: 'nonce-refused-readiness',
        }),
      });
      expect(resolved.json()).toEqual({
        success: true,
        status: 'not_found',
      });
    } finally {
      await app.close();
    }
  });

  it('returns recoverable pending for the first timed-out spawn nonce and resolves after the webhook arrives', async () => {
    let trackedChildren: any[] = [];
    const spawnSession = vi
      .fn()
      .mockResolvedValueOnce({
        type: 'error' as const,
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Timed out waiting for session webhook',
      })
      .mockResolvedValueOnce({ type: 'success' as const, sessionId: 'sess-duplicate' });
    const app = createDaemonControlApp({
      getChildren: () => trackedChildren,
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession,
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const firstRes = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp/one',
          spawnNonce: 'nonce-timeout-pending',
        }),
      });
      expect(firstRes.statusCode).toBe(202);
      expect(firstRes.json()).toEqual({
        success: false,
        status: 'pending',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      });

      const secondRes = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp/two',
          spawnNonce: 'nonce-timeout-pending',
        }),
      });
      expect(secondRes.statusCode).toBe(202);
      expect(secondRes.json()).toEqual({
        success: false,
        status: 'pending',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      });
      expect(spawnSession).toHaveBeenCalledTimes(1);

      trackedChildren = [
        {
          startedBy: 'daemon',
          pid: 123,
          happySessionId: 'sess-timeout-resolved',
          spawnOptions: { directory: '/tmp/one', spawnNonce: 'nonce-timeout-pending' },
        },
      ];
      const webhookRes = await app.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          sessionId: 'sess-timeout-resolved',
          metadata: {},
        }),
      });
      expect(webhookRes.statusCode).toBe(200);

      const resolveRes = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ spawnNonce: 'nonce-timeout-pending' }),
      });
      expect(resolveRes.statusCode).toBe(200);
      expect(resolveRes.json()).toEqual({
        success: true,
        status: 'success',
        sessionId: 'sess-timeout-resolved',
      });
    } finally {
      await app.close();
    }
  });

  it('settles an admitted nonce to first terminal child-exit failure and replays it', async () => {
    let settleSpawn!: (result: {
      type: 'error';
      errorCode: typeof SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK;
      errorMessage: string;
    }) => void;
    let trackedChildren: any[] = [];
    const spawnSession = vi.fn(async () => await new Promise<{
      type: 'error';
      errorCode: typeof SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK;
      errorMessage: string;
    }>((resolve) => {
      settleSpawn = resolve;
    }));
    const app = createDaemonControlApp({
      getChildren: () => trackedChildren,
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession,
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });
    const headers = { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' };
    const payload = JSON.stringify({ directory: '/tmp', spawnNonce: 'nonce-child-exit' });
    const errorMessage = 'Child process exited before session webhook (pid=8892, code=1, signal=null)';

    try {
      await app.ready();
      const firstSpawn = app.inject({ method: 'POST', url: '/spawn-session', headers, payload });
      await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledOnce());

      await expect(app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers,
        payload: JSON.stringify({ spawnNonce: 'nonce-child-exit' }),
      })).resolves.toMatchObject({ statusCode: 200 });

      settleSpawn({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
        errorMessage,
      });
      expect((await firstSpawn).json()).toMatchObject({
        success: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
        error: errorMessage,
      });

      const terminal = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers,
        payload: JSON.stringify({ spawnNonce: 'nonce-child-exit' }),
      });
      expect(terminal.json()).toEqual({
        success: true,
        status: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
        errorMessage,
      });

      const retry = await app.inject({ method: 'POST', url: '/spawn-session', headers, payload });
      expect(retry.json()).toMatchObject({
        success: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
        error: errorMessage,
      });
      expect(spawnSession).toHaveBeenCalledOnce();

      trackedChildren = [{
        startedBy: 'daemon',
        pid: 8892,
        happySessionId: 'session-too-late',
        spawnOptions: { directory: '/tmp', spawnNonce: 'nonce-child-exit' },
      }];
      expect((await app.inject({
        method: 'POST',
        url: '/session-started',
        headers,
        payload: JSON.stringify({ sessionId: 'session-too-late', metadata: {} }),
      })).statusCode).toBe(200);
      expect((await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers,
        payload: JSON.stringify({ spawnNonce: 'nonce-child-exit' }),
      })).json()).toEqual({
        success: true,
        status: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
        errorMessage,
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
      stopSession: async () => ({ status: 'not_found' as const }),
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
      stopSession: async () => ({ status: 'not_found' as const }),
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
      stopSession: async () => ({ status: 'not_found' as const }),
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
