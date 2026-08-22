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

describe('Kiro activation', () => {
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'settings',
      'systemTools',
    ]);
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      KIRO_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('registers its runtime through the public Agent activation API', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    expect(activation.registrations()).toContainEqual({ family: 'agents', localId: 'kiro' });
    expect(activation.registration('agents', 'kiro')?.factory).toEqual(expect.any(Function));
    await activation.dispose();
  });

  it('opens Kiro through the native ACP composer without a V1 fallback', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = activation.registration('agents', 'kiro')?.factory;
    if (!factory) throw new Error('Expected Kiro Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.kiro', version: '0.0.0' },
      agent: { id: 'kiro' },
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
      kind: 'resume',
      sessionId: 'session-kiro',
      providerSessionId: 'kiro-provider-session',
      cwd: '/workspace',
    };

    await expect(runtime.sessions.open(request, {
      protocols: { acp: { open } },
    } as AgentSessionRuntimeContext)).resolves.toBe(session);
    expect(open).toHaveBeenCalledWith(request, {
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'kiro-cli' },
        args: ['acp'],
      },
      definition: expect.objectContaining({
        mcp: { policy: 'pass_through' },
        stderrRules: expect.any(Object),
      }),
    });
    await activation.dispose();
  });
});
