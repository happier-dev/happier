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

describe('Qwen activation', () => {
  it('registers its runtime through the public Agent activation API', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    expect(activation.registrations()).toContainEqual({ family: 'agents', localId: 'qwen' });
    expect(activation.registration('agents', 'qwen')?.factory).toEqual(expect.any(Function));
    await activation.dispose();
  });

  it('opens Qwen through the native ACP composer with canonical VB4 permissions', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = activation.registration('agents', 'qwen')?.factory;
    if (!factory) throw new Error('Expected Qwen Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.qwen', version: '0.0.0' },
      agent: { id: 'qwen' },
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
      sessionId: 'session-qwen',
      cwd: '/workspace',
      configuration: {
        mode: { value: null, updatedAtMs: 20 },
        model: { value: null, updatedAtMs: 21 },
        permissionIntent: { value: 'safe-yolo', updatedAtMs: 22 },
        options: {},
      },
    };

    await expect(runtime.sessions.open(request, {
      protocols: { acp: { open } },
    } as AgentSessionRuntimeContext)).resolves.toBe(session);
    expect(open).toHaveBeenCalledWith(request, {
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'qwen-cli' },
        args: ['--acp', '--approval-mode', 'auto-edit'],
      },
      definition: {
        modelConfigOptionId: 'model',
        mcp: { policy: 'pass_through' },
      },
    });
    await activation.dispose();
  });
});
