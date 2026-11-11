import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
  AgentAcpRuntimeOptions,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Kilo activation', () => {
  it('proves native resume through ACP session/load when the prepared runtime can inspect it', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const launch = activation.registration('agents', 'kilo')?.connectedAccountLaunch;
    if (!launch?.continuity?.verifyResumeReachable) throw new Error('Expected Kilo resume continuity hook');
    const methods: string[] = [];
    await expect(launch.continuity.verifyResumeReachable({
      vendorResumeId: 'kilo-provider-session',
      sessionFiles: { verifyDeclaredPaths: async () => ({ found: false }), findDeclaredCandidate: async () => ({ found: false }) },
      nativeInspection: { cwd: '/real/kilo/workspace', withDeclaredJsonRpcClient: async (_command, inspect) => await inspect({
        request: async method => { methods.push(method); return {}; },
        notify: async () => undefined, onNotification: () => () => undefined, onRequest: () => () => undefined,
      }, new AbortController().signal) },
    })).resolves.toEqual({ ok: true, proof: 'native_session' });
    expect(methods).toEqual(['initialize', 'session/load']);
    await activation.dispose();
  });

  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'settings',
      'systemTools',
    ]);
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      KILO_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('registers its runtime through the public Agent activation API', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    expect(activation.registrations()).toContainEqual({ family: 'agents', localId: 'kilo' });
    expect(activation.registration('agents', 'kilo')?.factory).toEqual(expect.any(Function));
    await activation.dispose();
  });

  it.each([
    { kind: 'create' as const },
    { kind: 'resume' as const, providerSessionId: 'kilo-provider-session' },
  ])('opens a $kind session through the native ACP composer with canonical permissions', async (variant) => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = activation.registration('agents', 'kilo')?.factory;
    if (!factory) throw new Error('Expected Kilo Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.kilo', version: '0.0.0' },
      agent: { id: 'kilo' },
      signal: new AbortController().signal,
    });
    const session = {
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      cancel: vi.fn(async ({ turnId }: { turnId: string }) => ({ status: 'requested' as const, turnId })),
      watch: () => ({ dispose: () => undefined }),
      dispose: vi.fn(),
    } satisfies AgentSessionRuntime;
    const open = vi.fn(async (
      _request: AgentSessionOpenRequest,
      _options: AgentAcpRuntimeOptions,
    ) => session);
    const request: AgentSessionOpenRequest = {
      ...variant,
      sessionId: `session-kilo-${variant.kind}`,
      cwd: '/workspace',
      launchEnvironment: {
        values: { DEBUG: 'transport-debug' },
        unset: ['KILO_LEGACY_SETTING'],
      },
      configuration: {
        mode: { value: null, updatedAtMs: 10 },
        model: { value: 'model-kilo', updatedAtMs: 11 },
        permissionIntent: { value: 'read-only', updatedAtMs: 12 },
        options: {},
      },
    };

    await expect(runtime.sessions.open(request, {
      protocols: { acp: { open } },
    } as AgentSessionRuntimeContext)).resolves.toBe(session);
    expect(open).toHaveBeenCalledWith(request, {
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'kilo-cli' },
        args: ['acp'],
        env: { KILO_PERMISSION: expect.any(String) },
      },
      definition: expect.objectContaining({
        modelConfigOptionId: 'model',
        mcp: { policy: 'pass_through' },
        timeouts: expect.any(Object),
        stderrRules: expect.any(Object),
        toolNameInference: expect.any(Object),
      }),
    });
    const options = open.mock.calls[0]?.[1];
    if (!options || options.transport.kind !== 'stdio') {
      throw new Error('Expected Kilo native stdio ACP options');
    }
    expect(JSON.parse(options.transport.env?.KILO_PERMISSION ?? '{}')).toMatchObject({
      '*': 'deny',
      read: 'allow',
      edit: 'deny',
      bash: 'deny',
      external_directory: 'deny',
    });
    expect(options.definition).not.toHaveProperty('permissionOptionSelection');
    await activation.dispose();
  });
});
