import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { McpCommandDeps } from './deps';
import { runMcpServeCommand } from './serve';
import { disableMcpStdioConsolePatch } from '@/mcp/server/mcpStdioConsolePatch';
import { accountSettingsParse } from '@happier-dev/protocol';
import { withCliApiToken } from '@/auth/cliApiToken';
import { reloadConfiguration, configuration } from '@/configuration';
import { readStoredCredentials } from '@/persistence';
import { withTempDir } from '@/testkit/fs/tempDir';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { applyEphemeralServerSelectionFromPrefixArgs } from '@/server/serverSelection';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

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
        machineId: 'machine-1',
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
        machineId: 'machine-1',
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
        detectProviderMcpServers: async () => ({} as any),
        probeMcpStdioServerTools: async () => [],
        randomUUID: () => 'uuid',
        nowMs: () => 0,
      }),
    ).resolves.toBeUndefined();

    expect(readStoredCredentials).toHaveBeenCalledTimes(1);
  });

  it('pins one trusted saved Home snapshot while rejecting ambient and post-start redirection', async () => {
    await withTempDir('happier-cli-mcp-home-target-', async (homeDir) => {
      process.env.HAPPIER_HOME_DIR = homeDir;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_LOCAL_SERVER_URL;
      delete process.env.HAPPIER_PUBLIC_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      delete process.env.HAPPIER_ACTIVE_SERVER_ID;
      reloadConfiguration();

      await mkdir(dirname(configuration.privateKeyFile), { recursive: true });
      await writeFile(configuration.privateKeyFile, JSON.stringify({ token: 'active-home-token' }), 'utf8');
      const profile = await addServerProfile({
        name: 'selected-home',
        serverUrl: 'https://selected-home.example.test',
        webappUrl: 'https://app.selected-home.example.test',
        use: false,
      });
      await adoptServerProfileHomeConnectionDescriptor({
        descriptor: {
          v: 1,
          homeServerIdentityId: 'srv_selected_home',
          canonicalServerUrl: 'https://selected-home.example.test',
          revision: 1,
          endpoints: [{ kind: 'https', url: 'https://selected-home.example.test' }],
        },
        expectedProfileId: profile.id,
        observation: 'exact',
      });
      await mkdir(join(homeDir, 'servers', profile.id), { recursive: true });
      await writeFile(
        join(homeDir, 'servers', profile.id, 'access.key'),
        JSON.stringify({ token: 'selected-home-token' }),
        'utf8',
      );

      const resolution = await applyEphemeralServerSelectionFromPrefixArgs(['--server', profile.id, 'mcp', 'serve']);
      expect(resolution.selection?.application).toEqual({ kind: 'ephemeralEnv' });
      if (!resolution.selection || resolution.selection.application.kind !== 'ephemeralEnv') {
        throw new Error('Expected an ephemeral saved Home selection');
      }
      const selection = resolution.selection;

      process.env.HAPPIER_SERVER_URL = 'https://ambient-attacker.example.test';
      process.env.HAPPIER_ACTIVE_SERVER_ID = 'ambient-attacker';
      reloadConfiguration();

      const constructedSnapshots: Array<Readonly<{
        activeServerId: string;
        serverUrl: string;
        token: string;
        toolIds: readonly string[];
      }>> = [];
      const connectedSnapshots: typeof constructedSnapshots = [];
      const deps: McpCommandDeps = {
        observeServerFeaturesSnapshot: async () => ({
          status: 'ready',
          provenance: 'public',
          features: {
            features: {},
            capabilities: { serverIdentity: { serverIdentityId: 'srv_selected_home' } },
          },
        } as CliServerFeaturesSnapshot),
        readStoredCredentials,
        ensureMachineIdForCredentials: async () => ({ machineId: 'machine_1' }),
        bootstrapAccountSettingsContext: async ({ credentials }) => {
          expect(credentials.token).toBe(
            configuration.activeServerId === profile.id ? 'selected-home-token' : 'active-home-token',
          );
          return { settings: { actionsSettingsV1: null } } as any;
        },
        readDaemonPluginCatalog: async () => ({
          kind: 'available',
          plugins: [],
          tools: [{
            toolId: `${configuration.activeServerId}/tool`,
            actionId: `${configuration.activeServerId}/action`,
            name: `${configuration.activeServerId}_tool`,
            title: 'Profile-scoped tool',
            description: 'Profile-scoped tool',
            inputSchema: { type: 'object' },
            surfaces: ['mcp'],
          }],
        }),
        resolveLiveDaemonControlTargetForServer: async () => ({
          pid: process.pid,
          httpPort: 1,
          controlToken: 'selected-daemon-control-token',
        }),
        createExternalMcpServer: ({ credentials, pluginToolCatalog }) => {
          const snapshot = Object.freeze({
            activeServerId: configuration.activeServerId,
            serverUrl: configuration.serverUrl,
            token: credentials.token,
            toolIds: Object.freeze((pluginToolCatalog ?? []).map((tool) => tool.toolId)),
          });
          constructedSnapshots.push(snapshot);
          process.env.HAPPIER_SERVER_URL = 'https://post-start-attacker.example.test';
          process.env.HAPPIER_ACTIVE_SERVER_ID = 'post-start-attacker';
          reloadConfiguration();
          return { mcp: { snapshot } as any, toolNames: [] };
        },
        connectMcpStdio: async (mcp) => {
          connectedSnapshots.push((mcp as unknown as { snapshot: typeof constructedSnapshots[number] }).snapshot);
        },
        detectProviderMcpServers: async () => ({} as any),
        probeMcpStdioServerTools: async () => [],
        randomUUID: () => 'uuid',
        nowMs: () => 0,
      };

      try {
        await runMcpServeCommand(['serve'], deps, selection);
        await runMcpServeCommand(['serve'], deps);

        expect(constructedSnapshots).toEqual([
          {
            activeServerId: profile.id,
            serverUrl: 'https://selected-home.example.test',
            token: 'selected-home-token',
            toolIds: [`${profile.id}/tool`],
          },
          {
            activeServerId: 'cloud',
            serverUrl: 'https://api.happier.dev',
            token: 'active-home-token',
            toolIds: ['cloud/tool'],
          },
        ]);
        expect(connectedSnapshots).toEqual(constructedSnapshots);
        const persisted = JSON.parse(await readFile(join(homeDir, 'settings.json'), 'utf8'));
        expect(persisted.activeServerId).toBe('cloud');
      } finally {
        disableMcpStdioConsolePatch();
        delete process.env.HAPPIER_SERVER_URL;
        delete process.env.HAPPIER_ACTIVE_SERVER_ID;
        reloadConfiguration();
      }
    });
  });

  it('rejects a stale local route whose anonymously observed Home identity differs before reading or sending its bearer', async () => {
    const readStoredCredentials = vi.fn(async () => ({
      token: 'selected-home-token',
      encryption: null,
    }));
    const ensureMachineIdForCredentials = vi.fn(async () => ({ machineId: 'machine_1' }));
    const bootstrapAccountSettingsContext = vi.fn(async () => ({ settings: { actionsSettingsV1: null } }) as any);
    const observeServerFeaturesSnapshot = vi.fn(async () => ({
      status: 'ready' as const,
      provenance: 'public' as const,
      features: {
        features: {},
        capabilities: { serverIdentity: { serverIdentityId: 'srv_attacker_home' } },
      },
    } as CliServerFeaturesSnapshot));
    const selection = {
      homeTarget: {
        profileId: 'selected-home',
        homeServerIdentityId: 'srv_selected_home',
        descriptor: {
          v: 1 as const,
          homeServerIdentityId: 'srv_selected_home',
          canonicalServerUrl: 'https://selected-home.example.test',
          revision: 1,
          endpoints: [{ kind: 'https' as const, url: 'https://selected-route.example.test' }],
        },
        canonicalAuthUrl: 'https://selected-home.example.test',
        applicationUrl: 'https://selected-route.example.test',
        webappUrl: 'https://app.selected-home.example.test',
        credentialDestination: {
          v: 1 as const,
          homeServerIdentityId: 'srv_selected_home',
          canonicalServerUrl: 'https://selected-home.example.test',
          applicationEndpointUrls: ['https://selected-route.example.test'],
          irohEndpointIds: [],
        },
        preferredTransport: 'https' as const,
        authority: 'saved_profile' as const,
      },
      serverUrl: 'https://selected-home.example.test',
      localServerUrl: 'https://stale-malicious-route.example.test',
      webappUrl: 'https://app.selected-home.example.test',
      activeServerId: 'selected-home',
      application: { kind: 'ephemeralEnv' as const },
    };

    try {
      await expect(runMcpServeCommand(['serve'], {
        observeServerFeaturesSnapshot,
        readStoredCredentials,
        ensureMachineIdForCredentials,
        bootstrapAccountSettingsContext,
        createExternalMcpServer: vi.fn(() => ({ mcp: { connect: async () => {} } as any, toolNames: [] })),
        connectMcpStdio: async () => {},
        detectProviderMcpServers: async () => ({} as any),
        probeMcpStdioServerTools: async () => [],
        randomUUID: () => 'uuid',
        nowMs: () => 0,
      }, selection)).rejects.toMatchObject({ code: 'identity_mismatch' });

      expect(observeServerFeaturesSnapshot).toHaveBeenCalledWith({
        serverUrl: 'https://selected-route.example.test',
        projection: 'public',
      });
      expect(readStoredCredentials).not.toHaveBeenCalled();
      expect(ensureMachineIdForCredentials).not.toHaveBeenCalled();
      expect(bootstrapAccountSettingsContext).not.toHaveBeenCalled();
    } finally {
      disableMcpStdioConsolePatch();
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_LOCAL_SERVER_URL;
      delete process.env.HAPPIER_PUBLIC_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      delete process.env.HAPPIER_ACTIVE_SERVER_ID;
      reloadConfiguration();
    }
  });

  it('preserves an explicit manual Home URL without persisting or accepting ambient redirection', async () => {
    await withTempDir('happier-cli-mcp-manual-home-target-', async (homeDir) => {
      process.env.HAPPIER_HOME_DIR = homeDir;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_LOCAL_SERVER_URL;
      delete process.env.HAPPIER_PUBLIC_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      delete process.env.HAPPIER_ACTIVE_SERVER_ID;
      reloadConfiguration();

      const resolution = await applyEphemeralServerSelectionFromPrefixArgs([
        '--server-url',
        'https://manual-home.example.test',
        'mcp',
        'serve',
      ]);
      expect(resolution.selection?.application).toEqual({ kind: 'ephemeralEnv' });
      if (!resolution.selection || resolution.selection.application.kind !== 'ephemeralEnv') {
        throw new Error('Expected an ephemeral manual Home selection');
      }
      const selection = resolution.selection;

      await mkdir(join(homeDir, 'servers', selection.activeServerId), { recursive: true });
      await writeFile(
        join(homeDir, 'servers', selection.activeServerId, 'access.key'),
        JSON.stringify({ token: 'manual-home-token' }),
        'utf8',
      );
      process.env.HAPPIER_SERVER_URL = 'https://ambient-attacker.example.test';
      process.env.HAPPIER_ACTIVE_SERVER_ID = 'ambient-attacker';
      reloadConfiguration();

      const createExternalMcpServer = vi.fn(() => ({
        mcp: { connect: async () => {} } as any,
        toolNames: [],
      }));
      try {
        await runMcpServeCommand(['serve'], {
          readStoredCredentials,
          ensureMachineIdForCredentials: async () => ({ machineId: 'machine_1' }),
          bootstrapAccountSettingsContext: async () => ({ settings: { actionsSettingsV1: null } }) as any,
          createExternalMcpServer,
          connectMcpStdio: async () => {},
          detectProviderMcpServers: async () => ({} as any),
          probeMcpStdioServerTools: async () => [],
          randomUUID: () => 'uuid',
          nowMs: () => 0,
        }, selection);

        expect(configuration.activeServerId).toBe(selection.activeServerId);
        expect(configuration.serverUrl).toBe('https://manual-home.example.test');
        expect(createExternalMcpServer).toHaveBeenCalledWith(expect.objectContaining({
          credentials: expect.objectContaining({ token: 'manual-home-token' }),
        }));
        await expect(readFile(join(homeDir, 'settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        disableMcpStdioConsolePatch();
        delete process.env.HAPPIER_SERVER_URL;
        delete process.env.HAPPIER_ACTIVE_SERVER_ID;
        reloadConfiguration();
      }
    });
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
      machineId: 'machine_1',
      pluginToolCatalog: [],
    });
    expect(connectMcpStdio).toHaveBeenCalledOnce();
  });

  it('inherits the selected API Token through the canonical credential reader without rewriting saved credentials', async () => {
    await withTempDir('happier-cli-mcp-api-token-', async (homeDir) => {
      process.env.HAPPIER_HOME_DIR = homeDir;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_LOCAL_SERVER_URL;
      delete process.env.HAPPIER_PUBLIC_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      delete process.env.HAPPIER_ACTIVE_SERVER_ID;
      reloadConfiguration();
      await mkdir(dirname(configuration.privateKeyFile), { recursive: true });
      const stored = JSON.stringify({ token: 'stored-session-bearer' });
      await writeFile(configuration.privateKeyFile, stored, 'utf8');

      const token = 'hap_v1_mcp_token_secret';
      const createExternalMcpServer = vi.fn(() => ({
        mcp: { connect: async () => {} } as any,
        toolNames: [],
      }));

      try {
        await withCliApiToken(token, async () => await runMcpServeCommand(['serve'], {
          readStoredCredentials,
          ensureMachineIdForCredentials: async () => ({ machineId: 'machine_1' }),
          bootstrapAccountSettingsContext: async () => ({ settings: { actionsSettingsV1: null } }) as any,
          createExternalMcpServer,
          connectMcpStdio: async () => {},
          detectProviderMcpServers: async () => ({} as any),
          probeMcpStdioServerTools: async () => ({} as any),
          randomUUID: () => 'uuid',
          nowMs: () => 0,
        }));

        expect(createExternalMcpServer).toHaveBeenCalledWith({
          credentials: { token, encryption: null, credentialProvenance: 'api_token' },
          defaultSessionId: null,
          machineId: 'machine_1',
          pluginToolCatalog: [],
        });
        await expect(readFile(configuration.privateKeyFile, 'utf8')).resolves.toBe(stored);
      } finally {
        disableMcpStdioConsolePatch();
        reloadConfiguration();
      }
    });
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
