import type {
  AgentRuntimeFactoryContext,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import { buildCodexAgentRuntimeDescriptorV1 } from '../../protocol/runtimeDescriptorV1.js';
import { resolveCodexCliSessionExtraOptions } from '../cli/command.js';
import { createCodexAgentRuntime } from './engine.js';

function createSession(): AgentSessionRuntime {
  return {
    async send() {
      return { status: 'admitted' };
    },
    watch() {
      return { dispose() {} };
    },
    async dispose() {},
  };
}

function createConnectedAccountsBoundary() {
  return {
    getBinding: vi.fn(async () => null),
    requestSelection: vi.fn(),
    materialize: vi.fn(),
    watch: vi.fn(() => ({ dispose() {} })),
  };
}

describe('createCodexAgentRuntime', () => {
  it.each(['plain', undefined, 'herdr', 'zellij', 'tmux'] as const)(
    'keeps shared attach available without starting an invisible client for host %s',
    async (requestedHost) => {
      const runtime = await createCodexAgentRuntime({
        plugin: { id: 'happier.agent.codex', version: '0.0.0' },
        agent: { id: 'codex' }, signal: new AbortController().signal,
      });
      if (!runtime.sessions?.resolveTerminalPresentation) throw new Error('Codex presentation owner is unavailable');
      const selected = await runtime.sessions.resolveTerminalPresentation({
        requestedHost,
        launchEnvironment: { values: { HAPPIER_CODEX_BACKEND_MODE: 'appServer' } },
      }, {
        settings: { forScope() { throw new Error('Explicit Codex selection must not read account settings'); } },
        features: { isEnabled() { throw new Error('Explicit Codex selection must not read feature policy'); } },
      });
      const hosted = requestedHost !== 'plain' && requestedHost !== undefined;
      expect(selected).toMatchObject({
        kind: 'provider_attach', startingMode: hosted ? 'terminal' : 'remote',
        runtimeDescriptorV1: { agentId: 'codex', agent: { backendMode: 'appServer' } },
        environmentOverlay: { HAPPIER_CODEX_BACKEND_MODE: 'appServer' },
      });
      // The real CLI consumer translates the selected public mode into its
      // host mode; plain daemon startup must not become a local native launch.
      expect(resolveCodexCliSessionExtraOptions({ startingMode: selected.startingMode, agentArgs: [] }))
        .toEqual({ ok: true, options: { startingMode: hosted ? 'local' : 'remote' } });
    },
  );

  it('keeps captured ACP headless even when a terminal host is selected', async () => {
    const runtime = await createCodexAgentRuntime({
      plugin: { id: 'happier.agent.codex', version: '0.0.0' },
      agent: { id: 'codex' }, signal: new AbortController().signal,
    });
    const selected = await runtime.sessions?.resolveTerminalPresentation?.({
      requestedHost: 'herdr',
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'acp' } },
      launchEnvironment: { values: { HAPPIER_CODEX_BACKEND_MODE: 'appServer' } },
    }, {
      settings: { forScope() { throw new Error('Captured Codex selection must not read account settings'); } },
      features: { isEnabled() { throw new Error('Captured Codex selection must not read feature policy'); } },
    });
    expect(selected).toMatchObject({ kind: 'none', runtimeDescriptorV1: { agent: { backendMode: 'acp' } } });
    expect(selected?.startingMode).toBeUndefined();
  });

  it('forces the native read-only sandbox for hands-off even with the default permission mode', async () => {
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);
    const plan = await runtime.surfaces?.terminal?.resolveLaunch({
      sessionId: 'hands-off', cwd: '/repo', metadata: {}, modelSelection: null,
      configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {}, workspaceWrites: 'deny' },
    });
    expect(plan?.argv).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
  });

  it('exposes every declared Codex direct session control through the native factory', async () => {
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);

    expect(runtime.sessions).toMatchObject({
      goals: {
        get: expect.any(Function),
        set: expect.any(Function),
        clear: expect.any(Function),
      },
      catalog: { list: expect.any(Function) },
      usageLimitRecovery: { execute: expect.any(Function) },
      continuation: { verify: expect.any(Function) },
    });
    expect(runtime.surfaces?.handoff).toMatchObject({
      exportBundle: expect.any(Function),
      importBundle: expect.any(Function),
    });
  });

  it('opens ACP with the exact host-prepared launch environment and does not recustody Connected Account credentials', async () => {
    const open = vi.fn(async () => createSession());
    const connectedAccounts = createConnectedAccountsBoundary();
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
      services: { connectedAccounts },
      signal: new AbortController().signal,
    } as unknown as AgentSessionRuntimeContext;
    const request = {
      kind: 'resume' as const,
      sessionId: 'session-1',
      cwd: '/repo',
      providerSessionId: 'provider-1',
      launchEnvironment: {
        values: {
          HAPPIER_CODEX_BACKEND_MODE: 'acp',
          CODEX_HOME: '/host/materialized/codex-home',
        },
        unset: ['OPENAI_API_KEY'],
      },
    };

    const opened = await runtime.sessions?.open(request, context);

    expect(opened?.runtimeCapabilities).toEqual({
      localControl: null,
      sessionCapabilities: {
        sessionListing: 'supported',
        sessionFork: {
          conversation: 'unsupported',
          fromMessage: 'unsupported',
          protocol: 'acp',
        },
        sessionRollback: { conversation: 'unsupported' },
      },
    });

    expect(open).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        transport: expect.objectContaining({
          executable: { kind: 'managedDependency', id: 'codex-acp' },
        }),
      }),
    );
    expect(connectedAccounts.watch).not.toHaveBeenCalled();
    expect(connectedAccounts.getBinding).not.toHaveBeenCalled();
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();

    await expect(Promise.resolve(runtime.surfaces?.terminal?.resolveLaunch({
      sessionId: 'terminal-1',
      cwd: '/repo',
      metadata: {
        runtimeDescriptorV1: buildCodexAgentRuntimeDescriptorV1({
          backendMode: 'acp',
          providerSessionId: 'provider-1',
        }),
      },
      configuration: {
        mode: { value: null, updatedAtMs: 0 },
        model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'read-only', updatedAtMs: 1 },
        options: {},
      },
      modelSelection: null,
    }))).resolves.toMatchObject({
      argv: [
        'resume',
        'provider-1',
        '--cd',
        '/repo',
        '--ask-for-approval',
        'never',
        '--sandbox',
        'read-only',
      ],
      process: { stdio: 'inherit', windowsHide: true },
    });
  });

  it('rejects startup instructions for ACP before launch without touching Connected Accounts', async () => {
    const open = vi.fn(async () => createSession());
    const connectedAccounts = createConnectedAccountsBoundary();
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
      services: { connectedAccounts },
      signal: new AbortController().signal,
    } as unknown as AgentSessionRuntimeContext;

    await expect(runtime.sessions?.open({
      kind: 'create',
      sessionId: 'global-voice-session-acp',
      cwd: '/repo',
      startupInstructions: {
        v: 1,
        id: 'happier.global_voice_agent',
        revision: 1,
        instructions: 'Global Voice developer instructions.',
      },
      launchEnvironment: {
        values: { HAPPIER_CODEX_BACKEND_MODE: 'acp' },
        unset: [],
      },
      configuration: {
        mode: { value: 'acp', updatedAtMs: 1 },
        model: { value: null, updatedAtMs: 1 },
        permissionIntent: { value: null, updatedAtMs: 1 },
        options: { codexBackendMode: { value: 'acp', updatedAtMs: 1 } },
      },
    }, context)).rejects.toMatchObject({
      name: 'PluginError',
      code: 'codex_startup_instructions_unsupported_in_acp',
      retryable: false,
      remediation: { kind: 'openSettings', path: '/settings/agents/codex' },
    });

    expect(open).not.toHaveBeenCalled();
    expect(connectedAccounts.watch).not.toHaveBeenCalled();
    expect(connectedAccounts.getBinding).not.toHaveBeenCalled();
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
  });

  it('fails closed at runtime open when a released legacy MCP selection reaches the plugin', async () => {
    const open = vi.fn(async () => createSession());
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
      services: { connectedAccounts: createConnectedAccountsBoundary() },
      signal: new AbortController().signal,
    } as unknown as AgentSessionRuntimeContext;

    await expect(runtime.sessions?.open({
      kind: 'create',
      sessionId: 'legacy-mcp-session',
      cwd: '/repo',
      configuration: {
        mode: { value: null, updatedAtMs: 0 },
        model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: null, updatedAtMs: 0 },
        options: { codexBackendMode: { value: 'mcp', updatedAtMs: 1 } },
      },
    }, context)).rejects.toMatchObject({
      code: 'codex_legacy_mcp_backend_mode_unsupported',
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses a Provider-bound session in ACP mode before opening the ACP runtime', async () => {
    const open = vi.fn(async () => createSession());
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
    } as unknown as AgentSessionRuntimeContext;

    await expect(runtime.sessions?.open({
      kind: 'create',
      sessionId: 'session-provider-acp',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_CODEX_BACKEND_MODE: 'acp' },
        unset: [],
      },
      providerBinding: {
        connectionId: 'pc_work',
        materialization: {
          v: 1,
          kind: 'engineConfig',
          engineConfig: { v: 1, modelProvider: 'ollama', config: {} },
        },
      },
    } as never, context)).rejects.toThrow(/Provider binding.*ACP/u);

    expect(open).not.toHaveBeenCalled();
  });

  it('opens resumable Sessions through the native ACP owner for host-derived finite Runs', async () => {
    const open = vi.fn(async () => createSession());
    const connectedAccounts = createConnectedAccountsBoundary();
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
      services: { connectedAccounts },
      signal: new AbortController().signal,
    } as unknown as AgentSessionRuntimeContext;

    const session = await runtime.sessions?.open({
      kind: 'resume',
      sessionId: 'run-1',
      cwd: '/repo',
      providerSessionId: 'provider-checkpoint-1',
      launchEnvironment: {
        values: { HAPPIER_CODEX_BACKEND_MODE: 'acp' },
        unset: [],
      },
    }, context);

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'resume',
        sessionId: 'run-1',
        providerSessionId: 'provider-checkpoint-1',
      }),
      expect.any(Object),
    );
    expect(connectedAccounts.watch).not.toHaveBeenCalled();
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(session).toBeDefined();
  });
});
