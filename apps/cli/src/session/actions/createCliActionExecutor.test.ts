import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockAxiosGet, mockAxiosPost } = vi.hoisted(() => ({
  mockAxiosGet: vi.fn(),
  mockAxiosPost: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
    post: mockAxiosPost,
  },
}));

vi.mock('@/configuration', async () => {
  const actual = await vi.importActual<any>('@/configuration');
  return {
    ...actual,
    configuration: {
      ...actual.configuration,
      apiServerUrl: 'http://127.0.0.1:24599',
    },
  };
});

const {
  spawnDaemonSession,
  resolveDaemonSpawnSessionByNonce,
  fetchSessionById,
  fetchSessionsPage,
  updateSessionMetadataWithRetry,
  sendSessionMessage,
  requestSessionStop,
  setSessionTitle,
  setSessionMode,
  getExecutionRun,
  listExecutionRuns,
  sendExecutionRunMessage,
  startExecutionRun,
  stopExecutionRun,
  executeExecutionRunAction,
} = vi.hoisted(() => ({
  spawnDaemonSession: vi.fn(),
  resolveDaemonSpawnSessionByNonce: vi.fn(),
  fetchSessionById: vi.fn(),
  fetchSessionsPage: vi.fn(),
  updateSessionMetadataWithRetry: vi.fn(),
  sendSessionMessage: vi.fn(),
  requestSessionStop: vi.fn(),
  setSessionTitle: vi.fn(),
  setSessionMode: vi.fn(),
  getExecutionRun: vi.fn(),
  listExecutionRuns: vi.fn(),
  sendExecutionRunMessage: vi.fn(),
  startExecutionRun: vi.fn(),
  stopExecutionRun: vi.fn(),
  executeExecutionRunAction: vi.fn(),
}));

const { bootstrapAccountSettingsContext } = vi.hoisted(() => ({
  bootstrapAccountSettingsContext: vi.fn(),
}));

const { validateStoredAuthTokenAgainstActiveServer } = vi.hoisted(() => ({
  validateStoredAuthTokenAgainstActiveServer: vi.fn(),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    spawnDaemonSession,
    resolveDaemonSpawnSessionByNonce,
  };
});

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById,
  fetchSessionsPage,
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry,
}));

vi.mock('@/session/services/sendSessionMessage', () => ({
  sendSessionMessage,
}));

vi.mock('@/session/services/requestSessionStop', () => ({
  requestSessionStop,
}));

vi.mock('@/session/services/setSessionTitle', () => ({
  setSessionTitle,
}));

vi.mock('@/session/services/setSessionMode', () => ({
  setSessionMode,
}));

vi.mock('@/session/services/executionRuns', () => ({
  getExecutionRun,
  listExecutionRuns,
  sendExecutionRunMessage,
  startExecutionRun,
  stopExecutionRun,
  executeExecutionRunAction,
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext,
}));

vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer,
}));

const { callSessionRpc } = vi.hoisted(() => ({
  callSessionRpc: vi.fn(),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc,
}));

import { createCliActionExecutor } from './createCliActionExecutor';
import {
  accountSettingsParse,
  deriveBoxPublicKeyFromSeed,
  encodeBase64,
  sealEncryptedDataKeyEnvelopeV1,
  SPAWN_SESSION_ERROR_CODES,
  type ActionId,
} from '@happier-dev/protocol';
import { createPluginStateStore } from '@/plugins/store/state';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { configuration } from '@/configuration';

const env = process.env;

async function writePluginBackendFixture(rootDir: string): Promise<void> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify(
      createPluginManifestV2Fixture({
        id: 'acme.cli-action.plugin',
        version: '1.0.0',
        displayName: 'CLI Action Plugin',
        description: 'Contributes ACP backends for action discovery',
        engines: {
          happier: `^${configuration.currentCliVersion}`,
        },
        uses: ['agents'],
        entrypoints: {
          main: './daemon.mjs',
        },
        permissions: {
          required: [],
          optional: [],
        },
        contributes: {
          agents: [
            {
              kindVersion: 1,
              id: 'acme.cli-action.backend',
              display: {
                name: 'Plugin Review Bot',
              },
              runtime: {
                kind: 'acp',
                transport: {
                  kind: 'stdio',
                  launch: {
                    kind: 'executable',
                    command: 'plugin-review-bot',
                    args: ['acp'],
                    env: {},
                  },
                },
                ux: {
                  title: 'Plugin Review Bot',
                  description: 'Plugin-sourced ACP backend',
                },
                capabilities: {
                  supportsLoadSession: false,
                  supportsModes: 'unknown',
                  supportsModels: 'unknown',
                  supportsConfigOptions: 'unknown',
                  promptImageSupport: 'unknown',
                },
              },
            },
          ],
        },
      }),
      null,
      2,
    ),
    'utf8',
  );

  // The manifest references a daemon entrypoint; keep the fixture structurally valid so plugin
  // contribution discovery doesn't fail closed on missing files.
  await writeFile(join(rootDir, 'daemon.mjs'), 'export {};\n', 'utf8');
}

