import { afterEach, describe, expect, it, vi } from 'vitest';
import { delimiter, resolve } from 'node:path';

const { probeCodexAppServerExecutionRunAvailabilityMock } = vi.hoisted(() => ({
  probeCodexAppServerExecutionRunAvailabilityMock: vi.fn(() => true),
}));

vi.mock('./probeCodexAppServerExecutionRunAvailability', () => ({
  probeCodexAppServerExecutionRunAvailability: probeCodexAppServerExecutionRunAvailabilityMock,
}));

describe('executionRunBackendFactory (codex)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    probeCodexAppServerExecutionRunAvailabilityMock.mockImplementation(() => true);
  });

  it('scrubs Codex session attach env while preserving isolated execution-run env', async () => {
    const captured: Array<Record<string, unknown>> = [];

    vi.doMock('@/backends/codex/acp/backend', () => ({
      createCodexAcpBackend: (options: Record<string, unknown>) => {
        captured.push(options);
        return { backend: { dispose: async () => undefined } };
      },
    }));
    vi.doMock('@/backends/codex/acp/resolveCommand', () => ({
      resolveCodexAcpSpawn: () => ({ command: 'codex-acp', args: [] }),
    }));
    vi.doMock('@/backends/codex/acp/spawnAvailability', () => ({
      validateCodexAcpSpawnAvailability: () => ({ ok: true }),
    }));

    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    executionRunBackendFactory({
      cwd: '/tmp/happier-worktree',
      backendId: 'codex',
      permissionMode: 'read_only',
      isolation: {
        env: {
          PATH: '/tmp/isolated-bin:/usr/bin',
          HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'acp',
          XDG_STATE_HOME: '/tmp/state',
          CODEX_THREAD_ID: 'poisoned-thread',
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'poisoned-origin',
          CODEX_SHELL: '/bin/zsh',
        },
      },
    } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.env).toMatchObject({
      XDG_STATE_HOME: '/tmp/state',
      PATH: `${resolve('/tmp/happier-worktree', 'scripts', 'shims')}${delimiter}/tmp/isolated-bin:/usr/bin`,
    });
    expect(captured[0]?.env).not.toHaveProperty('CODEX_THREAD_ID');
    expect(captured[0]?.env).not.toHaveProperty('CODEX_INTERNAL_ORIGINATOR_OVERRIDE');
    expect(captured[0]?.env).not.toHaveProperty('CODEX_SHELL');
  });

  it('falls back to MCP when Codex ACP is selected but codex-acp is unavailable', async () => {
    const acpCalls: Array<Record<string, unknown>> = [];
    const mcpCalls: Array<Record<string, unknown>> = [];

    vi.doMock('@/backends/codex/acp/backend', () => ({
      createCodexAcpBackend: (options: Record<string, unknown>) => {
        acpCalls.push(options);
        return { backend: { dispose: async () => undefined } };
      },
    }));
    vi.doMock('./createCodexMcpExecutionRunBackend', () => ({
      createCodexMcpExecutionRunBackend: (options: Record<string, unknown>) => {
        mcpCalls.push(options);
        return { dispose: async () => undefined };
      },
    }));
    vi.doMock('@/backends/codex/acp/resolveCommand', () => ({
      resolveCodexAcpSpawn: () => ({ command: 'codex-acp', args: [] }),
    }));
    vi.doMock('@/backends/codex/acp/spawnAvailability', () => ({
      validateCodexAcpSpawnAvailability: () => ({ ok: false, errorMessage: 'codex-acp is not available on PATH' }),
    }));

    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    executionRunBackendFactory({
      cwd: '/tmp/happier-worktree',
      backendId: 'codex',
      permissionMode: 'read_only',
      start: {
        intent: 'delegate',
        retentionPolicy: 'ephemeral',
      },
      isolation: {
        env: {
          PATH: '/tmp/isolated-bin:/usr/bin',
          HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'acp',
        },
      },
    } as any);

    expect(acpCalls).toHaveLength(0);
    expect(mcpCalls).toHaveLength(1);
    expect(mcpCalls[0]?.env).toMatchObject({
      PATH: `${resolve('/tmp/happier-worktree', 'scripts', 'shims')}${delimiter}/tmp/isolated-bin:/usr/bin`,
    });
  });

  it('resolves Codex ACP against the isolated env when deciding whether to fall back to MCP', async () => {
    const acpCalls: Array<Record<string, unknown>> = [];
    const mcpCalls: Array<Record<string, unknown>> = [];

    vi.doMock('@/backends/codex/acp/backend', () => ({
      createCodexAcpBackend: (options: Record<string, unknown>) => {
        acpCalls.push(options);
        return { backend: { dispose: async () => undefined } };
      },
    }));
    vi.doMock('./createCodexMcpExecutionRunBackend', () => ({
      createCodexMcpExecutionRunBackend: (options: Record<string, unknown>) => {
        mcpCalls.push(options);
        return { dispose: async () => undefined };
      },
    }));
    vi.doMock('@/backends/codex/acp/resolveCommand', () => ({
      resolveCodexAcpSpawn: () => ({ command: '/tmp/isolated-bin/codex-acp', args: [] }),
    }));
    vi.doMock('@/backends/codex/acp/spawnAvailability', () => ({
      validateCodexAcpSpawnAvailability: (_spec: Record<string, unknown>, opts?: Record<string, unknown>) => {
        const env = opts?.env as NodeJS.ProcessEnv | undefined;
        return env?.PATH?.includes('/tmp/isolated-bin') ? { ok: true } : { ok: false, errorMessage: 'missing isolated bin' };
      },
    }));

    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    executionRunBackendFactory({
      cwd: '/tmp/happier-worktree',
      backendId: 'codex',
      permissionMode: 'read_only',
      start: {
        intent: 'delegate',
        retentionPolicy: 'ephemeral',
      },
      isolation: {
        env: {
          PATH: '/tmp/isolated-bin:/usr/bin',
          HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'acp',
        },
      },
    } as any);

    expect(acpCalls).toHaveLength(1);
    expect(mcpCalls).toHaveLength(0);
  });

  it('creates the app-server backend when the isolated execution-run transport opts into it', async () => {
    const acpCalls: Array<Record<string, unknown>> = [];
    const appServerCalls: Array<Record<string, unknown>> = [];

    vi.doMock('@/backends/codex/acp/backend', () => ({
      createCodexAcpBackend: (options: Record<string, unknown>) => {
        acpCalls.push(options);
        return { backend: { dispose: async () => undefined } };
      },
    }));
    vi.doMock('./createCodexAppServerExecutionRunBackend', () => ({
      createCodexAppServerExecutionRunBackend: (options: Record<string, unknown>) => {
        appServerCalls.push(options);
        return { dispose: async () => undefined };
      },
    }));

    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    executionRunBackendFactory({
      cwd: '/tmp/happier-worktree',
      backendId: 'codex',
      permissionMode: 'read_only',
      start: {
        intent: 'delegate',
        retentionPolicy: 'ephemeral',
      },
      isolation: {
        env: {
          PATH: '/tmp/isolated-bin:/usr/bin',
          HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'appServer',
        },
      },
    } as any);

    expect(acpCalls).toHaveLength(0);
    expect(appServerCalls).toHaveLength(1);
    expect(appServerCalls[0]).toMatchObject({
      cwd: '/tmp/happier-worktree',
      permissionMode: 'read-only',
      env: expect.objectContaining({
        HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'appServer',
        PATH: `${resolve('/tmp/happier-worktree', 'scripts', 'shims')}${delimiter}/tmp/isolated-bin:/usr/bin`,
      }),
    });
  });

  it('resolves HAPPIER_CODEX_BACKEND_MODE against the isolated env (not process.env) when selecting the transport', async () => {
    const mcpCalls: Array<Record<string, unknown>> = [];
    const appServerCalls: Array<Record<string, unknown>> = [];

    vi.doMock('./createCodexMcpExecutionRunBackend', () => ({
      createCodexMcpExecutionRunBackend: (options: Record<string, unknown>) => {
        mcpCalls.push(options);
        return { dispose: async () => undefined };
      },
    }));
    vi.doMock('./createCodexAppServerExecutionRunBackend', () => ({
      createCodexAppServerExecutionRunBackend: (options: Record<string, unknown>) => {
        appServerCalls.push(options);
        return { dispose: async () => undefined };
      },
    }));
    vi.doMock('@/backends/codex/acp/resolveCommand', () => ({
      resolveCodexAcpSpawn: () => ({ command: 'codex-acp', args: [] }),
    }));
    vi.doMock('@/backends/codex/acp/spawnAvailability', () => ({
      validateCodexAcpSpawnAvailability: () => ({ ok: true }),
    }));

    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    executionRunBackendFactory({
      cwd: '/tmp/happier-worktree',
      backendId: 'codex',
      permissionMode: 'read_only',
      accountSettings: {},
      start: {
        intent: 'delegate',
        retentionPolicy: 'ephemeral',
      },
      isolation: {
        env: {
          PATH: '/tmp/isolated-bin:/usr/bin',
          HAPPIER_CODEX_BACKEND_MODE: 'mcp',
        },
      },
    } as any);

    expect(appServerCalls).toHaveLength(0);
    expect(mcpCalls).toHaveLength(1);
  });

  it('prefers the app-server backend by default when probing succeeds', async () => {
    const acpCalls: Array<Record<string, unknown>> = [];
    const appServerCalls: Array<Record<string, unknown>> = [];

    vi.doMock('@/backends/codex/acp/backend', () => ({
      createCodexAcpBackend: (options: Record<string, unknown>) => {
        acpCalls.push(options);
        return { backend: { dispose: async () => undefined } };
      },
    }));
    vi.doMock('./createCodexAppServerExecutionRunBackend', () => ({
      createCodexAppServerExecutionRunBackend: (options: Record<string, unknown>) => {
        appServerCalls.push(options);
        return { dispose: async () => undefined };
      },
    }));

    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    executionRunBackendFactory({
      cwd: '/tmp/happier-worktree',
      backendId: 'codex',
      permissionMode: 'read_only',
      start: {
        intent: 'delegate',
        retentionPolicy: 'ephemeral',
      },
      isolation: {
        env: {
          PATH: '/tmp/isolated-bin:/usr/bin',
        },
      },
    } as any);

    expect(acpCalls).toHaveLength(0);
    expect(appServerCalls).toHaveLength(1);
    expect(appServerCalls[0]).toMatchObject({
      cwd: '/tmp/happier-worktree',
      permissionMode: 'read-only',
      env: expect.objectContaining({
        PATH: `${resolve('/tmp/happier-worktree', 'scripts', 'shims')}${delimiter}/tmp/isolated-bin:/usr/bin`,
      }),
    });
  });

  it('honors the account-settings Codex backend mode when no execution-run override is set', async () => {
    const acpCalls: Array<Record<string, unknown>> = [];
    const appServerCalls: Array<Record<string, unknown>> = [];
    const mcpCalls: Array<Record<string, unknown>> = [];

    vi.doMock('@/backends/codex/acp/backend', () => ({
      createCodexAcpBackend: (options: Record<string, unknown>) => {
        acpCalls.push(options);
        return { backend: { dispose: async () => undefined } };
      },
    }));
    vi.doMock('./createCodexAppServerExecutionRunBackend', () => ({
      createCodexAppServerExecutionRunBackend: (options: Record<string, unknown>) => {
        appServerCalls.push(options);
        return { dispose: async () => undefined };
      },
    }));
    vi.doMock('./createCodexMcpExecutionRunBackend', () => ({
      createCodexMcpExecutionRunBackend: (options: Record<string, unknown>) => {
        mcpCalls.push(options);
        return { dispose: async () => undefined };
      },
    }));
    vi.doMock('@/backends/codex/acp/resolveCommand', () => ({
      resolveCodexAcpSpawn: () => ({ command: 'codex-acp', args: [] }),
    }));
    vi.doMock('@/backends/codex/acp/spawnAvailability', () => ({
      validateCodexAcpSpawnAvailability: () => ({ ok: true }),
    }));

    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    executionRunBackendFactory({
      cwd: '/tmp/happier-worktree',
      backendId: 'codex',
      permissionMode: 'read_only',
      accountSettings: { codexBackendMode: 'mcp' },
      start: {
        intent: 'delegate',
        retentionPolicy: 'ephemeral',
      },
      isolation: {
        env: {
          PATH: '/tmp/isolated-bin:/usr/bin',
        },
      },
    } as any);

    expect(mcpCalls).toHaveLength(1);
    expect(acpCalls).toHaveLength(0);
    expect(appServerCalls).toHaveLength(0);
  });

  it('prefers the app-server backend by default for voice_agent runs when probing succeeds', async () => {
    const acpCalls: Array<Record<string, unknown>> = [];
    const appServerCalls: Array<Record<string, unknown>> = [];

    vi.doMock('@/backends/codex/acp/backend', () => ({
      createCodexAcpBackend: (options: Record<string, unknown>) => {
        acpCalls.push(options);
        return { backend: { dispose: async () => undefined } };
      },
    }));
    vi.doMock('./createCodexAppServerExecutionRunBackend', () => ({
      createCodexAppServerExecutionRunBackend: (options: Record<string, unknown>) => {
        appServerCalls.push(options);
        return { dispose: async () => undefined };
      },
    }));

    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    executionRunBackendFactory({
      cwd: '/tmp/happier-worktree',
      backendId: 'codex',
      permissionMode: 'read_only',
      start: {
        intent: 'voice_agent',
        retentionPolicy: 'resumable',
      },
      isolation: {
        env: {
          PATH: '/tmp/isolated-bin:/usr/bin',
        },
      },
    } as any);

    expect(acpCalls).toHaveLength(0);
    expect(appServerCalls).toHaveLength(1);
    expect(appServerCalls[0]).toMatchObject({
      cwd: '/tmp/happier-worktree',
      permissionMode: 'read-only',
      env: expect.objectContaining({
        PATH: `${resolve('/tmp/happier-worktree', 'scripts', 'shims')}${delimiter}/tmp/isolated-bin:/usr/bin`,
      }),
    });
  });

  it('falls back to ACP when the isolated execution-run transport opts into app-server but probing fails', async () => {
    const acpCalls: Array<Record<string, unknown>> = [];
    const appServerCalls: Array<Record<string, unknown>> = [];

    vi.doMock('@/backends/codex/acp/backend', () => ({
      createCodexAcpBackend: (options: Record<string, unknown>) => {
        acpCalls.push(options);
        return { backend: { dispose: async () => undefined } };
      },
    }));
    vi.doMock('./createCodexAppServerExecutionRunBackend', () => ({
      createCodexAppServerExecutionRunBackend: (options: Record<string, unknown>) => {
        appServerCalls.push(options);
        return { dispose: async () => undefined };
      },
    }));
    vi.doMock('@/backends/codex/acp/resolveCommand', () => ({
      resolveCodexAcpSpawn: () => ({ command: 'codex-acp', args: [] }),
    }));
    vi.doMock('@/backends/codex/acp/spawnAvailability', () => ({
      validateCodexAcpSpawnAvailability: () => ({ ok: true }),
    }));

    probeCodexAppServerExecutionRunAvailabilityMock.mockReturnValue(false);

    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    await executionRunBackendFactory({
      cwd: '/tmp/happier-worktree',
      backendId: 'codex',
      permissionMode: 'read_only',
      start: {
        intent: 'delegate',
        retentionPolicy: 'ephemeral',
      },
      isolation: {
        env: {
          PATH: '/tmp/isolated-bin:/usr/bin',
          HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'appServer',
        },
      },
    } as any);

    expect(appServerCalls).toHaveLength(0);
    expect(acpCalls).toHaveLength(1);
    expect(acpCalls[0]).toMatchObject({
      cwd: '/tmp/happier-worktree',
      permissionMode: 'read-only',
      env: expect.objectContaining({
        HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'appServer',
        PATH: `${resolve('/tmp/happier-worktree', 'scripts', 'shims')}${delimiter}/tmp/isolated-bin:/usr/bin`,
      }),
    });
  });
});
