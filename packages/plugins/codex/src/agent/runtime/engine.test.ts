import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentRuntimeContext,
  AgentRuntimeFactoryContext,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
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
    watch: vi.fn(() => ({ dispose() {} })),
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
        providerSessionId: 'provider-1',
        permissionMode: 'read-only',
        codexArgs: ['--search'],
      },
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

  it('routes startup-instruction sessions through app-server before ACP selection', async () => {
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
        mode: { value: null, updatedAtMs: 1 },
        model: { value: null, updatedAtMs: 1 },
        permissionIntent: { value: null, updatedAtMs: 1 },
        options: {
          codexBackendMode: { value: 'acp', updatedAtMs: 1 },
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
    const nativeSession = createSession();
    const nativeSend = vi.spyOn(nativeSession, 'send');
    const open = vi.fn(async () => nativeSession);
    const getBinding = vi.fn(async (purpose: string) => (
      purpose === 'primary'
        ? {
            purpose,
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            target: { kind: 'account' as const, displayName: 'Codex work' },
          }
        : null
    ));
    const materialize = vi.fn(async () => ({
      kind: 'files' as const,
      files: {
        'auth.json': new TextEncoder().encode(JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: { access_token: 'qualified-access' },
        })),
      },
    }));
    let resync: (() => void) | null = null;
    const watch = vi.fn((_purpose: string, listener: () => void) => {
      resync = listener;
      return { dispose() {} };
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
      expect(resync).not.toBeNull();
      resync?.();
      resync?.();
      await expect(session?.send({
        inputIds: ['input-after-account-change'],
        input: { text: 'must not reach stale auth' },
        delivery: { kind: 'newTurn', turnId: 'turn-after-account-change' },
      })).resolves.toMatchObject({
        status: 'unavailable',
        diagnostic: { code: 'codex_primary_connected_account_changed' },
      });
      expect(nativeSend).not.toHaveBeenCalled();
      await session?.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
