import { readFile, stat } from 'node:fs/promises';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import { GEMINI_ACP_RUNTIME_DEFINITION } from './agent/acp/definition.js';
import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

function disconnectedConnectedAccounts() {
  return {
    getBinding: vi.fn(async () => null),
    materialize: vi.fn(),
    requestSelection: vi.fn(),
    watch: vi.fn(() => ({ dispose() {} })),
  };
}

async function createGeminiRuntime() {
  const activation = await createPluginTestkit({
    manifest: PLUGIN_MANIFEST,
    module: { activate },
  });
  const factory = activation.registration('agents', 'gemini')?.factory;
  if (!factory) throw new Error('Expected Gemini Agent factory');
  const runtime = await factory({
    plugin: { id: 'happier.agent.gemini', version: '0.0.0' },
    agent: { id: 'gemini' },
    signal: new AbortController().signal,
  });
  await activation.dispose();
  return runtime;
}

describe('Gemini native runtime migration', () => {
  it('declares only the raw Connected Account materialization kinds consumed by session launch', () => {
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.connectedAccounts).toEqual([{
      purpose: 'model_upstream',
      service: 'gemini-account',
      required: false,
      materializationKinds: ['files', 'environment'],
    }]);
  });

  it('does not leak ambient daemon environment into the bounded native launch projection', async () => {
    const ambientKey = 'HAPPIER_GEMINI_UNDECLARED_SECRET';
    const previous = process.env[ambientKey];
    process.env[ambientKey] = 'must-not-reach-gemini';
    try {
      const runtime = await createGeminiRuntime();
      const run = vi.fn(async () => ({
        termination: { observed: { kind: 'exit' as const, exitCode: 0 }, requestedBy: { kind: 'none' as const } },
        stdout: new TextEncoder().encode('--acp'),
        stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
      }));
      const open = vi.fn(async () => ({
        send: vi.fn(), watch: () => ({ dispose: () => undefined }), dispose: vi.fn(),
      }));

      const session = await runtime.sessions.open({
        kind: 'create', sessionId: 'gemini-bounded-env', cwd: '/workspace',
        launchEnvironment: { values: { GEMINI_API_KEY: 'AIzaPluginScopedKey' }, unset: [] },
      }, {
        signal: new AbortController().signal,
        services: { exec: { run }, connectedAccounts: disconnectedConnectedAccounts() },
        protocols: { acp: { open } },
      } as unknown as AgentSessionRuntimeContext);
      await session.dispose();

      const probeEnvironment = run.mock.calls[0]?.[0].env;
      expect(probeEnvironment).not.toHaveProperty(ambientKey);
      expect(probeEnvironment).toMatchObject({ GEMINI_API_KEY: 'AIzaPluginScopedKey' });
    } finally {
      if (previous === undefined) delete process.env[ambientKey];
      else process.env[ambientKey] = previous;
    }
  });

  it('opens Gemini through the native ACP composer instead of the V1 compatibility envelope', async () => {
    const runtime = await createGeminiRuntime();
    const session = {
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: () => ({ dispose: () => undefined }),
      dispose: vi.fn(),
    };
    const open = vi.fn(async () => session);
    const run = vi.fn(async () => ({
      termination: { observed: { kind: 'exit' as const, exitCode: 0 }, requestedBy: { kind: 'none' as const } },
      stdout: new TextEncoder().encode('Usage: gemini --experimental-acp'),
      stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
    }));

    await expect(runtime.sessions.open({
      kind: 'create',
      sessionId: 'gemini-native-session',
      cwd: '/workspace',
      launchEnvironment: {
        values: { GEMINI_API_KEY: 'AIzaPluginScopedKey' },
        unset: [],
      },
      configuration: {
        mode: { value: null, updatedAtMs: 10 },
        model: { value: 'gemini-2.5-pro', updatedAtMs: 11 },
        permissionIntent: { value: 'plan', updatedAtMs: 12 },
        options: {},
      },
    }, {
      signal: new AbortController().signal,
      services: { exec: { run }, connectedAccounts: disconnectedConnectedAccounts() },
      protocols: { acp: { open } },
    } as unknown as AgentSessionRuntimeContext)).resolves.toMatchObject({ dispose: expect.any(Function) });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      executable: { kind: 'systemTool', id: 'gemini-cli' },
      args: ['--help'],
      env: expect.objectContaining({ GEMINI_API_KEY: 'AIzaPluginScopedKey' }),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      launchEnvironment: expect.objectContaining({ values: expect.objectContaining({ GEMINI_API_KEY: 'AIzaPluginScopedKey' }) }),
    }), expect.objectContaining({
      transport: expect.objectContaining({
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'gemini-cli' },
        args: ['--experimental-acp'],
      }),
      definition: expect.objectContaining({
        mcp: { policy: 'pass_through' },
        modelConfigOptionId: 'model',
        toolNameInference: GEMINI_ACP_RUNTIME_DEFINITION.toolNameInference,
        stderrRules: GEMINI_ACP_RUNTIME_DEFINITION.stderrRules,
      }),
    }));
  });

  it('projects the declared execution-run capability through the native ACP session owner', async () => {
    const runtime = await createGeminiRuntime();
    if (!runtime.executionRuns) throw new Error('Expected Gemini execution-run runtime');

    let publishSessionEvent: ((event: never) => void) | null = null;
    const send = vi.fn(async () => ({ status: 'admitted' as const }));
    const cancel = vi.fn(async () => ({ status: 'requested' as const }));
    const disposeSession = vi.fn();
    const disposeSubscription = vi.fn();
    const open = vi.fn(async () => ({
      send,
      cancel,
      watch(listener: (event: never) => void) {
        publishSessionEvent = listener;
        return { dispose: disposeSubscription };
      },
      dispose: disposeSession,
    }));
    const run = vi.fn(async () => ({
      termination: { observed: { kind: 'exit' as const, exitCode: 0 }, requestedBy: { kind: 'none' as const } },
      stdout: new TextEncoder().encode('--acp'),
      stderr: new Uint8Array(),
      stdoutTruncated: false,
      stderrTruncated: false,
    }));
    const execution = await runtime.executionRuns.open({
      kind: 'create',
      runId: 'gemini-native-run',
      cwd: '/workspace',
      profile: { pluginId: 'happier.agent.gemini', localId: 'review' },
      launchEnvironment: {
        values: { GEMINI_API_KEY: 'AIzaPluginScopedKey' },
        unset: [],
      },
      input: { text: 'Review this change' },
    }, {
      signal: new AbortController().signal,
      services: { exec: { run }, connectedAccounts: disconnectedConnectedAccounts() },
      protocols: { acp: { open } },
    } as unknown as AgentSessionRuntimeContext);

    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'create',
      sessionId: 'gemini-native-run',
      cwd: '/workspace',
    }), expect.anything());
    expect(send).toHaveBeenCalledWith({
      inputIds: ['gemini-native-run-input-1'],
      input: { text: 'Review this change' },
      delivery: { kind: 'newTurn', turnId: 'gemini-native-run-turn-1' },
    }, undefined);

    const events: Array<Record<string, unknown>> = [];
    execution.watch((event) => events.push(event));
    publishSessionEvent?.({
      kind: 'provider-session-id',
      providerSessionId: 'gemini-checkpoint-1',
      emittedAtMs: 10,
    } as never);
    publishSessionEvent?.({
      kind: 'message-delta',
      channel: 'assistant',
      text: 'Looks good',
      emittedAtMs: 11,
    } as never);

    await expect(execution.stop()).resolves.toEqual({ status: 'requested' });
    expect(cancel).toHaveBeenCalledWith({
      turnId: 'gemini-native-run-turn-1',
      reason: 'user',
    }, undefined);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'run-start', runId: 'gemini-native-run' }),
      expect.objectContaining({ kind: 'checkpoint', checkpointId: 'gemini-checkpoint-1' }),
      expect.objectContaining({ kind: 'output-delta', channel: 'assistant', text: 'Looks good' }),
    ]));

    await execution.dispose();
    expect(disposeSubscription).toHaveBeenCalledOnce();
    expect(disposeSession).toHaveBeenCalledOnce();
  });

  it('cleans the isolated Gemini home when the host disposes the native session', async () => {
    const runtime = await createGeminiRuntime();
    const dispose = vi.fn();
    const open = vi.fn(async () => ({ send: vi.fn(), watch: () => ({ dispose: () => undefined }), dispose }));
    const context = {
      signal: new AbortController().signal,
      services: { exec: { run: vi.fn(async () => ({
        termination: { observed: { kind: 'exit' as const, exitCode: 0 }, requestedBy: { kind: 'none' as const } },
        stdout: new TextEncoder().encode('--acp'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
      })) }, connectedAccounts: disconnectedConnectedAccounts() },
      protocols: { acp: { open } },
    } as unknown as AgentSessionRuntimeContext;
    const nativeSession = await runtime.sessions.open({
      kind: 'create', sessionId: 'gemini-native-cleanup', cwd: '/workspace',
      launchEnvironment: { values: { GEMINI_API_KEY: 'AIzaPluginScopedKey' }, unset: [] },
    }, context);

    await nativeSession.dispose();
    await nativeSession.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('retains the provider-owned spawn prerequisite hook', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    expect(activation.registration('hooks', 'resolve-prerequisites')).toEqual(expect.any(Function));
    await activation.dispose();
  });

  it('materializes the selected Gemini Connected Account before opening ACP', async () => {
    const runtime = await createGeminiRuntime();
    const connectedAccounts = {
      getBinding: vi.fn(async () => ({
        purpose: 'model_upstream',
        service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
        target: { kind: 'account' as const, displayName: 'Gemini API key' },
      })),
      materialize: vi.fn(async (_purpose: string, request: { kind: string }) => (
        request.kind === 'files'
          ? { kind: 'files' as const, files: {} }
          : {
              kind: 'environment' as const,
              env: { GEMINI_API_KEY: 'selected-gemini-key', GOOGLE_API_KEY: 'selected-gemini-key' },
            }
      )),
      requestSelection: vi.fn(),
      watch: vi.fn(() => ({ dispose() {} })),
    };
    const run = vi.fn(async () => ({
      termination: { observed: { kind: 'exit' as const, exitCode: 0 }, requestedBy: { kind: 'none' as const } },
      stdout: new TextEncoder().encode('--acp'),
      stderr: new Uint8Array(),
      stdoutTruncated: false,
      stderrTruncated: false,
    }));
    const open = vi.fn(async () => ({
      send: vi.fn(),
      watch: () => ({ dispose() {} }),
      dispose: vi.fn(),
    }));

    await runtime.sessions.open({
      kind: 'create',
      sessionId: 'gemini-connected-account',
      cwd: '/workspace',
      launchEnvironment: { values: {}, unset: [] },
    }, {
      signal: new AbortController().signal,
      services: { exec: { run }, connectedAccounts },
      protocols: { acp: { open } },
    } as unknown as AgentSessionRuntimeContext);

    expect(connectedAccounts.getBinding).toHaveBeenCalledWith(
      'model_upstream',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(connectedAccounts.materialize).toHaveBeenCalledWith(
      'model_upstream',
      { kind: 'environment', keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      launchEnvironment: {
        values: expect.objectContaining({
          GEMINI_API_KEY: 'selected-gemini-key',
          GOOGLE_API_KEY: 'selected-gemini-key',
        }),
        unset: [],
      },
    }), expect.anything());
  });

  it('writes a selected service account inside the session-owned home with private permissions', async () => {
    const runtime = await createGeminiRuntime();
    const serviceAccount = JSON.stringify({
      type: 'service_account',
      client_email: 'worker@example.iam.gserviceaccount.com',
      project_id: 'project-one',
      private_key: 'secret-private-key',
    });
    const connectedAccounts = {
      getBinding: vi.fn(async () => ({
        purpose: 'model_upstream',
        service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
        target: { kind: 'account' as const, displayName: 'Gemini service account' },
      })),
      materialize: vi.fn(async (_purpose: string, request: { kind: string }) => (
        request.kind === 'files'
          ? {
              kind: 'files' as const,
              files: { 'google-service-account.json': new TextEncoder().encode(serviceAccount) },
            }
          : {
              kind: 'environment' as const,
              env: {
                GOOGLE_GENAI_USE_VERTEXAI: '1',
                GOOGLE_CLOUD_PROJECT: 'project-one',
                GOOGLE_CLOUD_LOCATION: 'global',
              },
            }
      )),
      requestSelection: vi.fn(),
      watch: vi.fn(() => ({ dispose() {} })),
    };
    const run = vi.fn(async () => ({
      termination: { observed: { kind: 'exit' as const, exitCode: 0 }, requestedBy: { kind: 'none' as const } },
      stdout: new TextEncoder().encode('--acp'),
      stderr: new Uint8Array(),
      stdoutTruncated: false,
      stderrTruncated: false,
    }));
    const open = vi.fn(async () => ({
      send: vi.fn(),
      watch: () => ({ dispose() {} }),
      dispose: vi.fn(),
    }));

    const session = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'gemini-service-account',
      cwd: '/workspace',
      launchEnvironment: { values: {}, unset: [] },
    }, {
      signal: new AbortController().signal,
      services: { exec: { run }, connectedAccounts },
      protocols: { acp: { open } },
    } as unknown as AgentSessionRuntimeContext);

    const launchEnvironment = open.mock.calls[0]?.[0].launchEnvironment;
    const credentialPath = launchEnvironment?.values.GOOGLE_APPLICATION_CREDENTIALS;
    expect(credentialPath).toMatch(/google-service-account\.json$/u);
    expect(await readFile(credentialPath!, 'utf8')).toBe(serviceAccount);
    expect((await stat(credentialPath!)).mode & 0o777).toBe(0o600);
    expect(launchEnvironment?.values).toMatchObject({
      GOOGLE_GENAI_USE_VERTEXAI: '1',
      GOOGLE_CLOUD_PROJECT: 'project-one',
      GOOGLE_CLOUD_LOCATION: 'global',
    });
    expect(connectedAccounts.materialize).toHaveBeenCalledTimes(1);

    await session.dispose();
    await expect(stat(credentialPath!)).rejects.toThrow();
  });
});
