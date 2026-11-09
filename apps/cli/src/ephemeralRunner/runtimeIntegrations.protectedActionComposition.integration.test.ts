import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeRunnerMachineContentKeyFingerprintV1,
  FeaturesResponseSchema,
  MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
  PENDING_INPUT_PROTOCOL_VERSION_V3,
  projectSessionAccessCapabilitiesV1,
  SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
  sealEncryptedDataKeyEnvelopeV1,
  sealRunnerMachineContentKeyVerifierFactV1,
  signMachineInstallationProof,
  signRunnerMachineContentKeyBindingV1,
  wrapApiTokenEncryptionAccessV1,
} from '@happier-dev/protocol';
import {
  computeExternalActionRequestEnvelopeDigestV1,
  encodeExternalActionResolvedTargetV1,
  EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  ExternalActionRequestEnvelopeV2Schema,
  parseExternalActionDaemonDispatchResult,
  type ExternalActionRequestEnvelopeV2,
} from '@happier-dev/protocol/actions';
import { formatAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/rpc';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { resolveRunnerMcpMaterialV1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';
import { runnerArtifactTargetForPlatform } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import { ProviderModelBindingSourceV1Schema } from '@happier-dev/protocol/providers/binding-compatibility';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerConnectedAccountsAuthorityV1 } from './runnerConnectedAccountsOwner';
import { acquireReviewedRunnerPluginRuntimeLease } from './runnerPluginRuntimeLease';
import { createProductionEphemeralRunnerApplication } from './runtimeIntegrations';
import packageJson from '../../package.json';
import {
  createApiSessionSocketStub,
  createSessionRuntimeActivityHomeStub,
  createSessionTurnMutationAppliedSocketAck,
} from '@/testkit/backends/apiSessionSocketHarness';
import { createCurrentSessionProjectionRecordFixture } from '@/testkit/backends/sessionFixtures';
import {
  materializeSamplePluginFixture,
  SAMPLE_PLUGIN_ID,
  SAMPLE_PLUGIN_PROVIDER_ID,
} from '@/plugins/testkit/samplePackage';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { encrypt } from '@/api/encryption';
import {
  PROVIDER_BROKER_ENDPOINT_PATH_HEADER,
  PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH,
} from '@/providers/broker/providerBrokerPrivateProtocol';
// The published SDK is the creator's client here: the protected round trip is
// only real if the same entry point an API-token consumer uses seals it.
import { connect } from '@happier-dev/sdk';

const boundary = vi.hoisted(() => ({
  io: vi.fn(),
  brokerOpen: vi.fn(),
  tunnelRetire: vi.fn(async () => undefined),
  tunnelClose: vi.fn(async () => undefined),
  startAttemptAcceptor: vi.fn(async () => undefined),
  stopAttemptAcceptor: vi.fn(async () => undefined),
  stopActiveTunnels: vi.fn(async () => undefined),
  irohShutdown: vi.fn(async () => undefined),
}));

vi.mock('socket.io-client', () => ({ io: boundary.io }));

vi.mock('@/daemon/peer/iroh/daemonMachineIrohRuntime', () => ({
  createDaemonMachineIrohRuntime: vi.fn(async () => ({
    available: true as const,
    endpoint: { endpointId: 'a'.repeat(64) },
    startAttemptAcceptor: boundary.startAttemptAcceptor,
    stopAttemptAcceptor: boundary.stopAttemptAcceptor,
    stopActiveTunnels: boundary.stopActiveTunnels,
    shutdown: boundary.irohShutdown,
  })),
}));

vi.mock('@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen', () => ({
  createProviderBrokerMachineCarrierTunnelOpen: vi.fn(() => async () => ({
    localPort: 43123,
    localCapability: 'c'.repeat(64),
    observedPath: 'direct' as const,
    retire: boundary.tunnelRetire,
    close: boundary.tunnelClose,
  })),
}));

vi.mock('@/api/client/providerBrokerApi', () => ({
  openTeamCredentialProviderBroker: boundary.brokerOpen,
}));

const temporaryRoots: string[] = [];

const HOME_SERVER_IDENTITY_ID = 'srv_runner_home';
const ACCOUNT_ID = 'account-1';
const MACHINE_ID = 'machine-1';
const SESSION_ID = 'session-1';
const INSTALLATION_ID = 'installation-1';
const ACTIVATION_ID = '00000000-0000-4000-8000-000000000013';
const CREDENTIAL_ID = '123e4567-e89b-42d3-a456-426614174000';
/** Matched X25519 pair: the Account content key and its published public half. */
const ACCOUNT_CONTENT_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const ACCOUNT_CONTENT_PUBLIC_KEY = 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=';
const RUNNER_MACHINE_CONTENT_KEY = new Uint8Array(32).fill(9);
const RUNNER_SESSION_DATA_ENCRYPTION_KEY = new Uint8Array(32).fill(21);
const FOREIGN_SESSION_SENTINEL = 'foreign-private-session-sentinel';
/** The Home's stored Session metadata as an e2ee Session actually carries it. */
const SESSION_SHARED_METADATA_CIPHERTEXT = encodeBase64(
  encrypt(RUNNER_SESSION_DATA_ENCRYPTION_KEY, 'dataKey', { v: 1 }),
);

