import { existsSync, readFileSync, unlinkSync } from 'node:fs';

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

async function createKimiRuntime() {
  const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  const factory = activation.registration('agents', 'kimi')?.factory;
  if (!factory) throw new Error('Expected Kimi Agent factory');
  const runtime = await factory({
    plugin: { id: 'happier.agent.kimi', version: '0.0.0' },
    agent: { id: 'kimi' },
    signal: new AbortController().signal,
  });
  await activation.dispose();
  return runtime;
}

describe('activate', () => {
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'hooks',
      'settings',
      'systemTools',
    ]);
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      KIMI_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('registers the Kimi ACP spawn prerequisite hook through the plugin API', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });

    expect(activation.registration('hooks', 'resolve-prerequisites')).toEqual(expect.any(Function));
    await activation.dispose();
  });

  it('builds Kimi Session preferences through the public CLI command declaration', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const buildSessionOptions = activation.registration('agents', 'kimi')?.cliSessionCommand?.buildSessionOptions;
      expect(buildSessionOptions).toBeTypeOf('function');
      expect(buildSessionOptions?.({
        isExplicitCliSubcommand: true,
        parsed: { agentArgs: [] },
        settings: { kimiAcpPythonSelector: 'poll' },
        environment: { HAPPIER_KIMI_ACP_SELECTOR: 'auto' },
        startOrigin: 'terminal',
      })).toEqual({
        ok: true,
        options: { environmentVariables: { HAPPIER_KIMI_ACP_SELECTOR: 'auto' } },
      });
    } finally {
      await activation.dispose();
    }
  });

  it('opens Kimi through the native ACP composer without a V1 fallback', async () => {
    const runtime = await createKimiRuntime();
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
      sessionId: 'session-kimi',
      cwd: '/workspace',
      launchEnvironment: {
        values: {
          HAPPIER_KIMI_ACP_SELECTOR: 'poll',
          PYTHONPATH: '/existing',
        },
        unset: ['KIMI_LEGACY_SETTING'],
      },
      configuration: {
        mode: { value: null, updatedAtMs: 10 },
        model: { value: null, updatedAtMs: 11 },
        permissionIntent: { value: 'read-only', updatedAtMs: 12 },
        options: {},
      },
    };

    await expect(runtime.sessions.open(request, {
      protocols: { acp: { open } },
    } as AgentSessionRuntimeContext)).resolves.toBe(session);
    const options = open.mock.calls[0]?.[1];
    if (!options || options.transport.kind !== 'stdio') {
      throw new Error('Expected Kimi native stdio ACP options');
    }
    const composedRequest = open.mock.calls[0]?.[0];
    expect(composedRequest?.launchEnvironment?.values).toMatchObject({
      HAPPIER_KIMI_ACP_SELECTOR: 'poll',
    });
    expect(composedRequest?.launchEnvironment?.values).not.toHaveProperty('PYTHONPATH');
    expect(options).toMatchObject({
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'kimi-cli' },
        args: expect.arrayContaining(['--work-dir', '/workspace', 'acp']),
      },
      definition: {
        mcp: { policy: 'drop' },
        stderrRules: expect.any(Object),
        toolNameInference: expect.any(Object),
      },
    });
    expect(options.transport.args).toContain('--agent-file');
    if (process.platform === 'linux') {
      expect(options.transport.env?.PYTHONPATH).toContain('kimi-acp-poll-selector');
      expect(options.transport.env?.PYTHONPATH).toContain('/existing');
    } else {
      expect(options.transport.env?.PYTHONPATH).toBe('/existing');
    }
  });

  it('preserves Kimi ordered argv and readonly agent-file behavior', async () => {
    const runtime = await createKimiRuntime();
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
      sessionId: 'session-kimi-readonly',
      cwd: '/workspace',
      configuration: {
        mode: { value: null, updatedAtMs: 10 },
        model: { value: null, updatedAtMs: 11 },
        permissionIntent: { value: 'read-only', updatedAtMs: 12 },
        options: {},
      },
    };
    await runtime.sessions.open(request, {
      protocols: { acp: { open } },
    } as AgentSessionRuntimeContext);
    const options = open.mock.calls[0]?.[1];
    if (!options || options.transport.kind !== 'stdio') {
      throw new Error('Expected Kimi native stdio ACP options');
    }
    const argv = options.transport.args;
    let agentFilePath: string | undefined;

    try {
      expect(argv?.slice(0, 2)).toEqual(['--work-dir', '/workspace']);
      expect(argv?.at(-1)).toBe('acp');
      const agentFileIndex = argv?.indexOf('--agent-file') ?? -1;
      expect(agentFileIndex).toBeGreaterThan(-1);
      agentFilePath = argv?.[agentFileIndex + 1];
      expect(agentFilePath).toEqual(expect.stringContaining('happier-kimi-'));
      expect(existsSync(agentFilePath ?? '')).toBe(true);
      expect(readFileSync(agentFilePath ?? '', 'utf8')).toContain('kimi_cli.tools.shell:Shell');
    } finally {
      if (agentFilePath && existsSync(agentFilePath)) {
        unlinkSync(agentFilePath);
      }
    }
  });

  it('forwards the canonical yolo intent through the native ACP composer', async () => {
    const runtime = await createKimiRuntime();
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
      sessionId: 'session-kimi-yolo',
      providerSessionId: 'kimi-provider-session',
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
    expect(open.mock.calls[0]?.[1]).toMatchObject({
      transport: { args: ['--work-dir', '/workspace', '--yolo', 'acp'] },
    });
  });

});
