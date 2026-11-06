import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import '../../../../ui/sources/dev/vitestSetup';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { Server } from 'socket.io';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { AccountSettingsSchema, FeaturesResponseSchema, AUTHORITY_CEILING_HEADER_V1, PluginManifestV2Schema } from '@happier-dev/protocol';
import { MachineProvisionersListResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { MachinePresetActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { ManagedAdmissionOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityActionOutputSchemasV1 } from '@happier-dev/protocol/plugins/availability/actions';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { createExternalActionDaemonDispatchResponse, ExternalActionRequestEnvelopeSchema, normalizeActionsSettingsV1,
  sealExternalActionRequestV2, openExternalActionResponseV2 } from '@happier-dev/protocol/actions';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, loadManagedProvisionerCatalogForTests } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import type { FetchedMachineRow } from '../../../../ui/sources/sync/engine/machines/syncMachines';
import { createLightSqliteHarness, createAccountTokenForTests, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { enableAuthentication } from '../../../../server/sources/app/api/utils/enableAuthentication';
import { enableErrorHandlers } from '../../../../server/sources/app/api/utils/enableErrorHandlers';
import { registerAccountEncryptionRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerAccountSettingsRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountSettingsRoutes';
import { registerExternalActionRoutes } from '../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { machinesRoutes } from '../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { admitManagedAcquire } from '../../../../server/sources/app/machines/managed/managedAcquire';
import { registerPluginAvailabilityRoutes } from '../../../../server/sources/app/plugins/availability/routes';
import { createReleaseLessDeclarationV1 } from '../../../../server/sources/app/plugins/availability/currentDeclaration';
import { createExternalActionDaemonDispatcher } from '../../../../server/sources/app/api/socket/externalActionDispatcher';
import { db } from '../../../../server/sources/storage/db';
import { getOrCreateServerIdentityId } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { prepareRequesterAccountActionContext } from "../sessionEncryption/requesterAccountActionProjection";
import { type RequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { executeExternalAction } from './executeExternalAction';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createDaemonManagedMachineActionAdapter } from '../startup/managedMachineActionAdapter';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createManagedProviderOperationAuthority } from '../connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { mintExternalActionExecutionAuthorization, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { updateSettings, type StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// Load runtime consumers only after the canonical transport boundaries are installed.
const { TokenStorage } = await import('../../../../ui/sources/auth/storage/tokenStorage');
const provisionerCatalog = await loadManagedProvisionerCatalogForTests();

describe('managed catalog original Account transport', () => {
  let database: LightSqliteHarness;
  let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
  beforeAll(async () => { database = await createLightSqliteHarness({ tempDirPrefix: 'happier-fx16-catalog-', initAuth: true, initEncrypt: true }); }, 120_000);
  beforeEach(async () => { await home.reset(); provisionerCatalog.reset(); channel = await createRequesterCurrentnessSocketHarness(); });
  afterEach(async () => { await channel.close(); vi.restoreAllMocks(); });
  afterAll(async () => { await home.reset(); await database.close(); });

  it.each(['account', 'terminal'] as const)('round-trips the real provisioner catalog through Home minting and installed daemon admission with recovery-key crypto for %s credentials', async kind => {
    const secret = new Uint8Array(32).fill(kind === 'account' ? 29 : 30);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
    const signing = tweetnacl.sign.keyPair.fromSeed(secret);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const account = await db.account.create({ data: { publicKey: Buffer.from(signing.publicKey).toString('hex'), encryptionMode: 'e2ee',
      contentPublicKey: publicKey, contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: publicKey }) } });
    const homeId = await getOrCreateServerIdentityId();
    const controller = { machineId: `fx18-${kind}-controller`, installationId: `fx18-${kind}-installation` };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
    await db.machine.create({ data: { id: controller.machineId, accountId: account.id, installationId: controller.installationId,
      installationPublicKey: installation.publicKey, metadata: 'opaque', metadataVersion: 1,
      active: true, lastActiveAt: new Date(), operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
    const token = await createAccountTokenForTests(account.id, { kind,
      authority: kind === 'account' ? 'present_user' : 'account_automation' });
    const credentials: StoredCredentials = { token, encryption: { type: 'legacy', secret } };
    // Terminal pairing provisions the installed daemon with the Account data key,
    // while the browser retains its recovery-key credential.
    const installedCredentials: StoredCredentials = { token: await createAccountTokenForTests(account.id, {
      kind: 'terminal', authority: 'account_automation',
    }), encryption: { type: 'dataKey', machineKey, publicKey } };
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
    // Substitute plugin module loading through the existing native testkit;
    // the real registry and catalog producer must carry this declaration through the relay.
    const provisioner = nativeFixture({ credentialPurposes: [] });
    const registry = provisioner.runtimeRegistry;
    const unavailable = async (): Promise<never> => { throw new Error('Catalog reads must not materialize credentials'); };
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
      purposeBindingOwner: createConnectedAccountPurposeBindingOwner({ store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable,
        subscribe: () => ({ dispose() {} }) }, selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
        projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable }),
      requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
      createRedactionLease: () => ({ add() {}, close() {} }),
    });
    const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({ serverUrl,
      resolveCurrentMachineId: () => controller.machineId });
    const native = createDaemonManagedMachineActionAdapter({ credentials, machineId: controller.machineId, serverBaseUrl: serverUrl,
      serverId: configuration.activeServerId, installationIdentity: { installationId: controller.installationId, privateKey: installation.secretKey },
      managedProviderOperationAuthority: authority,
      resolveCurrentMachineExecutionOriginContext,
      acquireRuntimeRegistryLease: async () => ({ registry, source: 'active', durableRevision: 1, release: async () => {} }),
    });
    const executor = (admitted?: RequesterAccountActionContext) => createCliActionExecutorFromCredentials({
      credentials: installedCredentials, readCredentials: async () => installedCredentials, machineId: controller.machineId, serverId: configuration.activeServerId,
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
        // Installed credential custody is the OS fixture, as in daemon startup.
        // Resolve the actual Home identity and retain real recovery-key crypto.
        resolveEncryption: async signal => {
          const origin = await resolveCurrentMachineExecutionOriginContext(signal);
          return origin?.machineId === controller.machineId
            ? { serverIdentityId: origin.serverIdentityId, material: { type: 'dataKey', machineKey } }
            : null;
        },
        prepareRequesterAccountContext: async input => {
          const prepared = await prepareRequesterAccountActionContext({ authorization: input.authorization, purpose: { kind: 'external_action' },
            machineId: controller.machineId, installationId: controller.installationId, installationPrivateKey: installation.secretKey,
            serverId: configuration.activeServerId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl, ownCredentials: installedCredentials,
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
      const result = kind === 'account'
        ? await provisionerCatalog.read({ serverId: uiServerId, accountId: account.id }, { homeId, controller,
            contribution: { pluginId: 'acme.compute', localId: 'vm' } })
        : await (async () => {
          // Paired CLI credentials use the real authorization client. UI login
          // deliberately requires an Account token rather than a terminal token.
          const binding = { serverIdentityId: homeId, accountId: account.id, actionId: 'machines.provisioners.list',
            requestId: 'fx18-terminal-catalog', target: { kind: 'machine' as const, machineId: controller.machineId },
            authentication: { kind: 'terminal' as const, tokenEpoch: account.tokenEpoch } };
          const material = { type: 'dataKey' as const, machineKey };
          const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: { homeId, controller }, material,
            randomBytes: length => new Uint8Array(length).fill(17) });
          const minted = await mintExternalActionExecutionAuthorization({ actionId: binding.actionId, envelope,
            machineId: controller.machineId, pat: token, serverHttpBaseUrl: serverUrl });
          expect(minted).toMatchObject({ ok: true });
          if (!minted.ok) throw new Error(`Catalog authorization rejected: ${minted.code}`);
          const response = await app.inject({ method: 'POST', url: '/v1/actions/machines.provisioners.list',
            headers: { authorization: `Bearer ${token}`, [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' },
            payload: { v: 1, machineId: controller.machineId, envelope, executionAuthorization: minted.authorization } });
          expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
          const execution = openExternalActionResponseV2({ envelope: response.json(), binding, material, request: envelope });
          return execution?.ok ? { kind: 'succeeded', value: execution.result } : { kind: 'failed', execution };
        })();
      expect(admissionResult, JSON.stringify({ admissionResult, authorizationVerified, requesterContextPrepared, homeResponses, result }))
        .toMatchObject({ kind: 'response', response: { v: 2 } });
      expect(result.kind).toBe('succeeded');
      if (result.kind !== 'succeeded') throw new Error('Catalog transport failed');
      const catalog = MachineProvisionersListResultV1Schema.parse(result.value);
      expect(catalog.controller).toEqual(controller);
      expect(catalog.provisioners).toHaveLength(1);
      expect(catalog.provisioners[0]).toMatchObject({ contribution: { pluginId: 'acme.compute', localId: 'vm' },
        descriptor: { title: 'Virtual machine' } });
      expect(MachineProvisionersListResultV1Schema.safeParse({ ...catalog, unexpected: true }).success).toBe(false);
      if (kind === 'account') {
        // This must traverse the same UI -> encrypted Home -> installed daemon
        // owner. Dropping the contribution at any seam would return the VM.
        const missing = await provisionerCatalog.read({ serverId: uiServerId, accountId: account.id }, {
          homeId, controller, contribution: { pluginId: 'acme.compute', localId: 'missing' },
        });
        expect(missing).toMatchObject({ kind: 'succeeded', value: { controller, provisioners: [] } });
      }
    } finally { restoreHttp(); await app.close(); await io.close(); }
  });

  it('claims a release-less provisioner, saves a preset through the real Home Action adapter, and preserves it through disable/re-enable', async () => {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const homeId = await getOrCreateServerIdentityId();
    const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
    const credentials: StoredCredentials = { token, encryption: null };
    const controller = { machineId: 'preset-seam-controller', installationId: 'preset-seam-installation' };
    const provisioner = nativeFixture({ credentialPurposes: [] });
    const manifest = PluginManifestV2Schema.parse(provisioner.runtimeRegistry.contributes.activationTargets[0]!.manifest);
    const declaration = createReleaseLessDeclarationV1(manifest);
    await db.machine.create({ data: { id: controller.machineId, accountId: account.id, installationId: controller.installationId,
      metadata: '{}', pluginMaterializationRevision: BigInt(1) } });
    // Installed Machine inventory is the external daemon-report boundary.
    await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: homeId,
      machineId: controller.machineId, materializationId: controller.installationId, pluginId: manifest.id,
      version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false,
      archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
    const serverUrl = 'https://preset-seam.example';
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    enableErrorHandlers(app); enableAuthentication(app);
    registerAccountEncryptionRoutes(app); registerAccountSettingsRoutes(app);
    registerPluginAvailabilityRoutes(app); machinesRoutes(app);
    app.get('/v1/features', async () => FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } }));
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: serverUrl });
    const policy = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
      'machines.presets.create': ['cli'],
    } });
    const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
      serverId: configuration.activeServerId, serverApiUrl: serverUrl, serverIdentityId: homeId,
      actionsSettingsProvider: { getActionsSettings: () => policy,
        getAccountSettings: () => AccountSettingsSchema.parse({ actionsSettingsV1: policy }) } });
    const context = { surface: 'cli', authority: 'present_user', serverId: configuration.activeServerId } as const;
    const input = { id: 'preset-seam', homeId, name: 'Future guest', owner: { kind: 'account', accountId: account.id }, controller,
      recipe: { provider: { pluginId: manifest.id, localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      environment: { setupScript: 'echo setup' }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } as const;
    try {
      // Availability's private host protocol is not a public Action id. Use its
      // real authenticated route rather than inventing a public executor path.
      const claimId = 'account.plugins.availability.collectionWriters.claim';
      const claimed = await app.inject({ method: 'POST', url: PluginAvailabilityActionHttpPathsV1[claimId],
        headers: { authorization: `Bearer ${token}` }, payload: { manifest } });
      expect(claimed.statusCode, claimed.payload).toBe(200);
      expect(PluginAvailabilityActionOutputSchemasV1[claimId].parse(claimed.json()))
        .toMatchObject({ intent: { pluginId: manifest.id, desiredVersion: null, enabled: true, revision: '0' } });
      const created = await executor.execute('machines.presets.create', input, context);
      expect(created).toMatchObject({ ok: true });
      if (!created.ok) throw new Error(`Preset refused: ${created.errorCode}`);
      const saved = MachinePresetActionOutputSchemasV1['machines.presets.create'].parse(created.result);
      expect(saved).toEqual({ kind: 'saved', preset: { ...input, revision: 0 } });
      expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(0);
      expect((await db.managedMachinePreset.findUniqueOrThrow({ where: { id: input.id } })).launch).toEqual(input.recipe);
      const changeIntent = async (enabled: boolean, expectedRevision: string) => {
        const actionId = 'account.plugins.availability.intent.set';
        const response = await app.inject({ method: 'POST', url: PluginAvailabilityActionHttpPathsV1[actionId],
          headers: { authorization: `Bearer ${token}` }, payload: {
            pluginId: manifest.id, desiredVersion: null, enabled, offlineUiHosting: 'disabled', writableCollections: [], expectedRevision,
          } });
        expect(response.statusCode, response.payload).toBe(200);
        return PluginAvailabilityActionOutputSchemasV1[actionId].parse(response.json());
      };
      expect(await changeIntent(false, '0')).toMatchObject({ intent: { enabled: false, revision: '1' } });
      expect(await executor.execute('machines.presets.get', { homeId, id: input.id }, context))
        .toEqual({ ok: true, result: { kind: 'found', preset: { ...input, revision: 0 } } });
      expect(await executor.execute('machines.presets.create', { ...input, id: 'disabled-preset' }, context))
        .toEqual({ ok: true, result: { kind: 'refused', code: 'provider_unavailable' } });
      expect(await changeIntent(true, '1')).toMatchObject({ intent: { enabled: true, revision: '2' } });
      expect((await db.accountPluginIntent.findUniqueOrThrow({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } } })).releaseLessDeclaration)
        .toEqual(declaration);
      expect(await executor.execute('machines.presets.create', { ...input, id: 'reenabled-preset' }, context))
        .toEqual({ ok: true, result: { kind: 'saved', preset: { ...input, id: 'reenabled-preset', revision: 0 } } });
      expect(MachinePresetActionOutputSchemasV1['machines.presets.create'].safeParse({ ...saved, unexpected: true }).success).toBe(false);
      const admitted = ManagedAdmissionOutputV1Schema.parse(await admitManagedAcquire({ custodianAccountId: account.id,
        requesterAccountId: account.id, requestEnvelopeDigest: 'preset-seam-reviewed', input: {
          requestId: 'preset-seam-acquire', continuationPresent: false, input: {
            selection: { kind: 'preset', homeId, id: input.id, revision: 0 }, controller,
            retention: input.retention, wakeOnAcceptedMessage: false,
          },
        } }));
      const current = ManagedMachineV1Schema.parse(admitted.machine);
      expect(current).toMatchObject({ preset: { id: input.id, revision: 0 }, launch: input.recipe,
        environmentSetup: { environment: input.environment, state: 'pending' } });
      expect(await executor.execute('machines.managed.get', { homeId, managedId: current.id }, context))
        .toEqual({ ok: true, result: current });
    } finally { restoreHttp(); await app.close(); }
  });
});
