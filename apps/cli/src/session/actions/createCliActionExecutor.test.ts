import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { ArtifactHttpReadV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ArtifactJsonCreateHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactMutationHttpV1';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { buildAgentsById } from '@/plugins/projection/registry/projection/v2';
import { TeamCredentialResourceEntitledPageV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { createCompactSessionListRowFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { SessionPermissionRespondRpcParamsV1Schema } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { buildConnectedServiceCredentialRefreshSpawnErrorResult } from '@/daemon/connectedServices/diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';

const { mockAxiosGet, mockAxiosPost } = vi.hoisted(() => ({
  mockAxiosGet: vi.fn(),
  mockAxiosPost: vi.fn(),
}));

vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { default: {
    // Keep Axios configuration and error classification real beneath the HTTP boundary.
    defaults: actual.default.defaults,
    get: mockAxiosGet,
    post: mockAxiosPost,
    request: (config: import('axios').AxiosRequestConfig) => {
      const method = (config.method ?? 'GET').toUpperCase();
      if (method === 'GET') return mockAxiosGet(config.url, config);
      if (method === 'POST') return mockAxiosPost(config.url, config.data, config);
      throw new Error(`Unexpected fixture HTTP method: ${method}`);
    },
    isAxiosError: actual.default.isAxiosError,
    isCancel: actual.default.isCancel,
  } };
});

const {
  fetchSessionById,
  fetchSessionsPage,
  lookupSessionsByTags,
  updateSessionMetadataWithRetry,
  sendSessionMessage,
  requestSessionStop,
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
  setSessionMode: vi.fn(),
  getExecutionRun: vi.fn(),
  listExecutionRuns: vi.fn(),
  sendExecutionRunMessage: vi.fn(),
  startExecutionRun: vi.fn(),
  stopExecutionRun: vi.fn(),
  executeExecutionRunAction: vi.fn(),
  requestDaemonPluginActionExecution: vi.fn(),
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
} = vi.hoisted(() => ({
  callMachineRpc: vi.fn(),
  spawnMachineSession: vi.fn(),
  resolveMachineSpawnSessionByNonce: vi.fn(),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginActionExecution,
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
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

// Both names cross the Machine transport boundary; keep canonical disposition
// and requester codecs real while exercising the exact-target call used today.
vi.mock('@/session/transport/rpc/machineRpc', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(),
  callMachineRpc,
  callExactMachineRpc: callMachineRpc,
  // Target custody discovery is an HTTP/Machine boundary; null = the caller's own Account custody, so the
  // ordinary exact-target spawn below it stays real.
  dispatchRequesterSessionSpawnNewRpc: async () => null,
}));

import { createCliActionExecutor } from './createCliActionExecutor';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
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
  SessionSpawnNewInputV2Schema,
  createActionExecutor,
  type ActionExecutorDeps,
  type ExecutionRunGetResponse,
  API_TOKEN_FULL_GRANT_V1,
  computeExternalActionRequestEnvelopeDigestV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createPluginStateStore, writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createCustomAcpAdmittedRuntimeFixture } from '@/plugins/testkit/customAcp';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { prepareAcpCatalogTransferV2 } from '@happier-dev/protocol/acp/catalog/transferAcpCatalogV2';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedPurposeCatalogV1Schema, emptyConnectedAccountCatalogRecordV1, type ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { bindExternalActionExecutionAuthorizationVerifyHttpPathV1, ExternalActionExecutionAuthorizationV1Schema, ExternalActionMachineBootstrapV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { configuration } from '@/configuration';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { MachineOperationProtocolCapabilitiesV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { readStoredCredentials, writeCredentialsTokenOnly } from '@/persistence';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileRecordV1Schema, ProfileRowsListResponseV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import type { ComposerAttachmentRuntime, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  readHappierStructuredInputV1FromMeta,
  type PluginSessionInputAttachmentV1,
} from '@happier-dev/protocol';
import { createTargetComposerAttachmentRegistry } from '@/plugins/runtime/lifecycle/contributions/targetComposerAttachments';
import { ActionDiscoveryDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';

const env = process.env;
const PLUGIN_ACTION_ID = 'acme.cli-action-exec.plugin/actions/review-start';
const ACTIVATED_PLUGIN_ACTION_ID = 'acme.cli-activated-action.plugin/actions/review-start';
const storedArtifacts = new Map<string, ReturnType<typeof ArtifactHttpReadV1Schema.parse>>();
let machineCapabilitiesRevision = 1;

function acknowledgeArtifactCreate(body: unknown) {
  const input = ArtifactJsonCreateHttpInputV1Schema.parse(body);
  const artifact = ArtifactHttpReadV1Schema.parse({
    id: input.id, header: input.header, body: input.body, dataEncryptionKey: input.dataEncryptionKey,
    provenance: input.provenance, provenanceDataEncryptionKey: input.provenanceDataEncryptionKey,
    ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee', publicAudience: 'none',
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
  });
  storedArtifacts.set(artifact.id, artifact);
  return { status: 200, data: artifact };
}

function setAccountSettingsBoundary(input: Readonly<{ settings: Readonly<Record<string, unknown>>; purposes?: ConnectedPurposeCatalogV1; profileIds?: readonly string[];
  token?: string; settingsVersion: number; source: string; loadedAtMs: number; settingsSecretsReadKeys: readonly Uint8Array[]; whenRefreshed: null }>) {
  process.env.HAPPIER_ACCOUNT_SETTINGS_MODE = 'auto';
  // A real Settings writer advances the revision; equal-revision publications
  // are deliberately rejected by the live Account owner.
  const settingsVersion = Math.max(input.settingsVersion, (getActiveAccountSettingsSnapshot()?.settingsVersion ?? -1) + 1);
  const transferred = prepareAcpCatalogTransferV2({ rawSettings: input.settings, sourceSettingsVersion: settingsVersion });
  if (transferred.status !== 'ready' && transferred.status !== 'not-required') {
    throw new Error(`Invalid configured ACP fixture: ${transferred.status}`);
  }
  const record = transferred.status === 'ready' ? transferred.record : AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [] });
  const { acpCatalogSettingsV1: _retiredAcpSource, ...rawSettings } = input.settings;
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(rawSettings), rawSettings,
    settingsVersion, loadedAtMs: input.loadedAtMs, settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKeyForToken(input.token ?? 'token') });
  mockAxiosGet.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/encryption') return { status: 200,
      data: AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }) };
    if (path === '/v2/account/settings') return { status: 200,
      data: { version: settingsVersion, content: { t: 'plain', v: rawSettings } } };
    if (path === '/v1/account/profile') return { status: 200, data: { id: input.token
      ? JSON.parse(Buffer.from(input.token.split('.')[1]!, 'base64url').toString()).sub : 'account-1' } };
    if (path === '/v1/machines' || path === '/v1/machines/machine-1') {
      const machine = MachinePublishedRowV1Schema.parse({ ...ExternalActionMachineBootstrapV1Schema.parse({ id: 'machine-1', active: true,
        kind: 'persistent', installationId: 'installation-1', managedMachineRef: null,
        revokedAt: null, replacedByMachineId: null }), activeAt: Date.now(),
        metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({
          host: hostname(), platform: process.platform, happyCliVersion: configuration.currentCliVersion,
          homeDir: homedir(), happyHomeDir: configuration.happyHomeDir,
        })),
        metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({ sessionSpawn: { protocolVersions: [1] } }),
        operationProtocolCapabilitiesRevision: machineCapabilitiesRevision,
      });
      return { status: 200, data: path === '/v1/machines' ? [machine] : { machine } };
    }
    if (path === ACP_CATALOG_ROWS_ROUTE_V1) return { status: 200,
      data: { status: 'present', revision: 1, content: { t: 'plain', v: record } } };
    if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed',
      rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
        content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) } };
    if (path.startsWith(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/`)) {
      const key = path.endsWith('/purposes') ? 'purposes' : 'configurations';
      return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: key === 'purposes' && input.purposes
          ? { key, value: ConnectedPurposeCatalogV1Schema.parse(input.purposes) }
          : emptyConnectedAccountCatalogRecordV1(key) } } };
    }
    if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(url, []) };
    if (/^\/v1\/artifacts\/[^/]+$/.test(path)) {
      const artifact = storedArtifacts.get(decodeURIComponent(path.slice('/v1/artifacts/'.length)));
      return artifact ? { status: 200, data: artifact } : { status: 404, data: { error: 'Artifact not found' } };
    }
    if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200, data: {
      sessions: path.endsWith('/archived') ? [] : ['sess-1', 'sess-2'].map(id => createCompactSessionListRowFixture(
        createSessionRecordFixture(createSpawnedSessionRecord(id)))),
      nextCursor: null, hasNext: false,
    } };
    if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: ProfileRowsListResponseV1Schema.parse({ status: 'listed',
      rows: (input.profileIds ?? []).map(id => ({ id, revision: 1, content: { t: 'plain', v: ProfileRecordV1Schema.parse({
        v: 1, id, enabled: true, promptStack: [], secretBindings: {},
        definition: { kind: 'inline', profile: { v: 2, id, name: id, createdAt: 1, updatedAt: 1 } },
      }) } })), nextCursor: null, complete: true, referenceGuardRevision: 1, transferControl: { status: 'absent' }, diagnostics: [] }) };
    if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 1 } };
    if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
    throw new Error(`Unexpected Account fixture request: ${path}`);
  });
}

async function admitConfiguredAcpFixture(): Promise<void> {
  const runtime = await createCustomAcpAdmittedRuntimeFixture({ controller: pluginReloadController });
  onTestFinished(async () => {
    await runtime.dispose();
    // Retiring the fixture's publication must not leave later cases with an
    // explicitly empty Agent catalog. Restore through the same real owner as
    // the authored-plugin publication test below.
    const restoredRegistry = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir: configuration.happyHomeDir, pluginIds: [],
    });
    const restoration = await pluginReloadController.adoptPreparedRuntimeRegistry({
      registry: restoredRegistry, changedPluginIds: ['happier.agent.custom-acp'],
      runningSessionDisposition: 'retainRunningSessions',
    });
    expect(restoration.ok).toBe(true);
  });
}

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
        activation: { events: [{ kind: 'startup' }] },
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

  await writeFile(join(rootDir, 'daemon.mjs'), 'export async function activate() {}\n', 'utf8');
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

type CliActionExecutorTestOverrides = Pick<
  Parameters<typeof createCliActionExecutor>[0],
  'happyHomeDir' | 'listContributedActionDefinitions' | 'pluginActionExecutionOwner' | 'rawSession'
  | 'serverIdentityId' | 'externalActionMachineRequestPrivateKey' | 'externalActionMachineInstallationId'
>;

function createPlainExecutor(extra: CliActionExecutorTestOverrides = {}) {
  return createCliActionExecutor({
    token: 'token',
    credentials: {
      token: 'token',
      credentialProvenance: 'stored_session',
      encryption: null,
    },
    sessionId: 'sess-1',
    rawSession: { metadata: createTestMetadata({ machineId: 'machine-1', path: '/repo/current' }) },
    ...extra,
    mode: 'plain',
    ctx: null,
  });
}

describe('Account custody transport compatibility', () => {
  it.each([
    { failure: { isAxiosError: true, response: { status: 404 } }, placement: 'machine' as const },
    { failure: { isAxiosError: true, code: 'ECONNREFUSED' }, placement: 'machine' as const },
    { failure: { isAxiosError: true, response: { status: 404 } }, placement: 'account' as const },
    { failure: { isAxiosError: true, response: { status: 404 } }, placement: undefined },
  ])('requires independent current Machine placement when the Account endpoint is unavailable (%j)', async ({ failure, placement }) => {
    // HTTP and daemon control are the real external boundaries; all source
    // selection, manifest parsing and Action admission beneath them stay real.
    mockAxiosPost.mockRejectedValue(failure);
    const definition = ActionDiscoveryDefinitionV1Schema.parse({ id: 'acme.machine-source/actions/read', kindVersion: 1,
      title: 'Read', description: null, safety: 'safe', placements: [], slash: null, bindings: null, examples: null,
      surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: true, rpc: false, api: false, plugin: false },
      inputHints: null, inputSchema: {}, ...(placement ? { executionPlacement: placement } : {}) });
    requestDaemonPluginActionExecution.mockImplementation(async (request) => ({ matched: true,
      result: { ok: true, result: request.actionId === 'action.spec.get' ? { actionSpec: definition } : { machineRead: true } } }));
    const executor = createCliActionExecutor({ token: 'token', credentials: { token: 'token', encryption: null,
      credentialProvenance: 'stored_session' }, sessionId: 'sess-1', mode: 'plain', ctx: null,
      serverId: 'compatibility-home', serverHttpBaseUrl: 'http://compatibility-home.test' });
    const result = await executor.execute('action.invoke', { action: { pluginId: 'acme.machine-source', localId: 'read' }, input: {} }, { surface: 'cli' });
    expect(result).toMatchObject(placement === 'machine' ? { ok: true, result: { machineRead: true } }
      : { ok: false, errorCode: 'plugin_action_execution_placement_unavailable' });
  });
});

function createDataKeyExecutor(extra: CliActionExecutorTestOverrides = {}, token = 'token') {
  const machineKey = new Uint8Array(32).fill(7);
  const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
  return createCliActionExecutor({
    token,
    credentials: {
      token,
      credentialProvenance: 'stored_session',
      encryption: {
        type: 'dataKey',
        publicKey,
        machineKey,
      },
    },
    sessionId: 'sess-1',
    rawSession: { metadata: createTestMetadata({ machineId: 'machine-1', path: '/repo/current' }) },
    ...extra,
    mode: 'plain',
    ctx: null,
  });
}

// Account mode authority is a live HTTP route, re-read at final Artifact create admission,
// so the mode must stay served for every read rather than answering once.
function serveLiveAccountEncryptionMode(mode: 'e2ee' | 'plain'): void {
  const previous = mockAxiosGet.getMockImplementation();
  mockAxiosGet.mockImplementation(async (url: string, ...rest: unknown[]) => (
    new URL(url).pathname === '/v1/account/encryption'
      ? { status: 200, data: { mode, updatedAt: 1 } }
      : previous?.(url, ...rest)
  ));
}

function publishActionsSettings(actionsSettingsV1: unknown, settingsVersion = 1, token?: string): void {
  setAccountSettingsBoundary({ settings: { actionsSettingsV1 }, token, source: 'network', settingsVersion,
    loadedAtMs: Date.now(), settingsSecretsReadKeys: [], whenRefreshed: null });
}

const executionRunGetResponse = {
  run: {
    runId: 'run-1',
    callId: 'call-1',
    sidechainId: 'sidechain-1',
    intent: 'review',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    permissionMode: 'read_only',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
    status: 'running',
    startedAtMs: 1,
  },
} satisfies ExecutionRunGetResponse;

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
  const input = {
    creationKey: SessionCreationKeyV1Schema.parse('create-cli-action-executor-test'),
    executionTarget: {
      serverId: configuration.activeServerId,
      machineId: 'machine-1',
    },
    directory: { kind: 'path' as const, path: '/repo/current' },
    agentTarget: SESSION_SPAWN_AGENT_TARGETS.claude,
    connectedServices: { v: 2, bindingsByServiceId: {} },
    ...overrides,
  };
  // Public Action producers omit optional fields; undefined is not JSON input.
  return SessionSpawnNewInputV2Schema.parse(Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ));
}

function createSpawnedSessionRecord(sessionId: string) {
  const spawnRequest = latestSessionSpawnRequest;
  // Policy reads may inspect the existing caller before a new Session is spawned.
  const directory = typeof spawnRequest?.directory === 'string'
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
          ...(spawnRequest ? { sessionCreationCorrespondenceV1: spawnRequest.sessionCreationCorrespondence } : {}),
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
    resetActiveAccountSettingsSnapshotForTests();
    storedArtifacts.clear();
    latestSessionSpawnRequest = null;
    callMachineRpc.mockReset();
    spawnMachineSession.mockReset();
    resolveMachineSpawnSessionByNonce.mockReset();
    fetchSessionById.mockReset();
    fetchSessionsPage.mockReset();
    lookupSessionsByTags.mockReset();
    // `state: 'unavailable'` is produced only by a server that 404s
    // `/v2/sessions/lookup-by-tags` (`sessionsHttp.ts:396-401`), and the current
    // server registers that route (`registerSessionLookupByTagsRoute.ts:26`).
    // Deterministic V2 creation reads this before spawning
    // (`createSpawnedSession.ts:920-928`), so the default must answer as the
    // real server does; a test that wants the missing-route direction overrides it.
    lookupSessionsByTags.mockResolvedValue({ state: 'available', tags: [], sessions: [] });
    updateSessionMetadataWithRetry.mockReset();
    sendSessionMessage.mockReset();
    requestSessionStop.mockReset();
    setSessionMode.mockReset();
    getExecutionRun.mockReset();
    listExecutionRuns.mockReset();
    sendExecutionRunMessage.mockReset();
    startExecutionRun.mockReset();
    stopExecutionRun.mockReset();
    executeExecutionRunAction.mockReset();
    requestDaemonPluginActionExecution.mockReset();
    requestDaemonPluginActionExecution.mockImplementation(async (request) => {
      if (request.actionId === 'acme.cli-action-exec.plugin/review-start') {
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
              actionId: PLUGIN_ACTION_ID,
              input: request.input,
              surface: request.surface,
            },
          },
        };
      }
      if (request.actionId === 'acme.cli-activated-action.plugin/review-start') {
        return {
          matched: true,
          result: {
            ok: true,
            result: {
              pluginHandled: true,
              actionId: ACTIVATED_PLUGIN_ACTION_ID,
              input: request.input,
              surface: request.surface,
            },
          },
        };
      }
      return { matched: false };
    });
    validateStoredAuthTokenAgainstActiveServer.mockReset();
    validateStoredAuthTokenAgainstActiveServer.mockResolvedValue({ state: 'valid', httpStatus: 200 });
    fetchAccountEncryptionCurrentness.mockReset().mockResolvedValue({
      mode: 'plain',
      version: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 1,
    });
    machineCapabilitiesRevision = 1;
    mockMachineSpawnSuccess('sess-new');
    resolveMachineSpawnSessionByNonce.mockResolvedValue({ status: 'unsupported' });
    callMachineRpc.mockImplementation(async (call: MachineRpcCall) => {
      if (call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
          projection: { v: 2, generation: 1, familiesById: {},
            agentsById: buildAgentsById(readCurrentContributionRegistry(), 1) } });
      }
      if (call.method === RPC_METHODS.CAPABILITIES_DETECT) {
        if (!Array.isArray(call.request.requests)) throw new Error('Expected capability detection requests');
        return { protocolVersion: 1, results: Object.fromEntries(call.request.requests.map((request: unknown) => {
          if (!request || typeof request !== 'object' || !('id' in request) || typeof request.id !== 'string') {
            throw new Error('Expected a capability request id');
          }
          return [request.id, { ok: true, checkedAt: 1, data: {
            installed: true, version: '1.0', latestVersion: null, update: { supported: false, command: null },
            signIn: { status: 'signedIn', loginSupport: 'unsupported' }, platform: { supported: true },
            install: { available: false, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
          } }];
        })) };
      }
      if (
        call.method === RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE
        || call.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT
      ) {
        const directory = call.request.directory;
        return {
          ok: true,
          directory: typeof directory === 'string'
            ? directory
            : directory && typeof directory === 'object' && 'kind' in directory
              && directory.kind === 'path' && 'path' in directory && typeof directory.path === 'string'
              ? directory.path
            : '/repo/current',
          directoryKind: 'path' as const, directoryCreationRequired: false,
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
    mockAxiosPost.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v1/home/governance/get') return { status: 200,
        data: HomeSessionDefaultsProjectionV1Schema.parse({ homeDefaults: null }) };
      throw new Error(`Unexpected Account fixture request: POST ${path}`);
    });
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    setAccountSettingsBoundary({ settings: {}, source: 'network', settingsVersion: 1,
      loadedAtMs: Date.now(), settingsSecretsReadKeys: [], whenRefreshed: null });
  });

  afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('resolves execution backend options on the MCP surface', async () => {
    await admitConfiguredAcpFixture();
    setAccountSettingsBoundary({
      source: 'network',
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
      settings: {
        schemaVersion: 2,
        backendEnabledByTargetKey: {
          'agent:happier.agent.custom-acp/custom-acp:definition:review-bot': true,
          'agent:happier.agent.custom-acp/custom-acp:definition:disabled-bot': false,
        },
        acpCatalogSettingsV1: {
          v: 2,
          backends: [
            {
              id: 'review-bot',
              name: 'review-bot',
              title: 'Review Bot',
              launch: { kind: 'command' as const, command: 'review-bot', args: [] },
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
              launch: { kind: 'command' as const, command: 'disabled-bot', args: [] },
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

    expect(result, JSON.stringify(result)).toMatchObject({
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
          value: 'agent:happier.agent.claude/claude',
          label: expect.any(String),
        }),
        expect.objectContaining({
          value: 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot',
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
          value: 'agent:happier.agent.custom-acp/custom-acp:definition:disabled-bot',
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
      actionId: 'acme.cli-action-exec.plugin/review-start',
      input: { scope: 'diff' },
      surface: 'cli',
      defaultSessionId: 'sess-1',
    }, undefined);
  });

  it('forwards daemon-owned catalog meta Actions exactly once from a standalone executor', async () => {
    requestDaemonPluginActionExecution.mockResolvedValueOnce({
      matched: true,
      result: { ok: true, result: { actionSpecs: [] } },
    });
    const executor = createPlainExecutor();

    await expect(executor.execute(
      'action.spec.search',
      { limit: 10 },
      { surface: 'cli' },
    )).resolves.toEqual({ ok: true, result: { actionSpecs: [] } });

    expect(requestDaemonPluginActionExecution).toHaveBeenCalledOnce();
    expect(requestDaemonPluginActionExecution).toHaveBeenCalledWith({
      actionId: 'action.spec.search',
      input: { limit: 10 },
      surface: 'cli',
    }, undefined);
  });

  it('keeps daemon-owned catalog meta Actions in-process for the daemon executor', async () => {
    const executor = createPlainExecutor({
      pluginActionExecutionOwner: 'current_process',
      listContributedActionDefinitions: () => [],
    });

    const result = await executor.execute(
      'action.spec.search',
      { limit: 10 },
      { surface: 'api', authority: 'present_user' },
    );

    expect(result.ok).toBe(true);
    expect(requestDaemonPluginActionExecution).not.toHaveBeenCalled();
  });

  it('retains a signed Account Voice host confirmation at its exact installed receiver', async () => {
    const target = { kind: 'machine', machineId: 'machine-1' } as const;
    const accountId = 'recipient-account';
    const input = { homeId: 'home-identity', machineId: target.machineId,
      targets: [{ homeId: 'home-identity', machineId: target.machineId,
        sources: [{ kind: 'direct' as const, setup: {} }], desiredRevision: 1, recipePlans: [] }] };
    const requestId = 'voice-review';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
    const privateKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey;
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-account-root', binding: {
      serverIdentityId: 'home-identity', accountId, custodianAccountId: accountId,
      authentication: { kind: 'account', tokenEpoch: 1 }, machineId: target.machineId,
      installationId: 'installation-1', actionId: 'machines.setup.apply', requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input }),
      target, accountEncryptionMode: 'plain',
    } });
    mockAxiosPost.mockResolvedValue({ status: 200, data: { ok: true } });
    callMachineRpc.mockImplementation(async (call: MachineRpcCall) => {
      if (call.method !== RPC_METHODS.MACHINE_SETUP_PLAN) throw new Error(`Unexpected machine RPC: ${call.method}`);
      return { desiredRevision: 1, sources: [{ kind: 'direct', setup: {} }], exclusions: [], support: [] };
    });
    const readAccount = mockAxiosGet.getMockImplementation();
    mockAxiosGet.mockImplementation(async (url: string, config: unknown) => new URL(url).pathname === '/v1/machines/machine-1'
      ? { status: 200, data: { machine: { id: target.machineId, active: true, revokedAt: null,
        replacedByMachineId: null, kind: 'persistent', installationId: 'installation-1' } } }
      : readAccount?.(url, config));
    const executor = createCliActionExecutor({ token, credentials: { token, credentialProvenance: 'stored_session', encryption: null },
      sessionId: 'sess-1', mode: 'plain', ctx: null, pluginActionExecutionOwner: 'current_process',
      serverId: 'profile', serverHttpBaseUrl: 'https://home-policy.test',
      serverIdentityId: 'home-identity', externalActionMachineRequestPrivateKey: privateKey,
      externalActionMachineInstallationId: 'installation-1' });
    const context = {
      surface: 'voice', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'profile', serverIdentityId: 'home-identity', runtimeAccountId: accountId,
      actionRequestId: requestId, defaultSessionMachineId: target.machineId,
      externalActionTarget: target, externalActionExecutionAuthorization: authorization,
      presentUserConfirmation: { actionId: 'machines.setup.apply', requestId, accountId,
        serverId: 'home-identity', target, inputDigest: computeActionInputApprovalDigestV1('machines.setup.apply', input) },
    } as const;
    const prepared = await executor.prepare('machines.setup.apply', input, context);
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ kind: 'ready' });
  });

  it('includes plugin-contributed ACP backends in execution backend options', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-action-plugin-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-cli-action-plugin-root-'));

    await writePluginBackendFixture(pluginRoot);
    await writeCommittedLocalPathPluginFixture({
      happyHomeDir,
      pluginId: 'acme.cli-action.plugin',
      sourceRootPath: pluginRoot,
      plugin: {
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
    });
    setAccountSettingsBoundary({
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
    // Installation alone does not publish an Agent into the serving catalog.
    // Exercise the real daemon registry publication, not a caller-local catalog.
    const registry = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir,
      pluginIds: ['acme.cli-action.plugin'],
    });
    try {
      const publication = await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry,
        changedPluginIds: ['acme.cli-action.plugin'],
        runningSessionDisposition: 'retainRunningSessions',
      });
      expect(publication.ok).toBe(true);
      const executor = createPlainExecutor({ happyHomeDir, pluginActionExecutionOwner: 'current_process' });
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
          options: expect.arrayContaining([
            expect.objectContaining({
              value: 'agent:acme.cli-action.plugin/acme-cli-action-backend',
              label: 'Plugin Review Bot',
            }),
          ]),
        },
      });
      const spawnOptions = await executor.execute('action.options.resolve', {
        actionId: 'session.spawn_new', fieldPath: 'agentTarget',
      }, { surface: 'mcp', defaultSessionId: 'sess-1' });
      expect(spawnOptions).toMatchObject({ ok: true, result: { options: expect.arrayContaining([
        expect.objectContaining({ value: 'agent:acme.cli-action.plugin/acme-cli-action-backend' }),
      ]) } });
    } finally {
      const restoredRegistry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir: configuration.happyHomeDir,
        pluginIds: [],
      });
      const restoration = await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry: restoredRegistry,
        changedPluginIds: ['acme.cli-action.plugin'],
        runningSessionDisposition: 'retainRunningSessions',
      });
      expect(restoration.ok).toBe(true);
    }
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
    await admitConfiguredAcpFixture();
    setAccountSettingsBoundary({
      source: 'cache',
      settingsVersion: 2,
      loadedAtMs: 2,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
      settings: {
        schemaVersion: 2,
        backendEnabledByTargetKey: {
          'agent:happier.agent.custom-acp/custom-acp:definition:review-bot': true,
          'agent:happier.agent.custom-acp/custom-acp:definition:disabled-bot': false,
        },
        acpCatalogSettingsV1: {
          v: 2,
          backends: [
            {
              id: 'review-bot',
              name: 'review-bot',
              title: 'Review Bot',
              description: 'Primary review backend',
              launch: { kind: 'command' as const, command: 'review-bot', args: [] },
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
              launch: { kind: 'command' as const, command: 'disabled-bot', args: [] },
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
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        items: expect.arrayContaining([
          expect.objectContaining({
            targetKey: 'agent:happier.agent.pi/pi',
            agentId: 'pi',
            enabled: true,
          }),
          expect.objectContaining({
            targetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot',
            label: 'Review Bot',
            enabled: true,
          }),
          expect.objectContaining({
            targetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:disabled-bot',
            label: 'Disabled Bot',
            description: 'Disabled review backend',
            enabled: false,
          }),
        ]),
      },
    });
  });

  it('omits account-settings-disabled built-in backends from execution backend options by default', async () => {
    setAccountSettingsBoundary({
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
    await admitConfiguredAcpFixture();
    setAccountSettingsBoundary({
      source: 'network', settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [], whenRefreshed: null,
      settings: {
        schemaVersion: 2,
        acpCatalogSettingsV1: { v: 2, backends: [{
          id: 'review-bot', name: 'review-bot', title: 'Review Bot', launch: { kind: 'command' as const, command: 'review-bot', args: [] },
          createdAt: 1, updatedAt: 1,
        }] },
      },
    });
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

    expect(result).toMatchObject({
      ok: true,
      result: {
        actionId: 'review.start',
        fieldPath: 'engineIds',
        optionsSourceId: 'review.engines.available',
        options: expect.arrayContaining([
          expect.objectContaining({ value: 'claude' }),
          expect.objectContaining({ value: 'codex' }),
          expect.objectContaining({ value: 'opencode' }),
          expect.objectContaining({ value: 'coderabbit' }),
          expect.objectContaining({ value: 'deepsec' }),
          expect.objectContaining({ value: 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot', label: 'Review Bot' }),
        ]),
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
      id: 'sess-2-aaaaaaaaaaaa',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        sessionModesV1: {
          availableModes: [
            { id: 'build', name: 'Build' },
            { id: 'plan', name: 'Plan' },
          ],
        },
      }),
    });

    const result = await executor.execute(
      'action.options.resolve',
      {
        optionsSourceId: 'session.modes.available',
        sessionId: 'sess-2-aaaaaaaaaaaa',
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
    expect(fetchSessionById).toHaveBeenCalledWith({ reason: 'session-action', token: 'token', sessionId: 'sess-2-aaaaaaaaaaaa' });
  });

  it('rejects actions disabled on the CLI surface by action settings', async () => {
    publishActionsSettings({
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

  it('enforces persisted API action policy through external Action admission', async () => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
    const privateKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey;
    const executor = createDataKeyExecutor({ serverIdentityId: 'home-identity',
      externalActionMachineRequestPrivateKey: privateKey, externalActionMachineInstallationId: 'installation-1' }, token);
    const target = { kind: 'machine', machineId: 'machine-1' } as const;
    const envelope = { v: 1, requestId: 'request-api-policy', target, input: { query: 'session' } } as const;
    const principal = {
      accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
      grant: API_TOKEN_FULL_GRANT_V1, authority: 'account_automation',
    } as const;
    // The authenticated Home ingress is the boundary; digest/signing and
    // external admission beneath its verified stamp remain real.
    const executionAuthorization = { v: 1, token: 'test-home-proof', binding: {
      serverIdentityId: 'home-identity', accountId: principal.accountId, principalId: principal.principalId,
      custodianAccountId: principal.accountId, installationId: 'installation-1',
      credentialId: principal.credentialId, machineId: target.machineId, actionId: 'action.spec.search',
      requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      target, grant: principal.grant, accountEncryptionMode: 'e2ee',
    } } as const;
    mockAxiosPost.mockImplementation(async (url: string) => {
      expect(url).toBe(`https://home-policy.test${bindExternalActionExecutionAuthorizationVerifyHttpPathV1('action.spec.search')}`);
      return { status: 200, data: { ok: true } };
    });
    const execute = async () => await executeExternalAction({
      actionId: 'action.spec.search',
      envelope,
      principal,
      executionAuthorization,
      externalActionMachineRequestPrivateKey: privateKey,
      currentMachineId: 'machine-1',
      currentServerId: 'server-a',
      currentInstallationId: 'installation-1',
      verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
        privateKey, installationId: 'installation-1', serverHttpBaseUrl: 'https://home-policy.test' }),
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }),
      executor,
    });

    // One executor models an already-running daemon. The Account snapshot is
    // republished by the live settings subscriber between API requests; each
    // request must use its current revision rather than the startup env value.
    publishActionsSettings({
      v: 1,
      actions: {
        'action.spec.search': { disabledSurfaces: ['api'] },
      },
    }, 1, token);
    await expect(execute()).resolves.toMatchObject({
      kind: 'response',
      response: {
        actionId: 'action.spec.search',
        execution: {
          ok: false,
          errorCode: 'action_disabled',
        },
      },
    });

    publishActionsSettings({
      v: 1,
      actions: {
        'action.spec.search': { approvalRequiredSurfaces: ['api'] },
      },
    }, 2, token);
    mockAxiosPost.mockImplementation(async (url: string, body: unknown) => url.endsWith('/verify')
      ? { status: 200, data: { ok: true } } : acknowledgeArtifactCreate(body));
    serveLiveAccountEncryptionMode('e2ee');
    const approvalResult = await execute();
    expect(approvalResult, JSON.stringify(approvalResult)).toMatchObject({
      kind: 'response',
      response: {
        actionId: 'action.spec.search',
        execution: {
          ok: true,
          result: {
            kind: 'approval_request_created',
            artifactId: expect.any(String),
            actionId: 'action.spec.search',
          },
        },
      },
    });

    publishActionsSettings({ v: 1, actions: {} }, 3, token);
    await expect(execute()).resolves.toMatchObject({
      kind: 'response',
      response: {
        actionId: 'action.spec.search',
        execution: { ok: true },
      },
    });
  });

  it('fails closed for an unstamped MCP permission decision without approval origin', async () => {
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
      errorCode: 'approval_origin_unavailable',
      error: 'approval_origin_unavailable',
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
      metadata: '{}',
    });
    // The native permission owner acknowledges successful responses with void.
    callSessionRpc.mockResolvedValue(undefined);

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
      { surface: 'rpc', authority: 'present_user', defaultSessionId: 'sess-1' },
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
      metadata: '{}',
    });
    // The native permission owner acknowledges successful answers with void.
    callSessionRpc.mockResolvedValue(undefined);

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
      { surface: 'rpc', authority: 'present_user', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({ ok: true, result: { ok: true } });
    // Parse the real Action producer's wire payload with the runtime's strict consumer.
    expect(SessionPermissionRespondRpcParamsV1Schema.parse(callSessionRpc.mock.calls.at(-1)?.[0].request)).toMatchObject({
      approved: true,
      decision: 'approved',
      answers: { 'Where should this run?': ['Washington, D.C.', 'Virginia', 'A custom, exact answer'] },
    });
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
      metadata: '{}',
    });
    callSessionRpc.mockResolvedValue({ ok: true });

    const result = await executor.execute(
      'session.user_action.answer',
      {
        sessionId: 'sess-1',
        requestId: 'ua-reject',
        decision: 'reject',
        reason: 'not acceptable',
      },
      { surface: 'rpc', authority: 'present_user', defaultSessionId: 'sess-1' },
    );
    await executor.execute(
      'session.user_action.answer',
      {
        sessionId: 'sess-1',
        requestId: 'ua-request-changes',
        decision: 'request_changes',
        reason: 'revise first',
      },
      { surface: 'rpc', authority: 'present_user', defaultSessionId: 'sess-1' },
    );

    for (const [request] of callSessionRpc.mock.calls) {
      expect(SessionPermissionRespondRpcParamsV1Schema.safeParse(request.request).success).toBe(true);
    }
    expect(callSessionRpc).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'sess-1:session.user_action.answer',
      request: expect.objectContaining({
        id: 'ua-reject',
        approved: false,
        decision: 'denied',
        reason: 'not acceptable',
      }),
    }));
    expect(callSessionRpc).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'sess-1:session.user_action.answer',
      request: expect.objectContaining({
        id: 'ua-request-changes',
        approved: false,
        decision: 'abort',
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
    getExecutionRun.mockResolvedValue(executionRunGetResponse);

    const result = await executor.execute(
      'execution.run.get',
      { sessionId: 'sess-2-aaaaaaaaaaaa', runId: 'run-1', includeStructured: false },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({ ok: true, result: executionRunGetResponse });
    expect(getExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-2-aaaaaaaaaaaa',
    }));
  });

  it('resolves the stored encryption mode for execution.run.get when targeting a different session id', async () => {
    const executor = createDataKeyExecutor();
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
    getExecutionRun.mockResolvedValue(executionRunGetResponse);

    const result = await executor.execute(
      'execution.run.get',
      { sessionId: 'sess-2-aaaaaaaaaaaa', runId: 'run-1', includeStructured: false },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({ ok: true, result: executionRunGetResponse });
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
          ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'gpt-5' },
        },
        initialInput: { text: 'Hello from CLI action' },
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
          ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'gpt-5' },
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

  it('refuses an unavailable initial-trigger target before Session birth', async () => {
    const executor = createPlainExecutor();
    const result = await executor.execute('session.spawn_new', createSessionSpawnInput({
      initialTriggers: [{ target: { kind: 'workflow', ref: 'builtin:missing-workflow' },
        trigger: { kind: 'sessionLifecycle', enabled: true, events: ['sessionStarted'], policy: { kind: 'firstMatch' } } }],
    }), { surface: 'cli', defaultSessionId: 'sess-1' });
    expect(result).toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable', details: { type: 'error', code: 'target_unavailable', retryable: false } });
    expect(spawnMachineSession).not.toHaveBeenCalled();
  });

  it.each([
    { created: true, abort: false },
    { created: true, abort: true },
    { created: false, abort: false },
  ])('retains the checkout after an initial-trigger birth refusal without current exclusive ownership proof ($created, aborted=$abort)', async ({ created, abort }) => {
    const controller = new AbortController();
    const machineRpc = callMachineRpc.getMockImplementation();
    if (!machineRpc) throw new Error('Expected the Machine transport boundary fixture');
    callMachineRpc.mockImplementation(async (call: MachineRpcCall) => {
      if (call.method === RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE) {
        return {
          ok: true,
          directory: '/repo/.dev/worktree/initial-trigger',
          directoryKind: 'path',
          directoryCreationRequired: false,
          checkout: {
            kind: 'git_worktree',
            finalDirectory: '/repo/.dev/worktree/initial-trigger',
            baseRef: null,
            branchMode: created ? 'new' : 'existing',
            created,
          },
        };
      }
      if (call.method === RPC_METHODS.SCM_WORKTREE_REMOVE) return { success: true };
      return await machineRpc(call);
    });
    spawnMachineSession.mockImplementation(async () => {
      if (abort) controller.abort();
      return {
        error: 'Session initial trigger admission was refused',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorDetail: { kind: 'session_creation_initial_trigger_refused', code: 'feature_disabled' },
      };
    });

    const result = await createPlainExecutor().execute('session.spawn_new', createSessionSpawnInput({
      checkoutCreationDraft: {
        kind: 'git_worktree', displayName: 'initial-trigger', baseRef: null,
        branchMode: created ? 'new' : 'existing',
      },
    }), {
      surface: 'cli', defaultSessionId: 'sess-1', signal: controller.signal,
    });

    expect(result).toEqual(abort
      ? { ok: false, errorCode: 'cancelled', error: expect.any(String), details: { outcome: 'unknown' } }
      : { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable', details: { type: 'error', code: 'target_unavailable', retryable: false } });
    expect(latestSessionSpawnRequest).toMatchObject({ directory: '/repo/.dev/worktree/initial-trigger' });
    const compensations = callMachineRpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.SCM_WORKTREE_REMOVE);
    expect(compensations).toEqual([]);
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(resolveMachineSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it.each([false, true])('retains a created checkout when the spawn transport outcome is unknown (aborted=%s)', async (abort) => {
    const controller = new AbortController();
    callMachineRpc.mockResolvedValueOnce({
      ok: true,
      directory: '/repo/.dev/worktree/uncertain',
      directoryKind: 'path',
      directoryCreationRequired: false,
      checkout: {
        kind: 'git_worktree', finalDirectory: '/repo/.dev/worktree/uncertain',
        baseRef: 'main', branchMode: 'new', created: true, branchName: 'feature/actual',
      },
    });
    spawnMachineSession.mockImplementation(async () => {
      if (abort) controller.abort();
      throw Object.assign(new Error('The spawn response was lost'), { code: 'MACHINE_RPC_TIMEOUT' });
    });

    await expect(createPlainExecutor().execute('session.spawn_new', createSessionSpawnInput({
      checkoutCreationDraft: {
        kind: 'git_worktree', displayName: 'uncertain', baseRef: 'main', branchMode: 'new',
      },
    }), {
      surface: 'cli', defaultSessionId: 'sess-1', signal: controller.signal,
    })).resolves.toEqual(abort
      ? { ok: false, errorCode: 'cancelled',
        error: 'Action wait was cancelled; the Action may still be running and its outcome is unknown.',
        details: { outcome: 'unknown' } }
      : { ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' } });
    expect(latestSessionSpawnRequest).toMatchObject({ directory: '/repo/.dev/worktree/uncertain',
      sessionCreationCorrespondence: { recipe: { checkout: { baseRef: 'main', branchName: 'feature/actual' } } },
    });
    expect(callMachineRpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.SCM_WORKTREE_REMOVE)).toEqual([]);
  });

  it('enforces the live Account Agent spawn policy before daemon Session creation', async () => {
    setAccountSettingsBoundary({
      source: 'network',
      settings: {
        sessionAgentSpawnPolicyV1: {
          v: 1,
          allowModelOverride: false,
        },
      },
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    });
    const executor = createPlainExecutor();

    await expect(executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({
        modelSelection: {
          v: 1,
          updatedAt: 1710000000000,
          ref: {
            agentTargetKey: 'agent:happier.agent.claude/claude',
            providerConnectionId: null,
            modelId: 'gpt-5',
          },
        },
      }),
      {
        surface: 'agent',
        defaultSessionId: 'sess-1',
        callerPermissionMode: 'yolo',
        agentStartContext: {
          caller: { kind: 'session', sessionId: 'c123456789012345678901234', starterDepth: 0, turnDepth: 0 },
          baseline: { machineId: 'machine-1', directory: '/repo' },
          ledSubtreeSessionIds: [], roles: {}, workDepthLimit: 4, callerPermissionCeiling: 'yolo',
        },
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'yolo',
        },
      },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'policy_denied_field',
      error: 'policy_denied_field',
      details: { code: 'policy_denied_field', field: 'modelSelection' },
    });
    expect(callMachineRpc).not.toHaveBeenCalled();
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
      { signal: controller.signal, callerAuthority: 'present_user' },
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
        initialInput: { text: 'Hello from CLI action' },
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
    setAccountSettingsBoundary({ settings: {}, profileIds: ['codex-profile'], settingsVersion: 2,
      loadedAtMs: Date.now(), source: 'network', settingsSecretsReadKeys: [], whenRefreshed: null });
    const executor = createPlainExecutor();
    const mcpSelection = {
      v: 1,
      managedServersEnabled: true,
      forceIncludeServerIds: ['server-a'],
      forceExcludeServerIds: ['server-b'],
    } satisfies NonNullable<NonNullable<SessionSpawnNewInputV2['capabilitySelection']>['mcp']>;
    const connectedServices = {
      v: 2,
      bindingsByServiceId: {
        'happier.agent.codex/openai-codex': {
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
        directory: { kind: 'path', path: '/repo/rich' },
        agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex,
        permissionMode: 'safe-yolo',
        agentModeId: 'plan',
        modelSelection: {
          v: 1,
          updatedAt: 1710000000003,
          ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5' },
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
        capabilitySelection: { mcp: mcpSelection },
        transcriptStorage: 'persisted',
        terminal: { mode: 'tmux' },
        title: 'Happier Test',
        initialInput: { text: 'Hello rich session' },
        environmentVariables: { TOKEN: 'raw-launch-value' },
      }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result, JSON.stringify(result)).toMatchObject({
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
        ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5' },
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
      capabilitySelection: { mcp: mcpSelection },
      transcriptStorage: 'persisted',
      terminal: { mode: 'tmux' },
      initialTitle: 'Happier Test',
    });
    // `session create --env KEY=VALUE` reaches the daemon spawn verbatim.
    expect(richSpawnCall?.request).toMatchObject({
      environmentVariables: { TOKEN: 'raw-launch-value' },
    });
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
        initialInput: { text: 'Hello from CLI action' },
      }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'permission_denied',
      details: { type: 'error', code: 'permission_denied', retryable: false },
    });
    expect(validateStoredAuthTokenAgainstActiveServer).toHaveBeenCalledWith('token');
    expect(spawnMachineSession).not.toHaveBeenCalled();
    expect(fetchSessionById).not.toHaveBeenCalled();
  });

  it('uses the target account connected-service defaults instead of parent bindings for a strict V2 Session request', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'executor-connected-default-' }, async () => {
    await writeCredentialsTokenOnly({ token: 'token' });
    const executor = createPlainExecutor({
      rawSession: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
        metadata: {
          connectedServices: {
            v: 2,
            bindingsByServiceId: {
              'happier.agent.codex/openai-codex': {
                source: 'connected',
                selection: 'profile',
                profileId: 'parent-codex-profile',
              },
            },
          },
        },
      },
    });
    setAccountSettingsBoundary({
      source: 'network',
      settings: {},
      purposes: { v: 1, bindings: [{
        purpose: { consumer: { pluginId: 'happier.agent.claude', localId: 'claude' }, purpose: 'model_upstream' },
        target: { kind: 'group', service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, groupId: 'claude' },
      }] },
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
        connectedServices: undefined,
        modelSelection: {
          v: 1,
          updatedAt: 1710000000000,
          ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'gpt-5' },
        },
        initialInput: { text: 'Hello from CLI action' },
      }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-new',
        disposition: 'created',
      },
    });
    expect(spawnMachineSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/current',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'claude' },
      modelSelection: {
        v: 1,
        updatedAt: expect.any(Number),
        ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'gpt-5' },
      },
      spawnNonce: expect.any(String),
      // The current purpose row belongs to the target Account, not the parent Session.
      connectedServices: expect.objectContaining({
        v: 2,
        bindingsByServiceId: expect.objectContaining({
          'happier.agent.claude/claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude',
          },
          'happier.agent.claude/anthropic': { source: 'native' },
        }),
      }),
    }));
    expect(spawnMachineSession.mock.calls[0]?.[0]?.connectedServices?.bindingsByServiceId)
      .not.toHaveProperty(['happier.agent.codex/openai-codex']);
    });
  });

  it('resolves a fresh Team resource default through the bound Home catalog before Session dispatch', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'executor-team-default-' }, async () => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'recipient-account', tokenEpoch: 4,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
    await writeCredentialsTokenOnly({ token });
    expect((await readStoredCredentials())?.token).toBe(token);
    const entitledCatalog = {
      resources: [{
        id: 'resource-a', teamId: 'team-a', displayName: { content: { t: 'plain', v: 'Shared Codex account' }, recipientEnvelope: null },
        resourceRevision: 7, readiness: { kind: 'available' }, recoveryAction: null,
        mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
        sessionUsePolicy: 'personal_allowed', providerModels: [],
        connectedServiceSelections: [{
          source: 'team_resource', resourceId: 'resource-a', deliveryMode: 'brokered',
        }],
        sourcePresentation: {
          kind: 'connected_service',
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        },
      }],
    };
    const postAccount = mockAxiosPost.getMockImplementation();
    mockAxiosPost.mockImplementation(async (url: string, body: unknown, config: unknown) =>
      new URL(url).pathname === '/v1/teams/credential-resources/entitled/list'
        ? { status: 200, data: TeamCredentialResourceEntitledPageV1Schema.parse(entitledCatalog) }
        : postAccount?.(url, body, config));
    const executor = createCliActionExecutor({
      token,
      credentials: { token, credentialProvenance: 'stored_session', encryption: null },
      sessionId: 'sess-1', mode: 'plain', ctx: null,
      rawSession: { metadata: createTestMetadata({ machineId: 'machine-1', path: '/repo/current' }) },
    });
    setAccountSettingsBoundary({
      source: 'network',
      token,
      settings: {},
      purposes: { v: 1, bindings: [], teamResourceSelections: [{
        purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
        teamId: 'team-a', selection: { source: 'team_resource', resourceId: 'resource-a', deliveryMode: 'brokered' },
      }] },
      settingsVersion: 8, loadedAtMs: 1234, settingsSecretsReadKeys: [], whenRefreshed: null,
    });
    machineCapabilitiesRevision = 2;
    lookupSessionsByTags.mockResolvedValue({ state: 'available', sessions: [] });
    mockMachineSpawnSuccess('sess-team-default');

    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex, connectedServices: undefined }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true, result: { type: 'success', sessionId: 'sess-team-default' },
    });
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('/v1/teams/credential-resources/entitled/list'), expect.objectContaining({ teamId: 'team-a' }), expect.anything(),
    );
    expect(spawnMachineSession).toHaveBeenCalledWith(expect.objectContaining({
      connectedServices: expect.objectContaining({ v: 2, bindingsByServiceId: expect.objectContaining({
        'happier.agent.codex/openai-codex': {
          source: 'team_resource', resourceId: 'resource-a', deliveryMode: 'brokered',
        },
      }) }),
      // The Home admits the defaulted Team target only through the Session's
      // own Team slot binding, created with the Session (lane 10 child 01).
      teamCredentialBindings: [{
        v: 1,
        slot: {
          kind: 'connected_service_purpose',
          purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
        },
        resourceId: 'resource-a',
        expectedResourceRevision: 7,
        deliveryMode: 'brokered',
        teamId: 'team-a',
      }],
    }));
    });
  });

  it('keeps an explicit Team slot choice over the defaulted Team slot binding', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'executor-team-explicit-' }, async () => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'recipient-account', tokenEpoch: 4,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
    await writeCredentialsTokenOnly({ token });
    expect((await readStoredCredentials())?.token).toBe(token);
    const entitledCatalog = {
      resources: [{
        id: 'resource-a', teamId: 'team-a', displayName: 'Shared Codex account',
        resourceRevision: 7, readiness: { kind: 'available' }, recoveryAction: null,
        mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
        sessionUsePolicy: 'personal_allowed', providerModels: [],
        connectedServiceSelections: [{
          source: 'team_resource', resourceId: 'resource-a', deliveryMode: 'brokered',
        }],
        sourcePresentation: {
          kind: 'connected_service',
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        },
      }],
    };
    const postAccount = mockAxiosPost.getMockImplementation();
    mockAxiosPost.mockImplementation(async (url: string, body: unknown, config: unknown) =>
      new URL(url).pathname === '/v1/teams/credential-resources/entitled/list'
        ? { status: 200, data: TeamCredentialResourceEntitledPageV1Schema.parse(entitledCatalog) }
        : postAccount?.(url, body, config));
    const executor = createCliActionExecutor({
      token,
      credentials: { token, credentialProvenance: 'stored_session', encryption: null },
      sessionId: 'sess-1', mode: 'plain', ctx: null,
      rawSession: { metadata: createTestMetadata({ machineId: 'machine-1', path: '/repo/current' }) },
    });
    setAccountSettingsBoundary({
      source: 'network',
      token,
      settings: {},
      purposes: { v: 1, bindings: [], teamResourceSelections: [{
        purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
        teamId: 'team-a', selection: { source: 'team_resource', resourceId: 'resource-a', deliveryMode: 'brokered' },
      }] },
      settingsVersion: 8, loadedAtMs: 1234, settingsSecretsReadKeys: [], whenRefreshed: null,
    });
    machineCapabilitiesRevision = 2;
    lookupSessionsByTags.mockResolvedValue({ state: 'available', sessions: [] });
    mockMachineSpawnSuccess('sess-team-explicit');
    const explicitSlot = {
      v: 1 as const,
      slot: {
        kind: 'connected_service_purpose' as const,
        purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
      },
      resourceId: null,
    };

    await expect(executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({
        agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex,
        connectedServices: undefined,
        teamCredentialBindings: [explicitSlot],
      }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    )).resolves.toMatchObject({ ok: true, result: { type: 'success' } });
    expect(spawnMachineSession).toHaveBeenLastCalledWith(expect.objectContaining({
      teamCredentialBindings: [explicitSlot],
    }));
    });
  });

  it('fails closed for a strict V2 session.spawn_new when nonce recovery is unsupported', async () => {
    const executor = createPlainExecutor();
    spawnMachineSession.mockResolvedValue({
      type: 'success', sessionIdStatus: 'pending',
    });
    resolveMachineSpawnSessionByNonce.mockResolvedValue({ status: 'unsupported' });
    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'spawn_failed',
      details: { type: 'error', code: 'spawn_failed', retryable: true },
    });
    expect(resolveMachineSpawnSessionByNonce).toHaveBeenCalledTimes(1);
    expect(resolveMachineSpawnSessionByNonce).toHaveBeenCalledWith(expect.any(String));
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('resumes an ambiguous V2 action request by stable identity without submitting a second spawn', async () => {
    const executor = createPlainExecutor();
    spawnMachineSession.mockResolvedValue({
      type: 'success', sessionIdStatus: 'pending',
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
      ok: false,
      errorCode: 'spawn_failed',
      details: { type: 'error', code: 'spawn_failed' },
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
      type: 'success', sessionIdStatus: 'pending',
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
      type: 'error',
      errorMessage: 'Failed to spawn session: Child process exited before session webhook (pid=1234, code=null, signal=SIGKILL)',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
    });
    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'spawn_failed',
      details: { type: 'error', code: 'spawn_failed', retryable: true,
        launchError: { code: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
          message: 'Failed to spawn session: Child process exited before session webhook (pid=1234, code=null, signal=SIGKILL)' } },
    });
    expect(JSON.stringify(result)).not.toContain('spawn_recovery_not_found');
    expect(JSON.stringify(result)).not.toContain('Deterministic spawn recovery');
    expect(resolveMachineSpawnSessionByNonce).not.toHaveBeenCalled();
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('does not reclassify strict V2 spawn validation failures as target incompatibility', async () => {
    const executor = createPlainExecutor();
    spawnMachineSession.mockResolvedValue({
      type: 'error',
      errorMessage: 'OhMyPi has no available models. Set provider API keys before starting a session.',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
    });

    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.ohmypi }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'spawn_failed',
      details: { type: 'error', code: 'spawn_failed', retryable: true,
        launchError: { code: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
          message: 'OhMyPi has no available models. Set provider API keys before starting a session.' } },
    });
    expect(JSON.stringify(result)).not.toContain('incompatible_target');
    expect(JSON.stringify(result)).not.toContain('spawn_recovery_');
    expect(resolveMachineSpawnSessionByNonce).not.toHaveBeenCalled();
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('preserves the selected Connected Account reconnect reason through the real Action dependency wiring', async () => {
    const executor = createPlainExecutor();
    const refusal = buildConnectedServiceCredentialRefreshSpawnErrorResult({ agentId: 'codex', error: {
      name: 'ConnectedServiceSpawnCredentialRefreshError', kind: 'reconnect_required',
      serviceId: 'happier.agent.codex/openai-codex', profileId: 'revoked',
    } });
    if (!refusal) throw new Error('Expected rejected grant');
    spawnMachineSession.mockResolvedValue({ error: refusal.errorMessage,
      errorCode: refusal.errorCode, errorDetail: refusal.errorDetail });
    const result = await executor.execute('session.spawn_new',
      createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex }),
      { surface: 'cli', defaultSessionId: 'sess-1' });
    expect(result).toMatchObject({ ok: false, errorCode: 'spawn_failed', details: { type: 'error', code: 'spawn_failed', retryable: false,
      launchError: { code: 'connected_service_credential_reconnect_required', message: expect.stringMatching(/reconnect/i) } } });
  });

  it.each([
    'Daemon is not running, file is stale',
    'No daemon running, no state file found',
  ])('classifies direct exact-machine unavailability for %s', async (spawnError) => {
    const executor = createPlainExecutor();
    spawnMachineSession.mockResolvedValue({
      type: 'error', errorMessage: spawnError,
      errorCode: 'DAEMON_RPC_UNAVAILABLE',
    });

    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'incompatible_target',
      details: { type: 'error', code: 'incompatible_target', retryable: false },
    });
    expect(JSON.stringify(result)).not.toContain('spawn_recovery_');
    expect(resolveMachineSpawnSessionByNonce).not.toHaveBeenCalled();
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('projects a thrown exact-machine unavailable error through the V2 action result envelope', async () => {
    const executor = createPlainExecutor();
    spawnMachineSession.mockRejectedValue(Object.assign(
      new Error('Provider-bound session creation is unavailable'),
      { code: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
        details: { incompatibleTarget: { reason: 'requester_credentials_unavailable' } } },
    ));

    const result = await executor.execute(
      'session.spawn_new',
      createSessionSpawnInput({ agentTarget: SESSION_SPAWN_AGENT_TARGETS.codex }),
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result, JSON.stringify(result)).toMatchObject({
      ok: false,
      errorCode: 'incompatible_target',
      details: {
        type: 'error',
        code: 'incompatible_target',
        retryable: false,
        incompatibleTarget: { reason: 'requester_credentials_unavailable' },
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
        ...createSessionSpawnInput({ initialInput: { text: 'Hello' } }),
        host: 'other-host',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      details: { issues: [expect.objectContaining({ code: 'unrecognized_keys', path: [] })] },
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
      result: { status: 'accepted', localId: 'local-1' },
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

  it('rejoins an attachment-only plugin send after response loss without preparing twice', async () => {
    const attachment = { pluginId: 'happier.triage', localId: 'entry' } as const;
    const authored: readonly PluginSessionInputAttachmentV1[] = [
      {
        attachmentLocalId: attachment.localId,
        value: {
          key: 'forge/items:pull-request:origin:42',
          value: { v: 1, entryId: '42' },
          presentation: { label: 'Replace the duplicated normalizer', description: 'example/repository' },
        },
      },
      {
        attachmentLocalId: attachment.localId,
        value: {
          key: 'forge/items:issue:origin:43',
          value: { v: 1, entryId: '43' },
          presentation: { label: 'Preserve the attachment order', description: 'example/repository' },
        },
      },
    ];
    const prepareForSend = vi.fn<NonNullable<ComposerAttachmentRuntime['prepareForSend']>>(async (request) => ({
      attachments: request.attachments.map((item) => ({
        instanceId: item.instanceId,
        status: 'ready' as const,
        value: { ...(item.value as Record<string, unknown>), qualified: true },
      })),
    }));
    const resolveForDispatch = vi.fn<NonNullable<ComposerAttachmentRuntime['resolveForDispatch']>>(async (request) => ({
      attachments: request.attachments.map((item) => ({ instanceId: item.instanceId, status: 'ready' as const })),
    }));
    const afterMessageAccepted = vi.fn<NonNullable<ComposerAttachmentRuntime['afterMessageAccepted']>>(async () => {});
    const registry = createTargetComposerAttachmentRegistry({
      activateAttachmentOnDemand: async () => {},
      declaredAttachments: [{
        attachment,
        title: { key: 'triage.attachment.entry.title', fallback: 'Triage entry' },
        cardinality: 'many',
        valueSchema: {
          type: 'object',
          properties: { v: { const: 1 }, entryId: { type: 'string' } },
          required: ['v', 'entryId'],
          additionalProperties: false,
        },
        preparedValueSchema: {
          type: 'object',
          properties: { v: { const: 1 }, entryId: { type: 'string' }, qualified: { const: true } },
          required: ['v', 'entryId', 'qualified'],
          additionalProperties: false,
        },
        runtime: { prepareForSend: true, resolveForDispatch: true, afterMessageAccepted: true },
      }],
      targetRegistrations: [{
        pluginId: attachment.pluginId,
        occurrenceId: '1',
        registration: {
          family: 'composerAttachments',
          localId: attachment.localId,
          value: { prepareForSend, resolveForDispatch, afterMessageAccepted },
        },
      }],
      resolveOccurrenceLifecycle: () => ({
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
      }),
      createInvocationContext: (input) => {
        const base = {
          plugin: { id: attachment.pluginId, version: '1.0.0' },
          contribution: {
            id: attachment.localId,
            qualifiedId: `${attachment.pluginId}/composerAttachments/${attachment.localId}`,
          },
          surface: 'cli',
          signal: input.signal,
          services: { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), diagnostic: vi.fn() } },
        } as unknown as PluginInvocationContext;
        const { session: _session, ...scopeNeutralBase } = base;
        const scope = input.scope;
        return {
          context: scope.kind === 'session'
            ? { ...base, scope, session: { id: scope.sessionId } }
            : { ...scopeNeutralBase, scope },
          complete: vi.fn(),
        };
      },
    });
    lookupSessionsByTags.mockResolvedValue({
      state: 'available',
      sessions: [{
        id: 'sess-1',
        createdAt: 1,
        updatedAt: 2,
        active: true,
        activeAt: 2,
        pendingCount: 0,
        metadataVersion: 1,
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
      }],
    });
    const cliDeps = createCliActionExecutorHarness({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      resolveComposerAttachmentSendPreparation: () => registry,
    }).deps;
    const executor = createActionExecutor({
      sessionSendMessage: cliDeps.sessionSendMessage,
    } as ActionExecutorDeps);
    const caller = {
      surface: 'plugin' as const,
      defaultSessionId: 'sess-1',
      actionCaller: {
        kind: 'plugin' as const,
        pluginId: attachment.pluginId,
        contributionLocalId: 'entry-action',
      },
    };
    const input = {
      sessionId: 'sess-1',
      message: '',
      idempotencyKey: 'delivery-key-1',
      attachments: authored,
    };
    let persistedContent: Readonly<{
      t: 'plain';
      v: Readonly<{
        role: 'user';
        content: Readonly<{ type: 'text'; text: string }>;
        meta: Record<string, unknown>;
      }>;
    }> | null = null;
    let persistedLocalId: string | null = null;
    mockAxiosGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/pending')) {
        return {
          data: {
            pending: persistedContent && persistedLocalId
              ? [{ localId: persistedLocalId, content: persistedContent }]
              : [],
          },
        };
      }
      if (url.includes('/messages/by-local-id/')) {
        throw {
          isAxiosError: true,
          response: { status: 404, data: { error: 'Message not found' } },
        };
      }
      throw new Error(`Unexpected GET in attachment rejoin test: ${url}`);
    });
    sendSessionMessage
      .mockImplementationOnce(async (request) => {
        persistedLocalId = String(request.localId);
        persistedContent = {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: request.message },
            meta: request.messageMeta ?? {},
          },
        };
        return {
          ok: false,
          code: 'timeout' as const,
          admissionResult: {
            status: 'outcomeUnknown' as const,
            localId: persistedLocalId,
            code: 'pending_admission_outcome_unknown',
          },
        };
      })
      .mockImplementationOnce(async (request) => ({
        ok: true,
        sessionId: 'sess-1',
        localId: String(request.localId),
        waited: false,
        admissionResult: { status: 'alreadyAccepted' as const, localId: String(request.localId) },
      }));

    const firstResult = await executor.execute('session.message.send', input, caller);
    expect(firstResult).toMatchObject({
      ok: true,
      result: { status: 'outcomeUnknown', localId: expect.stringMatching(/^plugin-input-v1:/) },
    });
    expect(sendSessionMessage).toHaveBeenCalledTimes(1);
    expect(await executor.execute('session.message.send', input, caller)).toMatchObject({
      ok: true,
      result: { status: 'alreadyAccepted', localId: persistedLocalId },
    });
    await vi.waitFor(() => expect(afterMessageAccepted).toHaveBeenCalledTimes(1));
    expect(afterMessageAccepted).toHaveBeenNthCalledWith(1, {
      sessionId: 'sess-1',
      localId: persistedLocalId,
      attachments: [
        {
          instanceId: expect.any(String),
          key: 'forge/items:pull-request:origin:42',
          value: { v: 1, entryId: '42', qualified: true },
        },
        {
          instanceId: expect.any(String),
          key: 'forge/items:issue:origin:43',
          value: { v: 1, entryId: '43', qualified: true },
        },
      ],
    }, expect.any(Object));

    const firstWrite = sendSessionMessage.mock.calls.at(-2)?.[0];
    const retryWrite = sendSessionMessage.mock.calls.at(-1)?.[0];
    expect(retryWrite?.localId).toBe(firstWrite?.localId);
    expect(retryWrite?.message).toBe(firstWrite?.message);
    expect(retryWrite?.messageMeta).toEqual(firstWrite?.messageMeta);
    const persisted = readHappierStructuredInputV1FromMeta(firstWrite?.messageMeta);
    expect(persisted?.composerAttachments).toHaveLength(2);
    await expect(registry.resolveForDispatch({
      attachment,
      request: {
        sessionId: 'sess-1',
        localId: String(firstWrite?.localId),
        attachments: (persisted?.composerAttachments ?? []).map((item) => ({
          instanceId: item.instanceId,
          key: item.key,
          value: item.value,
        })),
      },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ attachments: [{ status: 'ready' }, { status: 'ready' }] });
    const transcriptModulePath = '../../../../ui/'
      + 'sources/components/sessions/transcript/composerAttachments/messageComposerAttachments';
    const transcriptProjection = await import(transcriptModulePath) as Readonly<{
      resolveMessageComposerAttachments(meta: unknown): readonly Readonly<{
        typeLabel: string;
        label: string;
        description: string | null;
      }>[];
    }>;
    expect(transcriptProjection.resolveMessageComposerAttachments(firstWrite?.messageMeta)).toEqual([
      expect.objectContaining({
        typeLabel: 'Triage entry',
        label: 'Replace the duplicated normalizer',
        description: 'example/repository',
      }),
      expect.objectContaining({
        typeLabel: 'Triage entry',
        label: 'Preserve the attachment order',
        description: 'example/repository',
      }),
    ]);
    expect(prepareForSend).toHaveBeenCalledTimes(1);
    expect(resolveForDispatch).toHaveBeenCalledTimes(1);

    const mismatchedRetry = await executor.execute('session.message.send', {
      ...input,
      attachments: authored.map((attachment, index) => index === 0
        ? {
            ...attachment,
            value: { ...attachment.value, key: 'forge/items:pull-request:origin:99' },
          }
        : attachment),
    }, caller);
    expect(mismatchedRetry).toEqual({
      ok: true,
      result: { status: 'rejected', code: 'session_input_idempotency_conflict' },
    });
    expect(prepareForSend).toHaveBeenCalledTimes(1);
    expect(sendSessionMessage).toHaveBeenCalledTimes(2);

    const rejected = await executor.execute('session.message.send', {
      ...input,
      idempotencyKey: 'delivery-key-invalid',
      attachments: [{ ...authored[0]!, attachmentLocalId: 'not-declared' }],
    }, caller);
    expect(rejected).toEqual({
      ok: true,
      result: { status: 'rejected', code: 'session_input_invalid' },
    });
    expect(sendSessionMessage).toHaveBeenCalledTimes(2);
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
    publishActionsSettings({
      v: 1,
      actions: {
        'session.message.send': { enabled: true, disabledSurfaces: [], disabledPlacements: [], approvalRequiredSurfaces: ['cli'] },
      },
    });

    mockAxiosPost.mockImplementationOnce(async (_url: string, body: unknown) => acknowledgeArtifactCreate(body));
    serveLiveAccountEncryptionMode('e2ee');

    const executor = createDataKeyExecutor();
    sendSessionMessage.mockResolvedValueOnce({ ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false });

    const result = await executor.execute(
      'session.message.send',
      { sessionId: 'sess-1', message: 'hello' },
      { surface: 'cli', serverId: 'server-a', actionRequestId: 'request-cli-approval', defaultSessionId: 'sess-1' },
    );

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
      kind: 'approval_request_created',
      artifactId: expect.any(String),
      actionId: 'session.message.send',
    } });
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('routes approval-required actions through approvalsCreate when CLI surface is implicit', async () => {
    publishActionsSettings({
      v: 1,
      actions: {
        'session.message.send': { enabled: true, disabledSurfaces: [], disabledPlacements: [], approvalRequiredSurfaces: ['cli'] },
      },
    });

    mockAxiosPost.mockImplementationOnce(async (_url: string, body: unknown) => acknowledgeArtifactCreate(body));
    serveLiveAccountEncryptionMode('e2ee');

    const executor = createDataKeyExecutor();
    sendSessionMessage.mockResolvedValueOnce({ ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false });

    const result = await executor.execute(
      'session.message.send',
      { sessionId: 'sess-1', message: 'hello' },
      { serverId: 'server-a', actionRequestId: 'request-cli-approval', defaultSessionId: 'sess-1' },
    );

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
      kind: 'approval_request_created',
      artifactId: expect.any(String),
      actionId: 'session.message.send',
    } });
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
      rawSession: { metadata: createTestMetadata({ machineId: 'machine-1', path: '/repo/current' }) },
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
