import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type {
  PluginApiHookRegistrationV1,
  PluginApiMcpDiscoveryProviderRegistrationV1,
  PluginDisposable,
} from '@happier-dev/plugin-sdk';
import type { BundledRegisterBackendEngineV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';

import { activate } from './activate.js';

describe('activate', () => {
  const previousCodexHome = process.env.CODEX_HOME;

  afterEach(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it('registers Codex MCP discovery through the plugin API', async () => {
      const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-mcp-'));
      const backendRegistrations: BundledRegisterBackendEngineV1[] = [];
      const hookRegistrations: PluginApiHookRegistrationV1[] = [];
      const registrations: PluginApiMcpDiscoveryProviderRegistrationV1[] = [];
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, 'config.toml'), [
        '[mcp_servers.docs]',
        'command = "codex-mcp"',
        'args = ["--project", "docs"]',
      ].join('\n'));
      process.env.CODEX_HOME = codexHome;

      const api = {
        registerBackendEngine: (registration): PluginDisposable => {
          backendRegistrations.push(registration);
          return { dispose: () => undefined };
        },
        registerMcpDiscoveryProvider: (registration) => {
          registrations.push(registration);
          return { dispose: () => undefined };
        },
        registerHook: (registration: PluginApiHookRegistrationV1) => {
          hookRegistrations.push(registration);
          return { dispose: () => undefined };
        },
      };
      activate(api);

      expect(backendRegistrations).toEqual([
        expect.objectContaining({
          backendId: 'codex',
          create: expect.any(Function),
        }),
      ]);
      expect(registrations.map((registration) => registration.id)).toEqual(['codex.config']);
      expect(hookRegistrations.map((registration) => registration.hookId)).toEqual([
        'backend.resolveRuntimePrerequisites',
        'spawn.augmentEnv',
      ]);
      expect(hookRegistrations).toEqual([
        expect.objectContaining({
          hookId: 'backend.resolveRuntimePrerequisites',
          filters: { backendId: 'codex' },
        }),
        expect.objectContaining({
          hookId: 'spawn.augmentEnv',
          filters: { backendId: 'codex' },
        }),
      ]);
      await expect(registrations[0]?.discover()).resolves.toEqual({
        servers: [{
          id: 'codex.config.docs',
          name: 'docs',
          transport: {
            kind: 'stdio',
            launch: {
              kind: 'binary',
              executablePath: 'codex-mcp',
              args: ['--project', 'docs'],
            },
          },
        }],
        warnings: [],
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
