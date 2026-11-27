import { describe, expect, it, onTestFinished, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionExecutionAuthorizationV1Schema, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { resolveAccountContentSecretKey } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS, WorkspaceSyncSourceExecutionV1Schema, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { createWorkspaceSyncTargetContent, openWorkspaceSyncTargetContent } from '@/api/rpc/workspaceSyncTargetContent';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { Machine } from '@/api/types';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { reloadConfiguration } from '@/configuration';
import { createRequesterEncryptionResolver, requesterActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { StoredCredentials } from '@/persistence';
import { adoptServerProfileHomeConnectionDescriptor, setServerProfileEndpointsById } from '@/server/serverProfiles';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { deriveWorkspaceSyncRelationshipId } from '@/workspaces/sync/workspaceSyncRelationshipIdentity';

const { socketIo } = vi.hoisted(() => ({ socketIo: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: socketIo }));

const identityStore = vi.hoisted(() => ({
  identity: null as import('@happier-dev/protocol').MachineInstallationIdentityV1 | null,
}));
vi.mock('@/daemon/identity/store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/identity/store')>(),
  readInstallationIdentityIfExistsSync: () => identityStore.identity,
}));

import { ApiMachineClient } from './apiMachine';

function makeJwtForAccount(accountId: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url'),
    'fixture-signature',
  ].join('.');
}

function makeInstallationIdentity(installationId: string, key: tweetnacl.SignKeyPair) {
  return {
    version: 1 as const,
    installationId,
    createdAt: 1,
    publicKey: Buffer.from(key.publicKey).toString('base64url'),
    privateKey: Buffer.from(key.secretKey).toString('base64url'),
  };
}

function attachRequesterTransportContext(
  authorization: ExternalActionExecutionAuthorizationV1,
  requesterCredentials: StoredCredentials,
  homeId: string,
  isCurrent: () => Promise<boolean> = async () => true,
): ExternalActionExecutionAuthorizationV1 {
  const projection = {
    accountId: authorization.binding.accountId,
    serverId: homeId,
    accountEncryptionMode: 'e2ee' as const,
    isCurrent,
  };
  Object.defineProperty(projection, requesterActionContext, {
    enumerable: false,
    value: Object.freeze({
      authorization,
      credentials: requesterCredentials,
      serverHttpBaseUrl: 'https://cross-account-open-home.invalid',
      isCurrent,
      resolveEncryption: createRequesterEncryptionResolver(requesterCredentials, homeId, isCurrent),
    }),
  });
  const carrier: ExternalActionExecutionAuthorizationV1 = { ...authorization };
  Object.defineProperty(carrier, 'requesterAccountProjection', {
    value: Object.freeze(projection),
    enumerable: false,
  });
  return Object.freeze(carrier);
}

type ScenarioConfig = Readonly<{
  custodianVariant: 'legacy' | 'dataKey';
  requesterVariant: 'legacy' | 'dataKey';
  workspaceActionKind: 'copy_once' | 'create_relationship';
}>;

