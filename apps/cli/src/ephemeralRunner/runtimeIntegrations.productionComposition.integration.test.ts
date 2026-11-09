import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FeaturesResponseSchema,
  MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
  PENDING_INPUT_PROTOCOL_VERSION_V3,
  projectSessionAccessCapabilitiesV1,
  SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
  signMachineInstallationProof,
} from '@happier-dev/protocol';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { resolveRunnerMcpMaterialV1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';
import { runnerArtifactTargetForPlatform } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import { ProviderModelBindingSourceV1Schema } from '@happier-dev/protocol/providers/binding-compatibility';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createReadyNotificationDispatcher } from '@/agent/runtime/notifications/createReadyNotificationDispatcher';
import { decodeBase64, decrypt, encrypt } from '@/api/encryption';
import { openSessionStoredContent } from '@/session/transport/encryption/sessionStoredContentCodec';
import {
  PROVIDER_BROKER_ENDPOINT_PATH_HEADER,
  PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH,
} from '@/providers/broker/providerBrokerPrivateProtocol';
import type { StrictSessionStoredMessageContentEnvelope } from '@happier-dev/protocol';

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

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
  agent.capabilities = {
    ...((agent.capabilities && typeof agent.capabilities === 'object') ? agent.capabilities : {}),
    tools: { delivery: 'native_mcp' },
  };
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
      globalThis.__HAPPIER_RUNNER_PRODUCTION_TEST_MCP__?.push(request.mcpServers);
      globalThis.__HAPPIER_RUNNER_PRODUCTION_TEST_CWDS__?.push(request.cwd);
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

