import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginContextV1Fixture } from '@happier-dev/plugin-sdk/experimental/testing/adapterHarness';

import { activate } from './activate.js';
import { OPENCODE_PROVIDER_BINDING_ADAPTER_V1 } from './agent/providerBinding/adapter.js';

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

    const registerAgentRuntime = vi.fn();
    const registerMcpDiscoveryProvider = vi.fn();
    activate({
      registerAgentRuntime,
      registerMcpDiscoveryProvider,
    });

    expect(registerAgentRuntime).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'opencode',
      providerBinding: OPENCODE_PROVIDER_BINDING_ADAPTER_V1,
      create: expect.any(Function),
    }));
    const backendRegistration = registerAgentRuntime.mock.calls[0]?.[0] as Readonly<{
      create: (ctx: unknown) => Promise<unknown>;
    }>;
    const fixture = createPluginContextV1Fixture();
    const pluginContext = {
      ...fixture.ctx,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };
    await expect(backendRegistration.create(pluginContext)).resolves.toEqual(expect.objectContaining({
      runtimeCore: expect.any(Object),
    }));
    expect(pluginContext.logger.debug).toHaveBeenCalledWith('[plugins/opencode] Creating backend engine');
    expect(pluginContext.logger.info).not.toHaveBeenCalled();
    expect(registerMcpDiscoveryProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: 'opencode.config',
      discover: expect.any(Function),
    }));

    const discovery = registerMcpDiscoveryProvider.mock.calls[0]?.[0] as {
      discover: () => Promise<Readonly<{
        servers: readonly unknown[];
        warnings: readonly unknown[];
      }>>;
    };
    await expect(discovery.discover()).resolves.toEqual({
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
  });
});