async function setupCrossAccountProjectOpenFixture(config: ScenarioConfig, run: (ctx: Readonly<{
  homeId: string;
  serverUrl: string;
  custodianAccountId: string;
  requesterAccountId: string;
  targetMachineId: string;
  sourceMachineId: string;
  targetInstallationId: string;
  sourceInstallationId: string;
  targetIdentity: ReturnType<typeof makeInstallationIdentity>;
  sourceIdentity: ReturnType<typeof makeInstallationIdentity>;
  sourceWorkspace: WorkspaceRefV1;
  openInput: ReturnType<typeof OpenProjectInputV1Schema.parse>;
  wireAuthorization: ExternalActionExecutionAuthorizationV1;
  inMemoryAuthorization: ExternalActionExecutionAuthorizationV1;
  envelope: ReturnType<typeof sealExternalActionRequestV2>;
  operationId: string;
  relationshipId: string;
  contentPolicy: ReturnType<typeof computeWorkspaceSyncPolicyDigest> extends string
    ? Readonly<{ v: 1; selection: 'all_files'; extraIgnorePatterns: []; extraIncludePatterns: []; policyDigest: string }> : never;
  custodianCredentials: StoredCredentials;
  client: ApiMachineClient;
  rpcHandlerManager: RpcHandlerManager;
  invokeWriterCallback: (options: Readonly<{
    phase: 'preflight' | 'prepare';
    sourceRouting: ReturnType<typeof WorkspaceSyncSourceRoutingV1Schema.parse>;
    sourceExecution: ReturnType<typeof WorkspaceSyncSourceExecutionV1Schema.parse>;
    prepareMode?: 'honest' | 'forged_two_way';
    authorizationOverride?: ExternalActionExecutionAuthorizationV1;
  }>) => Promise<unknown>;
  encodeSourceReply: (
    packet: Readonly<{ method: string; params: unknown }>,
    sourceRouting: ReturnType<typeof WorkspaceSyncSourceRoutingV1Schema.parse>,
    result: unknown,
  ) => Promise<Readonly<{ ok: true; result: unknown }>>;
  setEmitWithAck: (fn: (event: string, raw: unknown) => Promise<unknown>) => void;
}>) => Promise<void>): Promise<void> {
  const homeId = 'srv_cross_account_open_home';
  const serverUrl = 'https://cross-account-open-home.invalid';
  const custodianAccountId = 'e660281d';
  const requesterAccountId = 'd1b02bcf';
  const targetMachineId = 'f98c58ad';
  const sourceMachineId = '267f9cf1';
  const targetInstallationId = '11111111-1111-4111-8111-111111111111';
  const sourceInstallationId = '22222222-2222-4222-8222-222222222222';

  const targetKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
  const sourceKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(32));
  const targetIdentity = makeInstallationIdentity(targetInstallationId, targetKey);
  const sourceIdentity = makeInstallationIdentity(sourceInstallationId, sourceKey);

  const priorIdentity = identityStore.identity;
  identityStore.identity = targetIdentity;
  onTestFinished(() => { identityStore.identity = priorIdentity; });

  await withTempDir('happier-f4-cross-account-open-', async (happyHomeDir) => {
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    onTestFinished(() => {
      envScope.restore();
      reloadConfiguration();
    });
    envScope.patch({
      HAPPIER_HOME_DIR: happyHomeDir,
      HAPPIER_ACTIVE_SERVER_ID: homeId,
      HAPPIER_SERVER_URL: serverUrl,
      HAPPIER_WEBAPP_URL: serverUrl,
    });
    reloadConfiguration();
    await setServerProfileEndpointsById({ id: homeId, serverUrl, webappUrl: serverUrl, use: true });
    await adoptServerProfileHomeConnectionDescriptor({
      expectedProfileId: homeId,
      observation: 'exact',
      descriptor: {
        v: 1,
        homeServerIdentityId: homeId,
        canonicalServerUrl: serverUrl,
        revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }],
      },
    });
    reloadConfiguration();

    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({
      features: {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } },
    })));
    onTestFinished(() => vi.unstubAllGlobals());

    const postSpy = vi.spyOn(axios, 'post').mockImplementation(async (url) => {
      if (String(url).endsWith('/admission/verify')) {
        return {
          status: 200,
          data: {
            v: 1,
            ok: true,
            destinationInstallation: {
              machineId: sourceMachineId,
              installationId: sourceInstallationId,
              installationPublicKey: sourceIdentity.publicKey,
            },
          },
        };
      }
      throw new Error(`Unexpected axios.post in test: ${String(url)}`);
    });
    onTestFinished(() => postSpy.mockRestore());

    // Distinct key material for custodian vs requester so custodian machine.encryptionKey
    // can NEVER open the requester's sealed v2 envelope.
    const custodianEncryptionKey = new Uint8Array(32).fill(77);
    const requesterLegacySecret = new Uint8Array(32).fill(41);
    const requesterDataKeyMachineKey = new Uint8Array(32).fill(42);
    const requesterCredentials: StoredCredentials = {
      token: makeJwtForAccount(requesterAccountId),
      encryption: config.requesterVariant === 'legacy'
        ? { type: 'legacy', secret: requesterLegacySecret }
        : {
            type: 'dataKey',
            machineKey: requesterDataKeyMachineKey,
            publicKey: tweetnacl.box.keyPair.fromSecretKey(requesterDataKeyMachineKey).publicKey,
          },
    };
    const custodianCredentials: StoredCredentials = {
      token: makeJwtForAccount(custodianAccountId),
      encryption: config.custodianVariant === 'legacy'
        ? { type: 'legacy', secret: custodianEncryptionKey }
        : {
            type: 'dataKey',
            machineKey: custodianEncryptionKey,
            publicKey: tweetnacl.box.keyPair.fromSecretKey(custodianEncryptionKey).publicKey,
          },
    };
    const requesterSealMaterial = requesterCredentials.encryption!.type === 'legacy'
      ? { type: 'dataKey' as const, machineKey: resolveAccountContentSecretKey(requesterCredentials.encryption!) }
      : requesterCredentials.encryption!;

    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [] as [], extraIncludePatterns: [] as [] };
    const contentPolicy = { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) };
    const operationId = 'req-cross-account-open-1';
    const relationshipId = deriveWorkspaceSyncRelationshipId(operationId);

    const workspaceAction = config.workspaceActionKind === 'copy_once'
      ? { kind: 'copy_once' as const, contentPolicy }
      : { kind: 'create_relationship' as const, mode: 'keep_both_in_sync' as const, contentPolicy, flushBeforeCommit: true as const };

    const sourceWorkspace: WorkspaceRefV1 = {
      v: 1,
      id: 'ws-source-1',
      serverId: homeId,
      machineId: sourceMachineId,
      rootPath: '/srv/source-repo',
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const openInput = OpenProjectInputV1Schema.parse({
      serverId: homeId,
      machineId: targetMachineId,
      source: {
        kind: 'workspace',
        workspaceId: sourceWorkspace.id,
        checkout: {
          serverId: homeId,
          workspaceId: sourceWorkspace.id,
          machineId: sourceMachineId,
          rootPath: sourceWorkspace.rootPath,
        },
      },
      materialization: {
        kind: 'sync',
        targetPath: '/srv/target-repo',
        workspaceAction,
      },
    });
    const target = { kind: 'machine' as const, machineId: targetMachineId };
    const envelope = sealExternalActionRequestV2({
      binding: {
        serverIdentityId: homeId,
        accountId: requesterAccountId,
        authentication: { kind: 'account', tokenEpoch: 1 },
        actionId: 'projects.open',
        requestId: operationId,
        target,
      },
      projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      material: requesterSealMaterial,
      input: openInput,
      randomBytes: tweetnacl.randomBytes,
    });

    const sourceAdmission = {
      actorAccountId: requesterAccountId,
      custodianAccountId: requesterAccountId,
      machineId: sourceMachineId,
      installationId: sourceInstallationId,
      role: 'manage' as const,
      encryptionMode: 'e2ee' as const,
    };
    const wireAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1,
      token: 'home-issued-cross-account-open-token',
      binding: {
        serverIdentityId: homeId,
        accountId: requesterAccountId,
        custodianAccountId,
        authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'e2ee',
        machineId: targetMachineId,
        installationId: targetInstallationId,
        actionId: 'projects.open',
        requestId: operationId,
        target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        workspaceSyncAdmission: {
          relationshipId,
          sourceWorkspaceRefId: sourceWorkspace.id,
          source: sourceAdmission,
        },
      },
    });
    const inMemoryAuthorization = attachRequesterTransportContext(wireAuthorization, requesterCredentials, homeId);

    const machine: Machine = {
      id: targetMachineId,
      encryptionKey: custodianEncryptionKey,
      encryptionVariant: config.custodianVariant,
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };
    const client = runWithServerHttpBaseUrl(serverUrl, () =>
      new ApiMachineClient(custodianCredentials.token, machine));
    let currentEmitWithAck: (event: string, raw: unknown) => Promise<unknown> = async () => ({ ok: true, result: { kind: 'materialized' } });
    const socket = createApiSessionSocketStub({
      connected: true,
      emitWithAck: (event, raw) => currentEmitWithAck(event, raw),
    });
    Reflect.set(client, 'socket', socket);
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;

    let callbackCallCounter = 0;
    const invokeWriterCallback: Parameters<typeof run>[0]['invokeWriterCallback'] = async ({
      phase,
      sourceRouting,
      sourceExecution,
      prepareMode = 'honest',
      authorizationOverride,
    }) => {
      const method = phase === 'preflight'
        ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT
        : RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE;
      const scopedMethod = `${targetMachineId}:${method}`;
      const callbackOperationId = phase === 'prepare' && (prepareMode === 'forged_two_way' || config.workspaceActionKind !== 'copy_once')
        ? relationshipId
        : operationId;
      const writerTarget = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({
        v: 1,
        source: sourceRouting,
        sourceWriter: { machineId: sourceMachineId, installationId: sourceInstallationId },
        target: {
          v: 1,
          phase,
          operationId: callbackOperationId,
          accountServerId: homeId,
          targetMachineId,
          targetRootPath: openInput.materialization.kind === 'sync' ? openInput.materialization.targetPath : '/srv/target-repo',
        },
      });
      const rawParams = phase === 'preflight'
        ? {
            v: 1,
            serverId: homeId,
            machineId: targetMachineId,
            operationId: callbackOperationId,
            targetPath: '/srv/target-repo',
          }
        : {
            v: 1,
            bootstrapOperationId: callbackOperationId,
            ...(prepareMode === 'forged_two_way'
              ? {
                  owner: { kind: 'relationship' as const, relationshipId },
                  transientRelationship: {
                    v: 1 as const,
                    relationshipId,
                    controllerMachineId: sourceMachineId,
                    alphaWorkspaceRefId: sourceWorkspace.id,
                    betaWorkspaceRefId: 'ws-target-1',
                    mode: 'keep_both_in_sync' as const,
                    contentPolicy,
                    enabled: true,
                    createdAtMs: 1,
                    updatedAtMs: 1,
                  },
                }
              : config.workspaceActionKind === 'copy_once'
                ? {
                    owner: {
                      kind: 'copy_once' as const,
                      operation: {
                        v: 1 as const,
                        operationId,
                        controllerMachineId: sourceMachineId,
                        alphaWorkspaceRefId: sourceWorkspace.id,
                        betaWorkspaceRefId: 'ws-target-1',
                        contentPolicy,
                      },
                    },
                  }
                : {
                    owner: { kind: 'relationship' as const, relationshipId },
                    ...(config.workspaceActionKind === 'create_relationship'
                      ? {
                          transientRelationship: {
                            v: 1 as const,
                            relationshipId,
                            controllerMachineId: sourceMachineId,
                            alphaWorkspaceRefId: sourceWorkspace.id,
                            betaWorkspaceRefId: 'ws-target-1',
                            mode: 'keep_both_in_sync' as const,
                            contentPolicy,
                            enabled: true,
                            createdAtMs: 1,
                            updatedAtMs: 1,
                          },
                        }
                      : {}),
                  }),
            targetWorkspaceRefId: 'ws-target-1',
            endpointRole: 'beta' as const,
            policyDigest: contentPolicy.policyDigest,
            createIfMissing: true,
            targetBootstrap: 'materialize_from_source_workspace' as const,
          };
      const targetContent = createWorkspaceSyncTargetContent({
        destination: {
          machineId: targetMachineId,
          installationId: targetInstallationId,
          installationPublicKey: targetIdentity.publicKey,
        },
        method: scopedMethod,
        routing: writerTarget,
      });
      const callId = (++callbackCallCounter).toString(16).padStart(32, '0');
      const encodedParams = await socketRpcCodec.encodeParams(targetContent, rawParams, { method: scopedMethod, callId });
      const callbackAuth = authorizationOverride ?? wireAuthorization;
      const callbackExecution = authorizationOverride
        ? WorkspaceSyncSourceExecutionV1Schema.parse({
            ...sourceExecution,
            externalActionExecution: {
              ...sourceExecution.externalActionExecution,
              authorization: callbackAuth,
              machineSignature: signExternalActionMachineRpcRequestV1({
                authorizationToken: callbackAuth.token,
                effectActionId: 'projects.open',
                target: callbackAuth.binding.target,
                installationId: targetInstallationId,
                method: sourceExecution.method,
                requestId: sourceExecution.requestId,
                params: sourceExecution.params,
                workspaceSyncSourceRouting: sourceRouting,
                privateKey: targetKey.secretKey,
              }),
            },
          })
        : sourceExecution;
      const rawReply = await rpcHandlerManager.handleRequest({
        method: scopedMethod,
        params: encodedParams,
        machineAdmission: {
          actorAccountId: requesterAccountId,
          custodianAccountId,
          machineId: targetMachineId,
          installationId: targetInstallationId,
          role: 'manage' as const,
          encryptionMode: 'e2ee' as const,
        },
        callerAuthority: 'present_user' as const,
        callerInputAuthorization: callbackAuth,
        workspaceSyncSourceExecution: callbackExecution,
        workspaceSyncSourceWriterTargetRouting: writerTarget,
      });
      return await socketRpcCodec.decodeResult(targetContent, { ok: true, result: rawReply }, callId);
    };

    const encodeSourceReply: Parameters<typeof run>[0]['encodeSourceReply'] = async (packet, sourceRouting, result) => {
      const receiver = openWorkspaceSyncTargetContent({
        ciphertext: String(packet.params),
        installation: sourceIdentity,
        machineId: sourceMachineId,
        method: packet.method,
        routing: sourceRouting,
      });
      if (!receiver) throw new Error('Source could not open installed workspace sync target packet');
      const decoded = await socketRpcCodec.decodeRequestParams(receiver, packet.params, packet.method);
      return { ok: true as const, result: await socketRpcCodec.encodeResponse(receiver, result, decoded.callId) };
    };

    await run({
      homeId,
      serverUrl,
      custodianAccountId,
      requesterAccountId,
      targetMachineId,
      sourceMachineId,
      targetInstallationId,
      sourceInstallationId,
      targetIdentity,
      sourceIdentity,
      sourceWorkspace,
      openInput,
      wireAuthorization,
      inMemoryAuthorization,
      envelope,
      operationId,
      relationshipId,
      contentPolicy,
      custodianCredentials,
      client,
      rpcHandlerManager,
      invokeWriterCallback,
      encodeSourceReply,
      setEmitWithAck: (fn) => { currentEmitWithAck = fn; },
    });
  });
}

