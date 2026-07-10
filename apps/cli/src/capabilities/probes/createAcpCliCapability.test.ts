import { beforeEach, describe, expect, it, vi } from 'vitest';
import { delimiter } from 'node:path';

import type { DetectCliSnapshot } from '@/capabilities/snapshots/cliSnapshot';
import { createAcpTransportHandlerFromDefinition, normalizePluginAcpDefinition } from '@/agent/acp/runtime/definition';
import { createAcpCliCapability } from './createAcpCliCapability';
import type { AcpProbeResult } from './acpProbe';
import { KIMI_ACP_BACKEND_SPEC } from '@happier-dev/plugins-kimi/agent/acp/definition';
import { resolveKimiAcpPythonSelectorChildEnv } from '@happier-dev/plugins-kimi/agent/acp/pythonSelectorEnv';

type ProbeAcpAgentCapabilities = (params: {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
  env: Record<string, string | undefined>;
  transport: unknown;
  timeoutMs?: number;
}) => Promise<AcpProbeResult>;

const { probeAcpAgentCapabilities, requireAgentCliLaunchSpec } = vi.hoisted(() => ({
  probeAcpAgentCapabilities: vi.fn<ProbeAcpAgentCapabilities>(async () => ({
    ok: false as const,
    checkedAt: 1,
    error: { message: 'probe disabled in unit test' },
  })),
  requireAgentCliLaunchSpec: vi.fn(),
}));

vi.mock('@/capabilities/probes/acpProbe', () => ({
  probeAcpAgentCapabilities,
}));

vi.mock('@/packagedRuntime/managedTools/requireAgentCliLaunchSpec', () => ({
  requireAgentCliLaunchSpec,
}));

function buildCliSnapshot(resolvedPath: string): DetectCliSnapshot {
  return {
    path: process.env.PATH ?? null,
    clis: {
      claude: { available: false },
      antigravity: { available: false },
      codex: { available: false },
      opencode: { available: false },
      gemini: { available: true, resolvedPath },
      auggie: { available: false },
      qwen: { available: false },
      kimi: { available: false },
      kilo: { available: false },
      kiro: { available: false },
      customAcp: { available: false },
      ohMyPi: { available: false },
      pi: { available: false },
      cursor: { available: false },
      copilot: { available: false },
      coderabbit: { available: false },
      deepsec: { available: false },
    },
    tmux: { available: false },
    windowsTerminal: { available: false },
  };
}

function createKimiPluginCliCapability() {
  const definition = normalizePluginAcpDefinition({
    pluginId: 'happier.agent.kimi',
    spec: KIMI_ACP_BACKEND_SPEC,
  });
  return createAcpCliCapability({
    agentId: 'kimi',
    title: 'Kimi CLI',
    acpArgs: ['acp'],
    transport: createAcpTransportHandlerFromDefinition(definition),
    resolveAcpProbeEnv: ({ defaultEnv }) => resolveKimiAcpPythonSelectorChildEnv({
      selector: process.env.HAPPIER_KIMI_ACP_SELECTOR,
      env: defaultEnv,
      inheritedEnv: process.env,
    }),
  });
}

