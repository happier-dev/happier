import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

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

    const registerBackendEngine = vi.fn();
    const registerMcpDiscoveryProvider = vi.fn();
    activate({
      registerBackendEngine,
      registerMcpDiscoveryProvider,
    });

    expect(registerBackendEngine).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'opencode',
    }));
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