describe('ApiMachineClient cross-Account E2EE projects.open writer-target callbacks', () => {
  it.each([
    { custodianVariant: 'legacy', requesterVariant: 'legacy', workspaceActionKind: 'copy_once' },
    { custodianVariant: 'legacy', requesterVariant: 'dataKey', workspaceActionKind: 'create_relationship' },
    { custodianVariant: 'dataKey', requesterVariant: 'dataKey', workspaceActionKind: 'copy_once' },
    { custodianVariant: 'dataKey', requesterVariant: 'legacy', workspaceActionKind: 'create_relationship' },
  ] as const)(
    'admits in-flight preflight and prepare callbacks ($custodianVariant custodian, $requesterVariant guest, $workspaceActionKind) and refuses post-settlement callback',
    async (scenario) => {
      await setupCrossAccountProjectOpenFixture(scenario, async (ctx) => {
        let preflightHits = 0;
        let prepareHits = 0;
        ctx.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, () => {
          preflightHits += 1;
          return { type: 'not_required' };
        });
        ctx.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE, () => {
          prepareHits += 1;
          return { ok: true };
        });

        let capturedSourceRouting: ReturnType<typeof WorkspaceSyncSourceRoutingV1Schema.parse> | null = null;
        let capturedSourceExecution: ReturnType<typeof WorkspaceSyncSourceExecutionV1Schema.parse> | null = null;
        let preflightResponse: unknown;
        let prepareResponse: unknown;

        ctx.setEmitWithAck(async (event, raw) => {
          expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
          const packet = raw as {
            method: string;
            requestId: string;
            params: unknown;
            workspaceSyncSourceRouting: unknown;
            externalActionExecution: { authorization: Record<string, unknown> };
          };
          expect(packet.method).toBe(`${ctx.sourceMachineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`);
          // P1 must never receive requester keys or requesterAccountContext/requesterAccountProjection.
          expect(packet.externalActionExecution.authorization).not.toHaveProperty('requesterAccountContext');
          expect(Object.keys(packet.externalActionExecution.authorization)).not.toContain('requesterAccountProjection');
          expect(JSON.stringify(packet.externalActionExecution.authorization)).not.toContain('requesterAccountContext');
          expect(JSON.stringify(packet.externalActionExecution.authorization)).not.toContain('requesterAccountProjection');

          const sourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse(packet.workspaceSyncSourceRouting);
          expect(sourceRouting.originalActionEnvelope).toEqual(ctx.envelope);
          const sourceExecution = WorkspaceSyncSourceExecutionV1Schema.parse({
            method: packet.method,
            requestId: packet.requestId,
            params: packet.params,
            externalActionExecution: packet.externalActionExecution,
          });
          capturedSourceRouting = sourceRouting;
          capturedSourceExecution = sourceExecution;

          preflightResponse = await ctx.invokeWriterCallback({ phase: 'preflight', sourceRouting, sourceExecution });
          prepareResponse = await ctx.invokeWriterCallback({ phase: 'prepare', sourceRouting, sourceExecution });
          return await ctx.encodeSourceReply(packet, sourceRouting, { kind: 'materialized' });
        });

        const result = await ctx.client.callWorkspaceSyncProjectSource({
          machineId: ctx.sourceMachineId,
          operationId: ctx.operationId,
          sourceWorkspace: ctx.sourceWorkspace,
          credentials: ctx.custodianCredentials,
          request: ctx.openInput,
          context: {
            signal: new AbortController().signal,
            callerAuthority: 'present_user',
            callerInputAuthorization: ctx.inMemoryAuthorization,
            originalActionEnvelope: ctx.envelope,
            machineAdmission: {
              actorAccountId: ctx.requesterAccountId,
              custodianAccountId: ctx.custodianAccountId,
              machineId: ctx.targetMachineId,
              installationId: ctx.targetInstallationId,
              role: 'manage',
              encryptionMode: 'e2ee',
            },
            verifyMachineAdmissionCurrent: async () => true,
          },
        });

        expect(result).toEqual({ kind: 'materialized' });
        expect(preflightResponse, JSON.stringify(preflightResponse)).toEqual({ type: 'not_required' });
        expect(prepareResponse, JSON.stringify(prepareResponse)).toEqual({ ok: true });
        expect(preflightHits).toBe(1);
        expect(prepareHits).toBe(1);

        // Late / post-settlement callback MUST be refused once callWorkspaceSyncProjectSource returns.
        const latePreflight = await ctx.invokeWriterCallback({
          phase: 'preflight',
          sourceRouting: capturedSourceRouting!,
          sourceExecution: capturedSourceExecution!,
        });
        expect(latePreflight, JSON.stringify(latePreflight)).toMatchObject({
          errorCode: RPC_ERROR_CODES.FORBIDDEN,
          failureCause: { phase: 'rpc.admission.project_input_binding' },
        });
        expect(preflightHits).toBe(1);
      });
    },
  );

  it.each(['legacy', 'dataKey'] as const)(
    'still refuses a forged two-way prepare under a cross-Account E2EE one-way copy_once projects.open (%s custodian)',
    async (custodianVariant) => {
      await setupCrossAccountProjectOpenFixture(
        { custodianVariant, requesterVariant: custodianVariant, workspaceActionKind: 'copy_once' },
        async (ctx) => {
          let prepareHits = 0;
          ctx.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE, () => {
            prepareHits += 1;
            return { ok: true };
          });

          let forgedResponse: unknown;
          ctx.setEmitWithAck(async (_event, raw) => {
            const packet = raw as {
              method: string;
              requestId: string;
              params: unknown;
              workspaceSyncSourceRouting: unknown;
              externalActionExecution: unknown;
            };
            const sourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse(packet.workspaceSyncSourceRouting);
            const sourceExecution = WorkspaceSyncSourceExecutionV1Schema.parse({
              method: packet.method,
              requestId: packet.requestId,
              params: packet.params,
              externalActionExecution: packet.externalActionExecution,
            });
            forgedResponse = await ctx.invokeWriterCallback({
              phase: 'prepare',
              sourceRouting,
              sourceExecution,
              prepareMode: 'forged_two_way',
            });
            return await ctx.encodeSourceReply(packet, sourceRouting, { kind: 'materialized' });
          });

          await ctx.client.callWorkspaceSyncProjectSource({
            machineId: ctx.sourceMachineId,
            operationId: ctx.operationId,
            sourceWorkspace: ctx.sourceWorkspace,
            credentials: ctx.custodianCredentials,
            request: ctx.openInput,
            context: {
              signal: new AbortController().signal,
              callerAuthority: 'present_user',
              callerInputAuthorization: ctx.inMemoryAuthorization,
              originalActionEnvelope: ctx.envelope,
              machineAdmission: {
                actorAccountId: ctx.requesterAccountId,
                custodianAccountId: ctx.custodianAccountId,
                machineId: ctx.targetMachineId,
                installationId: ctx.targetInstallationId,
                role: 'manage',
                encryptionMode: 'e2ee',
              },
              verifyMachineAdmissionCurrent: async () => true,
            },
          });

          expect(forgedResponse, JSON.stringify(forgedResponse)).toMatchObject({
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
            failureCause: { phase: 'rpc.admission.project_input_binding' },
          });
          expect(prepareHits).toBe(0);
        },
      );
    },
  );

  it.each(['legacy', 'dataKey'] as const)(
    'removes the active requester encryption entry in finally when callWorkspaceSyncProjectSource throws (%s custodian)',
    async (custodianVariant) => {
      await setupCrossAccountProjectOpenFixture(
        { custodianVariant, requesterVariant: 'legacy', workspaceActionKind: 'copy_once' },
        async (ctx) => {
          let preflightHits = 0;
          ctx.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, () => {
            preflightHits += 1;
            return { type: 'not_required' };
          });

          let capturedSourceRouting: ReturnType<typeof WorkspaceSyncSourceRoutingV1Schema.parse> | null = null;
          let capturedSourceExecution: ReturnType<typeof WorkspaceSyncSourceExecutionV1Schema.parse> | null = null;

          ctx.setEmitWithAck(async (_event, raw) => {
            const packet = raw as {
              method: string;
              requestId: string;
              params: unknown;
              workspaceSyncSourceRouting: unknown;
              externalActionExecution: unknown;
            };
            capturedSourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse(packet.workspaceSyncSourceRouting);
            capturedSourceExecution = WorkspaceSyncSourceExecutionV1Schema.parse({
              method: packet.method,
              requestId: packet.requestId,
              params: packet.params,
              externalActionExecution: packet.externalActionExecution,
            });
            throw new Error('simulated source transport failure');
          });

          await expect(ctx.client.callWorkspaceSyncProjectSource({
            machineId: ctx.sourceMachineId,
            operationId: ctx.operationId,
            sourceWorkspace: ctx.sourceWorkspace,
            credentials: ctx.custodianCredentials,
            request: ctx.openInput,
            context: {
              signal: new AbortController().signal,
              callerAuthority: 'present_user',
              callerInputAuthorization: ctx.inMemoryAuthorization,
              originalActionEnvelope: ctx.envelope,
              machineAdmission: {
                actorAccountId: ctx.requesterAccountId,
                custodianAccountId: ctx.custodianAccountId,
                machineId: ctx.targetMachineId,
                installationId: ctx.targetInstallationId,
                role: 'manage',
                encryptionMode: 'e2ee',
              },
              verifyMachineAdmissionCurrent: async () => true,
            },
          })).rejects.toThrow('simulated source transport failure');

          const latePreflight = await ctx.invokeWriterCallback({
            phase: 'preflight',
            sourceRouting: capturedSourceRouting!,
            sourceExecution: capturedSourceExecution!,
          });
          expect(latePreflight, JSON.stringify(latePreflight)).toMatchObject({
            errorCode: RPC_ERROR_CODES.FORBIDDEN,
            failureCause: { phase: 'rpc.admission.project_input_binding' },
          });
          expect(preflightHits).toBe(0);
        },
      );
    },
  );

  it.each(['legacy', 'dataKey'] as const)(
    'refuses in-flight callbacks with a mismatched authorization.token or mutated authorization.binding (%s custodian)',
    async (custodianVariant) => {
    await setupCrossAccountProjectOpenFixture(
      { custodianVariant, requesterVariant: custodianVariant, workspaceActionKind: 'copy_once' },
      async (ctx) => {
        let preflightHits = 0;
        ctx.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, () => {
          preflightHits += 1;
          return { type: 'not_required' };
        });

        let mismatchedTokenResponse: unknown;
        let mutatedBindingResponse: unknown;

        ctx.setEmitWithAck(async (_event, raw) => {
          const packet = raw as {
            method: string;
            requestId: string;
            params: unknown;
            workspaceSyncSourceRouting: unknown;
            externalActionExecution: unknown;
          };
          const sourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse(packet.workspaceSyncSourceRouting);
          const sourceExecution = WorkspaceSyncSourceExecutionV1Schema.parse({
            method: packet.method,
            requestId: packet.requestId,
            params: packet.params,
            externalActionExecution: packet.externalActionExecution,
          });

          const mismatchedTokenAuth = ExternalActionExecutionAuthorizationV1Schema.parse({
            ...ctx.wireAuthorization,
            token: 'different-authorization-token',
          });
          mismatchedTokenResponse = await ctx.invokeWriterCallback({
            phase: 'preflight',
            sourceRouting,
            sourceExecution,
            authorizationOverride: mismatchedTokenAuth,
          });

          const mutatedBindingAuth = ExternalActionExecutionAuthorizationV1Schema.parse({
            ...ctx.wireAuthorization,
            binding: {
              ...ctx.wireAuthorization.binding,
              authentication: { kind: 'account', tokenEpoch: 2 },
            },
          });
          mutatedBindingResponse = await ctx.invokeWriterCallback({
            phase: 'preflight',
            sourceRouting,
            sourceExecution,
            authorizationOverride: mutatedBindingAuth,
          });

          return await ctx.encodeSourceReply(packet, sourceRouting, { kind: 'materialized' });
        });

        await ctx.client.callWorkspaceSyncProjectSource({
          machineId: ctx.sourceMachineId,
          operationId: ctx.operationId,
          sourceWorkspace: ctx.sourceWorkspace,
          credentials: ctx.custodianCredentials,
          request: ctx.openInput,
          context: {
            signal: new AbortController().signal,
            callerAuthority: 'present_user',
            callerInputAuthorization: ctx.inMemoryAuthorization,
            originalActionEnvelope: ctx.envelope,
            machineAdmission: {
              actorAccountId: ctx.requesterAccountId,
              custodianAccountId: ctx.custodianAccountId,
              machineId: ctx.targetMachineId,
              installationId: ctx.targetInstallationId,
              role: 'manage',
              encryptionMode: 'e2ee',
            },
            verifyMachineAdmissionCurrent: async () => true,
          },
        });

        expect(mismatchedTokenResponse, JSON.stringify(mismatchedTokenResponse)).toMatchObject({
          errorCode: RPC_ERROR_CODES.FORBIDDEN,
          failureCause: { phase: 'rpc.admission.project_input_binding' },
        });
        expect(mutatedBindingResponse, JSON.stringify(mutatedBindingResponse)).toMatchObject({
          errorCode: RPC_ERROR_CODES.FORBIDDEN,
          failureCause: { phase: 'rpc.admission.project_input_binding' },
        });
        expect(preflightHits).toBe(0);
      },
    );
  });
});