describe('production Ephemeral Runner composition', () => {
  it.each(['plain', 'e2ee'] as const)('reaches restricted tools and ordinary Session writes from the %s production factory', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-runner-production-composition-'));
    const agentEvents: string[] = [];
    vi.stubGlobal('__HAPPIER_RUNNER_PRODUCTION_TEST_EVENTS__', agentEvents);
    const agentWorkingDirectories: string[] = [];
    vi.stubGlobal('__HAPPIER_RUNNER_PRODUCTION_TEST_CWDS__', agentWorkingDirectories);
    const agentMcpServers: Array<Readonly<Record<string, { args?: readonly string[] }>> | undefined> = [];
    vi.stubGlobal('__HAPPIER_RUNNER_PRODUCTION_TEST_MCP__', agentMcpServers);
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const sessionKey = new Uint8Array(32).fill(21);
    const machineContentKey = new Uint8Array(32).fill(9);
    const sessionCrypto = mode === 'plain'
      ? { mode: 'plain' as const, ctx: null }
      : { mode: 'e2ee' as const, ctx: { encryptionKey: sessionKey, encryptionVariant: 'dataKey' as const } };
    const sharedMetadata = mode === 'plain'
      ? JSON.stringify({ v: 1 })
      : encodeBase64(encrypt(sessionKey, 'dataKey', { v: 1 }));
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
              value: sharedMetadata,
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
            sessions: { enabled: true, board: { enabled: true }, conversations: { enabled: true } },
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
    const boardWrites: Array<{ layoutContent: StrictSessionStoredMessageContentEnvelope }> = [];
    const getBoundary = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/auth/ping')) {
        return { status: 200, data: { success: true } } as never;
      }
      if (url.endsWith('/v2/sessions/session-1/permission-mediation-records')) {
        return {
          status: 200,
          data: { records: [], nextCursor: null, hasNext: false },
        } as never;
      }
      if (url.endsWith('/v2/sessions/session-1/system-records/record')) {
        return { status: 200, data: { record: null } } as never;
      }
      if (url.includes('/v2/sessions/session-1')) {
        return {
          status: 200,
          data: {
            session: createCurrentSessionProjectionRecordFixture({
              id: 'session-1',
              active: true,
              encryptionMode: mode,
              metadataLayoutVersion: 1,
              share: { accessLevel: 'edit', canApprovePermissions: false },
              metadata: sharedMetadata,
              metadataVersion: 1,
              pendingCount: 0,
              pendingVersion: 1,
              effectiveAccess: {
                v: 1, level: 'edit', sources: [{ kind: 'direct', shareId: 'share-1' }],
                capabilities: projectSessionAccessCapabilitiesV1({
                  owner: false, grants: [{ accessLevel: 'edit', canApprovePermissions: false }],
                }),
              },
            }),
          },
        } as never;
      }
      return { status: 404, data: { error: 'Not found' } } as never;
    });
    vi.spyOn(axios, 'request').mockImplementation(async (config) => {
      if (config.method?.toUpperCase() === 'PUT' && config.url?.endsWith('/v2/sessions/session-1/board')) {
        boardWrites.push(JSON.parse(String(config.data)) as { layoutContent: StrictSessionStoredMessageContentEnvelope });
        return { status: 200, data: {
          operation: 'update_layout', outcome: 'updated', layoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
        } } as never;
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
    const providerInputSessions = new Set<ApiSessionClient>();
    let didAttachProviderInputConsumer = false;
    const onUserMessage = ApiSessionClient.prototype.onUserMessage;
    vi.spyOn(ApiSessionClient.prototype, 'onUserMessage').mockImplementation(function (
      this: ApiSessionClient,
      callback,
    ) {
      didAttachProviderInputConsumer = true;
      providerInputSessions.add(this);
      return onUserMessage.call(this, callback);
    });
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
          bootstrap: mode === 'plain' ? { mode: 'plain' } : {
            mode: 'e2ee', machineContentKey, sessionDataEncryptionKey: sessionKey,
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

      const followParams = {
        v: 1,
        sourceSessionId: 'source-session-1',
        destinationSessionId: 'session-1',
        sourceDataEncryptionKeyBase64: encodeBase64(new Uint8Array(32).fill(23), 'base64'),
      };
      const followResponse = new Promise<unknown>((resolve) => {
        machineSocket.trigger(SOCKET_RPC_EVENTS.REQUEST, {
          method: `machine-1:${RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE}`,
          params: mode === 'plain' ? followParams : encodeBase64(encrypt(machineContentKey, 'dataKey', followParams)),
          authorization: {
            kind: 'session.follow.sourceKey.prepare',
            sourceSessionId: 'source-session-1',
            destinationSessionId: 'session-1',
          },
        }, (response: unknown) => resolve(mode === 'plain' ? response
          : decrypt(machineContentKey, 'dataKey', decodeBase64(String(response)))));
      });
      await expect(followResponse).resolves.toEqual({ v: 1, outcome: 'installed' });


      await Promise.race([
        vi.waitFor(() => {
          expect(boundary.brokerOpen).toHaveBeenCalledWith(
            expect.objectContaining({
              request: expect.objectContaining({
                resourceId: 'resource-1',
                expectedResourceRevision: 3,
                modelId: 'gpt-5',
                sourceRevision: 'source-3',
                initiatorMachineId: 'machine-1',
                consumer: { kind: 'session', sessionId: 'session-1' },
                application: applicationBinding,
              }),
              signal: expect.any(AbortSignal),
            }),
          );
        }, { timeout: 20_000 }),
        runtime.terminal.then((terminal) => {
          if (terminal.status === 'failed') throw terminal.error;
          throw new Error('Runner Session completed before opening its reviewed Provider binding');
        }),
      ]).catch((error) => {
        throw new Error(JSON.stringify({
          cause: error instanceof Error ? error.message : String(error),
          causeStack: error instanceof Error ? error.stack : null,
          socketConnected: sessionSocket.connected,
          socketEmits: sessionSocket.emitWithAck.mock.calls.map(([event]) => event),
          machineEmits: machineSocket.emitWithAck.mock.calls.map(([event]) => event),
          ioClientTypes: boundary.io.mock.calls.map(([, options]) => (
            options as { auth?: { clientType?: unknown } } | undefined
          )?.auth?.clientType ?? null),
        }, null, 2));
      });

      await vi.waitFor(() => {
        expect(didAttachProviderInputConsumer).toBe(true);
        expect(agentEvents).toContain('open');
      }, { timeout: 20_000 });
      // The endpoint review chose an ordinary path, not a private managed
      // allocation. Observe the real native Agent request after preparation.
      expect([...new Set(agentWorkingDirectories)]).toEqual([root]);
      const activitySession = [...providerInputSessions].at(-1);
      if (!activitySession) throw new Error('Production host did not publish its active Session client');
      // Both tool transports are created by the ordinary host, not a test that
      // manually supplies Session scope to the inner MCP helper.
      const accountAction = { toolName: 'action_execute', args: { actionId: 'machines.list', input: {} } };
      await expect(activitySession.rpcHandlerManager.invokeLocal(
        SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1,
        accountAction,
      )).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
      const boardAction = {
        toolName: 'action_execute',
        args: { actionId: 'session.board.layout.update', input: {
          expectedLayoutRevision: null, operation: { op: 'tab.create', tabId: 'overview', title: 'Runner notes' },
        } },
      };
      await expect(activitySession.rpcHandlerManager.invokeLocal(
        SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1, boardAction,
      )).resolves.toMatchObject({ ok: true });
      expect(boardWrites).toHaveLength(1);
      expect(boardWrites[0]?.layoutContent.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
      expect(openSessionStoredContent({ ...sessionCrypto, content: boardWrites[0]!.layoutContent })).toMatchObject({
        v: 1, tabs: [{ id: 'overview', title: 'Runner notes' }],
      });
      expect(getBoundary.mock.calls.some(([url]) => String(url).endsWith('/v1/machines'))).toBe(false);
      const happierArgs = agentMcpServers.at(-1)?.happier?.args ?? [];
      const mcpUrl = happierArgs[happierArgs.indexOf('--url') + 1];
      expect(mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
      const mcpClient = new Client({ name: 'runner-production-scope', version: '1' }, { capabilities: {} });
      try {
        await mcpClient.connect(new StreamableHTTPClientTransport(new URL(mcpUrl!)));
        const result = await mcpClient.callTool({ name: accountAction.toolName, arguments: accountAction.args });
        expect(result.content).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: expect.stringContaining('action_disabled') }),
        ]));
        const tools = await mcpClient.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain('session_board_get');
      } finally {
        await mcpClient.close();
      }
      const enqueueReadyEvent = vi.spyOn(activitySession, 'enqueueSessionEventCommitted');
      await createReadyNotificationDispatcher({
        session: activitySession,
        pushSender: null,
        waitingForCommandLabel: 'Waiting for command',
        logPrefix: '[Runner production composition]',
        includeAssistantPreviewText: false,
      })();
      expect(enqueueReadyEvent).toHaveBeenCalledWith({
        type: 'ready',
        ownerActivityDelivery: 'home_required',
      });

      await Promise.race([
        runtime.stop(),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Runner production stop did not settle')), 10_000);
          timer.unref?.();
        }),
      ]);
      await expect(Promise.race([
        runtime.terminal,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Runner production terminal did not settle')), 10_000);
          timer.unref?.();
        }),
      ])).resolves.toEqual({ status: 'completed' });
      expect(boundary.tunnelRetire).toHaveBeenCalledOnce();
      expect(boundary.tunnelClose).toHaveBeenCalledOnce();
      expect(boundary.startAttemptAcceptor).toHaveBeenCalledOnce();
      expect(boundary.stopAttemptAcceptor).toHaveBeenCalledOnce();
      expect(boundary.stopActiveTunnels).toHaveBeenCalledOnce();
      expect(boundary.irohShutdown).toHaveBeenCalledOnce();
      expect(agentEvents).toContain('dispose');
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