async function writePluginActionFixture(rootDir: string): Promise<void> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify(
      createPluginManifestV2Fixture({
        id: 'acme.cli-action-exec.plugin',
        version: '1.0.0',
        displayName: 'CLI Action Execution Plugin',
        description: 'Contributes a daemon-executed action',
        engines: {
          happier: `^${configuration.currentCliVersion}`,
        },
        uses: ['actions'],
        entrypoints: {
          main: './daemon.mjs',
        },
        permissions: {
          required: [],
          optional: [],
        },
        contributes: {
          actions: [
            {
              id: 'acme.review.start',
              title: 'Start Acme Review',
              description: 'Starts an Acme review workflow',
              scopes: ['global'],
              surfaces: ['cli'],
              placement: 'commandPalette',
              dangerLevel: 'safe',
              handler: {
                target: 'daemon',
                exportName: 'startReview',
              },
            },
          ],
        },
      }),
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(
    join(rootDir, 'daemon.mjs'),
    [
      'export async function startReview(request) {',
      '  return { ok: true, data: {',
      '    pluginHandled: true,',
      '    actionId: request.actionId,',
      '    input: request.input,',
      '    surface: request.context.surface,',
      '  }',
      '  };',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function writeActivatedPluginActionFixture(rootDir: string): Promise<void> {
  const manifestDir = join(rootDir, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify(
      createPluginManifestV2Fixture({
        id: 'acme.cli-activated-action.plugin',
        version: '1.0.0',
        displayName: 'CLI Activated Action Plugin',
        description: 'Registers a daemon action during activation',
        engines: {
          happier: `^${configuration.currentCliVersion}`,
        },
        uses: ['actions'],
        entrypoints: {
          main: './daemon.mjs',
        },
        permissions: {
          required: [],
          optional: [],
        },
        contributes: {
          actions: [
            {
              id: 'acme.activated.review.start',
              title: 'Activated Review Start',
              description: 'Starts an activated review workflow',
              scopes: ['global'],
              surfaces: ['cli'],
              placement: 'commandPalette',
              dangerLevel: 'safe',
              handler: {
                target: 'daemon',
                registrationId: 'acme.activated.review.start',
              },
            },
          ],
        },
      }),
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(
    join(rootDir, 'daemon.mjs'),
    [
      'export async function activate(api) {',
      '  api.registerAction({',
      '    id: "acme.activated.review.start",',
      '    handler: async (request) => ({',
      '      ok: true,',
      '      data: {',
      '        pluginHandled: true,',
      '        actionId: request.actionId,',
      '        input: request.input,',
      '        surface: request.context.surface,',
      '      },',
      '    }),',
      '  });',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
}

function createPlainExecutor(extra: Partial<Parameters<typeof createCliActionExecutor>[0]> = {}) {
  return createCliActionExecutor({
    token: 'token',
    credentials: {
      token: 'token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array([1, 2, 3, 4]),
      },
    },
    sessionId: 'sess-1',
    mode: 'plain',
    ctx: {
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
    },
    ...extra,
  });
}

function createDataKeyExecutor(extra: Partial<Parameters<typeof createCliActionExecutor>[0]> = {}) {
  const machineKey = new Uint8Array(32).fill(7);
  const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
  return createCliActionExecutor({
    token: 'token',
    credentials: {
      token: 'token',
      encryption: {
        type: 'dataKey',
        publicKey,
        machineKey,
      },
    },
    sessionId: 'sess-1',
    mode: 'plain',
    ctx: {
      encryptionKey: machineKey,
      encryptionVariant: 'dataKey',
    },
    ...extra,
  });
}

describe('createCliActionExecutor', () => {
  beforeEach(() => {
    spawnDaemonSession.mockReset();
    resolveDaemonSpawnSessionByNonce.mockReset();
    fetchSessionById.mockReset();
    fetchSessionsPage.mockReset();
    updateSessionMetadataWithRetry.mockReset();
    sendSessionMessage.mockReset();
    requestSessionStop.mockReset();
    setSessionTitle.mockReset();
    setSessionMode.mockReset();
    getExecutionRun.mockReset();
    listExecutionRuns.mockReset();
    sendExecutionRunMessage.mockReset();
    startExecutionRun.mockReset();
    stopExecutionRun.mockReset();
    executeExecutionRunAction.mockReset();
    bootstrapAccountSettingsContext.mockReset();
    validateStoredAuthTokenAgainstActiveServer.mockReset();
    validateStoredAuthTokenAgainstActiveServer.mockResolvedValue({ state: 'valid', httpStatus: 200 });
    callSessionRpc.mockReset();
    mockAxiosGet.mockReset();
    mockAxiosPost.mockReset();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  });

  it('resolves execution backend options on the MCP surface', async () => {
    bootstrapAccountSettingsContext.mockResolvedValueOnce({
      source: 'network',
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
      settings: {
        schemaVersion: 2,
        backendEnabledByTargetKey: {
          'acpBackend:review-bot': true,
          'acpBackend:disabled-bot': false,
        },
        acpCatalogSettingsV1: {
          v: 2,
          backends: [
            {
              id: 'review-bot',
              name: 'review-bot',
              title: 'Review Bot',
              command: 'review-bot',
              args: [],
              env: {},
              transportProfile: 'generic',
              capabilities: {
                supportsLoadSession: false,
                supportsModes: 'unknown',
                supportsModels: 'unknown',
                supportsConfigOptions: 'unknown',
                promptImageSupport: 'unknown',
              },
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: 'disabled-bot',
              name: 'disabled-bot',
              title: 'Disabled Bot',
              command: 'disabled-bot',
              args: [],
              env: {},
              transportProfile: 'generic',
              capabilities: {
                supportsLoadSession: false,
                supportsModes: 'unknown',
                supportsModels: 'unknown',
                supportsConfigOptions: 'unknown',
                promptImageSupport: 'unknown',
              },
              createdAt: 2,
              updatedAt: 2,
            },
          ],
        },
      },
    });
    const executor = createPlainExecutor();

    const result = await executor.execute(
      'action.options.resolve',
      {
        actionId: 'subagents.plan.start',
        fieldPath: 'backendTargetKeys',
        sessionId: 'sess-1',
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        actionId: 'subagents.plan.start',
        fieldPath: 'backendTargetKeys',
        optionsSourceId: 'execution.backends.enabled',
      },
    });
    expect((result as any).result.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'backend:claude',
          label: expect.any(String),
        }),
        expect.objectContaining({
          value: 'backend:review-bot:configured:review-bot',
          label: 'Review Bot',
        }),
      ]),
    );
    expect((result as any).result.options).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'agent:customAcp',
        }),
        expect.objectContaining({
          value: 'backend:disabled-bot:configured:disabled-bot',
        }),
      ]),
    );
  });

  it('includes plugin-contributed ACP backends in execution backend options', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-action-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-cli-action-plugin-root-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writePluginBackendFixture(pluginRoot);
    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.cli-action.plugin': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            manifestDigest: null,
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });
    bootstrapAccountSettingsContext.mockResolvedValueOnce({
      source: 'network',
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
      settings: {
        schemaVersion: 2,
        acpCatalogSettingsV1: {
          v: 2,
          backends: [],
        },
      },
    });
    const executor = createPlainExecutor({ happyHomeDir });

    const result = await executor.execute(
      'action.options.resolve',
      {
        actionId: 'subagents.plan.start',
        fieldPath: 'backendTargetKeys',
        sessionId: 'sess-1',
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect((result as any).result.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'backend:acme.cli-action.backend:configured:acme.cli-action.backend',
          label: 'Plugin Review Bot',
        }),
      ]),
    );
  });

  it('executes plugin-contributed actions through the daemon action handler', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-plugin-action-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-cli-plugin-action-root-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writePluginActionFixture(pluginRoot);
    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.cli-action-exec.plugin': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            manifestDigest: null,
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });
    const executor = createPlainExecutor({ happyHomeDir });

    const result = await executor.execute(
      'acme.review.start' as ActionId,
      { scope: 'diff' },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        pluginHandled: true,
        actionId: 'acme.review.start',
        input: {
          scope: 'diff',
        },
        surface: 'cli',
      },
    });
  });

  it('executes activation-time plugin actions through the authoritative runtime registry', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-plugin-activated-action-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-cli-plugin-activated-action-root-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writeActivatedPluginActionFixture(pluginRoot);
    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.cli-activated-action.plugin': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            manifestDigest: null,
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });
    const executor = createPlainExecutor({ happyHomeDir });

    const result = await executor.execute(
      'acme.activated.review.start' as ActionId,
      { scope: 'activation' },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        pluginHandled: true,
        actionId: 'acme.activated.review.start',
        input: {
          scope: 'activation',
        },
        surface: 'cli',
      },
    });
  });

  it('fails plugin-contributed actions closed when the requested surface is not declared', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-plugin-action-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-cli-plugin-action-root-'));
    const store = createPluginStateStore({ happyHomeDir });

    await writePluginActionFixture(pluginRoot);
    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.cli-action-exec.plugin': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            manifestDigest: null,
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });
    const executor = createPlainExecutor({ happyHomeDir });

    const result = await executor.execute(
      'acme.review.start' as ActionId,
      {},
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'plugin_action_unavailable',
      error: 'Plugin action is not available on the requested surface',
    });
  });

  it('returns configured ACP backends from agents.backends.list when disabled entries are requested', async () => {
    bootstrapAccountSettingsContext.mockResolvedValueOnce({
      source: 'cache',
      settingsVersion: 2,
      loadedAtMs: 2,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
      settings: {
        schemaVersion: 2,
        backendEnabledByTargetKey: {
          'acpBackend:review-bot': true,
          'acpBackend:disabled-bot': false,
        },
        acpCatalogSettingsV1: {
          v: 2,
          backends: [
            {
              id: 'review-bot',
              name: 'review-bot',
              title: 'Review Bot',
              description: 'Primary review backend',
              command: 'review-bot',
              args: [],
              env: {},
              transportProfile: 'generic',
              capabilities: {
                supportsLoadSession: false,
                supportsModes: 'unknown',
                supportsModels: 'unknown',
                supportsConfigOptions: 'unknown',
                promptImageSupport: 'unknown',
              },
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: 'disabled-bot',
              name: 'disabled-bot',
              title: 'Disabled Bot',
              description: 'Disabled review backend',
              command: 'disabled-bot',
              args: [],
              env: {},
              transportProfile: 'generic',
              capabilities: {
                supportsLoadSession: false,
                supportsModes: 'unknown',
                supportsModels: 'unknown',
                supportsConfigOptions: 'unknown',
                promptImageSupport: 'unknown',
              },
              createdAt: 2,
              updatedAt: 2,
            },
          ],
        },
      },
    });
    const executor = createPlainExecutor();

    const result = await executor.execute(
      'agents.backends.list',
      {
        includeDisabled: true,
        limit: 20,
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        items: expect.arrayContaining([
          expect.objectContaining({
            targetKey: 'backend:pi',
            agentId: 'pi',
            enabled: true,
          }),
          expect.objectContaining({
            targetKey: 'backend:review-bot:configured:review-bot',
            label: 'Review Bot',
            enabled: true,
          }),
          expect.objectContaining({
            targetKey: 'backend:disabled-bot:configured:disabled-bot',
            label: 'Disabled Bot',
            description: 'Disabled review backend',
            enabled: false,
          }),
        ]),
      },
    });
  });

  it('omits account-settings-disabled built-in backends from execution backend options by default', async () => {
    bootstrapAccountSettingsContext.mockResolvedValueOnce({
      source: 'network',
      settingsVersion: 3,
      loadedAtMs: 3,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
      settings: {
        schemaVersion: 2,
        backendEnabledByTargetKey: {
          'agent:claude': false,
        },
        acpCatalogSettingsV1: {
          v: 2,
          backends: [],
        },
      },
    });
    const executor = createPlainExecutor();

    const result = await executor.execute(
      'action.options.resolve',
      {
        actionId: 'subagents.plan.start',
        fieldPath: 'backendTargetKeys',
        sessionId: 'sess-1',
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        actionId: 'subagents.plan.start',
        fieldPath: 'backendTargetKeys',
        optionsSourceId: 'execution.backends.enabled',
      },
    });
    expect((result as any).result.options).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'agent:claude',
        }),
      ]),
    );
  });

  it('resolves review engine options on the MCP surface', async () => {
    const executor = createPlainExecutor();

    const result = await executor.execute(
      'action.options.resolve',
      {
        actionId: 'review.start',
        fieldPath: 'engineIds',
        sessionId: 'sess-1',
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: 'review.start',
        fieldPath: 'engineIds',
        optionsSourceId: 'review.engines.available',
        options: [
          { value: 'coderabbit', label: 'CodeRabbit' },
          { value: 'deepsec', label: 'DeepSec' },
        ],
      },
    });
  });

  it('resolves session mode options from raw session metadata on the MCP surface', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          sessionModesV1: {
            currentModeId: 'build',
            availableModes: [
              { id: 'build', name: 'Build' },
              { id: 'plan', name: 'Plan' },
            ],
          },
        },
      },
    });

    const result = await executor.execute(
      'action.options.resolve',
      {
        optionsSourceId: 'session.modes.available',
        sessionId: 'sess-1',
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: null,
        fieldPath: null,
        optionsSourceId: 'session.modes.available',
        options: [
          { value: 'build', label: 'Build' },
          { value: 'plan', label: 'Plan' },
        ],
      },
    });
  });

  it('resolves session mode options from fetched session metadata when targeting a different session id', async () => {
    const executor = createPlainExecutor();
    fetchSessionById.mockResolvedValue({
      id: 'sess-2',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        sessionModesV1: {
          availableModes: [
            { id: 'build', name: 'Build' },
            { id: 'plan', name: 'Plan' },
          ],
        },
      },
    });

    const result = await executor.execute(
      'action.options.resolve',
      {
        optionsSourceId: 'session.modes.available',
        sessionId: 'sess-2',
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: null,
        fieldPath: null,
        optionsSourceId: 'session.modes.available',
        options: [
          { value: 'build', label: 'Build' },
          { value: 'plan', label: 'Plan' },
        ],
      },
    });
    expect(fetchSessionById).toHaveBeenCalledWith({ token: 'token', sessionId: 'sess-2' });
  });

  it('rejects actions disabled on the CLI surface by action settings', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['cli'], disabledPlacements: [] },
      },
    });

    const executor = createPlainExecutor();

    const result = await executor.execute(
      'review.start',
      {
        sessionId: 'sess-1',
        engineIds: ['coderabbit'],
        instructions: 'Review this change.',
        permissionMode: 'read_only',
        changeType: 'committed',
        base: { kind: 'none' },
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
      details: expect.objectContaining({
        actionId: 'review.start',
        surface: 'cli',
        reason: 'disabled_by_settings',
        settingsState: 'disabled',
      }),
    });
  });

  it('activates review-provider plugins before dispatching review.start', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-review-provider-lazy-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-cli-review-provider-lazy-root-'));
    const markerPath = join(pluginRoot, 'activation.log');
    const sessionId = 'sess-1-aaaaaaaaaaaa';
    const manifestDir = join(pluginRoot, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, 'plugin.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          id: 'acme.lazy.review-provider',
          version: '1.0.0',
          displayName: 'Lazy Review Provider',
          description: 'Activates only when a review provider is requested',
          engines: {
            happier: `^${configuration.currentCliVersion}`,
          },
          activationEvents: ['onReviewProvider:coderabbit'],
          uses: [],
          entrypoints: {
            main: './daemon.mjs',
          },
          permissions: {
            required: [],
            optional: [],
          },
          contributes: {},
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(
      join(pluginRoot, 'daemon.mjs'),
      [
        'import { appendFile } from "node:fs/promises";',
        '',
        'export async function activate() {',
        `  await appendFile(${JSON.stringify(markerPath)}, "activated\\n", "utf8");`,
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const store = createPluginStateStore({ happyHomeDir });
    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.lazy.review-provider': {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            manifestDigest: null,
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });
    fetchSessionById.mockResolvedValue({
      id: sessionId,
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {},
    });
    callSessionRpc.mockImplementationOnce(async () => {
      await expect(readFile(markerPath, 'utf8')).resolves.toBe('activated\n');
      return { ok: true, reviewTurnId: 'turn-review-native' };
    });
    const executor = createPlainExecutor({ happyHomeDir, sessionId });

    const result = await executor.execute(
      'review.start',
      {
        sessionId,
        engineIds: ['coderabbit'],
        instructions: 'Review this change.',
        runLocation: 'current_session',
        permissionMode: 'read_only',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      },
      { surface: 'cli', defaultSessionId: sessionId },
    );

    expect(result).toEqual({
      ok: true,
      result: { ok: true, reviewTurnId: 'turn-review-native' },
    });
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      method: `${sessionId}:session.review.startInline`,
    }));
    await expect(readFile(markerPath, 'utf8')).resolves.toBe('activated\n');
  });

  it('responds to permission requests via session RPC', async () => {
    const executor = createPlainExecutor();
    fetchSessionsPage.mockResolvedValue({
      sessions: [{ id: 'sess-1', metadata: {} }],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {},
    });
    callSessionRpc.mockResolvedValue({ ok: true });

    const result = await executor.execute(
      'session.permission.respond',
      { sessionId: 'sess-1', decision: 'allow', requestId: 'perm-1' },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({ ok: true, result: { ok: true } });
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-1',
      method: 'sess-1:session.permission.respond',
      request: { id: 'perm-1', approved: true },
    }));
  });

  it('preserves legacy permission response semantics for canonical RPC permission denies and metadata', async () => {
    const executor = createPlainExecutor();
    fetchSessionsPage.mockResolvedValue({
      sessions: [{ id: 'sess-1', metadata: {} }],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {},
    });
    callSessionRpc.mockResolvedValue({ ok: true });

    const result = await executor.execute(
      'session.permission.respond',
      {
        sessionId: 'sess-1',
        decision: 'deny',
        requestId: 'perm-1',
        allowedTools: ['Bash(ls:*)'],
        updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }] }],
        execPolicyAmendment: { command: ['ls'] },
      },
      { surface: 'rpc', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({ ok: true, result: { ok: true } });
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: 'sess-1:session.permission.respond',
      request: {
        id: 'perm-1',
        approved: false,
        decision: 'denied',
        allowedTools: ['Bash(ls:*)'],
        updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }] }],
        execPolicyAmendment: { command: ['ls'] },
      },
    }));
  });

  it('answers user-action requests via session RPC', async () => {
    const executor = createPlainExecutor();
    fetchSessionsPage.mockResolvedValue({
      sessions: [{ id: 'sess-1', metadata: {} }],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {},
    });
    callSessionRpc.mockResolvedValue({ ok: true });

    const result = await executor.execute(
      'session.user_action.answer',
      {
        sessionId: 'sess-1',
        requestId: 'ua-1',
        decision: 'approve',
        reason: 'ok',
        answers: [{ question: 'Continue?', answer: 'Yes' }],
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({ ok: true, result: { ok: true } });
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-1',
      method: 'sess-1:session.user_action.answer',
      request: expect.objectContaining({
        id: 'ua-1',
        approved: true,
        decision: 'approved',
        reason: 'ok',
        answers: { 'Continue?': 'Yes' },
      }),
    }));
  });

  it('preserves reject and request-changes semantics for canonical user-action answers', async () => {
    const executor = createPlainExecutor();
    fetchSessionsPage.mockResolvedValue({
      sessions: [{ id: 'sess-1', metadata: {} }],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {},
    });
    callSessionRpc.mockResolvedValue({ ok: true });

    await executor.execute(
      'session.user_action.answer',
      {
        sessionId: 'sess-1',
        requestId: 'ua-reject',
        decision: 'reject',
        reason: 'not acceptable',
      },
      { surface: 'rpc', defaultSessionId: 'sess-1' },
    );
    await executor.execute(
      'session.user_action.answer',
      {
        sessionId: 'sess-1',
        requestId: 'ua-request-changes',
        decision: 'request_changes',
        reason: 'revise first',
      },
      { surface: 'rpc', defaultSessionId: 'sess-1' },
    );

    expect(callSessionRpc).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'sess-1:session.user_action.answer',
      request: expect.objectContaining({
        id: 'ua-reject',
        approved: false,
        decision: 'denied',
        actionDecision: 'reject',
        reason: 'not acceptable',
      }),
    }));
    expect(callSessionRpc).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'sess-1:session.user_action.answer',
      request: expect.objectContaining({
        id: 'ua-request-changes',
        approved: false,
        decision: 'abort',
        actionDecision: 'request_changes',
        reason: 'revise first',
      }),
    }));
  });

  it('executes execution.run.get against the requested session id (not the executor default)', async () => {
    const executor = createPlainExecutor();
    fetchSessionById.mockResolvedValue({
      id: 'sess-2-aaaaaaaaaaaa',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: {},
    });
    getExecutionRun.mockResolvedValue({ ok: true, runId: 'run-1' });

    const result = await executor.execute(
      'execution.run.get',
      { sessionId: 'sess-2-aaaaaaaaaaaa', runId: 'run-1', includeStructured: false },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({ ok: true, result: { ok: true, runId: 'run-1' } });
    expect(getExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-2-aaaaaaaaaaaa',
    }));
  });

  it('resolves the stored encryption mode for execution.run.get when targeting a different session id', async () => {
    const executor = createPlainExecutor();
    fetchSessionById.mockResolvedValue({
      id: 'sess-2-aaaaaaaaaaaa',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      encryptionMode: 'e2ee',
      metadata: {},
    });
    getExecutionRun.mockResolvedValue({ ok: true, runId: 'run-1' });

    const result = await executor.execute(
      'execution.run.get',
      { sessionId: 'sess-2-aaaaaaaaaaaa', runId: 'run-1', includeStructured: false },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({ ok: true, result: { ok: true, runId: 'run-1' } });
    expect(fetchSessionById).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-2-aaaaaaaaaaaa',
    }));
    expect(getExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-2-aaaaaaaaaaaa',
      mode: 'e2ee',
    }));
  });

  it('spawns a new session from the current session context on the CLI surface', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess-new' });
    fetchSessionById.mockResolvedValue({
      id: 'sess-new',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        tag: 'voice-qa',
        summary: { text: 'Spawned session' },
      },
    });
    updateSessionMetadataWithRetry.mockResolvedValue({
      version: 2,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
        tag: 'voice-qa',
      },
    });
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-new',
      localId: 'local-1',
      waited: false,
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        tag: 'voice-qa',
        agentId: 'claude',
        modelId: 'gpt-5',
        initialMessage: 'Hello from CLI action',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result.ok).toBe(true);
    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/current',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'claude' },
      modelSelection: {
        v: 1,
        updatedAt: expect.any(Number),
        ref: { agentTargetKey: 'backend:claude', providerConnectionId: null, modelId: 'gpt-5' },
      },
      initialPrompt: 'Hello from CLI action',
    }));
    expect(updateSessionMetadataWithRetry).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-new',
      token: 'token',
    }));
    expect(sendSessionMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-new',
        created: true,
        session: {
          id: 'sess-new',
        },
      },
    });
  });

  it('spawns a new session for an explicit canonical opencode backend target key', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess-opencode' });
    fetchSessionById.mockResolvedValue({
      id: 'sess-opencode',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        summary: { text: 'Spawned OpenCode session' },
      },
    });
    updateSessionMetadataWithRetry.mockResolvedValue({
      version: 2,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        backendTargetKey: 'backend:opencode',
        initialMessage: 'Hello from CLI action',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-opencode',
        created: true,
      },
    });
    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/current',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'opencode' },
      initialPrompt: 'Hello from CLI action',
    }));
  });

  it('forwards rich dev spawn fields from session.spawn_new to daemon spawn', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    const runtimeDescriptorV1 = {
      v: 1,
      agentId: 'codex',
      agent: {
        agentExtra: {
          owner: 'happier',
          schemaId: 'codex-runtime',
          v: 1,
        },
        backendMode: 'appServer',
      },
    } as const;
    const mcpSelection = {
      forceIncludeServerIds: ['server-a'],
      forceExcludeServerIds: ['server-b'],
    } as const;
    const connectedServices = {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'profile',
          profileId: 'codex-profile',
        },
      },
    } as const;
    const sessionConfigOptionOverrides = {
      v: 1,
      updatedAt: 1710000000000,
      overrides: {
        reasoning_effort: { updatedAt: 1710000000000, value: 'xhigh' },
      },
    } as const;
    const configOptions = { ultracode: true } as const;
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess-rich' });
    fetchSessionById.mockResolvedValue({
      id: 'sess-rich',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/rich',
        host: 'leeroy-mbp',
        summary: { text: 'Spawned rich session' },
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        directory: '/repo/rich',
        backendTargetKey: 'backend:codex',
        initialPrompt: 'Hello rich session',
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 1710000000001,
        agentModeId: 'plan',
        agentModeUpdatedAt: 1710000000002,
        modelId: 'gpt-5',
        modelUpdatedAt: 1710000000003,
        sessionConfigOptionOverrides,
        configOptions,
        profileId: 'codex-profile',
        environmentVariables: { FEATURE_FLAG: 'enabled' },
        connectedServices,
        connectedServicesUpdatedAt: 1710000000004,
        mcpSelection,
        transcriptStorage: 'persisted',
        runtimeDescriptorV1,
        terminal: { mode: 'tmux' },
        windowsTerminalWindowName: 'Happier Test',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result.ok).toBe(true);
    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/rich',
      spawnNonce: expect.any(String),
      initialPrompt: 'Hello rich session',
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 1710000000001,
      agentModeId: 'plan',
      agentModeUpdatedAt: 1710000000002,
      modelSelection: {
        v: 1,
        updatedAt: 1710000000003,
        ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'gpt-5' },
      },
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: expect.any(Number),
        overrides: {
          reasoning_effort: { updatedAt: 1710000000000, value: 'xhigh' },
          ultracode: { updatedAt: expect.any(Number), value: true },
        },
      },
      profileId: 'codex-profile',
      environmentVariables: { FEATURE_FLAG: 'enabled' },
      connectedServices,
      connectedServicesUpdatedAt: 1710000000004,
      mcpSelection: {
        v: 1,
        managedServersEnabled: true,
        ...mcpSelection,
      },
      transcriptStorage: 'persisted',
      runtimeDescriptorV1,
      terminal: { mode: 'tmux' },
      windowsTerminalWindowName: 'Happier Test',
    }));
  });

  it('rejects session-agent session.permission_mode.set escalation before transport dispatch', async () => {
    callSessionRpc.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      permissionMode: 'workspace_write',
    });
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
          permissionMode: 'default',
          permissionModeUpdatedAt: 100,
        },
      },
    });

    const result = await executor.execute(
      'session.permission_mode.set',
      {
        sessionId: 'sess-1',
        permissionMode: 'workspace_write',
      },
      { surface: 'agent', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'permission_escalation_denied',
      error: 'permission_escalation_denied',
    }));
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('blocks session.spawn_new before daemon spawn when the active server rejects stored auth', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    validateStoredAuthTokenAgainstActiveServer.mockResolvedValueOnce({
      state: 'invalid',
      httpStatus: 401,
      reasonCode: 'not_authenticated',
    });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess-new' });
    fetchSessionById.mockResolvedValue({
      id: 'sess-new',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        summary: { text: 'Spawned session' },
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        agentId: 'opencode',
        initialMessage: 'Hello from CLI action',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'not_authenticated',
    });
    expect(validateStoredAuthTokenAgainstActiveServer).toHaveBeenCalledWith('token');
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(fetchSessionById).not.toHaveBeenCalled();
  });

  it('spawns a new session from the current session context with account connected-service defaults', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    bootstrapAccountSettingsContext.mockResolvedValueOnce({
      source: 'network',
      settings: accountSettingsParse({
        connectedServicesDefaultAuthByAgentIdV1: {
          v: 1,
          bindingsByAgentId: {
            claude: {
              v: 1,
              bindingsByServiceId: {
                'claude-subscription': {
                  source: 'connected',
                  selection: 'group',
                  groupId: 'claude',
                },
              },
            },
          },
        },
      }),
      settingsVersion: 7,
      loadedAtMs: 1234,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess-new' });
    fetchSessionById.mockResolvedValue({
      id: 'sess-new',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        tag: 'voice-qa',
        summary: { text: 'Spawned session' },
      },
    });
    updateSessionMetadataWithRetry.mockResolvedValue({
      version: 2,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
        tag: 'voice-qa',
      },
    });
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-new',
      localId: 'local-1',
      waited: false,
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        tag: 'voice-qa',
        agentId: 'claude',
        modelId: 'gpt-5',
        initialMessage: 'Hello from CLI action',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result.ok).toBe(true);
    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/current',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'claude' },
      modelSelection: {
        v: 1,
        updatedAt: expect.any(Number),
        ref: { agentTargetKey: 'backend:claude', providerConnectionId: null, modelId: 'gpt-5' },
      },
      initialPrompt: 'Hello from CLI action',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude',
          },
          anthropic: { source: 'native' },
        },
      },
      connectedServicesUpdatedAt: expect.any(Number),
    }));
    expect(updateSessionMetadataWithRetry).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-new',
      token: 'token',
    }));
    expect(sendSessionMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-new',
        created: true,
        session: {
          id: 'sess-new',
        },
      },
    });
  });

  it('fails closed for session.spawn_new when nonce recovery is unsupported instead of using row-scan heuristics', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({
      error: 'Request failed: /spawn-session, The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
    });
    resolveDaemonSpawnSessionByNonce.mockResolvedValue({ status: 'unsupported' });
    const result = await executor.execute(
      'session.spawn_new',
      {
        path: '/repo/current',
        backendTargetKey: 'agent:codex',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: false,
    });
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledTimes(1);
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/i));
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('recovers session.spawn_new via spawn nonce resolution before fallback row scans', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({
      error: 'Request failed: /spawn-session, The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
    });
    resolveDaemonSpawnSessionByNonce.mockResolvedValue({
      status: 'success',
      sessionId: 'sess-recovered-nonce',
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-recovered-nonce',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      active: true,
      activeAt: Date.now(),
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });
    updateSessionMetadataWithRetry.mockResolvedValue({
      version: 1,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        path: '/repo/current',
        backendTargetKey: 'agent:codex',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-recovered-nonce',
        created: true,
      },
    });
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledTimes(1);
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('recovers session.spawn_new when daemon reports a structured webhook timeout as pending', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({
      status: 'pending',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      error: 'Timed out waiting for session webhook',
    });
    resolveDaemonSpawnSessionByNonce.mockResolvedValue({
      status: 'success',
      sessionId: 'sess-recovered-timeout',
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-recovered-timeout',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      active: true,
      activeAt: Date.now(),
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });
    updateSessionMetadataWithRetry.mockResolvedValue({
      version: 1,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        path: '/repo/current',
        backendTargetKey: 'agent:codex',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-recovered-timeout',
        created: true,
      },
    });
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledTimes(1);
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('preserves session.spawn_new child-exit failures instead of masking them with nonce recovery', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({
      error: 'Failed to spawn session: Child process exited before session webhook (pid=1234, code=null, signal=SIGKILL)',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
    });
    resolveDaemonSpawnSessionByNonce.mockResolvedValue({
      status: 'success',
      sessionId: 'sess-recovered-webhook-exit',
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-recovered-webhook-exit',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      active: true,
      activeAt: Date.now(),
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });
    updateSessionMetadataWithRetry.mockResolvedValue({
      version: 1,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        path: '/repo/current',
        backendTargetKey: 'agent:codex',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Child process exited before session webhook'),
    });
    expect(JSON.stringify(result)).not.toContain('spawn_recovery_not_found');
    expect(JSON.stringify(result)).not.toContain('Deterministic spawn recovery');
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('preserves session.spawn_new spawn validation failures instead of masking them as daemon unavailable', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({
      error: 'OhMyPi has no available models. Set provider API keys before starting a session.',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        path: '/repo/current',
        backendTargetKey: 'agent:ohMyPi',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      error: expect.stringContaining('OhMyPi has no available models'),
    });
    expect(JSON.stringify(result)).not.toContain(SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE);
    expect(JSON.stringify(result)).not.toContain('spawn_recovery_');
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it.each([
    'Daemon is not running, file is stale',
    'No daemon running, no state file found',
  ])('preserves direct daemon-down spawn failures for %s', async (spawnError) => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({
      error: spawnError,
      errorCode: 'DAEMON_RPC_UNAVAILABLE',
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        path: '/repo/current',
        backendTargetKey: 'agent:codex',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain(spawnError);
    expect(JSON.stringify(result)).not.toContain('spawn_recovery_');
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('returns host_not_found when session.spawn_new targets a different host on the CLI surface', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        host: 'other-host',
        initialMessage: 'Hello',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'host_not_found',
      error: 'host_not_found',
    });
    expect(spawnDaemonSession).not.toHaveBeenCalled();
  });

  it('executes session.message.send via the existing sendSessionMessage service', async () => {
    const executor = createPlainExecutor();
    sendSessionMessage.mockResolvedValue({ ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false });

    const result = await executor.execute(
      'session.message.send',
      {
        sessionId: 'sess-1',
        message: 'Hello',
        modelOverride: 'default',
        providerConnectionId: 'pc_work',
        wait: false,
        timeoutSeconds: 10,
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false },
    });
    expect(sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ token: 'token' }),
      idOrPrefix: 'sess-1',
      message: 'Hello',
      modelSelectionInput: {
        providerConnectionId: 'pc_work',
        modelId: 'default',
      },
      wait: false,
      timeoutMs: 10_000,
    }));
  });

  it('executes session.mode.set via the setSessionMode service', async () => {
    const executor = createPlainExecutor();
    fetchSessionById.mockResolvedValueOnce({
      id: 'sess-2',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        sessionModesV1: {
          availableModes: [{ id: 'plan', name: 'Plan' }],
        },
      },
    });
    setSessionMode.mockResolvedValue({
      ok: true,
      sessionId: 'sess-2',
      metadata: {},
      version: 1,
    });

    const result = await executor.execute(
      'session.mode.set',
      { sessionId: 'sess-2', modeId: 'plan' },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-2',
        modeId: 'plan',
      },
    });
    expect((result as any).result.updatedAt).toEqual(expect.any(Number));
    expect(setSessionMode).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ token: 'token' }),
      idOrPrefix: 'sess-2',
      modeId: 'plan',
      updatedAt: expect.any(Number),
    }));
  });

  it('routes approval-required actions through approvalsCreate when configured for the CLI surface', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.message.send': { enabled: true, disabledSurfaces: [], disabledPlacements: [], approvalRequiredSurfaces: ['cli'] },
      },
    });

    mockAxiosPost.mockResolvedValueOnce({ status: 200, data: { id: 'artifact-1' } });

    const executor = createDataKeyExecutor();
    sendSessionMessage.mockResolvedValueOnce({ ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false });

    const result = await executor.execute(
      'session.message.send',
      { sessionId: 'sess-1', message: 'hello' },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect((result as any).result).toEqual(expect.objectContaining({
      kind: 'approval_request_created',
      artifactId: 'artifact-1',
      actionId: 'session.message.send',
    }));
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('routes approval-required actions through approvalsCreate when CLI surface is implicit', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.message.send': { enabled: true, disabledSurfaces: [], disabledPlacements: [], approvalRequiredSurfaces: ['cli'] },
      },
    });

    mockAxiosPost.mockResolvedValueOnce({ status: 200, data: { id: 'artifact-1' } });

    const executor = createDataKeyExecutor();
    sendSessionMessage.mockResolvedValueOnce({ ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false });

    const result = await executor.execute(
      'session.message.send',
      { sessionId: 'sess-1', message: 'hello' },
      { defaultSessionId: 'sess-1' },
    );

    expect((result as any).result).toEqual(expect.objectContaining({
      kind: 'approval_request_created',
      artifactId: 'artifact-1',
      actionId: 'session.message.send',
    }));
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('uses a session-specific data key encryption context when starting execution runs in other sessions', async () => {
    const machineKey = new Uint8Array(32).fill(7);
    const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
    const sessionDek = new Uint8Array(32).fill(9);
    const encryptedDek = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionDek,
      recipientPublicKey: publicKey,
      randomBytes: (length) => new Uint8Array(length).fill(3),
    });
    const dataEncryptionKey = encodeBase64(encryptedDek, 'base64');

    fetchSessionById.mockResolvedValue({
      id: 'sess-2-aaaaaaaaaaaa',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      encryptionMode: 'e2ee',
      dataEncryptionKey,
      metadata: {},
    });

    startExecutionRun.mockResolvedValueOnce({ ok: true, data: { runId: 'run-1' } });

    const executor = createCliActionExecutor({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'dataKey', publicKey, machineKey },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: { encryptionKey: machineKey, encryptionVariant: 'dataKey' },
    });

    await executor.execute(
      'execution.run.start',
      {
        sessionId: 'sess-2-aaaaaaaaaaaa',
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(startExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-2-aaaaaaaaaaaa',
      ctx: expect.objectContaining({
        encryptionVariant: 'dataKey',
        encryptionKey: sessionDek,
      }),
    }));
  });
});