const accountMaterial = { type: 'dataKey' as const, machineKey: ACCOUNT_CONTENT_KEY };
const apiTokenWrappingSecret = new Uint8Array(32).fill(7);
const apiTokenBearer = `hap_v1_${CREDENTIAL_ID}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
const apiTokenCredential = formatAccountApiTokenCredentialV1({
  bearer: apiTokenBearer,
  serverIdentityId: HOME_SERVER_IDENTITY_ID,
  accountId: ACCOUNT_ID,
  contentPublicKey: ACCOUNT_CONTENT_PUBLIC_KEY,
  wrappingSecret: encodeBase64(apiTokenWrappingSecret, 'base64url'),
});
const apiTokenEncryptionAccess = {
  v: 1,
  accountId: ACCOUNT_ID,
  tokenId: CREDENTIAL_ID,
  encryptionAccess: wrapApiTokenEncryptionAccessV1({
    context: {
      serverIdentityId: HOME_SERVER_IDENTITY_ID,
      accountId: ACCOUNT_ID,
      tokenId: CREDENTIAL_ID,
      contentPublicKey: ACCOUNT_CONTENT_PUBLIC_KEY,
    },
    wrappingSecret: apiTokenWrappingSecret,
    contentPrivateKey: ACCOUNT_CONTENT_KEY,
    randomBytes: (length) => new Uint8Array(length).fill(3),
  }),
};

/**
 * The exact Machine bootstrap row a creator publishes for this Runner: its
 * content key sealed to the Account, the strict binding signed by the
 * activation identity, and that identity sealed for Account readers.
 */
function buildRunnerBootstrapRow(contentKey: Uint8Array = RUNNER_MACHINE_CONTENT_KEY) {
  const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(13));
  const binding = signRunnerMachineContentKeyBindingV1({
    payload: {
      v: 1,
      purpose: 'happier.ephemeral-runner.machine-content-key',
      homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
      activationId: ACTIVATION_ID,
      creatorAccountId: ACCOUNT_ID,
      machineId: MACHINE_ID,
      installationId: INSTALLATION_ID,
      machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(contentKey),
    },
    activationSigningSecretKey: signing.secretKey,
  });
  return {
    id: MACHINE_ID,
    active: true,
    revokedAt: null,
    replacedByMachineId: null,
    kind: 'ephemeral_session_runner' as const,
    installationId: INSTALLATION_ID,
    dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: contentKey,
      recipientPublicKey: decodeBase64(ACCOUNT_CONTENT_PUBLIC_KEY),
      randomBytes: (length) => new Uint8Array(length).fill(6),
    })),
    runnerContentKeyBinding: {
      ...binding,
      creatorVerifierFactCiphertext: sealRunnerMachineContentKeyVerifierFactV1({
        payload: {
          v: 1,
          activationId: ACTIVATION_ID,
          machineId: MACHINE_ID,
          activationSigningPublicKey: encodeBase64(signing.publicKey, 'base64url'),
        },
        material: accountMaterial,
        randomBytes: (length) => new Uint8Array(length).fill(2),
      }),
    },
  };
}

/**
 * Stands in for the Home's public Action API only: it serves the Machine
 * bootstrap projection the SDK reads and relays a protected request to this
 * exact Machine the way the server dispatcher does — closed server origin,
 * server-held placement and a Home-minted invocation authority. It never holds
 * the Runner's content key, so everything it carries stays sealed.
 */
async function serveHomeActionRelay(input: Readonly<{
  rows: readonly unknown[];
  dispatch: (request: Readonly<{ actionId: string; envelope: ExternalActionRequestEnvelopeV2 }>) => Promise<unknown>;
}>) {
  const captured: Array<{ path: string; body: string }> = [];
  const failures: unknown[] = [];
  const send = (response: ServerResponse, body: string, status = 200) => {
    captured.push({ path: 'response', body });
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const path = request.url ?? '';
    captured.push({ path, body });
    if (path.endsWith('/encryption-access')) {
      send(response, JSON.stringify(apiTokenEncryptionAccess));
      return;
    }
    if (path === '/v1/machines') {
      send(response, JSON.stringify(input.rows));
      return;
    }
    const actionId = decodeURIComponent(path.split('/').at(-1)!);
    const envelope = ExternalActionRequestEnvelopeV2Schema.parse(JSON.parse(body));
    const result = parseExternalActionDaemonDispatchResult(await input.dispatch({ actionId, envelope }));
    if (result?.kind !== 'response') {
      send(response, JSON.stringify({ error: 'dispatch_refused', result }), 502);
      return;
    }
    send(response, result.prepared.body);
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      failures.push(error);
      send(response, '{}', 500);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    captured,
    failures,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  boundary.io.mockReset();
  boundary.brokerOpen.mockReset();
  boundary.tunnelRetire.mockClear();
  boundary.tunnelClose.mockClear();
  boundary.startAttemptAcceptor.mockClear();
  boundary.stopAttemptAcceptor.mockClear();
  boundary.stopActiveTunnels.mockClear();
  boundary.irohShutdown.mockClear();
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

function createEmptyMcpMaterial(agentId: string) {
  const result = resolveRunnerMcpMaterialV1({
    settings: { v: 1, strictMode: true, servers: [], bindings: [] },
    agentId,
    agentAcceptsUserMcp: false,
    capabilitySelection: { mcp: {
      v: 1,
      managedServersEnabled: false,
      forceIncludeServerIds: [],
      forceExcludeServerIds: [],
    } },
    resolveSavedSecret: () => null,
  });
  if (!result.ok) throw new Error(`Runner MCP fixture failed: ${result.reason}`);
  return result.material;
}

function connectableSocket(options: Parameters<typeof createApiSessionSocketStub>[0] = {}) {
  return createApiSessionSocketStub({
    ...options,
    connected: options.connected ?? false,
    emitWithAck: async (event, payload, socket) => {
      if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
        return { v: 1, result: 'success', revision: 1 };
      }
      return options.emitWithAck?.(event, payload, socket)
        ?? { ok: true, id: 'message-1', seq: 1, localId: 'local-1' };
    },
  });
}

async function installProviderAwareSamplePlugin(input: Readonly<{
  happyHomeDir: string;
  pluginRoot: string;
}>): Promise<void> {
  await materializeSamplePluginFixture(input.pluginRoot);
  const manifestPath = join(input.pluginRoot, '.happier-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    hostAccess: { required: Array<Record<string, unknown>>; optional: Array<Record<string, unknown>> };
    contributes: {
      agents: Array<Record<string, unknown>>;
      systemTools?: Array<Record<string, unknown>>;
    };
  };
  const agent = manifest.contributes.agents[0];
  if (!agent) throw new Error('Sample plugin fixture has no Agent contribution');
  agent.providerRequirements = {
    acceptsProtocols: ['openai-responses'],
    required: { streaming: true, toolRoundTrips: true },
    credentialSupport: {
      supportsNoAuth: false,
      apiKeyTransports: [{
        protocol: 'openai-responses',
        destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['raw', 'bearer'] },
      }],
    },
    authIsolation: {
      suppressConnectedServiceIds: [],
      ownedEnvKeys: ['HAPPIER_SAMPLE_PROVIDER_AUTHORITY'],
    },
    materialization: 'spawnEnv',
    applyPolicy: 'restart_session',
    supportsFreeformModelIds: true,
  };
  agent.catalog = {
    ...((agent.catalog && typeof agent.catalog === 'object') ? agent.catalog : {}),
    agentCliSystemTool: { toolId: 'sample-cli' },
  };
  manifest.contributes.systemTools = [{
    id: 'sample-cli',
    title: 'Sample CLI',
    executableNames: ['acme-sample'],
  }];
  manifest.hostAccess.required.push({
    id: 'sample-process',
    capability: 'process',
    reason: 'Run the reviewed Sample Agent with its brokered Provider environment.',
    scope: {
      executables: [{ kind: 'systemTool', id: 'sample-cli' }],
      envKeys: ['HAPPIER_SAMPLE_PROVIDER_AUTHORITY'],
    },
  });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await writeFile(join(input.pluginRoot, 'daemon.mjs'), `
