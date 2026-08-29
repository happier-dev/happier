import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { accountSettingsParse } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { resolveConnectedServiceMaterializedHomeRoot } from '@/daemon/connectedServices/catalogHooks';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  resolveExecutablePluginRuntimeRegistry,
  type ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

import { validateExternalMachineSource } from './validateExternalMachineSource';

describe('validateExternalMachineSource', () => {
  let controllerOwnsRegistry = false;

  beforeAll(async () => {
    let unownedRegistry: ResolvedExecutablePluginRuntimeRegistry | null =
      await resolveExecutablePluginRuntimeRegistry({
        contributes: getResolvedContributionRegistry(),
        pluginIds: [
          'happier.agent.claude',
          'happier.agent.codex',
          'happier.agent.ohmypi',
          'happier.agent.opencode',
        ],
      });
    try {
      await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry: unownedRegistry,
        changedPluginIds: [
          'happier.agent.claude',
          'happier.agent.codex',
          'happier.agent.ohmypi',
          'happier.agent.opencode',
        ],
        durableRevision: 1,
        runningSessionDisposition: 'retainRunningSessions',
      });
      controllerOwnsRegistry = true;
      unownedRegistry = null;
    } finally {
      await unownedRegistry?.dispose();
    }
  });

  afterAll(async () => {
    if (!controllerOwnsRegistry) return;
    controllerOwnsRegistry = false;
    await pluginReloadController.shutdown({ timeoutMs: 5_000 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetActiveAccountSettingsSnapshotForTests();
  });

  /**
   * A real listener, because the host supervises an attach service and health
   * probes the address before the Agent leaf ever canonicalizes the source. A
   * dead address makes every one of these cases wait out the 15s invocation
   * deadline instead of reaching the rule under test.
   */
  async function listenOnLoopback(): Promise<Readonly<{
    baseUrl: string;
    received: readonly string[];
    close(): Promise<void>;
  }>> {
    const received: string[] = [];
    const server = createServer((request, response) => {
      received.push(`${request.method ?? 'GET'} ${request.url ?? ''}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('[]');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return Object.freeze({
      baseUrl: `http://127.0.0.1:${port}`,
      get received(): readonly string[] {
        return received;
      },
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    });
  }

  function publishAgentSettings(settings: Readonly<Record<string, unknown>>): void {
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse(settings),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: 'external-source-admission',
    });
  }

  it('rejects Codex connectedService source ids with path traversal segments', async () => {
    await expect(
      validateExternalMachineSource({
        agentId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: '../escape',
        },
        env: {},
      }),
    ).rejects.toMatchObject({
      name: 'ExternalSessionProviderFailureError',
      code: 'source_invalid',
      operation: 'resolveSource',
      retryable: false,
    });
  });

  it('accepts safe Codex connectedService source ids', async () => {
    await expect(
      validateExternalMachineSource({
        agentId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        },
        env: {},
      }),
    ).resolves.toMatchObject({
      ok: true,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
      },
    });
  });

  it('stamps the host-materialized connected home onto a raw machine call that omits homePath', async () => {
    const materializedRoot = resolveConnectedServiceMaterializedHomeRoot('codex', {
      activeServerDir: configuration.activeServerDir,
      serviceId: 'openai-codex',
      profileId: 'profile-1',
    });
    if (!materializedRoot) {
      throw new Error('Codex connected-service materialized home is unavailable in the test catalog');
    }

    await expect(
      validateExternalMachineSource({
        agentId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'profile-1',
        },
        env: {},
      }),
    ).resolves.toMatchObject({
      ok: true,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
        homePath: materializedRoot,
      },
    });
  });

  it('rejects a raw connected-service machine call whose homePath does not match the materialized root', async () => {
    await expect(
      validateExternalMachineSource({
        agentId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'profile-1',
          homePath: '/tmp/elsewhere/codex-home',
        },
        env: {},
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'invalid_request',
      error: 'external_session_source_invalid',
    });
  });

  it('fills the configured Codex home path when the user source omits it', async () => {
    vi.stubEnv('CODEX_HOME', '/tmp/codex-home');
    await expect(
      validateExternalMachineSource({
        agentId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'user',
        },
        env: process.env,
      }),
    ).resolves.toMatchObject({
      ok: true,
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/tmp/codex-home',
      },
    });
  });

  it('rejects Codex user homePath overrides that do not match the configured home', async () => {
    await expect(
      validateExternalMachineSource({
        agentId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'user',
          homePath: '/tmp/other-codex-home',
        },
        env: {
          CODEX_HOME: join(homedir(), '.codex'),
        } as NodeJS.ProcessEnv,
      }),
    ).rejects.toMatchObject({
      name: 'ExternalSessionProviderFailureError',
      code: 'source_invalid',
      operation: 'resolveSource',
      retryable: false,
    });
  });

  it('fills the configured ohMyPi agent dir when the source omits it', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/tmp/omp-agent');
    await expect(
      validateExternalMachineSource({
        agentId: 'ohMyPi',
        source: {
          kind: 'ohMyPiAgentDir',
        },
        env: process.env,
      }),
    ).resolves.toMatchObject({
      ok: true,
      source: {
        kind: 'ohMyPiAgentDir',
        agentDir: '/tmp/omp-agent',
      },
    });
  });

  it('rejects ohMyPi agentDir overrides that do not match the configured agent dir', async () => {
    await expect(
      validateExternalMachineSource({
        agentId: 'ohMyPi',
        source: {
          kind: 'ohMyPiAgentDir',
          agentDir: '/tmp/other-omp-agent',
        },
        env: {
          PI_CODING_AGENT_DIR: '/tmp/omp-agent',
        } as NodeJS.ProcessEnv,
      }),
    ).rejects.toMatchObject({
      name: 'ExternalSessionProviderFailureError',
      code: 'source_invalid',
      operation: 'resolveSource',
      retryable: false,
    });
  });

  it('rejects malformed OpenCode baseUrl values with a typed provider failure', async () => {
    await expect(
      validateExternalMachineSource({
        agentId: 'opencode',
        source: {
          kind: 'opencodeServer',
          baseUrl: 'not a url',
        },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toMatchObject({
      name: 'ExternalSessionProviderFailureError',
      code: 'source_invalid',
      operation: 'resolveSource',
      retryable: false,
    });
  });
  it('rejects Claude configDir overrides that do not match the configured config dir', async () => {
    await expect(
      validateExternalMachineSource({
        agentId: 'claude',
        source: {
          kind: 'claudeConfig',
          configDir: '/tmp/other-claude-config',
        },
        env: {
          CLAUDE_CONFIG_DIR: join(homedir(), '.claude'),
        } as NodeJS.ProcessEnv,
      }),
    ).rejects.toMatchObject({
      name: 'ExternalSessionProviderFailureError',
      code: 'source_invalid',
      operation: 'resolveSource',
      retryable: false,
    });
  });

  /**
   * A selector inside the configured root stays caller-chosen: the admission
   * rule governs only the fields the host's own materialization determines.
   */
  it('admits a Claude source that names a project inside the configured config dir', async () => {
    const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'happier-claude-config-')));
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    await expect(
      validateExternalMachineSource({
        agentId: 'claude',
        source: {
          kind: 'claudeConfig',
          projectId: 'project-a',
        },
        env: process.env,
      }),
    ).resolves.toMatchObject({
      ok: true,
      source: { kind: 'claudeConfig', configDir, projectId: 'project-a' },
    });
  });

  /**
   * Oh My Pi declares an `agentSettingOverride` agent directory, so the root a
   * user configured in account settings is the authorized one and this
   * machine's ambient root is not. Pinning admission to the environment would
   * delete that setting; admitting anything would let a request name any
   * directory. Both directions are the same rule.
   */
  it('admits the ohMyPi agent dir an account setting configured, and not the ambient one', async () => {
    const configuredAgentDir = realpathSync(mkdtempSync(join(tmpdir(), 'happier-omp-configured-')));
    const ambientAgentDir = realpathSync(mkdtempSync(join(tmpdir(), 'happier-omp-ambient-')));
    publishAgentSettings({ ohMyPiAgentDir: configuredAgentDir });
    const env = { PI_CODING_AGENT_DIR: ambientAgentDir } as NodeJS.ProcessEnv;

    await expect(
      validateExternalMachineSource({
        agentId: 'ohMyPi',
        source: { kind: 'ohMyPiAgentDir', agentDir: configuredAgentDir },
        env,
      }),
    ).resolves.toMatchObject({
      ok: true,
      source: { kind: 'ohMyPiAgentDir', agentDir: configuredAgentDir },
    });

    await expect(
      validateExternalMachineSource({
        agentId: 'ohMyPi',
        source: { kind: 'ohMyPiAgentDir', agentDir: ambientAgentDir },
        env,
      }),
    ).rejects.toMatchObject({
      name: 'ExternalSessionProviderFailureError',
      code: 'source_invalid',
      operation: 'resolveSource',
      retryable: false,
    });
  });

  /**
   * OpenCode's `agentSettingOverride` carries the whole authorization: a user
   * who already runs a server configures it and Happier reuses that one,
   * otherwise Happier owns the managed server outright. With no server
   * configured no override instance materializes, so a request that names a
   * base URL of its own names a source neither the machine's environment nor
   * the account's settings ever produced. Admitting it points the daemon's own
   * HTTP client at any address the daemon can reach.
   */
  it('refuses an OpenCode baseUrl when no server is configured, without dialing it', async () => {
    const server = await listenOnLoopback();
    try {
      await expect(
        validateExternalMachineSource({
          agentId: 'opencode',
          source: { kind: 'opencodeServer', baseUrl: server.baseUrl },
          env: {} as NodeJS.ProcessEnv,
        }),
      ).rejects.toMatchObject({
        name: 'ExternalSessionProviderFailureError',
        code: 'source_invalid',
        operation: 'resolveSource',
        retryable: false,
      });
      // Refusing after the address has already been dialed is not refusing it:
      // the request's only observable effect on the named host must be none.
      expect(server.received).toEqual([]);
    } finally {
      await server.close();
    }
  });

  /**
   * Omitting the field stays the supported managed flow, and a selector inside
   * the managed server stays caller-chosen: the rule governs only the fields
   * the host's own materialization determines.
   */
  it('admits the managed OpenCode default and a directory selector inside it', async () => {
    await expect(
      validateExternalMachineSource({
        agentId: 'opencode',
        source: { kind: 'opencodeServer' },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).resolves.toMatchObject({
      ok: true,
      source: { kind: 'opencodeServer', managedEndpoint: true },
    });

    await expect(
      validateExternalMachineSource({
        agentId: 'opencode',
        source: { kind: 'opencodeServer', directory: '/tmp/opencode-project' },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).resolves.toMatchObject({
      ok: true,
      source: { kind: 'opencodeServer', managedEndpoint: true, directory: '/tmp/opencode-project' },
    });
  });

  /**
   * The other direction of the same rule: with a server configured the
   * operator's own address is authorized, and it is the only one.
   */
  it('admits the OpenCode server an account setting configured, and not another one', async () => {
    const configured = await listenOnLoopback();
    const other = await listenOnLoopback();
    try {
      publishAgentSettings({ opencodeServerBaseUrl: configured.baseUrl });

      await expect(
        validateExternalMachineSource({
          agentId: 'opencode',
          source: { kind: 'opencodeServer', baseUrl: configured.baseUrl },
          env: {} as NodeJS.ProcessEnv,
        }),
      ).resolves.toMatchObject({
        ok: true,
        source: { kind: 'opencodeServer', baseUrl: configured.baseUrl },
      });

      await expect(
        validateExternalMachineSource({
          agentId: 'opencode',
          source: { kind: 'opencodeServer', baseUrl: other.baseUrl },
          env: {} as NodeJS.ProcessEnv,
        }),
      ).rejects.toMatchObject({
        name: 'ExternalSessionProviderFailureError',
        code: 'source_invalid',
        operation: 'resolveSource',
        retryable: false,
      });
    } finally {
      await configured.close();
      await other.close();
    }
  });

  /**
   * Why the comparison against an authorized instance cannot move ahead of the
   * Agent leaf: it is only meaningful on canonicalized values. A trailing slash
   * is the same server, and the operator's own reuse flow sends whichever
   * spelling their client carries.
   */
  it('admits an equivalent spelling of the OpenCode server an account setting configured', async () => {
    const configured = await listenOnLoopback();
    try {
      publishAgentSettings({ opencodeServerBaseUrl: configured.baseUrl });

      await expect(
        validateExternalMachineSource({
          agentId: 'opencode',
          source: { kind: 'opencodeServer', baseUrl: `${configured.baseUrl}/` },
          env: {} as NodeJS.ProcessEnv,
        }),
      ).resolves.toMatchObject({
        ok: true,
        source: { kind: 'opencodeServer', baseUrl: configured.baseUrl },
      });
    } finally {
      await configured.close();
    }
  });
});
