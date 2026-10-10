import '../../../../ui/sources/dev/vitestSetup';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { Server } from 'socket.io';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { createExternalActionDaemonDispatchResponse, ExternalActionRequestEnvelopeSchema, normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { TokenStorage } from '../../../../ui/sources/auth/storage/tokenStorage';
import { resetScopedHomeActionExecutorsForTests } from '../../../../ui/sources/sync/ops/actions/scopedHomeActionExecutor';
import { createManagedProvisionerClient } from '../../../../ui/sources/components/settings/machines/managed/managedProvisionerClient';
import type { FetchedMachineRow } from '../../../../ui/sources/sync/engine/machines/syncMachines';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { enableAuthentication } from '../../../../server/sources/app/api/utils/enableAuthentication';
import { enableErrorHandlers } from '../../../../server/sources/app/api/utils/enableErrorHandlers';
import { registerAccountEncryptionRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerAccountSettingsRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountSettingsRoutes';
import { registerExternalActionRoutes } from '../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { createExternalActionDaemonDispatcher } from '../../../../server/sources/app/api/socket/externalActionDispatcher';
import { db } from '../../../../server/sources/storage/db';
import { auth } from '../../../../server/sources/app/auth/auth';
import { getOrCreateServerIdentityId } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { prepareRequesterAccountActionContext, type RequesterAccountActionContext } from '../sessionEncryption/requesterAccountActionProjection';
import { executeExternalAction } from './executeExternalAction';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createDaemonManagedMachineActionAdapter } from '../startup/managedMachineActionAdapter';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createManagedProviderOperationAuthority } from '../connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { updateSettings, type StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);

