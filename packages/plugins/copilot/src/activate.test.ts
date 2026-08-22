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

describe('Copilot activation', () => {
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'settings',
      'systemTools',
      'ui',
    ]);
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      COPILOT_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('registers its runtime through the public Agent activation API', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    expect(activation.registrations()).toContainEqual({ family: 'agents', localId: 'copilot' });
    expect(activation.registration('agents', 'copilot')?.factory).toEqual(expect.any(Function));
    await activation.dispose();
  });

  it('opens Copilot through the native ACP composer with canonical VB4 permissions', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = activation.registration('agents', 'copilot')?.factory;
    if (!factory) throw new Error('Expected Copilot Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.copilot', version: '0.0.0' },
      agent: { id: 'copilot' },
      signal: new AbortController().signal,
    });
    const session = {
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: () => ({ dispose: () => undefined }),
      dispose: vi.fn(),
    } satisfies AgentSessionRuntime;
    const open = vi.fn(async (
      _request: AgentSessionOpenRequest,
      _options: AgentAcpRuntimeOptions,
    ) => session);
    const request: AgentSessionOpenRequest = {
      kind: 'create',
      sessionId: 'session-copilot',
      cwd: '/workspace',
      configuration: {
        mode: { value: null, updatedAtMs: 10 },
        model: { value: null, updatedAtMs: 11 },
        permissionIntent: { value: 'yolo', updatedAtMs: 12 },
        options: {},
      },
    };

    await expect(runtime.sessions.open(request, {
      protocols: { acp: { open } },
    } as AgentSessionRuntimeContext)).resolves.toBe(session);
    expect(open).toHaveBeenCalledWith(request, {
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'copilot-cli' },
        args: ['--acp', '--yolo'],
      },
      definition: expect.objectContaining({
        mcp: { policy: 'pass_through' },
        timeouts: expect.any(Object),
        stderrRules: expect.any(Object),
        toolNameInference: expect.any(Object),
      }),
    });
    await activation.dispose();
  });
});
