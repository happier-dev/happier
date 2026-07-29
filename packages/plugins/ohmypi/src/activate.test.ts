import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
  AgentAcpRuntimeOptions,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';

import { AGENT_DEFINITION } from './agent/definition.js';
import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('OhMyPi plugin activation', () => {
  it('registers the native primary runtime and auxiliary External Sessions independently', async () => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const agent = fixture.registration('agents', 'ohmypi');

    expect(agent).toEqual(expect.objectContaining({
      factory: expect.any(Function),
      externalSessions: expect.objectContaining({
        resolveSource: expect.any(Function),
        listCandidates: expect.any(Function),
        resolveLinkIdentity: expect.any(Function),
        resolveLinkedIdentity: expect.any(Function),
        pageTranscript: expect.any(Function),
        readAfterTranscript: expect.any(Function),
      }),
      externalSessionTakeover: {
        resolveLaunch: expect.any(Function),
      },
    }));
    expect(Object.keys(agent?.externalSessions ?? {}).sort()).toEqual([
      'listCandidates',
      'pageTranscript',
      'readAfterTranscript',
      'resolveLinkIdentity',
      'resolveLinkedIdentity',
      'resolveSource',
    ]);
    expect(Object.keys(
      agent?.externalSessionObservation ?? {},
    ).sort()).toEqual([
      'describeResource',
      'observeResource',
      'reconcileResource',
    ]);
    expect(Object.keys(
      agent?.externalSessionTakeover ?? {},
    )).toEqual(['resolveLaunch']);
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.id).toBe('ohmypi');
    expect(AGENT_DEFINITION.id).toBe('ohMyPi');
    expect(fixture.registrations()).toContainEqual({
      family: 'hooks',
      localId: 'resolve-prerequisites',
    });

    const registration = fixture.registration('hooks', 'resolve-prerequisites');
    const result = await registration?.({
      payload: {
        cwd: '/repo',
      },
    }, {
      tools: {
        runSystemTool: async () => ({
          ok: true,
          exitCode: 0,
          stdout: 'No models available. Set API keys in environment variables.\n',
          stderr: '',
        }),
      },
    });

    expect(result).toMatchObject({
      decision: 'deny',
      reasonCode: 'ohmypi_models_unavailable',
    });
    await fixture.dispose();
  });

  it.each([
    {
      name: 'create',
      request: {
        kind: 'create',
        sessionId: 'happier-ohmypi-create',
        cwd: '/workspace',
      },
    },
    {
      name: 'resume',
      request: {
        kind: 'resume',
        sessionId: 'happier-ohmypi-resume',
        providerSessionId: 'omp-provider-session',
        cwd: '/workspace',
      },
    },
    {
      name: 'fork',
      request: {
        kind: 'fork',
        sessionId: 'happier-ohmypi-fork',
        cwd: '/workspace-fork',
        source: {
          sessionId: 'happier-ohmypi-source',
          providerSessionId: 'omp-provider-session',
          cwd: '/workspace',
        },
      },
    },
  ] as const)('opens $name through the direct native ACP composer', async ({ request }) => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = fixture.registration('agents', 'ohmypi')?.factory;
    if (!factory) throw new Error('Expected OhMyPi Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.ohmypi', version: '0.0.0' },
      agent: { id: 'ohmypi' },
      signal: new AbortController().signal,
    });
    const session = {
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      cancel: vi.fn(async ({ turnId }: { turnId: string }) => ({
        status: 'requested' as const,
        turnId,
      })),
      watch: () => ({ dispose: () => undefined }),
      dispose: vi.fn(),
    } satisfies AgentSessionRuntime;
    const open = vi.fn(async (
      _request: AgentSessionOpenRequest,
      _options: AgentAcpRuntimeOptions,
    ) => session);

    const opened = await runtime.sessions.open(
      request,
      { protocols: { acp: { open } } } as AgentSessionRuntimeContext,
    );

    expect(opened).toBe(session);
    expect(open).toHaveBeenCalledWith(request, {
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'ohmypi-cli' },
        args: ['--mode', 'acp'],
      },
      definition: {
        acceptsVerifiedImageInput: true,
        modelConfigOptionId: 'model',
        mcp: { policy: 'pass_through' },
      },
    });
    await expect(opened.cancel?.({
      turnId: `${request.sessionId}-turn`,
      reason: 'user',
    })).resolves.toEqual({
      status: 'requested',
      turnId: `${request.sessionId}-turn`,
    });
    await fixture.dispose();
  });

  it('passes direct activation-hook payloads through to the spawn prerequisite owner', async () => {
    const fixture = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const runSystemTool = vi.fn(async () => ({
      ok: true,
      exitCode: 0,
      stdout: 'No models available. Set API keys in environment variables.\n',
      stderr: '',
    }));

    const registration = fixture.registration('hooks', 'resolve-prerequisites');
    const result = await registration?.({
      cwd: '/repo',
      directory: '/repo',
    }, {
      tools: {
        runSystemTool,
      },
    });

    expect(runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
    }));
    expect(result).toMatchObject({
      decision: 'deny',
      reasonCode: 'ohmypi_models_unavailable',
    });
    await fixture.dispose();
  });
});