describe('createAcpCliCapability', () => {
  beforeEach(() => {
    probeAcpAgentCapabilities.mockClear();
    requireAgentCliLaunchSpec.mockReset();
  });

  it('probes ACP capabilities through the canonical provider launch path when the CLI uses a JS runtime wrapper', async () => {
    requireAgentCliLaunchSpec.mockReturnValue({
      source: 'managed',
      resolvedPath: '/managed/gemini/index.mjs',
      command: '/managed/node',
      args: ['/managed/gemini/index.mjs'],
    });

    const capability = createAcpCliCapability({
      agentId: 'gemini',
      title: 'Gemini CLI',
      acpArgs: ['--acp'],
      transport: {
        agentName: 'gemini',
        getInitTimeout: () => 2_000,
        getToolPatterns: () => [],
      },
    });

    await capability.detect({
      request: { id: 'cli.gemini', params: { includeAcpCapabilities: true } },
      context: {
        cliSnapshot: buildCliSnapshot('/managed/gemini/index.mjs'),
      },
    });

    expect(probeAcpAgentCapabilities).toHaveBeenCalledWith(expect.objectContaining({
      command: '/managed/node',
      args: ['/managed/gemini/index.mjs', '--acp'],
    }));
  });

  it('probes ACP capabilities from a projected runtime definition bridge when ACP uses a separate system tool', async () => {
    const resolveSystemTool = vi.fn(async () => ({
      grantId: 'system-tool:codex-acp',
      toolId: 'codex-acp',
      displayName: 'Codex ACP',
      source: 'system' as const,
      executablePath: '/tools/codex-acp',
      launch: {
        kind: 'binary' as const,
        executablePath: '/tools/codex-acp',
        args: ['--from-grant'],
        env: { PATH: '' },
      },
    }));
    const capability = createAcpCliCapability({
      agentId: 'codex',
      title: 'Codex CLI',
      runtimeDefinitionBridge: {
        exec: {
          systemTools: {
            resolve: resolveSystemTool,
          },
        },
        createDefinition: () => ({
          backendId: 'codex',
          source: { kind: 'plugin_contributed' },
          identity: { backendId: 'codex' },
          engine: { kind: 'acp' },
          ux: { title: 'Codex' },
          transport: {
            kind: 'stdio',
            launch: {
              kind: 'system-tool',
              toolId: 'codex-acp',
              purpose: 'Run Codex ACP',
              preferredCommand: 'codex-acp',
              args: ['--probe'],
            },
          },
          launchEnv: {},
          capabilities: {},
          timeouts: { initMs: 3_333 },
          mcp: { policy: 'pass_through' },
          callbacks: {},
        }),
      },
    });

    const detected = await capability.detect({
      request: { id: 'cli.codex', params: { includeAcpCapabilities: true } },
      context: {
        cliSnapshot: buildCliSnapshot('/managed/gemini/index.mjs'),
      },
    });

    expect(resolveSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'codex-acp',
      cwd: process.cwd(),
    }));
    expect(probeAcpAgentCapabilities).toHaveBeenCalledWith(expect.objectContaining({
      command: '/tools/codex-acp',
      args: ['--from-grant', '--probe'],
      timeoutMs: 8_000,
      transport: expect.objectContaining({ agentName: 'codex' }),
    }));
    expect(detected).toMatchObject({
      available: false,
      acp: {
        ok: false,
      },
    });
  });

  it('allows provider-owned ACP probes to augment the child environment', async () => {
    requireAgentCliLaunchSpec.mockReturnValue({
      source: 'managed',
      resolvedPath: '/managed/kimi/index.mjs',
      command: '/managed/node',
      args: ['/managed/kimi/index.mjs'],
    });

    const capability = createAcpCliCapability({
      agentId: 'kimi',
      title: 'Kimi CLI',
      acpArgs: ['acp'],
      transport: {
        agentName: 'kimi',
        getInitTimeout: () => 2_000,
        getToolPatterns: () => [],
      },
      resolveAcpProbeEnv: ({ defaultEnv }) => ({
        ...defaultEnv,
        PYTHONPATH: '/tmp/kimi-selector-shim',
      }),
    });

    await capability.detect({
      request: { id: 'cli.kimi', params: { includeAcpCapabilities: true } },
      context: {
        cliSnapshot: {
          ...buildCliSnapshot('/managed/gemini/index.mjs'),
          clis: {
            ...buildCliSnapshot('/managed/gemini/index.mjs').clis,
            kimi: { available: true, resolvedPath: '/managed/kimi/index.mjs' },
          },
        },
      },
    });

    expect(probeAcpAgentCapabilities).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        PYTHONPATH: '/tmp/kimi-selector-shim',
      }),
    }));
  });

  it('preserves inherited PYTHONPATH when Kimi ACP capability probing uses poll mode', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalSelector = process.env.HAPPIER_KIMI_ACP_SELECTOR;
    const originalPythonPath = process.env.PYTHONPATH;
    const originalSecret = process.env.HAPPIER_TEST_SECRET;
    expect(originalPlatformDescriptor).toBeDefined();
    requireAgentCliLaunchSpec.mockReturnValue({
      source: 'managed',
      resolvedPath: '/managed/kimi/index.mjs',
      command: '/managed/node',
      args: ['/managed/kimi/index.mjs'],
    });

    try {
      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
      process.env.HAPPIER_KIMI_ACP_SELECTOR = 'poll';
      process.env.PYTHONPATH = '/inherited/pythonpath';
      process.env.HAPPIER_TEST_SECRET = 'do-not-forward';

      await createKimiPluginCliCapability().detect({
        request: { id: 'cli.kimi', params: { includeAcpCapabilities: true } },
        context: {
          cliSnapshot: {
            ...buildCliSnapshot('/managed/gemini/index.mjs'),
            clis: {
              ...buildCliSnapshot('/managed/gemini/index.mjs').clis,
              kimi: { available: true, resolvedPath: '/managed/kimi/index.mjs' },
            },
          },
        },
      });

      const env = probeAcpAgentCapabilities.mock.calls.at(-1)?.[0]?.env;
      const pythonPathEntries = env?.PYTHONPATH?.split(delimiter) ?? [];
      expect(pythonPathEntries[0]).toContain('kimi-acp-poll-selector-');
      expect(pythonPathEntries).toContain('/inherited/pythonpath');
      expect(env).toMatchObject({
        NODE_ENV: 'production',
        DEBUG: '',
      });
      expect(env?.HAPPIER_TEST_SECRET).toBeUndefined();
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
      if (originalSelector === undefined) {
        delete process.env.HAPPIER_KIMI_ACP_SELECTOR;
      } else {
        process.env.HAPPIER_KIMI_ACP_SELECTOR = originalSelector;
      }
      if (originalPythonPath === undefined) {
        delete process.env.PYTHONPATH;
      } else {
        process.env.PYTHONPATH = originalPythonPath;
      }
      if (originalSecret === undefined) {
        delete process.env.HAPPIER_TEST_SECRET;
      } else {
        process.env.HAPPIER_TEST_SECRET = originalSecret;
      }
    }
  });
});
