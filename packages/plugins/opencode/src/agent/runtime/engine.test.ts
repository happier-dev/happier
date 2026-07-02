import { describe, expect, it, vi } from 'vitest';

import type { PluginContextV1 } from '@happier-dev/plugin-sdk';

import { createOpenCodeBackendEngine } from './engine.js';

function createPluginContextFixture(): PluginContextV1 {
  // Unit fixture: this test only verifies context forwarding to plugin-owned runtime leaves.
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as PluginContextV1;
}

describe('createOpenCodeBackendEngine', () => {
  it('creates a server session runtime plan through the default plugin-owned leaf', async () => {
    const ctx = createPluginContextFixture();
    const engine = createOpenCodeBackendEngine(ctx);

    await expect(
      engine.runtimeCore?.createSessionRuntime({ cwd: '/tmp/opencode' }),
    ).resolves.toMatchObject({
      kind: 'hostSessionRuntimePlan',
      providerId: 'opencode',
      config: {
        backendDisplayName: 'OpenCode',
        providerName: 'opencode',
      },
    });
  });

  it('creates an ACP backend through ctx.acp.defineAcpBackend by default', async () => {
    const acpRuntime = { kind: 'acp-runtime' };
    const acpEngine = {
      runtimeCore: {
        createSessionRuntime: vi.fn(async () => acpRuntime),
        createExecutionRunBackend: vi.fn(),
      },
    };
    const ctx = {
      ...createPluginContextFixture(),
      acp: {
        defineAcpBackend: vi.fn(() => acpEngine),
      },
    } as unknown as PluginContextV1;
    const engine = createOpenCodeBackendEngine(ctx);

    await expect(
      engine.runtimeCore?.createSessionRuntime({
        isolation: { env: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' } },
      }),
    ).resolves.toBe(acpRuntime);

    expect(ctx.acp.defineAcpBackend).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'opencode',
      mcp: { policy: 'pass_through' },
    }));
  });

  it('creates a server execution-run runtime through the default plugin-owned leaf', () => {
    const ctx = createPluginContextFixture();
    const engine = createOpenCodeBackendEngine(ctx);

    expect(engine.runtimeCore?.createExecutionRunBackend({
      cwd: '/tmp/opencode',
      backendId: 'opencode',
      permissionMode: 'read_only',
    })).toEqual(expect.objectContaining({
      readResumeSupport: expect.any(Function),
      provisionSession: expect.any(Function),
      sendPrompt: expect.any(Function),
      waitForTurnCompletion: expect.any(Function),
      probeTurnLiveness: expect.any(Function),
      dispose: expect.any(Function),
    }));
  });

  it('dispatches session runtime creation to the server leaf by default', async () => {
    const ctx = createPluginContextFixture();
    const serverRuntime = { kind: 'server-runtime' };
    const server = vi.fn(async () => serverRuntime);
    const acp = vi.fn(async () => ({ kind: 'acp-runtime' }));
    const executionRuns = vi.fn(() => ({ kind: 'execution-run-runtime' }));
    const engine = createOpenCodeBackendEngine(ctx, {
      sessionRuntimes: { server, acp },
      executionRuns,
    });

    await expect(
      engine.runtimeCore?.createSessionRuntime({ cwd: '/tmp/opencode' }),
    ).resolves.toBe(serverRuntime);

    expect(server).toHaveBeenCalledWith({
      ctx,
      sessionParams: { cwd: '/tmp/opencode' },
    });
    expect(acp).not.toHaveBeenCalled();
  });

  it('lets explicit execution environment opt into ACP mode', async () => {
    const ctx = createPluginContextFixture();
    const acpRuntime = { kind: 'acp-runtime' };
    const server = vi.fn(async () => ({ kind: 'server-runtime' }));
    const acp = vi.fn(async () => acpRuntime);
    const executionRuns = vi.fn(() => ({ kind: 'execution-run-runtime' }));
    const engine = createOpenCodeBackendEngine(ctx, {
      sessionRuntimes: { server, acp },
      executionRuns,
    });

    await expect(
      engine.runtimeCore?.createSessionRuntime({
        cwd: '/tmp/opencode',
        isolation: {
          env: {
            HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
          },
        },
        accountSettings: {
          opencodeBackendMode: 'server',
        },
      }),
    ).resolves.toBe(acpRuntime);

    expect(acp).toHaveBeenCalledTimes(1);
    expect(server).not.toHaveBeenCalled();
  });

  it('routes execution-run backend creation through the plugin execution-run leaf', () => {
    const ctx = createPluginContextFixture();
    const executionRunRuntime = { kind: 'execution-run-runtime' };
    const server = vi.fn(async () => ({ kind: 'server-runtime' }));
    const acp = vi.fn(async () => ({ kind: 'acp-runtime' }));
    const executionRuns = vi.fn(() => executionRunRuntime);
    const engine = createOpenCodeBackendEngine(ctx, {
      sessionRuntimes: { server, acp },
      executionRuns,
    });
    const executionRunParams = {
      cwd: '/tmp/opencode',
      permissionMode: 'read_only',
      accountSettings: {
        opencodeBackendMode: 'acp',
      },
    };

    expect(engine.runtimeCore?.createExecutionRunBackend(executionRunParams)).toBe(executionRunRuntime);
    expect(executionRuns).toHaveBeenCalledWith({
      ctx,
      mode: 'acp',
      executionRunParams,
    });
  });
});