describe('managed catalog original Account transport', () => {
  let database: LightSqliteHarness;
  beforeAll(async () => { database = await createLightSqliteHarness({ tempDirPrefix: 'happier-fx16-catalog-', initAuth: true, initEncrypt: true }); }, 120_000);
  beforeEach(async () => { await home.reset(); resetScopedHomeActionExecutorsForTests(); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await home.reset(); await database.close(); });

  it('round-trips the real UI provisioner catalog through Home minting and installed daemon admission with recovery-key crypto', async () => {
    const secret = new Uint8Array(32).fill(29);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
    const signing = tweetnacl.sign.keyPair.fromSeed(secret);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const account = await db.account.create({ data: { publicKey: Buffer.from(signing.publicKey).toString('hex'), encryptionMode: 'e2ee',
      contentPublicKey: publicKey, contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: publicKey }) } });
    const homeId = await getOrCreateServerIdentityId();
    const controller = { machineId: 'fx16-controller', installationId: 'fx16-installation' };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
    await db.machine.create({ data: { id: controller.machineId, accountId: account.id, installationId: controller.installationId,
      installationPublicKey: installation.publicKey, metadata: 'opaque', metadataVersion: 1,
      active: true, lastActiveAt: new Date(), operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
    const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
    const credentials: StoredCredentials = { token, encryption: { type: 'legacy', secret } };
    const serverUrl = 'https://fx16-home.example';
    const uiServerId = await home.addHome({ name: 'FX16', serverUrl, serverIdentityId: homeId, accountId: account.id,
      accountEncryptionMode: 'e2ee', currentAccount: true });
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token, secret: encodeBase64(secret, 'base64url') });
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [configuration.activeServerId]: {
      id: configuration.activeServerId, name: 'FX16', serverUrl, webappUrl: serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
      homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl,
        revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] },
    } } }));
    const machineRow = { id: controller.machineId, kind: 'persistent', installationId: controller.installationId, active: true, activeAt: Date.now(),
      revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, storageMode: 'e2ee', metadata: 'opaque', metadataVersion: 1,
      daemonState: null, daemonStateVersion: 0, keyBasis: { dataEncryptionKey: null, metadataVersion: 1, daemonStateVersion: 0 },
      seq: 1, createdAt: 1, updatedAt: 1, access: { custodian: { accountId: account.id, displayName: 'Owner' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' },
    } as const satisfies FetchedMachineRow;
    home.answer(uiServerId, '/v1/machines', { body: [machineRow] });
    // The plugin-loading boundary has no installed leaves. The real registry and
    // native catalog owner produce the empty catalog; no provider answer is fabricated.
    const registry = { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry;
    const unavailable = async (): Promise<never> => { throw new Error('Catalog reads must not materialize credentials'); };
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
      purposeBindingOwner: createConnectedAccountPurposeBindingOwner({ store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable,
        subscribe: () => ({ dispose() {} }) }, selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
        projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable }),
      requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
      createRedactionLease: () => ({ add() {}, close() {} }),
    });
    const native = createDaemonManagedMachineActionAdapter({ credentials, machineId: controller.machineId, serverBaseUrl: serverUrl,
      serverId: configuration.activeServerId, installationIdentity: { installationId: controller.installationId, privateKey: installation.secretKey },
      managedProviderOperationAuthority: authority,
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl,
        resolveCurrentMachineId: () => controller.machineId }),
      acquireRuntimeRegistryLease: async () => ({ registry, source: 'active', durableRevision: 1, release: async () => {} }),
    });
    const executor = (admitted?: RequesterAccountActionContext) => createCliActionExecutorFromCredentials({
      credentials, readCredentials: async () => credentials, machineId: controller.machineId, serverId: configuration.activeServerId,
      serverApiUrl: serverUrl, serverIdentityId: homeId, managedMachineAction: native,
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admitted?.accountSettingsContext.settings.actionsSettingsV1),
        ...(admitted ? { getAccountSettings: () => admitted.accountSettingsContext.settings } : {}) },
    });
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    enableErrorHandlers(app);
    enableAuthentication(app);
    const homeResponses: Array<{ path: string; status: number }> = [];
    app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
      homeResponses.push({ path: request.url, status: reply.statusCode });
    });
    registerAccountEncryptionRoutes(app);
    registerAccountSettingsRoutes(app);
    app.get('/v1/account/profile', async () => ({ id: account.id }));
    app.get('/v1/features', async () => FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } }));
    const io = new Server(createServer());
    let admissionResult: Awaited<ReturnType<typeof executeExternalAction>> | undefined;
    let authorizationVerified = false;
    let requesterContextPrepared = false;
    const dispatch = createExternalActionDaemonDispatcher({ io, forwardRpc: async request => {
      const raw = request.callParams;
      if (!raw || typeof raw !== 'object' || !('envelope' in raw) || !('executionAuthorization' in raw) || !('principal' in raw)) throw new Error('Missing dispatch');
      const { ExternalActionDaemonDispatchRequestSchema } = await import('@happier-dev/protocol/actions');
      const admitted = ExternalActionDaemonDispatchRequestSchema.parse(raw);
      admissionResult = await executeExternalAction({ actionId: admitted.actionId, envelope: admitted.envelope, principal: admitted.principal,
        executionAuthorization: admitted.executionAuthorization, currentMachineId: controller.machineId, currentInstallationId: controller.installationId,
        currentServerId: configuration.activeServerId, externalActionMachineRequestPrivateKey: installation.secretKey,
        verifyExecutionAuthorization: async input => {
          authorizationVerified = await verifyExternalActionExecutionAuthorizationCurrent({ ...input,
            installationId: controller.installationId, privateKey: installation.secretKey, serverHttpBaseUrl: serverUrl });
          return authorizationVerified;
        },
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor: executor(),
        prepareRequesterAccountContext: async input => {
          const prepared = await prepareRequesterAccountActionContext({ authorization: input.authorization, purpose: { kind: 'external_action' },
            machineId: controller.machineId, installationId: controller.installationId, installationPrivateKey: installation.secretKey,
            serverId: configuration.activeServerId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl, ownCredentials: credentials,
            // Installed custody and its retained credential are the OS fixture.
            // Account mode, settings, authorization and crypto stay real.
            isCurrent: async () => true, createExecutor: executor });
          requesterContextPrepared = prepared !== null;
          return prepared;
        },
      });
      return { ok: true, result: admissionResult.kind === 'response' ? createExternalActionDaemonDispatchResponse(admissionResult.prepared) : admissionResult };
    } });
    registerExternalActionRoutes(app, { dispatch });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: serverUrl });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe(serverUrl);
      if (url.pathname !== '/v1/features') return home.request(input, init);
      const response = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
      return new Response(response.payload, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    });
    home.answer(uiServerId, '/v1/actions/machines.provisioners.list', { select: async value => {
      expect(ExternalActionRequestEnvelopeSchema.parse(value).v).toBe(2);
      const response = await app.inject({ method: 'POST', url: '/v1/actions/machines.provisioners.list',
        headers: { authorization: `Bearer ${token}` }, payload: value });
      return { status: response.statusCode, body: response.json() };
    } });
    try {
      const result = await createManagedProvisionerClient({ serverId: uiServerId, accountId: account.id }, homeId)
        .read('machines.provisioners.list', { homeId, controller });
      expect(admissionResult, JSON.stringify({ admissionResult, authorizationVerified, requesterContextPrepared, homeResponses, result }))
        .toMatchObject({ kind: 'response', response: { v: 2 } });
      expect(result).toEqual({ kind: 'succeeded', value: { controller, provisioners: [] } });
    } finally { restoreHttp(); await app.close(); await io.close(); }
  });
});