import { sampleAgentRuntimeFactory } from './agentRuntime.mjs';

const providerBinding = {
  v: 1,
  adapterVersion: 1,
  prepare() {
    return { v: 1, materialization: 'spawnEnv' };
  },
  async materialize(input) {
    if (input.binding.endpoint.protocol !== 'openai-responses') {
      throw new Error('sample_provider_protocol_mismatch');
    }
    if (input.credential.kind !== 'apiKey') {
      throw new Error('sample_provider_credential_missing');
    }
    return {
      v: 1,
      kind: 'spawnEnv',
      env: [{
        name: 'HAPPIER_SAMPLE_PROVIDER_AUTHORITY',
        value: input.credential.value,
        source: 'provider',
      }],
    };
  },
};

export function activate(api) {
  api.agents.register('${SAMPLE_PLUGIN_PROVIDER_ID}', sampleAgentRuntimeFactory, {
    sessionRunnerFactory: {
      module: './agentRuntime.mjs',
      export: 'sampleAgentRuntimeFactory',
      runtimeApiVersion: 1,
    },
    providerBinding,
  });
  api.hooks.register('resolve-prerequisites', async () => 'runner-production-composition');
}
`);
  await writeFile(join(input.pluginRoot, 'agentRuntime.mjs'), `
export const sampleAgentRuntimeFactory = () => ({
  sessions: {
    async open(request) {
      globalThis.__HAPPIER_RUNNER_PRODUCTION_TEST_EVENTS__?.push('open');
      const binding = request.providerBinding;
      if (binding?.source?.kind !== 'team_resource'
        || binding.source.resourceId !== 'resource-1'
        || binding.model?.id !== 'gpt-5'
        || binding.upstream?.protocol !== 'openai-responses'
        || binding.materialization?.kind !== 'spawnEnv') {
        throw new Error('sample_provider_binding_handoff_missing');
      }
      let listener = null;
      let sequence = 0;
      return {
        async send(input) {
          globalThis.__HAPPIER_RUNNER_PRODUCTION_TEST_EVENTS__?.push('send');
          listener?.({
            sequence: ++sequence,
            sessionId: request.sessionId,
            emittedAtMs: Date.now(),
            kind: 'input-accepted',
            inputIds: input.inputIds,
            delivery: input.delivery,
          });
          queueMicrotask(() => {
            listener?.({
              sequence: ++sequence,
              sessionId: request.sessionId,
              emittedAtMs: Date.now(),
              kind: 'turn-start',
              turnId: input.delivery.turnId,
              startedBy: 'host',
            });
            listener?.({
              sequence: ++sequence,
              sessionId: request.sessionId,
              emittedAtMs: Date.now(),
              kind: 'turn-complete',
              turnId: input.delivery.turnId,
            });
          });
          return { status: 'admitted' };
        },
        async cancel() { globalThis.__HAPPIER_RUNNER_PRODUCTION_TEST_EVENTS__?.push('cancel'); },
        watch(nextListener) {
          listener = nextListener;
          return { dispose() { if (listener === nextListener) listener = null; } };
        },
        async dispose() {
          globalThis.__HAPPIER_RUNNER_PRODUCTION_TEST_EVENTS__?.push('dispose');
          listener = null;
        },
        sessionId: request.sessionId,
      };
    },
  },
});
`);
  await seedCurrentLocalPathPluginFixture({
    happyHomeDir: input.happyHomeDir,
    pluginRoot: input.pluginRoot,
    pluginId: SAMPLE_PLUGIN_ID,
    manifestVersion: '1.0.0',
  });
}

describe('production Ephemeral Runner composition under an e2ee bootstrap', () => {
  it('executes a protected SDK Action relayed to the Runner inside its own Session and refuses a substituted key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-runner-production-composition-'));
    const agentEvents: string[] = [];
    vi.stubGlobal('__HAPPIER_RUNNER_PRODUCTION_TEST_EVENTS__', agentEvents);
    temporaryRoots.push(root);
    const activationFilePath = join(root, 'happier-runner.activation.json');
    const pluginRoot = join(root, 'sample-plugin');
    await installProviderAwareSamplePlugin({ happyHomeDir: root, pluginRoot });
    const activationSigningKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(13));
    const artifactTarget = runnerArtifactTargetForPlatform({
      os: process.platform === 'win32' ? 'windows' : process.platform,
      arch: process.arch,
    });
    if (!artifactTarget) throw new Error('Test host is not a supported Runner artifact target');
    await writeFile(activationFilePath, JSON.stringify({
      v: 1,
      home: {
        v: 1,
        homeServerIdentityId: 'srv_runner_home',
        canonicalServerUrl: 'https://home.example.test',
        revision: 1,
        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
      },
      activation: {
        id: '00000000-0000-4000-8000-000000000013',
        signingPrivateKeyBase64Url: encodeBase64(activationSigningKey.secretKey, 'base64url'),
        creatorAccountId: 'account-1',
        creatorTokenEpoch: 1,
        activationExpiresAt: null,
        workspace: { kind: 'choose_on_endpoint' as const },
        sessionId: 'session-1',
        machineId: 'machine-1',
        authoringCommitment: encodeBase64(new Uint8Array(32).fill(17), 'base64url'),
        artifact: {
          product: 'happier-runner',
          version: packageJson.version,
          target: artifactTarget,
          sha256: 'a'.repeat(64),
        },
        endpointFactsRecipient: { mode: 'plain', creatorAccountId: 'account-1' },
      },
    }), { mode: 0o600 });

    const application = await createProductionEphemeralRunnerApplication({ activationFilePath });
    const reviewedTarget = {
      kind: 'agent' as const,
      identity: { pluginId: SAMPLE_PLUGIN_ID, localId: SAMPLE_PLUGIN_PROVIDER_ID },
    };
    const pluginRuntime = await acquireReviewedRunnerPluginRuntimeLease({
      happyHomeDir: root,
      target: reviewedTarget,
    });
    const connectedAccountsAuthority = createRunnerConnectedAccountsAuthorityV1({
      sessionId: 'session-1',
      bindings: { v: 2, bindingsByServiceId: {} },
    });
    connectedAccountsAuthority.bind({
      registry: pluginRuntime.lease.registry,
      agentId: pluginRuntime.selected.agentId,
    });

    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    const installationPublicKey = encodeBase64(installation.publicKey, 'base64url');
    const installationPrivateKey = encodeBase64(installation.secretKey, 'base64url');
    const installationProof = signMachineInstallationProof({
      payload: {
        version: 1,
        installationId: 'installation-1',
        machineId: 'machine-1',
        accountId: 'account-1',
      },
      privateKey: installationPrivateKey,
    });

    const machineSocket = connectableSocket();
    // The Home's registered Runtime Activity publisher transport. The
    // capabilities below advertise it, so the Session socket must answer it the
    // way a Home does.
    const homeRuntimeActivity = createSessionRuntimeActivityHomeStub({
      machineId: 'machine-1',
    });
    const sessionSocket = connectableSocket({
      onConnect: (connectedSocket) => {
        queueMicrotask(() => connectedSocket.trigger('update', {
          id: 'session-snapshot-1',
          seq: 1,
          createdAt: Date.now(),
          body: {
            t: 'update-session',
            sid: 'session-1',
            metadata: {
              version: 1,
              value: SESSION_SHARED_METADATA_CIPHERTEXT,
            },
          },
        }));
      },
      emitWithAck: async (event, payload) => {
        const homeAnswer = homeRuntimeActivity.answer(event, payload);
        if (homeAnswer !== null) return homeAnswer;
        if (event === 'session-turn-mutation') {
          return createSessionTurnMutationAppliedSocketAck(payload as never);
        }
        return { ok: true, id: 'message-1', seq: 1, localId: 'local-1' };
      },
    });
    boundary.io.mockImplementation((_serverUrl: string, options: Readonly<{
      auth?: Readonly<{ clientType?: string }>;
    }>) => options.auth?.clientType === 'session-scoped' ? sessionSocket : machineSocket);
    vi.stubGlobal('fetch', vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = typeof request === 'string'
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
      if (url === `http://127.0.0.1:43123${PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH}`) {
        return new Response(null, {
          status: 204,
          headers: { [PROVIDER_BROKER_ENDPOINT_PATH_HEADER]: '/v1' },
        });
      }
      // The managed connection supervisor probes the Home's public projection
      // before it dials the Session socket, so both projections must answer or
      // the composition never reaches its Provider broker.
      if (url.endsWith('/v1/features/authenticated') || url.endsWith('/v1/features')) {
        if (url.endsWith('/v1/features/authenticated')) {
          const headers = new Headers(
            init?.headers ?? (request instanceof Request ? request.headers : undefined),
          );
          expect(headers.get('authorization')).toBe('Bearer runner-token');
        }
        const features = FeaturesResponseSchema.parse({
          features: {
            machines: {
              enabled: true,
              tunnel: {
                enabled: false,
                directPeer: { enabled: false },
                serverRouted: { enabled: false },
              },
            },
            sharing: {
              session: { enabled: true },
              public: { enabled: true },
              contentKeys: { enabled: true },
              pendingQueueV2: { enabled: true },
            },
          },
          capabilities: {
            serverIdentity: { serverIdentityId: 'srv_runner_home' },
            // A current Home: the Runner's target-admission leaf is derived
            // from this snapshot, so the fixture must state the Home contract
            // the composition is asserted against. A Home publishes the
            // Runtime Activity and publisher-authority protocols beside
            // pending input (server `resolveSessionProtocolCapabilitiesFeature`),
            // and the host runtime's startup Activity publication waits for
            // that settlement before it enters its Session loop.
            session: {
              runtimeActivity: {
                protocolVersion: SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
              },
              pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V3 },
              publisherAuthority: { protocolVersion: 1 },
            },
            machines: {
              peerMediation: {
                grantSigningKeys: [{
                  keyId: 'runner-composition-test',
                  publicKey: Buffer.alloc(32, 7).toString('base64url'),
                  expiresAt: null,
                }],
              },
            },
          },
        });
        return new Response(JSON.stringify(features), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }));
    const homeRequests: Array<{ path: string; headers: Readonly<Record<string, string>> }> = [];
    const recordHomeRequest = (path: string, config?: Parameters<typeof axios.get>[1]) => {
      homeRequests.push({
        path,
        headers: Object.fromEntries(
          Object.entries(config?.headers ?? {}).map(([name, value]) => [name, String(value)]),
        ),
      });
    };
    vi.spyOn(axios, 'get').mockImplementation(async (url: string, config?: Parameters<typeof axios.get>[1]) => {
      if (url.endsWith('/v1/auth/ping')) {
        return { status: 200, data: { success: true } } as never;
      }
      if (url.endsWith('/v2/sessions/session-1/permission-mediation-records')) {
        return {
          status: 200,
          data: { records: [], nextCursor: null, hasNext: false },
        } as never;
      }
      // The Home routes a relayed Action's own effects reach. Recording their
      // headers is how the round trip proves which identity carried them.
      if (url.endsWith('/v1/account/encryption/currentness')) {
        recordHomeRequest('/v1/account/encryption/currentness', config);
        return {
          status: 200,
          data: {
            mode: 'e2ee',
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
          },
        } as never;
      }
      if (url.includes('/v2/sessions/session-1')) {
        recordHomeRequest('/v2/sessions/session-1', config);
        return {
          status: 200,
          data: {
            // This Home advertises `sharing.session`, so the Runner reads the
            // current access projection; its direct edit share is projected
            // exactly as the Home's canonical effective-access owner states it.
            session: createCurrentSessionProjectionRecordFixture({
              id: 'session-1',
              active: true,
              encryptionMode: 'e2ee',
              metadataLayoutVersion: 1,
              share: { accessLevel: 'edit', canApprovePermissions: false },
              effectiveAccess: {
                v: 1,
                level: 'edit',
                sources: [{ kind: 'direct', shareId: 'share-runner-session' }],
                capabilities: projectSessionAccessCapabilitiesV1({
                  owner: false,
                  grants: [{ accessLevel: 'edit', canApprovePermissions: false }],
                }),
              },
              metadata: SESSION_SHARED_METADATA_CIPHERTEXT,
              metadataVersion: 1,
              pendingCount: 0,
              pendingVersion: 1,
            }),
          },
        } as never;
      }
      return { status: 404, data: { error: 'Not found' } } as never;
    });
    vi.spyOn(axios, 'patch').mockResolvedValue({
      status: 200,
      data: {
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 2 },
      },
    } as never);
    vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/sessions/session-1/end')) {
        return { status: 200, data: { success: true, applied: true } } as never;
      }
      return { status: 404, data: { error: 'Not found' } } as never;
    });

    const applicationBinding = {
      agentTargetKey: `agent:${SAMPLE_PLUGIN_ID}/${SAMPLE_PLUGIN_PROVIDER_ID}`,
      implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
      endpointTemplateId: 'responses',
      protocol: 'openai-responses' as const,
    };
    boundary.brokerOpen.mockImplementation(async (request: Readonly<Record<string, unknown>>) => ({
      ok: true as const,
      authority: {
        payload: {
          v: 1 as const,
          grantId: 'grant-1',
          aud: 'happier-provider-broker-route-v1' as const,
          issuedAt: 1,
          expiresAt: Date.now() + 60_000,
          teamId: 'team-1',
          resourceId: 'resource-1',
          sourceRevision: 'source-3',
          brokerPlacementFingerprint: 'c'.repeat(64),
          initiatorTokenEpoch: 0,
          initiator: {
            accountId: 'account-1',
            machineId: 'machine-1',
            endpointId: 'a'.repeat(64),
          },
          target: {
            custodianAccountId: 'account-2',
            machineId: 'broker-1',
            endpointId: 'b'.repeat(64),
          },
          consumer: { kind: 'session' as const, sessionId: 'session-1' },
          application: applicationBinding,
        },
        signature: { alg: 'Ed25519' as const, keyId: 'home', valueBase64Url: 'A'.repeat(86) },
      },
      target: {
        custodianAccountId: 'account-2',
        brokerMachineId: 'broker-1',
        endpointId: 'b'.repeat(64),
        endpointRevision: 1,
        endpoint: { endpointId: 'b'.repeat(64) },
      },
      request,
    }));

    const controller = new AbortController();
    let runtime: Awaited<ReturnType<typeof application.dependencies.startSession>> | null = null;
    try {
      runtime = await application.dependencies.startSession({
        binding: {
          homeServerIdentityId: 'srv_runner_home',
          sessionId: 'session-1',
          machineId: 'machine-1',
        },
        manifest: {
          endpointFacts: { directory: root },
          credentialSelectionBinding: {
            v: 1,
            resourceId: 'resource-1',
            brokerMachineId: 'broker-1',
            revision: 3,
            application: applicationBinding,
            sourceRevision: 'source-3',
          },
          reviewedProviderModel: {
            selection: {
              kind: 'team_credential_provider_model',
              resourceId: 'resource-1',
              teamId: 'team-1',
              expectedResourceRevision: 3,
              deliveryMode: 'brokered',
              agentTargetKey: `agent:${SAMPLE_PLUGIN_ID}/${SAMPLE_PLUGIN_PROVIDER_ID}`,
              modelId: 'gpt-5',
            },
            descriptor: { id: 'gpt-5', name: 'GPT-5' },
            sourceFacts: ProviderModelBindingSourceV1Schema.parse({
              endpoint: {
                id: 'responses',
                protocol: 'openai-responses',
                capabilities: {
                  streaming: 'supported', toolRoundTrips: 'supported',
                  statefulResponses: 'unknown', reasoningControls: 'unknown',
                },
              },
              credential: {
                kind: 'apiKey', required: true, slotId: 'apiKey',
                transports: [{
                  id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
                  destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
                }],
              },
            }),
            application: applicationBinding,
            sourceRevision: 'source-3',
            availability: 'available',
          },
          preparedAuthoring: {
            actionsSettings: { v: 1, actions: {} },
            mcpMaterial: createEmptyMcpMaterial(pluginRuntime.selected.agentId),
            authoring: {
              executionTarget: {
                kind: 'temporary_computer',
                serverId: 'runner-home-profile',
                artifactTarget: 'linux-x64',
                workspace: { kind: 'choose_on_endpoint' },
              },
              agentTarget: {
                kind: 'agent',
                identity: { pluginId: SAMPLE_PLUGIN_ID, localId: SAMPLE_PLUGIN_PROVIDER_ID },
              },
              permissionMode: 'safe-yolo',
              modelSelection: {
                v: 1,
                updatedAt: 1,
                ref: {
                  agentTargetKey: `agent:${SAMPLE_PLUGIN_ID}/${SAMPLE_PLUGIN_PROVIDER_ID}`,
                  providerConnectionId: null,
                  modelId: 'gpt-5',
                },
              },
              environmentVariables: {},
              checkoutCreationDraft: null,
              primaryTeamId: null,
            },
          },
        },
        materialized: {
          runtimeOrigin: 'https://home.example.test',
          runtimeToken: 'runner-token',
          installationProof,
          // The e2ee arm of the same production composition: the Machine
          // content key this bootstrap carries is the only material that opens
          // a protected Action sealed for this Runner.
          bootstrap: {
            mode: 'e2ee',
            machineContentKey: RUNNER_MACHINE_CONTENT_KEY,
            sessionDataEncryptionKey: RUNNER_SESSION_DATA_ENCRYPTION_KEY,
          },
          principal: {
            kind: 'ephemeral_session_runner',
            authority: 'session_runtime',
            accountId: 'account-1',
            activationId: '00000000-0000-4000-8000-000000000013',
            sessionId: 'session-1',
            machineId: 'machine-1',
            installationId: 'installation-1',
            installationPublicKey,
            creatorTokenEpoch: 1,
          },
          pluginRuntime,
          connectedAccountsAuthority,
        },
        preparation: {
          managed: {
            launch: {
              source: 'managed',
              resolvedPath: join(root, 'sample-runtime'),
              command: join(root, 'sample-runtime'),
              args: [],
            },
          },
          pluginRuntime,
          homeDirectory: root,
        },
        localState: {
          homeDirectory: root,
          environment: { HAPPIER_HOME_DIR: root, HOME: root, PATH: '' },
          unsetEnvironmentVariables: [],
        },
        installationPrivateKey,
        signal: controller.signal,
        onRuntimeStopReady: () => undefined,
        onRuntimeConnectionState: () => undefined,
      } as never);
      await vi.waitFor(() => expect(machineSocket.emitWithAck).toHaveBeenCalledWith(
        MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
        expect.objectContaining({
          machineId: 'machine-1',
          capabilities: expect.objectContaining({
            finiteTransferRpc: { protocolVersions: [1] },
            sessionInputAdmission: { protocolVersions: [1, 2, PENDING_INPUT_PROTOCOL_VERSION_V3] },
            sessionFollow: { contextV1: true },
            // Published only because the composition installed the real
            // dispatch receiver; the Home dispatcher gates on exactly this.
            externalActionExecutionAuthorization: { protocolVersions: [1] },
          }),
        }),
      ));
      // Drive the round trip against a fully started Runner, and give the
      // ordinary Session Stop owner a live host runtime to terminalize.
      await Promise.race([
        vi.waitFor(() => expect(agentEvents).toContain('open'), { timeout: 20_000 }),
        runtime.terminal.then((terminal) => {
          throw terminal.status === 'failed'
            ? terminal.error
            : new Error('Runner Session completed before its reviewed Agent opened');
        }),
      ]);

      // Exactly what the Home dispatcher forwards: closed server origin, its
      // own placement facts and the Account-minted invocation authority. The
      // relay never sees the Action input or result.
      const dispatch = async ({ actionId, envelope }: Readonly<{
        actionId: string; envelope: ExternalActionRequestEnvelopeV2;
      }>) => await new Promise<unknown>((resolveDispatch) => {
        machineSocket.trigger(SOCKET_RPC_EVENTS.REQUEST, {
          method: `${MACHINE_ID}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
          params: {
            actionId,
            envelope,
            principal: {
              accountId: ACCOUNT_ID,
              principalId: 'principal-1',
              credentialId: CREDENTIAL_ID,
              authority: 'account_automation',
            },
            placement: { machineId: MACHINE_ID, target: { kind: 'machine', machineId: MACHINE_ID } },
            executionAuthorization: {
              v: 1,
              token: 'home-minted-invocation',
              binding: {
                serverIdentityId: HOME_SERVER_IDENTITY_ID,
                accountId: ACCOUNT_ID,
                principalId: 'principal-1',
                credentialId: CREDENTIAL_ID,
                machineId: MACHINE_ID,
                actionId,
                requestId: envelope.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                target: envelope.target ?? { kind: 'machine', machineId: MACHINE_ID },
              },
            },
          },
          authorization: ACTION_API_SERVER_ORIGIN,
        }, resolveDispatch);
      });

      const relay = await serveHomeActionRelay({ rows: [buildRunnerBootstrapRow()], dispatch });
      const substitutedRelay = await serveHomeActionRelay({
        // The Home relays a content key that is not the one the creator signed.
        rows: [{ ...buildRunnerBootstrapRow(new Uint8Array(32).fill(31)),
          dataEncryptionKey: buildRunnerBootstrapRow().dataEncryptionKey }],
        dispatch,
      });
      const sdk = connect({ endpoint: relay.endpoint, token: apiTokenCredential });
      const substitutedSdk = connect({ endpoint: substitutedRelay.endpoint, token: apiTokenCredential });
      const openedOutcome = async (run: Promise<unknown>) =>
        await run.then(() => null, (error: unknown) => error);
      try {
        // An Action steering at any other Session is refused by the Runner's
        // own target owner before it executes, and the refusal comes back
        // sealed: the creator's SDK opens it, the relay never saw it.
        const foreign = await openedOutcome(
          sdk.machine(MACHINE_ID).actions.session.activity.get({ sessionId: FOREIGN_SESSION_SENTINEL }),
        );
        expect(foreign).toMatchObject({ name: 'HappierActionError', code: 'target_not_local' });
        expect(relay.failures).toEqual([]);
        expect(relay.captured.some((entry) => entry.path.startsWith('/v1/actions/'))).toBe(true);
        // The request input never reaches the relay in the clear; only the
        // Runner's own Machine content key opens it.
        expect(JSON.stringify(relay.captured)).not.toContain(FOREIGN_SESSION_SENTINEL);

        // Its own outer Machine target resolves to its own Session, so the same
        // Action against this Runner's Session executes and its own result
        // comes back to the SDK client through the sealed round trip.
        const own = await sdk.machine(MACHINE_ID).actions.session.activity.get({
          sessionId: SESSION_ID,
        });
        expect(own).toMatchObject({ ok: true, sessionId: SESSION_ID, active: true, pendingCount: 0 });
        // The Home-bound effect behind that result was made by this Runner:
        // the session route carries the Home-minted invocation authority and a
        // machine signature, which the executor can only produce from the
        // installation key and installation id of this Machine.
        const sessionEffect = homeRequests.filter((entry) => (
          entry.path === '/v2/sessions/session-1'
          && entry.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] !== undefined
        ));
        expect(sessionEffect).toHaveLength(1);
        expect(sessionEffect[0]!.headers).toMatchObject({
          [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'home-minted-invocation',
          [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.activity.get',
          [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1({
            kind: 'session',
            sessionId: SESSION_ID,
          }),
        });
        expect(sessionEffect[0]!.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]).toBeTypeOf('string');
        // A meta Action executes in the Runner's own process: it hosts its
        // plugin runtime in-process and has no daemon to route to.
        const spec = await sdk.machine(MACHINE_ID).actions.get({ id: 'session.activity.get' });
        expect(spec).toMatchObject({ actionSpec: { id: 'session.activity.get' } });

        // A substituted Runner binding fails closed at the SDK: no Action is
        // dispatched at all, so the Home never carries the request.
        await expect(substitutedSdk.machine(MACHINE_ID).actions.session.activity.get({
          sessionId: SESSION_ID,
        })).rejects.toMatchObject({ name: 'HappierTransportError', code: 'invalid_encrypted_envelope' });
        expect(substitutedRelay.captured.some((entry) => entry.path.startsWith('/v1/actions/'))).toBe(false);
      } finally {
        await sdk.close().catch(() => undefined);
        await substitutedSdk.close().catch(() => undefined);
        await relay.close();
        await substitutedRelay.close();
      }

      // Terminalize through the ordinary Stop owner before this file ends, so
      // no Session transport of this Runner outlives it.
      await Promise.race([
        runtime.stop(),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Runner protected composition stop did not settle')), 10_000);
          timer.unref?.();
        }),
      ]);
      await expect(Promise.race([
        runtime.terminal,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Runner protected composition terminal did not settle')), 10_000);
          timer.unref?.();
        }),
      ])).resolves.toEqual({ status: 'completed' });
    } finally {
      controller.abort();
      await Promise.race([
        runtime?.stop().catch(() => undefined) ?? Promise.resolve(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          timer.unref?.();
        }),
      ]);
      connectedAccountsAuthority.dispose();
      await pluginRuntime.release().catch(() => undefined);
    }
  }, 60_000);
});
