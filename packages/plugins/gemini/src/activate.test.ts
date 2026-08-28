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
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'connectedAccountDescriptors',
      'hooks',
      'systemTools',
      'ui',
    ]);
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      GEMINI_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('declares only the raw Connected Account materialization kinds consumed by session launch', () => {
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.connectedAccounts).toEqual([{
      purpose: 'model_upstream',
      service: 'gemini-account',
      required: false,
      materializationKinds: ['files', 'environment'],
    }]);
  });

  it('registers only the focused data-only Connected Account launch facts before open', async () => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const launch = fixture.registration('agents', 'gemini')?.connectedAccountLaunch;

      expect(Object.keys(launch ?? {}).sort()).toEqual([
        'continuity',
        'environmentUses',
        'fileEnvironmentUses',
        'stateSharingDescriptor',
        'switchContinuity',
      ]);
      expect(launch?.fileEnvironmentUses).toEqual([{
        purpose: 'model_upstream',
        fileId: 'google-service-account.json',
        environmentKey: 'GOOGLE_APPLICATION_CREDENTIALS',
      }]);
      expect(launch?.environmentUses).toEqual([
        { purpose: 'model_upstream', environmentKey: 'GEMINI_API_KEY' },
        { purpose: 'model_upstream', environmentKey: 'GOOGLE_API_KEY' },
        { purpose: 'model_upstream', environmentKey: 'GOOGLE_GENAI_USE_VERTEXAI' },
        { purpose: 'model_upstream', environmentKey: 'GOOGLE_CLOUD_PROJECT' },
        { purpose: 'model_upstream', environmentKey: 'GOOGLE_CLOUD_LOCATION' },
      ]);
      expect(launch?.continuity?.runtimeAuthAdapter).toMatchObject({
        classifyRuntimeAuthFailure: expect.any(Function),
        verifyProviderOutcome: expect.any(Function),
      });
      expect(launch?.continuity?.verifyResumeReachable).toBeUndefined();
      expect(launch?.stateSharingDescriptor).toEqual({
        providerSupportStatus: 'unsupported',
        config: {
          supported: false,
          modes: ['isolated'],
          entries: [],
          unavailableReason: 'not_implemented',
        },
        state: {
          supported: false,
          modes: ['isolated'],
          entries: [],
          symlinkUnavailableDegradePolicy: 'block_continuity',
          unavailableReason: 'not_implemented',
        },
        authIsolation: {
          mode: 'process_env',
          secretEntries: [
            'GEMINI_API_KEY',
            'GOOGLE_API_KEY',
            'GOOGLE_GENAI_USE_VERTEXAI',
            'GOOGLE_CLOUD_PROJECT',
            'GOOGLE_CLOUD_LOCATION',
          ],
        },
      });
    } finally {
      await fixture.dispose();
    }
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

  it('opens the native ACP Session owner and admits input for host-derived finite Runs', async () => {
    const runtime = await createGeminiRuntime();

    let publishSessionEvent: ((event: never) => void) | null = null;
    const send = vi.fn(async () => ({ status: 'admitted' as const }));
    const cancel = vi.fn(async ({ turnId }: { turnId: string }) => ({
      status: 'requested' as const,
      turnId,
    }));
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
    const openedSession = await runtime.sessions.open({
      kind: 'create',
      sessionId: 'gemini-native-run',
      cwd: '/workspace',
      launchEnvironment: {
        values: { GEMINI_API_KEY: 'AIzaPluginScopedKey' },
        unset: [],
      },
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
    await expect(openedSession.send({
      inputIds: ['gemini-input-1'],
      input: { text: 'Review this change' },
      delivery: { kind: 'newTurn', turnId: 'gemini-turn-1' },
    })).resolves.toEqual({ status: 'admitted' });

    const events: Array<Record<string, unknown>> = [];
    const eventSubscription = openedSession.watch((event) => events.push(event));
    publishSessionEvent?.({
      kind: 'provider-session-id',
      providerSessionId: 'gemini-checkpoint-1',
      emittedAtMs: 10,
    } as never);
    publishSessionEvent?.({
      kind: 'message-delta',
      turnId: 'gemini-turn-1',
      channel: 'assistant',
      text: 'Looks good',
      emittedAtMs: 11,
    } as never);

    await expect(openedSession.cancel?.({ turnId: 'gemini-turn-1', reason: 'user' })).resolves.toEqual({
      status: 'requested',
      turnId: 'gemini-turn-1',
    });
    expect(cancel).toHaveBeenCalledWith({
      turnId: 'gemini-turn-1',
      reason: 'user',
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'provider-session-id', providerSessionId: 'gemini-checkpoint-1' }),
      expect.objectContaining({ kind: 'message-delta', channel: 'assistant', text: 'Looks good' }),
    ]));

    eventSubscription.dispose();
    await openedSession.dispose();
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

  it('consumes the host-materialized Gemini API-key environment without recustodying the account', async () => {
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
      launchEnvironment: {
        values: {
          GEMINI_API_KEY: 'selected-gemini-key',
          GOOGLE_API_KEY: 'selected-gemini-key',
        },
        unset: [],
      },
    }, {
      signal: new AbortController().signal,
      services: { exec: { run }, connectedAccounts },
      protocols: { acp: { open } },
    } as unknown as AgentSessionRuntimeContext);

    expect(connectedAccounts.getBinding).not.toHaveBeenCalled();
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
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

  it('consumes the host-owned service-account path and Vertex environment without filesystem custody', async () => {
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
      launchEnvironment: {
        values: {
          GOOGLE_APPLICATION_CREDENTIALS: '/host/materialized/google-service-account.json',
          GOOGLE_GENAI_USE_VERTEXAI: '1',
          GOOGLE_CLOUD_PROJECT: 'project-one',
          GOOGLE_CLOUD_LOCATION: 'global',
        },
        unset: [],
      },
    }, {
      signal: new AbortController().signal,
      services: { exec: { run }, connectedAccounts },
      protocols: { acp: { open } },
    } as unknown as AgentSessionRuntimeContext);

    const launchEnvironment = open.mock.calls[0]?.[0].launchEnvironment;
    const credentialPath = launchEnvironment?.values.GOOGLE_APPLICATION_CREDENTIALS;
    expect(credentialPath).toBe('/host/materialized/google-service-account.json');
    expect(launchEnvironment?.values).toMatchObject({
      GOOGLE_GENAI_USE_VERTEXAI: '1',
      GOOGLE_CLOUD_PROJECT: 'project-one',
      GOOGLE_CLOUD_LOCATION: 'global',
    });
    expect(connectedAccounts.getBinding).not.toHaveBeenCalled();
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();

    await session.dispose();
  });
});
