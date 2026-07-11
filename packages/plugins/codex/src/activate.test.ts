import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RegisterDaemonAuthBridgeV1,
  PluginApiHookRegistrationV1,
  PluginApiMcpDiscoveryProviderRegistrationV1,
  PluginDisposable,
  RegisterAgentRuntimeV1,
} from '@happier-dev/plugin-sdk';

import { activate } from './activate.js';
import { CODEX_PROVIDER_BINDING_ADAPTER_V1 } from './agent/providerBinding/adapter.js';

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
      const backendRegistrations: RegisterAgentRuntimeV1[] = [];
      const daemonAuthBridgeRegistrations: RegisterDaemonAuthBridgeV1[] = [];
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
        registerAgentRuntime: (registration): PluginDisposable => {
          backendRegistrations.push(registration);
          return { dispose: () => undefined };
        },
        registerDaemonAuthBridge: (registration): PluginDisposable => {
          daemonAuthBridgeRegistrations.push(registration);
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
          agentId: 'codex',
          providerBinding: CODEX_PROVIDER_BINDING_ADAPTER_V1,
          create: expect.any(Function),
        }),
      ]);
      expect(daemonAuthBridgeRegistrations).toEqual([
        expect.objectContaining({
          serviceId: 'openai-codex',
          refresh: expect.any(Function),
        }),
      ]);
      expect(registrations.map((registration) => registration.id)).toEqual(['codex.config']);
      expect(hookRegistrations.map((registration) => registration.hookId)).toEqual([
        'agent.resolvePrerequisites',
        'agent.spawnEnv.augment',
      ]);
      expect(hookRegistrations).toEqual([
        expect.objectContaining({
          hookId: 'agent.resolvePrerequisites',
          filters: { agentId: 'codex' },
        }),
        expect.objectContaining({
          hookId: 'agent.spawnEnv.augment',
          filters: { agentId: 'codex' },
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

  it('passes direct activation-hook payloads through to Codex spawn hooks', async () => {
    const hookRegistrations: PluginApiHookRegistrationV1[] = [];
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: false as const,
      errorMessage: 'codex-acp unavailable',
    }));

    activate({
      registerAgentRuntime: () => ({ dispose: () => undefined }),
      registerDaemonAuthBridge: () => ({ dispose: () => undefined }),
      registerMcpDiscoveryProvider: () => ({ dispose: () => undefined }),
      registerHook: (registration) => {
        hookRegistrations.push(registration);
        return { dispose: () => undefined };
      },
    });

    const prerequisiteHook = hookRegistrations.find(
      (registration) => registration.hookId === 'agent.resolvePrerequisites',
    );
    const envHook = hookRegistrations.find(
      (registration) => registration.hookId === 'agent.spawnEnv.augment',
    );

    await expect(prerequisiteHook?.handler({
      runtimeSelection: {
        providerRuntimeSelection: { codexBackendMode: 'acp' },
      },
    }, {
      tools: { resolveManagedInstallable },
    })).resolves.toMatchObject({
      allowed: false,
      reasonCode: 'codex_acp_unavailable',
    });
    expect(resolveManagedInstallable).toHaveBeenCalledWith(expect.objectContaining({
      installableId: 'codex-acp',
    }));

    await expect(Promise.resolve(envHook?.handler({
      runtimeSelection: {
        providerRuntimeSelection: { codexBackendMode: 'appServer' },
      },
    }))).resolves.toEqual({
      HAPPIER_CODEX_BACKEND_MODE: 'appServer',
    });
  });
});
