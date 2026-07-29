import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';

import { activate } from './activate.js';
import { OPENCODE_PROVIDER_BINDING_ADAPTER_V1 } from './agent/providerBinding/adapter.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('activate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers the OpenCode config MCP discovery provider through the plugin API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-plugin-mcp-'));
    const opencodeDir = join(root, '.config', 'opencode');
    const configPath = join(opencodeDir, 'opencode.json');
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          review: {
            command: 'review-mcp',
            args: ['--stdio'],
          },
        },
      }),
      'utf8',
    );
    vi.stubEnv('HOME', root);
    vi.stubEnv('XDG_CONFIG_HOME', '');

    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const agent = activation.registration('agents', 'opencode');

    expect(agent).toEqual(expect.objectContaining({
      factory: expect.any(Function),
      externalSessions: expect.any(Object),
      externalSessionObservation: expect.any(Object),
      externalSessionTakeover: {
        resolveLaunch: expect.any(Function),
      },
    }));
    expect(agent?.providerBinding).toEqual(OPENCODE_PROVIDER_BINDING_ADAPTER_V1);
    const externalSessions = agent?.externalSessions;
    expect(Object.keys(externalSessions ?? {}).sort()).toEqual([
      'listCandidates',
      'pageTranscript',
      'readAfterTranscript',
      'resolveLinkIdentity',
      'resolveLinkedIdentity',
      'resolveSource',
    ]);
    expect(externalSessions).not.toHaveProperty('status');
    expect(externalSessions).not.toHaveProperty('follow');
    expect(externalSessions).not.toHaveProperty('takeover');
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
    const discovery = activation.registration('mcp.discoveryProviders', 'config');
    expect(discovery).toEqual(expect.any(Function));
    if (!discovery) throw new Error('Missing OpenCode MCP discovery registration');
    await expect(Reflect.apply(discovery, undefined, [{}])).resolves.toEqual({
      items: [],
      servers: [
        expect.objectContaining({
          id: 'opencode.config.review',
          name: 'review',
          transport: {
            kind: 'stdio',
            launch: {
              kind: 'binary',
              executablePath: 'review-mcp',
              args: ['--stdio'],
            },
          },
        }),
      ],
      warnings: [],
    });
    await activation.dispose();
  });

  it.each([
    {
      kind: 'create',
      sessionId: 'happier-opencode-create',
      cwd: '/workspace',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' },
        unset: [],
      },
    },
    {
      kind: 'resume',
      sessionId: 'happier-opencode-resume',
      providerSessionId: 'provider-session',
      cwd: '/workspace',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' },
        unset: [],
      },
    },
    {
      kind: 'fork',
      sessionId: 'happier-opencode-fork',
      cwd: '/workspace-fork',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' },
        unset: [],
      },
      source: {
        sessionId: 'happier-opencode-source',
        providerSessionId: 'provider-session',
        cwd: '/workspace',
      },
    },
  ] satisfies AgentSessionOpenRequest[])('registers a native primary that opens $kind sessions', async (request) => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = activation.registration('agents', 'opencode')?.factory;
    if (!factory) throw new Error('Expected OpenCode Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
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
      _options: unknown,
    ) => session);

    const opened = await runtime.sessions.open(
      request,
      { protocols: { acp: { open } } } as AgentSessionRuntimeContext,
    );

    expect(opened).toBe(session);
    await activation.dispose();
  });

  it('opens native execution runs through the same ACP session owner and admits the initial input', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = activation.registration('agents', 'opencode')?.factory;
    if (!factory) throw new Error('Expected OpenCode Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });
    const send = vi.fn(async () => ({ status: 'admitted' as const }));
    const session = {
      send,
      cancel: vi.fn(async ({ turnId }: { turnId: string }) => ({
        status: 'requested' as const,
        turnId,
      })),
      watch: () => ({ dispose: () => undefined }),
      dispose: vi.fn(),
    } satisfies AgentSessionRuntime;
    const open = vi.fn(async () => session);
    const execution = await runtime.executionRuns?.open({
      kind: 'create',
      runId: 'opencode-run-1',
      cwd: '/workspace',
      profile: { pluginId: 'happier.agent.opencode', localId: 'default' },
      input: { text: 'Implement the change' },
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'acp' },
        unset: [],
      },
    }, {
      protocols: { acp: { open } },
    } as never);

    expect(execution).toBeDefined();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'create',
      sessionId: 'opencode-run-1',
      cwd: '/workspace',
    }), expect.objectContaining({
      transport: expect.objectContaining({
        kind: 'stdio',
        args: ['acp'],
      }),
    }));
    expect(send).toHaveBeenCalledWith({
      inputIds: ['opencode-run-1-input-1'],
      input: { text: 'Implement the change' },
      delivery: { kind: 'newTurn', turnId: 'opencode-run-1-turn-1' },
    }, undefined);
    await execution?.dispose();
    await activation.dispose();
  });
});
