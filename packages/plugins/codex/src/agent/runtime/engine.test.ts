import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentRuntimeContext,
  AgentRuntimeFactoryContext,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

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

function createUnboundConnectedAccounts() {
  return {
    getBinding: vi.fn(async () => null),
    requestSelection: vi.fn(),
    materialize: vi.fn(),
    watch: vi.fn((_purpose: string, listener: () => void) => {
      queueMicrotask(listener);
      return { dispose() {} };
    }),
  };
}

describe('createCodexAgentRuntime', () => {
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
    expect(runtime.surfaces?.handoff).toEqual({
      exportBundle: expect.any(Function),
      importBundle: expect.any(Function),
    });
  });

  it('routes ACP sessions through the native composer and exposes the data-only terminal plan', async () => {
    const open = vi.fn(async () => createSession());
    const runtime = await createCodexAgentRuntime({
      plugin: { id: 'happier.agent.codex', version: '0.0.0' },
      agent: { id: 'codex' },
      signal: new AbortController().signal,
    } as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
      services: { connectedAccounts: createUnboundConnectedAccounts() },
      signal: new AbortController().signal,
    } as unknown as AgentSessionRuntimeContext;

    await runtime.sessions?.open({
      kind: 'resume',
      sessionId: 'session-1',
      cwd: '/repo',
      providerSessionId: 'provider-1',
      launchEnvironment: {
        values: { HAPPIER_CODEX_BACKEND_MODE: 'acp' },
        unset: [],
      },
    }, context);

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'resume', providerSessionId: 'provider-1' }),
      expect.objectContaining({
        transport: expect.objectContaining({
          executable: { kind: 'managedDependency', id: 'codex-acp' },
        }),
      }),
    );
    await expect(Promise.resolve(runtime.surfaces?.terminal?.resolveLaunch({
      sessionId: 'terminal-1',
      cwd: '/repo',
      metadata: {
        resumeId: 'provider-1',
        permissionMode: 'read-only',
        codexArgs: ['--search'],
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
        '--search',
      ],
      process: { stdio: 'inherit', windowsHide: true },
    });
  });

  it('rejects startup instructions for an explicitly selected ACP runtime before account preparation or launch', async () => {
    const open = vi.fn(async () => createSession());
    const resolveSystemTool = vi.fn(async () => {
      throw new Error('app-server system-tool boundary sentinel');
    });
    const connectedAccounts = createUnboundConnectedAccounts();
    const runtime = await createCodexAgentRuntime({
      plugin: { id: 'happier.agent.codex', version: '1.5.2' },
      agent: { id: 'codex' },
      signal: new AbortController().signal,
    } as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
      services: {
        connectedAccounts,
        exec: {
          systemTools: { resolve: resolveSystemTool },
        },
        logger: { debug: vi.fn() },
        sessions: {
          current: {
            media: { registerSourceRoot: vi.fn() },
          },
        },
      },
      ui: { title: { set: vi.fn(async () => undefined) } },
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
        options: {
          codexBackendMode: { value: 'acp', updatedAtMs: 1 },
        },
      },
    }, context)).rejects.toMatchObject({
      name: 'PluginError',
      code: 'codex_startup_instructions_unsupported_in_acp',
      retryable: false,
      remediation: {
        kind: 'openSettings',
        path: '/settings/agents/codex',
      },
    });

    expect(open).not.toHaveBeenCalled();
    expect(connectedAccounts.watch).not.toHaveBeenCalled();
    expect(connectedAccounts.getBinding).not.toHaveBeenCalled();
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(resolveSystemTool).not.toHaveBeenCalled();
  });

  it('routes startup instructions through the selected app-server runtime', async () => {
    const open = vi.fn(async () => createSession());
    const resolveSystemTool = vi.fn(async () => {
      throw new Error('app-server system-tool boundary sentinel');
    });
    const runtime = await createCodexAgentRuntime({
      plugin: { id: 'happier.agent.codex', version: '1.5.2' },
      agent: { id: 'codex' },
      signal: new AbortController().signal,
    } as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
      services: {
        connectedAccounts: createUnboundConnectedAccounts(),
        exec: {
          systemTools: { resolve: resolveSystemTool },
        },
        logger: { debug: vi.fn() },
        sessions: {
          current: {
            media: { registerSourceRoot: vi.fn() },
          },
        },
      },
      ui: { title: { set: vi.fn(async () => undefined) } },
      signal: new AbortController().signal,
    } as unknown as AgentSessionRuntimeContext;

    await expect(runtime.sessions?.open({
      kind: 'create',
      sessionId: 'global-voice-session-app-server',
      cwd: '/repo',
      startupInstructions: {
        v: 1,
        id: 'happier.global_voice_agent',
        revision: 1,
        instructions: 'Global Voice developer instructions.',
      },
      launchEnvironment: {
        values: { HAPPIER_CODEX_BACKEND_MODE: 'appServer' },
        unset: [],
      },
      configuration: {
        mode: { value: 'appServer', updatedAtMs: 1 },
        model: { value: null, updatedAtMs: 1 },
        permissionIntent: { value: null, updatedAtMs: 1 },
        options: {
          codexBackendMode: { value: 'appServer', updatedAtMs: 1 },
        },
      },
    }, context)).rejects.toThrow('Codex app-server startup failed.');

    expect(open).not.toHaveBeenCalled();
    expect(resolveSystemTool).toHaveBeenCalledWith({
      toolId: 'codex-cli',
      purpose: 'Launch the Codex native app-server',
    });
  });

  it('materializes the qualified primary Codex account before opening the actual ACP session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-qualified-primary-'));
    const lifecycle: string[] = [];
    const nativeDispose = vi.fn();
    const nativeSession = { ...createSession(), dispose: nativeDispose };
    const open = vi.fn(async () => {
      lifecycle.push('open');
      return nativeSession;
    });
    const getBinding = vi.fn(async (purpose: string) => {
      lifecycle.push(`binding:${purpose}`);
      return purpose === 'primary'
        ? {
            purpose,
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            target: { kind: 'account' as const, displayName: 'Codex work' },
          }
        : null;
    });
    const materialize = vi.fn(async () => {
      lifecycle.push('materialize:primary');
      return {
        kind: 'files' as const,
        files: {
          'auth.json': new TextEncoder().encode(JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: { access_token: 'qualified-access' },
          })),
        },
      };
    });
    let resync: (() => void) | null = null;
    const disposeSubscription = vi.fn();
    const watch = vi.fn((_purpose: string, listener: () => void) => {
      lifecycle.push('watch:primary');
      resync = listener;
      queueMicrotask(listener);
      return { dispose: disposeSubscription };
    });
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
      services: {
        connectedAccounts: {
          getBinding,
          materialize,
          watch,
        },
      },
      signal: new AbortController().signal,
    } as unknown as AgentSessionRuntimeContext;

    try {
      const session = await runtime.sessions?.open({
        kind: 'create',
        sessionId: 'session-qualified-primary',
        cwd: '/repo',
        launchEnvironment: {
          values: {
            HAPPIER_CODEX_BACKEND_MODE: 'acp',
            CODEX_HOME: root,
          },
          unset: [],
        },
      }, context);

      expect(getBinding).toHaveBeenCalledWith('primary', { signal: context.signal });
      expect(materialize).toHaveBeenCalledWith(
        'primary',
        { kind: 'files', fileIds: ['auth.json'] },
        { signal: context.signal },
      );
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          launchEnvironment: {
            values: expect.objectContaining({ CODEX_HOME: root }),
            unset: [],
          },
        }),
        expect.any(Object),
      );
      await expect(readFile(join(root, 'auth.json'), 'utf8')).resolves.toContain(
        'qualified-access',
      );
      expect(watch).toHaveBeenCalledWith('primary', expect.any(Function));
      expect(lifecycle).toEqual([
        'watch:primary',
        'binding:primary',
        'materialize:primary',
        'open',
      ]);
      expect(resync).not.toBeNull();
      resync?.();
      resync?.();
      await vi.waitFor(() => {
        expect(nativeDispose).toHaveBeenCalledWith('runtime_recovery');
      });
      expect(nativeDispose).toHaveBeenCalledTimes(1);
      expect(disposeSubscription).toHaveBeenCalledTimes(1);
      await session?.dispose();
      expect(nativeDispose).toHaveBeenCalledTimes(1);
      expect(disposeSubscription).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains the primary-purpose watch for an unbound native launch', async () => {
    let resync: (() => void) | null = null;
    const disposeSubscription = vi.fn();
    const nativeDispose = vi.fn();
    const open = vi.fn(async () => ({ ...createSession(), dispose: nativeDispose }));
    const connectedAccounts = {
      getBinding: vi.fn(async () => null),
      materialize: vi.fn(),
      watch: vi.fn((_purpose: string, listener: () => void) => {
        resync = listener;
        queueMicrotask(listener);
        return { dispose: disposeSubscription };
      }),
    };
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
      services: { connectedAccounts },
      signal: new AbortController().signal,
    } as unknown as AgentSessionRuntimeContext;

    const session = await runtime.sessions?.open({
      kind: 'create',
      sessionId: 'session-native-unbound',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_CODEX_BACKEND_MODE: 'acp', NATIVE_AUTH: 'preserved' },
        unset: [],
      },
    }, context);

    expect(connectedAccounts.watch).toHaveBeenCalledWith('primary', expect.any(Function));
    expect(connectedAccounts.getBinding).toHaveBeenCalledWith('primary', { signal: context.signal });
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        launchEnvironment: {
          values: { HAPPIER_CODEX_BACKEND_MODE: 'acp', NATIVE_AUTH: 'preserved' },
          unset: [],
        },
      }),
      expect.any(Object),
    );

    resync?.();
    await vi.waitFor(() => {
      expect(nativeDispose).toHaveBeenCalledWith('runtime_recovery');
    });
    expect(disposeSubscription).toHaveBeenCalledTimes(1);
    await session?.dispose();
    expect(nativeDispose).toHaveBeenCalledTimes(1);
  });

  it('waits for the initial primary-purpose resync before reading its binding', async () => {
    let initialResync: (() => void) | null = null;
    const open = vi.fn(async () => createSession());
    const connectedAccounts = {
      getBinding: vi.fn(async () => null),
      materialize: vi.fn(),
      watch: vi.fn((_purpose: string, listener: () => void) => {
        initialResync = listener;
        return { dispose() {} };
      }),
    };
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
      services: { connectedAccounts },
      signal: new AbortController().signal,
    } as unknown as AgentSessionRuntimeContext;

    const opening = runtime.sessions?.open({
      kind: 'create',
      sessionId: 'session-initial-resync',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_CODEX_BACKEND_MODE: 'acp' },
        unset: [],
      },
    }, context);

    await vi.waitFor(() => expect(connectedAccounts.watch).toHaveBeenCalledTimes(1));
    expect(connectedAccounts.getBinding).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    initialResync?.();
    const session = await opening;
    expect(connectedAccounts.getBinding).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    await session?.dispose();
  });

  it('disposes the opened session once when a later resync arrives during the binding read', async () => {
    let resync: (() => void) | null = null;
    const nativeDispose = vi.fn();
    const open = vi.fn(async () => ({ ...createSession(), dispose: nativeDispose }));
    const connectedAccounts = {
      getBinding: vi.fn(async () => {
        resync?.();
        return null;
      }),
      materialize: vi.fn(),
      watch: vi.fn((_purpose: string, listener: () => void) => {
        resync = listener;
        queueMicrotask(listener);
        return { dispose() {} };
      }),
    };
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
      services: { connectedAccounts },
      signal: new AbortController().signal,
    } as unknown as AgentSessionRuntimeContext;

    const session = await runtime.sessions?.open({
      kind: 'create',
      sessionId: 'session-resync-during-binding-read',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_CODEX_BACKEND_MODE: 'acp' },
        unset: [],
      },
    }, context);

    await vi.waitFor(() => {
      expect(nativeDispose).toHaveBeenCalledWith('runtime_recovery');
    });
    expect(nativeDispose).toHaveBeenCalledTimes(1);
    await session?.dispose();
    expect(nativeDispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the primary-purpose watch when preparation fails', async () => {
    const disposeSubscription = vi.fn();
    const open = vi.fn(async () => createSession());
    const connectedAccounts = {
      getBinding: vi.fn(async () => ({
        purpose: 'primary',
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        target: { kind: 'account' as const, displayName: 'Codex work' },
      })),
      materialize: vi.fn(async () => {
        throw new Error('qualified materialization failed');
      }),
      watch: vi.fn((_purpose: string, listener: () => void) => {
        queueMicrotask(listener);
        return { dispose: disposeSubscription };
      }),
    };
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
      services: { connectedAccounts },
      signal: new AbortController().signal,
    } as unknown as AgentSessionRuntimeContext;

    await expect(runtime.sessions?.open({
      kind: 'create',
      sessionId: 'session-materialization-failure',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_CODEX_BACKEND_MODE: 'acp' },
        unset: [],
      },
    }, context)).rejects.toThrow('qualified materialization failed');

    expect(open).not.toHaveBeenCalled();
    expect(disposeSubscription).toHaveBeenCalledTimes(1);
  });

  it('disposes the primary-purpose watch when native session open fails', async () => {
    const disposeSubscription = vi.fn();
    const open = vi.fn(async () => {
      throw new Error('native session open failed');
    });
    const connectedAccounts = {
      getBinding: vi.fn(async () => null),
      materialize: vi.fn(),
      watch: vi.fn((_purpose: string, listener: () => void) => {
        queueMicrotask(listener);
        return { dispose: disposeSubscription };
      }),
    };
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
      services: { connectedAccounts },
      signal: new AbortController().signal,
    } as unknown as AgentSessionRuntimeContext;

    await expect(runtime.sessions?.open({
      kind: 'create',
      sessionId: 'session-open-failure',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_CODEX_BACKEND_MODE: 'acp' },
        unset: [],
      },
    }, context)).rejects.toThrow('native session open failed');

    expect(disposeSubscription).toHaveBeenCalledTimes(1);
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

  it('opens resumable execution runs through the same native ACP session owner', async () => {
    const open = vi.fn(async () => createSession());
    const runtime = await createCodexAgentRuntime({} as AgentRuntimeFactoryContext);
    const context = {
      protocols: { acp: { open } },
      services: { connectedAccounts: createUnboundConnectedAccounts() },
      signal: new AbortController().signal,
    } as unknown as AgentRuntimeContext;

    const executionRun = await runtime.executionRuns?.open({
      kind: 'resume',
      runId: 'run-1',
      cwd: '/repo',
      profile: { pluginId: 'happier.agent.codex', localId: 'default' },
      checkpointId: 'provider-checkpoint-1',
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
    expect(executionRun).toBeDefined();
  });
});
