import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
  fetchSessionById,
  fetchSessionsPage,
  lookupSessionsByTags,
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
  requestDaemonPluginActionExecution,
} = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  fetchSessionsPage: vi.fn(),
  lookupSessionsByTags: vi.fn(),
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
  requestDaemonPluginActionExecution: vi.fn(),
}));

const { bootstrapAccountSettingsContext } = vi.hoisted(() => ({
  bootstrapAccountSettingsContext: vi.fn(),
}));

const { validateStoredAuthTokenAgainstActiveServer } = vi.hoisted(() => ({
  validateStoredAuthTokenAgainstActiveServer: vi.fn(),
}));

const { fetchAccountEncryptionCurrentness } = vi.hoisted(() => ({
  fetchAccountEncryptionCurrentness: vi.fn(),
}));

const {
  callMachineRpc,
  spawnMachineSession,
  resolveMachineSpawnSessionByNonce,
  readMachineOperationProtocolCapabilitiesV1,
} = vi.hoisted(() => ({
  callMachineRpc: vi.fn(),
  spawnMachineSession: vi.fn(),
  resolveMachineSpawnSessionByNonce: vi.fn(),
  readMachineOperationProtocolCapabilitiesV1: vi.fn(),
}));

vi.mock('@/daemon/controlClient', () => ({ requestDaemonPluginActionExecution }));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById,
  fetchSessionsPage,
  lookupSessionsByTags,
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

vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>();
  return {
    ...actual,
    fetchAccountEncryptionCurrentness,
  };
});

const { callSessionRpc } = vi.hoisted(() => ({
  callSessionRpc: vi.fn(),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc,
}));

vi.mock('@/session/transport/rpc/machineRpc', () => ({
  callMachineRpc,
}));

vi.mock('@/api/machine/machineOperationProtocolCapabilities', () => ({
  readMachineOperationProtocolCapabilitiesV1,
}));

