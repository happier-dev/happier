import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
  type AgentAcpRuntimeOptions,
  type AgentSessionOpenRequest,
  type AgentSessionRuntime,
  type AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Auggie activation', () => {
  it('registers its runtime through the public Agent activation API', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    expect(activation.registrations()).toContainEqual({ family: 'agents', localId: 'auggie' });
    const registration = activation.registration('agents', 'auggie');
    expect(registration?.factory).toEqual(expect.any(Function));
    expect(registration).not.toHaveProperty('externalSessions');
    expect(registration).not.toHaveProperty('externalSessionObservation');
    await activation.dispose();
  });

  it('opens Auggie through the native ACP composer with VB4 inputs and no V1 fallback', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = activation.registration('agents', 'auggie')?.factory;
    if (!factory) throw new Error('Expected Auggie Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.auggie', version: '0.0.0' },
      agent: { id: 'auggie' },
      signal: new AbortController().signal,
    });
    const session: AgentSessionRuntime = {
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: () => ({ dispose: () => undefined }),
      dispose: vi.fn(),
    };
    const open = vi.fn(async (
      _request: AgentSessionOpenRequest,
      _options: AgentAcpRuntimeOptions,
    ) => session);
    const request: AgentSessionOpenRequest = {
      kind: 'create',
      sessionId: 'session-auggie',
      cwd: '/workspace',
      launchEnvironment: {
        values: { AUGMENT_SESSION_AUTH: 'host-authorized-auth' },
        unset: ['AUGGIE_LEGACY_SETTING'],
      },
      configuration: {
        mode: { value: null, updatedAtMs: 10 },
        model: { value: 'model-auggie', updatedAtMs: 11 },
        permissionIntent: { value: 'safe-yolo', updatedAtMs: 12 },
        options: { allowIndexing: { value: true, updatedAtMs: 13 } },
      },
    };
    const context = {
      protocols: { acp: { open } },
    } as AgentSessionRuntimeContext;

    await expect(runtime.sessions.open(request, context)).resolves.toBe(session);
    expect(open).toHaveBeenCalledWith(request, {
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'auggie-cli' },
        args: expect.arrayContaining([
          '--acp',
          '--allow-indexing',
          '--permission',
          'save-file:allow',
        ]),
      },
      definition: expect.objectContaining({
        modelConfigOptionId: 'model',
        mcp: { policy: 'pass_through' },
        timeouts: expect.objectContaining({
          initMs: 60_000,
          investigationToolCallMs: 600_000,
        }),
        stderrRules: expect.any(Object),
        toolNameInference: expect.any(Object),
      }),
    });
    await activation.dispose();
  });
});
