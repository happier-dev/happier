import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpCommandDeps } from './deps';
import { runMcpServeCommand } from './serve';
import { disableMcpStdioConsolePatch } from '@/mcp/server/mcpStdioConsolePatch';
import { accountSettingsParse } from '@happier-dev/protocol';

const env = process.env;

describe('happier mcp serve (env hardening)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...env };
  });

  it('bootstraps account settings before starting the stdio MCP server', async () => {
    const credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
    };

    const connect = vi.fn(async () => {});
    const deps: McpCommandDeps = {
      readStoredCredentials: async () => credentials,
      bootstrapAccountSettingsContext: vi.fn(async () => ({}) as any),
      updateAccountSettingsV2WithRetry: vi.fn(async () => ({ version: 1 }) as any),
      ensureMachineIdForCredentials: vi.fn(async () => ({ machineId: 'machine-1' })),
      detectProviderMcpServers: vi.fn(async () => ({ ok: true, servers: [] }) as any),
      probeMcpStdioServerTools: vi.fn(async () => ({ ok: true, toolNames: [] }) as any),
      randomUUID: () => 'id',
      nowMs: () => 1,
      createExternalMcpServer: vi.fn(() => ({ mcp: { connect }, toolNames: [] }) as any),
      connectMcpStdio: vi.fn(async (_server) => {}),
    };

    try {
      await runMcpServeCommand(['serve', '--session', 'sess-1'], deps);

      expect(deps.bootstrapAccountSettingsContext).toHaveBeenCalledWith(expect.objectContaining({
        credentials,
        mode: 'blocking',
        refresh: 'force',
        honorAccountSettingsModeEnv: false,
      }));
      expect(deps.ensureMachineIdForCredentials).toHaveBeenCalledWith(credentials);
      expect(deps.createExternalMcpServer).toHaveBeenCalledWith({
        credentials,
        defaultSessionId: 'sess-1',
        pluginToolCatalog: [],
      });
      expect(deps.connectMcpStdio).toHaveBeenCalledWith(expect.objectContaining({ connect }));
    } finally {
      disableMcpStdioConsolePatch();
    }
  });

  it('passes the daemon-projected tool catalog to the external MCP server', async () => {
    const credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
    };
    const pluginTool = {
      toolId: 'acme.review.plugin/review-tool',
      actionId: 'acme.review.plugin/review-start',
      name: 'acme_review_start',
      title: 'Acme Review Start',
      description: 'Start a review',
      inputSchema: { type: 'object' as const },
      surfaces: ['mcp' as const],
    };
    const createExternalMcpServer = vi.fn(() => ({
      mcp: { connect: vi.fn(async () => {}) },
      toolNames: [],
    }) as any);
    const deps: McpCommandDeps = {
      readStoredCredentials: async () => credentials,
      bootstrapAccountSettingsContext: vi.fn(async () => ({ settings: {} }) as any),
      updateAccountSettingsV2WithRetry: vi.fn(async () => ({ version: 1 }) as any),
      ensureMachineIdForCredentials: vi.fn(async () => ({ machineId: 'machine-1' })),
      detectProviderMcpServers: vi.fn(async () => ({ ok: true, servers: [] }) as any),
      probeMcpStdioServerTools: vi.fn(async () => ({ ok: true, toolNames: [] }) as any),
      randomUUID: () => 'id',
      nowMs: () => 1,
      readDaemonPluginCatalog: vi.fn(async () => ({
        kind: 'available' as const,
        plugins: [],
        tools: [pluginTool],
      })),
      createExternalMcpServer,
      connectMcpStdio: vi.fn(async () => {}),
    };

    try {
      await runMcpServeCommand(['serve'], deps);

      expect(createExternalMcpServer).toHaveBeenCalledWith({
        credentials,
        defaultSessionId: null,
        pluginToolCatalog: [pluginTool],
      });
    } finally {
      disableMcpStdioConsolePatch();
    }
  });

  it('overrides HAPPIER_ACTIONS_SETTINGS_V1 env var with account settings for mcp serve', async () => {
    const prev = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({ v: 1, actions: { 'review.start': { enabled: true } } });

    const credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
    };

    const connect = vi.fn(async () => {});
    const deps: McpCommandDeps = {
      readStoredCredentials: async () => credentials,
      bootstrapAccountSettingsContext: vi.fn(async () => ({
        source: 'network',
        settingsVersion: 1,
        loadedAtMs: 1,
        whenRefreshed: null,
        settingsSecretsReadKeys: [],
        settings: {
          actionsSettingsV1: {
            v: 1,
            actions: {
              'review.start': { enabled: false, disabledSurfaces: [], disabledPlacements: [] },
            },
          },
        },
      }) as any),
      updateAccountSettingsV2WithRetry: vi.fn(async () => ({ version: 1 }) as any),
      ensureMachineIdForCredentials: vi.fn(async () => ({ machineId: 'machine-1' })),
      detectProviderMcpServers: vi.fn(async () => ({ ok: true, servers: [] }) as any),
      probeMcpStdioServerTools: vi.fn(async () => ({ ok: true, toolNames: [] }) as any),
      randomUUID: () => 'id',
      nowMs: () => 1,
      createExternalMcpServer: vi.fn(() => ({ mcp: { connect }, toolNames: [] }) as any),
      connectMcpStdio: vi.fn(async (_server) => {}),
    };

    try {
      await runMcpServeCommand(['serve'], deps);

      expect(process.env.HAPPIER_ACTIONS_SETTINGS_V1).toBe(JSON.stringify({
        v: 1,
        actions: {
          'review.start': { enabled: false, disabledSurfaces: [], disabledPlacements: [] },
        },
      }));
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = prev;
      disableMcpStdioConsolePatch();
    }
  });

  it('patches console output to avoid stdout corruption in stdio MCP mode', async () => {
    const credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
    };

    const deps: McpCommandDeps = {
      readStoredCredentials: async () => credentials,
      bootstrapAccountSettingsContext: vi.fn(async () => ({}) as any),
      updateAccountSettingsV2WithRetry: vi.fn(async () => ({ version: 1 }) as any),
      ensureMachineIdForCredentials: vi.fn(async () => ({ machineId: 'machine-1' })),
      detectProviderMcpServers: vi.fn(async () => ({ ok: true, servers: [] }) as any),
      probeMcpStdioServerTools: vi.fn(async () => ({ ok: true, toolNames: [] }) as any),
      randomUUID: () => 'id',
      nowMs: () => 1,
      createExternalMcpServer: vi.fn(() => ({ mcp: { connect: vi.fn(async () => {}) }, toolNames: [] }) as any),
      connectMcpStdio: vi.fn(async (_server) => {}),
    };

    const original = console.log;
    try {
      await runMcpServeCommand(['serve'], deps);
      expect(console.log).not.toBe(original);
    } finally {
      disableMcpStdioConsolePatch();
    }
    expect(console.log).toBe(original);
  });

  it('clears env server-selection overrides before reading credentials', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://attacker.example.test';
    process.env.HAPPIER_LOCAL_SERVER_URL = 'http://attacker-local.example.test';
    process.env.HAPPIER_PUBLIC_SERVER_URL = 'http://attacker-public.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://attacker-webapp.example.test';
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'attacker';

    const readStoredCredentials = vi.fn(async () => {
      if (
        process.env.HAPPIER_SERVER_URL
        || process.env.HAPPIER_LOCAL_SERVER_URL
        || process.env.HAPPIER_PUBLIC_SERVER_URL
        || process.env.HAPPIER_WEBAPP_URL
        || process.env.HAPPIER_ACTIVE_SERVER_ID
      ) {
        throw new Error('server_selection_env_override_not_cleared_before_credentials');
      }

      return {
        token: 't',
        encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
      };
    });

    await expect(
      runMcpServeCommand(['serve'], {
        readStoredCredentials,
        ensureMachineIdForCredentials: async () => ({ machineId: 'machine_1' }),
        bootstrapAccountSettingsContext: async () => ({
          settings: {
            actionsSettingsV1: null,
          },
        }) as any,
        createExternalMcpServer: () => ({ mcp: { connect: async () => {} } as any, toolNames: [] }),
        connectMcpStdio: async () => {},
        updateAccountSettingsV2WithRetry: async () => ({} as any),
        detectProviderMcpServers: async () => ({} as any),
        probeMcpStdioServerTools: async () => [],
        randomUUID: () => 'uuid',
        nowMs: () => 0,
      }),
    ).resolves.toBeUndefined();

    expect(readStoredCredentials).toHaveBeenCalledTimes(1);
  });

  it('starts the plain Settings-backed MCP server with token-only credentials', async () => {
    const credentials = { token: 'plain-token', encryption: null } as const;
    const ensureMachineIdForCredentials = vi.fn(async () => ({ machineId: 'machine_1' }));
    const bootstrapAccountSettingsContext = vi.fn(async () => ({
      source: 'network' as const,
      settings: accountSettingsParse({
        actionsSettingsV1: {
          v: 1,
          actions: {},
        },
      }),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    }));
    const createExternalMcpServer = vi.fn(() => ({
      // Boundary fixture: only connect behavior is exercised by this command test.
      mcp: { connect: async () => {} } as any,
      toolNames: [],
    }));
    const connectMcpStdio = vi.fn(async () => {});

    await expect(runMcpServeCommand(['serve'], {
      readStoredCredentials: async () => credentials,
      ensureMachineIdForCredentials,
      bootstrapAccountSettingsContext,
      createExternalMcpServer,
      connectMcpStdio,
      updateAccountSettingsV2WithRetry: vi.fn(async () => ({} as any)),
      detectProviderMcpServers: vi.fn(async () => ({} as any)),
      probeMcpStdioServerTools: vi.fn(async () => []),
      randomUUID: () => 'uuid',
      nowMs: () => 0,
    })).resolves.toBeUndefined();

    expect(ensureMachineIdForCredentials).toHaveBeenCalledWith(credentials);
    expect(bootstrapAccountSettingsContext).toHaveBeenCalledWith(expect.objectContaining({
      credentials,
      mode: 'blocking',
      refresh: 'force',
    }));
    expect(createExternalMcpServer).toHaveBeenCalledWith({
      credentials,
      defaultSessionId: null,
      pluginToolCatalog: [],
    });
    expect(connectMcpStdio).toHaveBeenCalledOnce();
  });

  it('clears env server-selection overrides before fetching account settings', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://attacker.example.test';
    process.env.HAPPIER_LOCAL_SERVER_URL = 'http://attacker-local.example.test';
    process.env.HAPPIER_PUBLIC_SERVER_URL = 'http://attacker-public.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'http://attacker-webapp.example.test';
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'attacker';

    const bootstrapAccountSettingsContext = vi.fn(async () => {
      if (process.env.HAPPIER_SERVER_URL || process.env.HAPPIER_PUBLIC_SERVER_URL || process.env.HAPPIER_LOCAL_SERVER_URL) {
        throw new Error('server_selection_env_override_not_cleared');
      }

      return {
        settings: {
          actionsSettingsV1: null,
        },
      } as any;
    });

    await expect(
      runMcpServeCommand(['serve'], {
        readStoredCredentials: async () => ({
          token: 't',
          encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
        }),
        ensureMachineIdForCredentials: async () => ({ machineId: 'machine_1' }),
        bootstrapAccountSettingsContext,
        createExternalMcpServer: () => ({ mcp: { connect: async () => {} } as any, toolNames: [] }),
        connectMcpStdio: async () => {},
        updateAccountSettingsV2WithRetry: async () => ({} as any),
        detectProviderMcpServers: async () => ({} as any),
        probeMcpStdioServerTools: async () => [],
        randomUUID: () => 'uuid',
        nowMs: () => 0,
      }),
    ).resolves.toBeUndefined();

    expect(process.env.HAPPIER_SERVER_URL).toBeUndefined();
    expect(process.env.HAPPIER_LOCAL_SERVER_URL).toBeUndefined();
    expect(process.env.HAPPIER_PUBLIC_SERVER_URL).toBeUndefined();
    expect(process.env.HAPPIER_WEBAPP_URL).toBeUndefined();
    expect(process.env.HAPPIER_ACTIVE_SERVER_ID).toBeUndefined();
  });
});