import { createCliActionExecutor } from './createCliActionExecutor';
import { registerSessionSpawnNewRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import {
  accountSettingsParse,
  deriveBoxPublicKeyFromSeed,
  encodeBase64,
  sealEncryptedDataKeyEnvelopeV1,
  SPAWN_SESSION_ERROR_CODES,
  type ActionId,
  createPlainSessionOwnerMetadataEnvelopeV1,
  SessionCreationKeyV1Schema,
  SessionOwnerMetadataV1Schema,
  type SessionSpawnNewInputV2,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { configuration } from '@/configuration';

const env = process.env;
const PLUGIN_ACTION_ID = 'acme.cli-action-exec.plugin/review-start';
const ACTIVATED_PLUGIN_ACTION_ID = 'acme.cli-activated-action.plugin/review-start';

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
        entrypoints: {
          daemon: './daemon.mjs',
        },
        hostAccess: {
          required: [],
          optional: [],
        },
        contributes: {
          agents: [
            {
              id: 'acme-cli-action-backend',
              title: 'Plugin Review Bot',
              runtime: {
                kind: 'acp',
                transport: {
                  kind: 'stdio',
                  executable: { kind: 'systemTool', id: 'review-bot-cli' },
                  args: ['acp'],
                },
              },
              primary: 'sessions',
              capabilities: {
                sessions: {
                  open: ['create'],
                  delivery: ['newTurn'],
                  cancel: true,
                },
              },
            },
          ],
          systemTools: [{ id: 'review-bot-cli', title: 'Plugin Review Bot CLI', executableNames: ['plugin-review-bot'] }],
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
        entrypoints: {
          daemon: './daemon.mjs',
        },
        activation: { events: [{ kind: 'startup' }] },
        hostAccess: {
          required: [],
          optional: [],
        },
        contributes: {
          actions: [
            {
              id: 'review-start',
              title: 'Start Acme Review',
              description: 'Starts an Acme review workflow',
              scopes: ['global'],
              surfaces: ['cli'],
              placementBindings: ['commandPalette'],
              dangerLevel: 'safe',
              execution: { target: 'daemon' },
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
      '  api.actions.register("review-start", async (input, context) => ({',
      '    pluginHandled: true,',
      `    actionId: ${JSON.stringify(PLUGIN_ACTION_ID)},`,
      '    input,',
      '    surface: context.surface,',
      '  }));',
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
        entrypoints: {
          daemon: './daemon.mjs',
        },
        activation: { events: [{ kind: 'startup' }] },
        hostAccess: {
          required: [],
          optional: [],
        },
        contributes: {
          actions: [
            {
              id: 'review-start',
              title: 'Activated Review Start',
              description: 'Starts an activated review workflow',
              scopes: ['global'],
              surfaces: ['cli'],
              placementBindings: ['commandPalette'],
              dangerLevel: 'safe',
              execution: { target: 'daemon' },
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
      '  api.actions.register("review-start", async (input, context) => ({',
      '        pluginHandled: true,',
      `        actionId: ${JSON.stringify(ACTIVATED_PLUGIN_ACTION_ID)},`,
      '        input,',
      '        surface: context.surface,',
      '  }));',
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
    ...extra,
    mode: 'plain',
    ctx: null,
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
    ...extra,
    mode: 'plain',
    ctx: null,
  });
}

const SESSION_SPAWN_AGENT_TARGETS = {
  claude: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
  },
  codex: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
  opencode: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
  },
  ohmypi: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.ohmypi', localId: 'ohmypi' },
  },
} as const satisfies Record<string, SessionSpawnNewInputV2['agentTarget']>;

type MachineRpcCall = Readonly<{
  method: string;
  request: Record<string, unknown>;
}>;

let latestSessionSpawnRequest: Readonly<Record<string, unknown>> | null = null;

function createSessionSpawnInput(
  overrides: Partial<SessionSpawnNewInputV2> = {},
): SessionSpawnNewInputV2 {
  return {
    creationKey: SessionCreationKeyV1Schema.parse('create-cli-action-executor-test'),
    executionTarget: {
      serverId: configuration.activeServerId,
      machineId: 'machine-1',
    },
    directory: '/repo/current',
    agentTarget: SESSION_SPAWN_AGENT_TARGETS.claude,
    ...overrides,
  };
}

function createSpawnedSessionRecord(sessionId: string) {
  const spawnRequest = latestSessionSpawnRequest;
  if (!spawnRequest) {
    throw new Error('Expected a Session creation request before reading the spawned Session.');
  }
  const directory = typeof spawnRequest.directory === 'string'
    ? spawnRequest.directory
    : '/repo/current';
  return {
    id: sessionId,
    createdAt: 1,
    updatedAt: 2,
    active: true,
    activeAt: 2,
    pendingCount: 0,
    metadataVersion: 1,
    encryptionMode: 'plain' as const,
    metadataLayoutVersion: 1,
    metadata: JSON.stringify({ v: 1 }),
    ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
      SessionOwnerMetadataV1Schema.parse({
        v: 1,
        workspace: { path: directory, host: 'leeroy-mbp' },
        system: {
          sessionCreationCorrespondenceV1: spawnRequest.sessionCreationCorrespondence,
        },
      }),
    ),
  };
}

function mockMachineSpawnSuccess(
  sessionId: string,
  disposition: 'created' | 'rejoined' = 'created',
): void {
  spawnMachineSession.mockResolvedValue({
    success: true,
    sessionId,
    sessionCreationOutcome: {
      disposition,
      organizationPlacement: { folderId: null, tagIds: [] },
    },
  });
}

describe('createCliActionExecutor', () => {
  beforeEach(() => {
    latestSessionSpawnRequest = null;
    callMachineRpc.mockReset();
    spawnMachineSession.mockReset();
    resolveMachineSpawnSessionByNonce.mockReset();
    readMachineOperationProtocolCapabilitiesV1.mockReset();
    fetchSessionById.mockReset();
    fetchSessionsPage.mockReset();
    lookupSessionsByTags.mockReset();
    lookupSessionsByTags.mockResolvedValue({ state: 'unavailable' });
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
    requestDaemonPluginActionExecution.mockReset();
    requestDaemonPluginActionExecution.mockImplementation(async (request) => {
      if (request.actionId === PLUGIN_ACTION_ID) {
        if (request.surface !== 'cli') {
          return {
            matched: true,
            result: {
              ok: false,
              errorCode: 'plugin_action_unavailable',
              error: 'Plugin action is not available on the requested surface',
            },
          };
        }
        return {
          matched: true,
          result: {
            ok: true,
            result: {
              pluginHandled: true,
              actionId: request.actionId,
              input: request.input,
              surface: request.surface,
            },
          },
        };
      }
      if (request.actionId === ACTIVATED_PLUGIN_ACTION_ID) {
        return {
          matched: true,
          result: {
            ok: true,
            result: {
              pluginHandled: true,
              actionId: request.actionId,
              input: request.input,
              surface: request.surface,
            },
          },
        };
      }
      return { matched: false };
    });
    bootstrapAccountSettingsContext.mockReset();
    validateStoredAuthTokenAgainstActiveServer.mockReset();
    validateStoredAuthTokenAgainstActiveServer.mockResolvedValue({ state: 'valid', httpStatus: 200 });
    fetchAccountEncryptionCurrentness.mockReset().mockResolvedValue({
      mode: 'plain',
      version: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 1,
    });
    readMachineOperationProtocolCapabilitiesV1.mockResolvedValue({
      capabilities: { sessionSpawn: { protocolVersions: [1] } },
      revision: 1,
    });
    mockMachineSpawnSuccess('sess-new');
    resolveMachineSpawnSessionByNonce.mockResolvedValue({ status: 'unsupported' });
    callMachineRpc.mockImplementation(async (call: MachineRpcCall) => {
      if (call.method === RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE) {
        return {
          ok: true,
          directory: typeof call.request.directory === 'string'
            ? call.request.directory
            : '/repo/current',
          directoryCreationRequired: false,
          checkout: null,
        };
      }
      if (
        call.method === RPC_METHODS.SPAWN_HAPPY_SESSION
        || call.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
      ) {
        latestSessionSpawnRequest = call.request;
        return await spawnMachineSession(call.request);
      }
      if (call.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE) {
        const spawnNonce = typeof call.request.spawnNonce === 'string'
          ? call.request.spawnNonce
          : '';
        return await resolveMachineSpawnSessionByNonce(spawnNonce);
      }
      throw new Error(`Unexpected machine RPC in Action executor test: ${call.method}`);
    });
    fetchSessionById.mockImplementation(async ({ sessionId }: { sessionId: string }) =>
      createSpawnedSessionRecord(sessionId),
    );
    sendSessionMessage.mockImplementation(async ({
      idOrPrefix,
      localId,
    }: Readonly<{ idOrPrefix?: unknown; localId?: unknown }>) => {
      const sessionId = typeof idOrPrefix === 'string' ? idOrPrefix : 'sess-new';
      const resolvedLocalId = typeof localId === 'string' ? localId : 'spawn-initial-input';
      return {
        ok: true,
        sessionId,
        localId: resolvedLocalId,
        waited: false,
        admissionResult: { status: 'accepted' as const, localId: resolvedLocalId },
      };
    });
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

  it('executes plugin-contributed actions through the active daemon instead of a caller-local runtime', async () => {
    requestDaemonPluginActionExecution.mockResolvedValueOnce({
      matched: true,
      result: {
        ok: true,
        result: {
          pluginHandled: true,
          actionId: PLUGIN_ACTION_ID,
        },
      },
    });
    const executor = createPlainExecutor();

    await expect(executor.execute(
      PLUGIN_ACTION_ID as ActionId,
      { scope: 'diff' },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    )).resolves.toEqual({
      ok: true,
      result: {
        pluginHandled: true,
        actionId: PLUGIN_ACTION_ID,
      },
    });

    expect(requestDaemonPluginActionExecution).toHaveBeenCalledWith({
      actionId: PLUGIN_ACTION_ID,
      input: { scope: 'diff' },
      surface: 'cli',
      defaultSessionId: 'sess-1',
    });
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
          value: 'backend:acme-cli-action-backend:configured:acme-cli-action-backend',
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
      PLUGIN_ACTION_ID as ActionId,
      { scope: 'diff' },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        pluginHandled: true,
        actionId: PLUGIN_ACTION_ID,
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
      ACTIVATED_PLUGIN_ACTION_ID as ActionId,
      { scope: 'activation' },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        pluginHandled: true,
        actionId: ACTIVATED_PLUGIN_ACTION_ID,
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
      PLUGIN_ACTION_ID as ActionId,
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
      encryptionMode: 'plain',
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

  it('does not permit MCP to respond to permission requests', async () => {
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
      encryptionMode: 'plain',
      metadata: {},
    });
    callSessionRpc.mockResolvedValue({ ok: true });

    const result = await executor.execute(
      'session.permission.respond',
      { sessionId: 'sess-1', decision: 'allow', requestId: 'perm-1' },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
      details: expect.objectContaining({
        actionId: 'session.permission.respond',
        surface: 'mcp',
        reason: 'unsupported_surface',
      }),
    });
    expect(callSessionRpc).not.toHaveBeenCalled();
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
      encryptionMode: 'plain',
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
      encryptionMode: 'plain',
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
        answers: [{
          question: 'Where should this run?',
          values: ['Washington, D.C.', 'Virginia', 'A custom, exact answer'],
        }],
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
        answers: {
          'Where should this run?': ['Washington, D.C.', 'Virginia', 'A custom, exact answer'],
        },
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
      encryptionMode: 'plain',
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

  it('spawns a strict V2 Session request through the exact machine RPC owner', async () => {
    const executor = createPlainExecutor();
    mockMachineSpawnSuccess('sess-new');

    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({
        agentTarget: SESSION_SPAWN_AGENT_TARGETS.claude,
        modelSelection: {
          v: 1,
          updatedAt: 1710000000000,
          ref: { agentTargetKey: 'backend:claude', providerConnectionId: null, modelId: 'gpt-5' },
        },
        initialMessage: 'Hello from CLI action',
      }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      request: expect.objectContaining({
        directory: '/repo/current',
        machineId: 'machine-1',
        backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'claude' },
        modelSelection: {
          v: 1,
          updatedAt: 1710000000000,
          ref: { agentTargetKey: 'backend:claude', providerConnectionId: null, modelId: 'gpt-5' },
        },
        spawnNonce: expect.any(String),
      }),
    }));
    const firstSpawnCall = callMachineRpc.mock.calls.find(
      ([call]) => call.method === RPC_METHODS.SPAWN_HAPPY_SESSION,
    )?.[0] as MachineRpcCall | undefined;
    expect(firstSpawnCall?.request).not.toHaveProperty('initialPrompt');
    expect(sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'sess-new',
      message: 'Hello from CLI action',
      localId: expect.stringMatching(/^plugin-input-v1:/),
      inputAdmission: expect.any(Object),
    }));
    expect(updateSessionMetadataWithRetry).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        disposition: 'created',
        sessionId: 'sess-new',
        executionTarget: {
          serverId: configuration.activeServerId,
          machineId: 'machine-1',
        },
        initialInput: {
          status: 'accepted',
          localId: expect.stringMatching(/^plugin-input-v1:/),
        },
      },
    });
  });

  it('preserves V2 provider resume and Windows terminal intent through the canonical private spawn bridge', async () => {
    const executor = createPlainExecutor();
    mockMachineSpawnSuccess('sess-v2-resume-windows');

    const result = await executor.execute(
      'session.spawn_new',
      {
        ...createSessionSpawnInput(),
        configuration: {
          mode: { value: null, updatedAtMs: 1 },
          model: { value: null, updatedAtMs: 1 },
          permissionIntent: { value: null, updatedAtMs: 1 },
          options: {},
          providerSessionResume: {
            kind: 'provider_session.v1',
            providerSessionId: 'provider-session-1',
          },
        },
        terminal: {
          mode: 'windows_terminal',
          windows: {
            launchMode: 'windows_terminal',
            console: 'visible',
            windowName: 'Happier QA',
          },
        },
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    const spawnCall = callMachineRpc.mock.calls.find(
      ([call]) => call.method === RPC_METHODS.SPAWN_HAPPY_SESSION,
    )?.[0] as MachineRpcCall | undefined;
    expect(spawnCall?.request).toMatchObject({
      resume: 'provider-session-1',
      terminal: { mode: 'windows_terminal' },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsRemoteSessionConsole: 'visible',
      windowsTerminalWindowName: 'Happier QA',
    });
    expect(result).toMatchObject({
      ok: true,
      result: { type: 'success', sessionId: 'sess-v2-resume-windows' },
    });
  });

  it('keeps a public RPC accepted-pending spawn retryable without an action request id', async () => {
    const executor = createPlainExecutor();
    const controller = new AbortController();
    const handlers = new Map<string, RpcHandler>();
    const rpcHandlerManager: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };
    registerSessionSpawnNewRpcHandlers({
      rpcHandlerManager,
      actionExecutor: executor,
    });
    const handler = handlers.get(RPC_METHODS.SESSION_SPAWN_NEW);
    expect(handler).toEqual(expect.any(Function));
    if (!handler) return;

    spawnMachineSession.mockResolvedValue({
      success: true,
      status: 'pending',
      sessionIdStatus: 'pending',
    });
    resolveMachineSpawnSessionByNonce
      .mockImplementationOnce(async () => await new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      }))
      .mockResolvedValueOnce({
        status: 'success',
        sessionId: 'sess-late-rpc-spawn',
        sessionCreationOutcome: {
          disposition: 'created',
          organizationPlacement: { folderId: null, tagIds: [] },
        },
      });

    const pending = handler(
      createSessionSpawnInput({
        creationKey: SessionCreationKeyV1Schema.parse('public-rpc-no-action-request-id'),
      }),
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(resolveMachineSpawnSessionByNonce).toHaveBeenCalledTimes(1));
    controller.abort(new Error('public caller retired after accepted submission'));

    await expect(pending).resolves.toEqual({
      type: 'pending',
      retryWithSameCreationKey: true,
      outcome: 'unknown',
    });
    const spawnCall = callMachineRpc.mock.calls.find(
      ([call]) => call.method === RPC_METHODS.SPAWN_HAPPY_SESSION,
    )?.[0] as MachineRpcCall | undefined;
    expect(spawnCall?.request.spawnNonce).toMatch(/^session\.spawn_new\.creation:/u);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(resolveMachineSpawnSessionByNonce).toHaveBeenCalledTimes(1);
    expect(requestSessionStop).not.toHaveBeenCalled();
  });

  it('spawns a new session for an explicit qualified OpenCode Agent target', async () => {
    const executor = createPlainExecutor();
    mockMachineSpawnSuccess('sess-opencode');

    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({
        agentTarget: SESSION_SPAWN_AGENT_TARGETS.opencode,
        initialMessage: 'Hello from CLI action',
      }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        disposition: 'created',
        sessionId: 'sess-opencode',
      },
    });
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      request: expect.objectContaining({
        directory: '/repo/current',
        machineId: 'machine-1',
        backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'opencode' },
      }),
    }));
    expect(sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'sess-opencode',
      message: 'Hello from CLI action',
      localId: expect.stringMatching(/^plugin-input-v1:/),
    }));
  });

  it('forwards the supported V2 creation fields without reviving removed raw spawn fields', async () => {
    const executor = createPlainExecutor();
    const mcpSelection = {
      v: 1,
      managedServersEnabled: true,
      forceIncludeServerIds: ['server-a'],
      forceExcludeServerIds: ['server-b'],
    } satisfies NonNullable<SessionSpawnNewInputV2['mcpSelection']>;
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
    mockMachineSpawnSuccess('sess-rich');

    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({
        directory: '/repo/rich',
        agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex,
        permissionMode: 'safe-yolo',
        agentModeId: 'plan',
        modelSelection: {
          v: 1,
          updatedAt: 1710000000003,
          ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'gpt-5' },
        },
        configuration: {
          mode: { value: 'plan', updatedAtMs: 1710000000002 },
          model: { value: 'gpt-5', updatedAtMs: 1710000000003 },
          permissionIntent: { value: 'safe-yolo', updatedAtMs: 1710000000001 },
          options: {
            reasoning_effort: { value: 'xhigh', updatedAtMs: 1710000000000 },
            ultracode: { value: true, updatedAtMs: 1710000000004 },
          },
        },
        profileId: 'codex-profile',
        connectedServices,
        mcpSelection,
        transcriptStorage: 'persisted',
        terminal: { mode: 'tmux' },
        title: 'Happier Test',
        initialMessage: 'Hello rich session',
      }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: { type: 'success', sessionId: 'sess-rich', disposition: 'created' },
    });
    const richSpawnCall = callMachineRpc.mock.calls.find(
      ([call]) => call.method === RPC_METHODS.SPAWN_HAPPY_SESSION,
    )?.[0] as MachineRpcCall | undefined;
    expect(richSpawnCall?.request).toMatchObject({
      directory: '/repo/rich',
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      permissionMode: 'safe-yolo',
      agentModeId: 'plan',
      modelSelection: {
        v: 1,
        updatedAt: 1710000000003,
        ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'gpt-5' },
      },
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 1710000000004,
        overrides: {
          reasoning_effort: { updatedAt: 1710000000000, value: 'xhigh' },
          ultracode: { updatedAt: 1710000000004, value: true },
        },
      },
      profileId: 'codex-profile',
      connectedServices,
      mcpSelection,
      transcriptStorage: 'persisted',
      terminal: { mode: 'tmux' },
      initialTitle: 'Happier Test',
    });
    expect(richSpawnCall?.request).not.toHaveProperty('environmentVariables');
    expect(richSpawnCall?.request).not.toHaveProperty('runtimeDescriptorV1');
    expect(richSpawnCall?.request).not.toHaveProperty('windowsTerminalWindowName');
    expect(sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'sess-rich',
      message: 'Hello rich session',
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

  it('blocks strict V2 session.spawn_new before exact-machine dispatch when the active server rejects stored auth', async () => {
    const executor = createPlainExecutor();
    validateStoredAuthTokenAgainstActiveServer.mockResolvedValueOnce({
      state: 'invalid',
      httpStatus: 401,
      reasonCode: 'not_authenticated',
    });

    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({
        agentTarget: SESSION_SPAWN_AGENT_TARGETS.opencode,
        initialMessage: 'Hello from CLI action',
      }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: { type: 'error', code: 'permission_denied', retryable: false },
    });
    expect(validateStoredAuthTokenAgainstActiveServer).toHaveBeenCalledWith('token');
    expect(spawnMachineSession).not.toHaveBeenCalled();
    expect(fetchSessionById).not.toHaveBeenCalled();
  });

  it('preserves account connected-service defaults for a strict V2 Session request', async () => {
    const executor = createPlainExecutor();
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
    mockMachineSpawnSuccess('sess-new');

    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({
        agentTarget: SESSION_SPAWN_AGENT_TARGETS.claude,
        modelSelection: {
          v: 1,
          updatedAt: 1710000000000,
          ref: { agentTargetKey: 'backend:claude', providerConnectionId: null, modelId: 'gpt-5' },
        },
        initialMessage: 'Hello from CLI action',
      }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(spawnMachineSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/current',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'claude' },
      modelSelection: {
        v: 1,
        updatedAt: expect.any(Number),
        ref: { agentTargetKey: 'backend:claude', providerConnectionId: null, modelId: 'gpt-5' },
      },
      spawnNonce: expect.any(String),
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
    }));
    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-new',
        disposition: 'created',
      },
    });
  });

  it('fails closed for a strict V2 session.spawn_new when nonce recovery is unsupported', async () => {
    const executor = createPlainExecutor();
    spawnMachineSession.mockResolvedValue({
      error: 'Request failed: /spawn-session, The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
    });
    resolveMachineSpawnSessionByNonce.mockResolvedValue({ status: 'unsupported' });
    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: { type: 'error', code: 'spawn_failed', retryable: true },
    });
    expect(resolveMachineSpawnSessionByNonce).toHaveBeenCalledTimes(1);
    expect(resolveMachineSpawnSessionByNonce).toHaveBeenCalledWith(expect.any(String));
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('resumes an ambiguous V2 action request by stable identity without submitting a second spawn', async () => {
    const executor = createPlainExecutor();
    spawnMachineSession.mockResolvedValue({
      error: 'Request failed: /spawn-session, The socket connection was closed unexpectedly',
    });
    resolveMachineSpawnSessionByNonce
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({
        status: 'success',
        sessionId: 'sess-resumed-attempt',
        sessionCreationOutcome: {
          disposition: 'created',
          organizationPlacement: { folderId: null, tagIds: [] },
        },
      });
    const input = createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex });
    const context = {
      surface: 'cli' as const,
      defaultSessionId: 'sess-1',
      actionRequestId: 'attempt-1',
    };

    await expect(executor.execute('session.spawn_new', input, context)).resolves.toMatchObject({
      ok: true,
      result: { type: 'error', code: 'spawn_failed' },
    });
    await expect(executor.execute('session.spawn_new', input, {
      ...context,
      resumeActionRequest: true,
    })).resolves.toMatchObject({
      ok: true,
      result: { type: 'success', sessionId: 'sess-resumed-attempt' },
    });

    expect(spawnMachineSession).toHaveBeenCalledTimes(1);
    expect(resolveMachineSpawnSessionByNonce).toHaveBeenCalledTimes(2);
  });

  it('recovers a strict V2 session.spawn_new via nonce resolution before fallback row scans', async () => {
    const executor = createPlainExecutor();
    spawnMachineSession.mockResolvedValue({
      error: 'Request failed: /spawn-session, The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
    });
    resolveMachineSpawnSessionByNonce.mockResolvedValue({
      status: 'success',
      sessionId: 'sess-recovered-nonce',
      sessionCreationOutcome: {
        disposition: 'created',
        organizationPlacement: { folderId: null, tagIds: [] },
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-recovered-nonce',
        disposition: 'created',
      },
    });
    expect(resolveMachineSpawnSessionByNonce).toHaveBeenCalledTimes(1);
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('recovers strict V2 session.spawn_new when the machine reports a structured webhook timeout', async () => {
    const executor = createPlainExecutor();
    spawnMachineSession.mockResolvedValue({
      status: 'pending',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      error: 'Timed out waiting for session webhook',
    });
    resolveMachineSpawnSessionByNonce.mockResolvedValue({
      status: 'success',
      sessionId: 'sess-recovered-timeout',
      sessionCreationOutcome: {
        disposition: 'created',
        organizationPlacement: { folderId: null, tagIds: [] },
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-recovered-timeout',
        disposition: 'created',
      },
    });
    expect(resolveMachineSpawnSessionByNonce).toHaveBeenCalledTimes(1);
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('preserves a strict V2 session.spawn_new child-exit failure instead of attempting nonce recovery', async () => {
    const executor = createPlainExecutor();
    spawnMachineSession.mockResolvedValue({
      error: 'Failed to spawn session: Child process exited before session webhook (pid=1234, code=null, signal=SIGKILL)',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
    });
    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: { type: 'error', code: 'spawn_failed', retryable: true },
    });
    expect(JSON.stringify(result)).not.toContain('spawn_recovery_not_found');
    expect(JSON.stringify(result)).not.toContain('Deterministic spawn recovery');
    expect(resolveMachineSpawnSessionByNonce).not.toHaveBeenCalled();
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('does not reclassify strict V2 spawn validation failures as target incompatibility', async () => {
    const executor = createPlainExecutor();
    spawnMachineSession.mockResolvedValue({
      error: 'OhMyPi has no available models. Set provider API keys before starting a session.',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
    });

    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.ohmypi }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: { type: 'error', code: 'spawn_failed', retryable: true },
    });
    expect(JSON.stringify(result)).not.toContain('incompatible_target');
    expect(JSON.stringify(result)).not.toContain('spawn_recovery_');
    expect(resolveMachineSpawnSessionByNonce).not.toHaveBeenCalled();
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it.each([
    'Daemon is not running, file is stale',
    'No daemon running, no state file found',
  ])('classifies direct exact-machine unavailability for %s', async (spawnError) => {
    const executor = createPlainExecutor();
    spawnMachineSession.mockResolvedValue({
      error: spawnError,
      errorCode: 'DAEMON_RPC_UNAVAILABLE',
    });

    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: { type: 'error', code: 'incompatible_target', retryable: false },
    });
    expect(JSON.stringify(result)).not.toContain('spawn_recovery_');
    expect(resolveMachineSpawnSessionByNonce).not.toHaveBeenCalled();
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('projects a thrown exact-machine unavailable error through the V2 action result envelope', async () => {
    const executor = createPlainExecutor();
    spawnMachineSession.mockRejectedValue(Object.assign(
      new Error('Provider-bound session creation is unavailable'),
      { code: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE },
    ));

    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex }),
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'error',
        code: 'incompatible_target',
        retryable: false,
      },
    });
    expect(resolveMachineSpawnSessionByNonce).not.toHaveBeenCalled();
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('rejects a legacy host field at the strict V2 session.spawn_new boundary', async () => {
    const executor = createPlainExecutor();

    const result = await executor.execute(
      'session.spawn_new',
      {
        ...createSessionSpawnInput({ initialMessage: 'Hello' }),
        host: 'other-host',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(spawnMachineSession).not.toHaveBeenCalled();
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
    mockAxiosGet.mockResolvedValueOnce({ status: 200, data: { mode: 'e2ee' } });

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
    mockAxiosGet.mockResolvedValueOnce({ status: 200, data: { mode: 'e2ee' } });

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
      ctx: null,
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
