import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import nacl from 'tweetnacl';
import axios from 'axios';
import { AccountSettingsSchema, MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent, PluginReleaseFactsV1Schema, type ActionExecuteResult } from '@happier-dev/protocol';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { auth } from '../../../../server/sources/app/auth/auth';
import { setEligibleMachineAccessGrantInTx as setMachineAccessGrantInTx } from '../../../../server/sources/testkit/machineAccessGrant.testkit';
import { createSessionMachineAccessKeyInTx } from '../../../../server/sources/app/accessKeys/sessionMachineAccessKeyMutations';
import { enqueuePendingMessage, updatePendingRequestedAction } from '../../../../server/sources/app/session/pending/pendingMessageService';
import { createPresentUserSessionAccessAuthentication } from '../../../../server/sources/app/session/access/sessionAccessAuthentication.testkit';
import { getOrCreateServerIdentityId, initializeServerIdentityCache } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { sessionPendingRoutes } from '../../../../server/sources/app/api/routes/session/pendingRoutes';
import { registerSessionListingRoutes } from '../../../../server/sources/app/api/routes/session/registerSessionListingRoutes';
import { artifactsRoutes } from '../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { registerAccountEncryptionRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerAccountSecurityRoutes } from '../../../../server/sources/app/api/routes/auth/registerAccountSecurityRoutes';
import { featuresRoutes } from '../../../../server/sources/app/api/routes/features/featuresRoutes';
import { registerManagedMachineRoutes } from '../../../../server/sources/app/machines/managed/managedRoutes';
import { machinesRoutes } from '../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { createReleaseLessDeclarationV1 } from '../../../../server/sources/app/plugins/availability/currentDeclaration';
import { logger as serverLogger } from '../../../../server/sources/utils/logging/log';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { configuration } from '@/configuration';
import { ApiClient } from '@/api/api';
import { CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1 } from '@/api/apiMachine';
import { readStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { logger } from '@/ui/logger';
import { updateSettings } from '@/persistence';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createManagedProviderOperationAuthority } from '../connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createDaemonManagedMachineActionAdapter } from './managedMachineActionAdapter';
import { createDaemonManagedMachinePolicyRuntime, readManagedMachinePolicyCensus } from './managedMachinePolicyRuntime';
import { executeManagedMachinePolicyAction } from './managedMachinePolicyAction';
import { activatePendingInactiveSession } from '../sessions/activatePendingInactiveSession';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { createManagedPolicyCensusProofV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { registerPluginAvailabilityRoutes } from '../../../../server/sources/app/plugins/availability/routes';
import { registerSocketRpcHandlers } from '../../../../server/sources/app/api/socket/rpc/registerSocketRpcHandlers';
import { narrowCredentialAuthority } from '../../../../server/sources/app/auth/effectiveCredentialAuthority';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { Server } from 'socket.io';
import { registerExternalActionRoutes } from '../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { registerAccountProfileRoute } from '../../../../server/sources/app/api/routes/account/registerAccountProfileRoute';
import { registerAccountSettingsRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountSettingsRoutes';
import { createExternalActionDaemonDispatcher } from '../../../../server/sources/app/api/socket/externalActionDispatcher';
import { ExternalActionDaemonDispatchRequestSchema, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { MANAGED_FINITE_WAKE_RPC_METHOD, ManagedFiniteWakeRequestV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { registerExternalActionRpcHandler } from '@/rpc/handlers/externalAction';
import type { RpcHandler } from '@/api/rpc/types';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/rpc';
import { createDaemonExternalActionTargetResolver } from '../externalActions/daemonExternalActionTargetResolver';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { startSocket } from '../../../../server/sources/app/api/socket';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';

let database: LightSqliteHarness;
beforeAll(async () => {
    database = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-wake-approval-', initAuth: true, initEncrypt: true, initFiles: true,
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    await initializeServerIdentityCache();
}, 120_000);
afterAll(async () => { resetActiveAccountSettingsSnapshotForTests(); if (database) await database.close(); });

async function readPowerApprovals(accountId: string, read: (artifactId: string) => Promise<string>) {
    const approvals: Array<{ id: string; status: string; liveWaiters: number }> = [];
    for (const artifact of await db.artifact.findMany({ where: { accountId } })) {
        const content = decodePlainArtifactStoredContent(await read(artifact.id));
        const body = content && typeof content === 'object' && 'body' in content ? content.body : null;
        if (typeof body !== 'string') continue;
        let value: unknown;
        try { value = JSON.parse(body); } catch { continue; }
        const request = StoredApprovalRequestSchema.safeParse(value);
        if (request.success && request.data.actionId === 'machines.managed.power.set') approvals.push({ id: artifact.id,
            status: request.data.status, liveWaiters: getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifact.id) });
    }
    return approvals;
}

it('does not create an unused-power operation from the real Home census before guest enrollment', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const homeId = await getOrCreateServerIdentityId();
    const signing = nacl.sign.keyPair();
    const controller = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
        installationId: randomUUID(), installationPublicKey: signing.publicKey, metadata: 'fixture', active: true } });
    const managed = await db.managedMachine.create({ data: { homeId, custodianAccountId: owner.id,
        controllerMachineId: controller.id, controllerInstallationId: controller.installationId!,
        admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
        launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        desired: 'start', retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true } });
    const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
    const credentials = { token, encryption: null };
    const serverUrl = 'https://retention-home.example';
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    machinesRoutes(app);
    registerAccountEncryptionRoutes(app);
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
    const api = await ApiClient.create(credentials);
    const operations = createHostActionOperationRuntime({ machineId: controller.id, resolveAccountId: async () => owner.id });
    const adapter = createDaemonManagedMachineActionAdapter({ credentials: { token, encryption: null }, machineId: controller.id,
        serverId: configuration.activeServerId, serverBaseUrl: serverUrl, installationIdentity: null,
        acquireRuntimeRegistryLease: async () => { throw new Error('No native runtime installed'); },
        observeActionExecution: request => operations.observeExecution(request),
        executeManagedPolicyAction: (machine, context, runApproved, purpose) => executeManagedMachinePolicyAction({ machine, purpose, context,
            runApproved, serverId: configuration.activeServerId, createExecutor: overrides => createActionExecutor(overrides) }),
    });
    const censusInput = { homeId, controller: { machineId: controller.id, installationId: controller.installationId! },
        custodianAccountId: owner.id, privateKey: signing.secretKey, token, serverUrl };
    let censusRead: (() => void) | undefined;
    let censusError: unknown;
    const runtime = createDaemonManagedMachinePolicyRuntime({
        loadMachine: (id, signal) => runWithServerHttpBaseUrl(serverUrl, () => api.getMachine(id, { signal })),
        readCensus: async signal => {
            try {
                const census = await readManagedMachinePolicyCensus({ ...censusInput, signal });
                expect(census.machines).toMatchObject([{ id: managed.id, allocation: 'bound' }]);
                return census;
            } catch (error) { censusError = error; throw error; }
            finally { censusRead?.(); }
        },
        executePolicy: adapter.executePolicy,
    });
    const notify = async () => {
        const read = new Promise<void>(resolve => { censusRead = resolve; });
        runtime.notifyChanged();
        await read;
        expect(censusError).toBeUndefined();
        await new Promise<void>(resolve => setImmediate(resolve));
    };
    try {
        expect((await readManagedMachinePolicyCensus(censusInput)).machines[0]!.enrolledMachineId).toBeUndefined();
        await notify();
        expect(await operations.handlers.listV2({})).toEqual({ items: [], nextCursor: null });
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, active: true,
            metadata: encodePlainMachineStoredContent({ host: 'retention-fixture', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/retention', happyHomeDir: '/home/retention/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running', startedAt: 1 }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            installationId: randomUUID() } });
        await db.managedMachine.update({ where: { id: managed.id }, data: { enrolledMachineId: guest.id } });
        await notify();
        // A missing native installation is now a legitimate observable attempt.
        // This assertion also fails if the census/adapter binding is disconnected.
        await vi.waitFor(async () => expect(await operations.handlers.listV2({})).toMatchObject({ items: [
            { state: 'failed', error: { errorCode: 'admission_unavailable' } },
        ] }));
    } finally {
        await runtime.stop();
        restore();
        await app.close();
    }
});

it.each([
    { accountOwned: false, reconnected: false, outcome: 'keeps shared fire-time Ask waiting across a competing runtime failure' },
    { accountOwned: false, reconnected: true, outcome: 'preserves admitted Pending when real Home census retires a reconnected guest wake' },
    { accountOwned: true, reconnected: false, outcome: 'wakes null-controller compute from a standalone custodian daemon through its installed Action' },
])('$outcome', async ({ accountOwned, reconnected }) => await withConfiguredDaemonTestHome({ prefix: 'managed-wake-entry-' }, async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const custodian = accountOwned || reconnected ? owner : await db.account.create({ data: { encryptionMode: 'plain' } });
    const homeId = await getOrCreateServerIdentityId();
    const signing = nacl.sign.keyPair();
    const machine = (active: boolean) => db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
        installationId: randomUUID(), active, installationPublicKey: signing.publicKey,
        metadata: encodePlainMachineStoredContent({ host: 'wake-fixture', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/wake', happyHomeDir: '/home/wake/.happier' }),
        dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] },
            ...(reconnected ? { externalActionExecutionAuthorization: { protocolVersions: [1] } } : {}) } } });
    const controller = await machine(true), guest = await machine(false);
    for (const target of accountOwned || reconnected ? [] : [controller, guest]) await inTx(tx => setMachineAccessGrantInTx(tx, {
        actorAccountId: custodian.id, machineId: target.id, principal: { kind: 'account', accountId: owner.id }, level: 'admin' }));
    const effects: string[] = [];
    const inspections = vi.fn();
    const native = nativeFixture({ privateNative: true, supportedIntents: ['start', 'delete'], onNativeRole: role => { effects.push(role); },
        onInspect: inspections, nativeRoleResults: { inspect: { observedAt: 2, availability: 'present', power: 'running', storage: 'retained' } } });
    const manifest = native.runtimeRegistry.contributes.activationTargets[0]!.manifest;
    const declaration = createReleaseLessDeclarationV1(manifest);
    await db.machine.update({ where: { id: controller.id }, data: { pluginMaterializationRevision: BigInt(1) } });
    await db.accountPluginIntent.create({ data: { accountId: custodian.id, pluginId: manifest.id, enabled: true,
        writableCollections: [], releaseLessDeclaration: declaration } });
    if (accountOwned) {
        const release = PluginReleaseFactsV1Schema.parse({ ref: { pluginId: manifest.id, version: manifest.version },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } });
        await db.accountPluginRelease.create({ data: { accountId: custodian.id, pluginId: manifest.id, version: manifest.version,
            archiveDigestSha256: release.archiveDigestSha256, normalizedManifest: release.normalizedManifest,
            collectionContracts: release.collectionContracts, uiSlots: release.uiSlots, packageAssetArchive: release.packageAssetArchive } });
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: custodian.id, pluginId: manifest.id } },
            data: { desiredVersion: manifest.version } });
    }
    await db.pluginMachineMaterialization.create({ data: { accountId: custodian.id, serverIdentityId: homeId,
        machineId: controller.id, materializationId: controller.installationId!, pluginId: manifest.id,
        version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false,
        archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true,
        trustState: 'trusted', observedAt: new Date() } });
    const launch = { provider: { pluginId: manifest.id, localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
    const facts = buildManagedConfigurationFactsV1({ choicesSchema: PluginJsonValueV2Schema, launch,
        provisioner: native.runtimeRegistry.contributes.machineProvisioners[0]!.definition,
        optionStatus: 'current', prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'not-billed' },
        retentionCapabilities: native.runtimeRegistry.contributes.machineProvisioners[0]!.definition.retention,
        machineOverride: { retention: { kind: 'until-delete' } } });
    const retention = accountOwned ? facts.retention : { kind: 'unused', afterMs: 3_600_000, effect: 'stop' } as const;
    const managed = await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
        ...(!accountOwned ? { controllerMachineId: controller.id, controllerInstallationId: controller.installationId! } : {}), enrolledMachineId: guest.id,
        admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
        launch,
        resource: { contributionRef: { pluginId: manifest.id, localId: 'vm' }, schemaVersion: 1, value: {} },
        ...(accountOwned ? { reviewedFacts: facts } : {}),
        desired: 'stop', retention, wakeOnAcceptedMessage: accountOwned ? facts.wakeOnAcceptedMessage : true,
        observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' } } });
    const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
        metadata: reconnected ? JSON.stringify({ machineId: guest.id, path: '/workspace' }) : '{}', encryptionMode: 'plain', active: false } });
    expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: owner.id, sessionId: session.id,
        machineId: guest.id, data: reconnected ? MACHINE_PLAIN_DATA_KEY_MARKER : 'fixture-encrypted-key' }))).toMatchObject({ ok: true });
    const input = { actorUserId: owner.id, authentication: createPresentUserSessionAccessAuthentication(), sessionId: session.id,
        localId: randomUUID(), targetMachineId: guest.id, requestedAction: { v: 1, kind: reconnected ? 'send_now' : 'enqueue' },
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'original queued input' } } } } as const;
    if (!reconnected) expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
    const token = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
    // Approval currentness uses fetch while managed requests use Axios. Serve
    // both transports from the same real Home instead of letting fetch escape
    // the injected Axios transport to a nonexistent fixture hostname.
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    sessionPendingRoutes(app);
    if (reconnected) machinesRoutes(app); else registerManagedMachineRoutes(app);
    registerAccountEncryptionRoutes(app); artifactsRoutes(app);
    registerSessionListingRoutes(app);
    registerAccountSecurityRoutes(app);
    registerPluginAvailabilityRoutes(app);
    featuresRoutes(app);
    let finiteWakes = 0;
    const admissions: unknown[] = [];
    let receive: RpcHandler | undefined;
    let connectGuest: (() => Promise<void>) | undefined;
    if (reconnected) startSocket(app);
    const actionSocket = reconnected && app.machineDaemonPresence instanceof Server ? app.machineDaemonPresence : null;
    if (actionSocket) {
        registerAccountProfileRoute(app);
        registerAccountSettingsRoutes(app);
        registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io: actionSocket,
            forwardRpc: async request => {
                if (request.method.endsWith(`:${MANAGED_FINITE_WAKE_RPC_METHOD}`)) {
                    const wake = ManagedFiniteWakeRequestV1Schema.parse(request.callParams);
                    expect(wake.target.managedId).toBe(managed.id);
                    finiteWakes += 1;
                    // Native wake has completed before Home receives the guest's
                    // presence publication. The socket boundary can deliver its
                    // input during that same reconnect.
                    await db.managedMachine.update({ where: { id: managed.id }, data: {
                        observation: { observedAt: Date.now(), availability: 'present', power: 'running', storage: 'retained' },
                    } });
                    return { ok: true, result: { ok: true, result: { kind: 'accepted', managedId: managed.id,
                        intentRevision: wake.target.expectedIntentRevision + 1 } } };
                }
                if (!receive) throw new Error('Guest Action owner was not registered');
                await connectGuest?.();
                return { ok: true, result: await receive(ExternalActionDaemonDispatchRequestSchema.parse(request.callParams), {
                    authorization: ACTION_API_SERVER_ORIGIN, signal: request.cancellation?.signal ?? new AbortController().signal,
                }) };
            } }) });
    }
    const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [configuration.activeServerId]: {
        id: configuration.activeServerId, name: 'Wake Home', serverUrl, webappUrl: serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } } } }));
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
    let guestClient: ReturnType<ApiClient['machineSyncClient']> | undefined;
    onTestFinished(async () => { await guestClient?.shutdown(); restore(); await app.close(); });
    if (accountOwned) {
        expect(await fetchServerFeaturesSnapshot({ serverUrl, token })).toMatchObject({
            status: 'ready', provenance: 'authenticated', features: { capabilities: { serverIdentity: { serverIdentityId: homeId } } },
        });
        // Merely reading an inactive guest with queued, unarmed input is not a wake demand.
        const passive = await readManagedMachinePolicyCensus({ homeId, controller: {
            machineId: controller.id, installationId: controller.installationId!,
        }, custodianAccountId: custodian.id, privateKey: signing.secretKey, token, serverUrl });
        expect(passive).toMatchObject({ machines: [], targets: [] });
        expect(effects).toEqual([]);
    }
    // Process when online enters through the same Action and real HTTP PATCH
    // as the client, rather than arming the authorization inside the fixture.
    if (reconnected) {
        await writeFile(configuration.installationIdentityFile, JSON.stringify({ version: 1,
            installationId: guest.installationId, createdAt: Date.now(),
            publicKey: encodeBase64(signing.publicKey, 'base64url'),
            privateKey: encodeBase64(signing.secretKey, 'base64url') }), { mode: 0o600 });
        const api = await runWithServerHttpBaseUrl(serverUrl, () => ApiClient.create(credentials));
        const machine = await runWithServerHttpBaseUrl(serverUrl, () => api.getMachine(guest.id));
        if (!machine) throw new Error('Guest Machine was not readable');
        const snapshot = await fetchServerFeaturesSnapshot({ serverUrl, token });
        const client = runWithServerHttpBaseUrl(serverUrl, () => api.machineSyncClient(machine, undefined, {
            getServerFeaturesSnapshot: () => snapshot, resolveCurrentServerIdentityId: () => homeId,
        }));
        guestClient = client;
        let connected: Promise<void> | undefined;
        connectGuest = () => connected ??= new Promise<void>(resolve => client.connect({ onConnect: async () => {
            // This focused receiver installs Pending admission without a native
            // Session-spawn host; publish only the leaves it actually supports.
            await client.publishOperationProtocolCapabilities({
                sessionInputAdmission: CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1.sessionInputAdmission,
                externalActionExecutionAuthorization: CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1.externalActionExecutionAuthorization,
            });
            // Input can arrive over the new channel before the guest's presence
            // publication reaches the controller's next Home census.
            await db.machine.update({ where: { id: guest.id }, data: { active: false } });
            resolve();
        } }));
        const receiver = createCliActionExecutorFromCredentials({ credentials, serverId: configuration.activeServerId,
            serverIdentityId: homeId, serverApiUrl: serverUrl, machineId: guest.id,
            machineActionDirectTargetTransport: { machineId: guest.id,
                invoke: async () => { throw new Error('Send-now uses real Home Pending admission, not another Machine RPC'); } },
            machineAdmissionTransport: async (request, options) => {
                const result = await client.enqueueSessionPendingByMachine(request, options);
                admissions.push({ result, targetMachineId: request.targetMachineId });
                return result;
            },
            externalActionMachineInstallationId: guest.installationId!, externalActionMachineRequestPrivateKey: signing.secretKey,
            actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
        const target = await runWithServerHttpBaseUrl(serverUrl, () => receiver.resolveSessionTarget(session.id));
        expect(target, JSON.stringify(target)).toMatchObject({ ok: true, sessionId: session.id });
        registerExternalActionRpcHandler({ registerHandler: (method, handler) => {
            if (method === EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1) receive = handler;
        } }, { machineId: guest.id, currentServerId: configuration.activeServerId, currentServerHttpBaseUrl: serverUrl,
            resolveAccountId: async () => custodian.id, resolveInstallationId: () => guest.installationId!,
            externalActionMachineRequestPrivateKey: signing.secretKey,
            verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                privateKey: signing.secretKey, installationId: guest.installationId!, serverHttpBaseUrl: serverUrl }),
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverUrl }), executor: receiver });
    }
    const processWhenOnline = await runWithServerHttpBaseUrl(serverUrl, () => reconnected
        ? createCliActionExecutorFromCredentials({ credentials, externalActionClient: true, serverId: configuration.activeServerId,
            serverIdentityId: homeId, serverApiUrl: serverUrl,
            actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
        }).execute('session.message.send', { sessionId: session.id, localId: input.localId, message: 'original queued input',
            requestedAction: input.requestedAction, reply: 'none' }, { surface: 'cli',
                externalActionTarget: { kind: 'machine', machineId: guest.id } })
        : createActionExecutor(createCliActionDeps({
        token: ownerToken, credentials: { token: ownerToken, encryption: null }, sessionId: session.id, mode: 'plain', ctx: null,
    })).execute('session.pending.action.set', {
        sessionId: session.id, localId: input.localId, requestedAction: input.requestedAction, resumeWhenAvailable: true,
    }, { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'session.pending.action.set' } }));
    expect(processWhenOnline, JSON.stringify({ processWhenOnline, admissions })).toMatchObject({ ok: true,
        result: reconnected ? { status: 'accepted', localId: input.localId } : { didUpdate: true } });
    if (reconnected) expect(finiteWakes).toBe(1);
    const before = await db.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(before).toMatchObject({ pendingActivationStatus: 'waiting', pendingActivationRequestId: input.localId });
    const sockets = await createRequesterCurrentnessSocketHarness();
    // The live Ask origin publishes its RPC endpoint before persisting the
    // Artifact. Keep Home registration and credential verification real;
    // the harness redirects only the network listener to loopback.
    sockets.server.use(async (socket, next) => {
        const verified = await auth.verifyTokenForRoute(socket.handshake.auth.token);
        if (!verified) return next(new Error('Unauthorized'));
        socket.data.authTokenKind = verified.authTokenKind;
        socket.data.authAuthority = narrowCredentialAuthority(verified.authority, socket.handshake.auth.authorityCeiling);
        socket.data.authTokenAuthenticationEvidence = verified.authenticationEvidence;
        socket.data.clientType = socket.handshake.auth.clientType;
        socket.data.userId = verified.userId;
        next();
    });
    sockets.server.on('connection', socket => registerSocketRpcHandlers({
        userId: socket.data.userId, socket, io: sockets.server,
    }));
    const unavailable = async (): Promise<never> => { throw new Error('No provider credentials required before Ask'); };
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
        purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
            projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable }),
        requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
        createRedactionLease: () => ({ add() {}, close() {} }) });
    const operationId = randomUUID();
    let installedActionAdmissions = 0;
    let installedExecutor: ReturnType<typeof createCliActionExecutorFromCredentials> | undefined;
    let policyOwnerFailure: Readonly<{ code: unknown; frames: readonly string[] }> | undefined;
    const operations = createHostActionOperationRuntime({ machineId: controller.id, resolveAccountId: async () => custodian.id,
        generateOperationId: () => operationId });
    const adapter = createDaemonManagedMachineActionAdapter({ credentials, machineId: controller.id, serverBaseUrl: serverUrl,
        serverId: configuration.activeServerId, installationIdentity: { installationId: controller.installationId!, privateKey: signing.secretKey },
        managedProviderOperationAuthority: authority,
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: controller.id }),
        acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
        observeActionExecution: request => operations.observeExecution(request),
        executeManagedPolicyAction: async (current, context, runApproved, purpose) => {
            try { return await executeManagedMachinePolicyAction({ machine: current, purpose, context,
            runApproved, serverId: configuration.activeServerId, createExecutor: overrides => {
                installedActionAdmissions++;
                installedExecutor = createCliActionExecutorFromCredentials({
                credentials, serverId: configuration.activeServerId, serverApiUrl: serverUrl, serverIdentityId: homeId,
                externalActionMachineRequestPrivateKey: signing.secretKey, externalActionMachineInstallationId: controller.installationId!,
                pluginActionExecutionOwner: 'current_process', machineActionDirectTargetTransport: { machineId: controller.id,
                    // The installed daemon's local RPC endpoint is a system boundary; policy power never dispatches through it.
                    invoke: async () => { throw new Error('Managed policy stays within its installed Action owner'); } },
                machineId: controller.id, readCredentials: async () => credentials, ...overrides });
                return installedExecutor;
            } }); }
            catch (error) {
                policyOwnerFailure = { code: error && typeof error === 'object' && 'code' in error ? error.code : null,
                    frames: error instanceof Error ? (error.stack?.split('\n').slice(1, 5) ?? []) : [] };
                throw error;
            }
        } });
    const readCensus = (signal?: AbortSignal) => readManagedMachinePolicyCensus({ homeId,
        controller: { machineId: controller.id, installationId: controller.installationId! }, custodianAccountId: custodian.id,
        privateKey: signing.secretKey, token, serverUrl, signal });
    let policyResult: ActionExecuteResult | undefined;
    let policyError: unknown;
    const runtime = createDaemonManagedMachinePolicyRuntime({ readCensus,
        executePolicy: async request => { policyResult = await adapter.executePolicy(request); return policyResult; },
        onUnavailable: error => { policyError = error; } });
    const serverLog = vi.spyOn(serverLogger, 'info');
    const daemonLog = vi.spyOn(logger, 'warnLocalFile');
    const actualPost = axios.post;
    const policyPaths: string[] = [];
    let censusUnavailable = false;
    const censusFailures: Array<{ expectedBearer: boolean; status: number | null; errorCode: string | null }> = [];
    const recordCensusFailure = (status: number | null, data: unknown, bearer: unknown) => {
        censusFailures.push({ expectedBearer: bearer === `Bearer ${token}`, status,
            errorCode: data !== null && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
                ? data.error : null });
    };
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, data, config) => {
        const path = new URL(String(url), serverUrl).pathname;
        if (path.startsWith('/v1/machines/managed/controller/') && !path.endsWith('/policies')) policyPaths.push(path.split('/').at(-1)!);
        if (String(url).endsWith('/v1/machines/managed/controller/policies')) {
            if (censusUnavailable) return { status: 503, data: { error: 'temporarily_unavailable' } };
            try {
                const response = await actualPost(url, data, config);
                if (response.status < 200 || response.status >= 300) {
                    recordCensusFailure(response.status, response.data, config?.headers?.Authorization);
                }
                return response;
            }
            catch (error) {
                recordCensusFailure(axios.isAxiosError(error) ? error.response?.status ?? null : null,
                    axios.isAxiosError(error) ? error.response?.data : null, config?.headers?.Authorization);
                throw error;
            }
        }
        return actualPost(url, data, config);
    });
    try {
        if (accountOwned) {
            expect(controller.id).not.toBe(guest.id);
            expect(managed.controllerMachineId).toBeNull();
            expect(managed.wakeOnAcceptedMessage).toBe(true);
            const census = await readCensus();
            expect(census.machines).toMatchObject([{ id: managed.id, enrolledMachineId: guest.id }]);
            expect(census.targets).toMatchObject([{ managedId: managed.id, enrolledMachineId: guest.id }]);
            const controllerBinding = { machineId: controller.id, installationId: controller.installationId! };
            const invalidProof = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/policies',
                headers: { authorization: `Bearer ${token}` }, payload: { homeId, controller: controllerBinding,
                    proof: createManagedPolicyCensusProofV1({ homeId, controller: controllerBinding,
                        custodianAccountId: custodian.id, privateKey: nacl.sign.keyPair().secretKey }) } });
            expect(invalidProof.statusCode).toBe(403);
            expect(invalidProof.json()).not.toHaveProperty('machines');
            expect(invalidProof.json()).not.toHaveProperty('targets');
            const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
            const strangerKeys = nacl.sign.keyPair();
            const strangerDaemon = await db.machine.create({ data: { id: randomUUID(), accountId: stranger.id,
                installationId: randomUUID(), installationPublicKey: strangerKeys.publicKey, metadata: 'fixture', active: true } });
            const strangerToken = await auth.createToken(stranger.id, undefined, { kind: 'account', authority: 'present_user' });
            expect(await readManagedMachinePolicyCensus({ homeId, controller: {
                machineId: strangerDaemon.id, installationId: strangerDaemon.installationId!,
            }, custodianAccountId: stranger.id, privateKey: strangerKeys.secretKey, token: strangerToken, serverUrl }))
                .toMatchObject({ machines: [], targets: [] });
            await db.managedMachine.update({ where: { id: managed.id }, data: { wakeOnAcceptedMessage: false } });
            expect(await readCensus()).toMatchObject({ machines: [], targets: [] });
            await db.managedMachine.update({ where: { id: managed.id }, data: { wakeOnAcceptedMessage: true } });
            const readManagedPublications = () => db.accountChange.findMany({
                where: { accountId: custodian.id, kind: 'account', entityId: managed.id }, orderBy: { cursor: 'asc' },
            });
            const beforeWakePublications = await readManagedPublications();
            runtime.notifyChanged();
            let artifactId = '';
            await expect.poll(async () => {
                if (policyError) throw policyError;
                if (policyResult && !policyResult.ok) throw new Error(`Policy refused before Ask: ${JSON.stringify({
                    code: policyResult.errorCode, policyOwnerFailure, installedActionAdmissions, policyPaths })}`);
                const approvals = await readPowerApprovals(custodian.id, async id => {
                    const response = await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`,
                        headers: { authorization: `Bearer ${token}` } });
                    expect(response.statusCode, response.body).toBe(200);
                    return response.json().body;
                });
                artifactId = approvals.find(approval => approval.liveWaiters === 1)?.id ?? '';
                return { approvals, policyPaths };
            }, { timeout: 10_000 }).toMatchObject({ approvals: expect.arrayContaining([expect.objectContaining({ status: 'open', liveWaiters: 1 })]) });
            expect(effects).toEqual([]);
            expect(policyPaths).toEqual(['prepare-policy']);
            expect(installedExecutor).toBeDefined();
            const decision = await installedExecutor!.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
                surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: custodian.id,
            });
            expect(decision).toMatchObject({ ok: true });
            await expect.poll(() => {
                if (policyError) throw policyError;
                if (policyResult && !policyResult.ok) throw new Error(`Policy refused after Ask: ${JSON.stringify({
                    code: policyResult.errorCode, policyOwnerFailure, installedActionAdmissions, policyPaths,
                    effects, inspections: inspections.mock.calls.length })}`);
                return policyResult;
            }, { timeout: 10_000 }).toMatchObject({ ok: true });
            // The fresh vendor observation is already running, so the wake
            // owner skips redundant power and asks for its bootstrap carrier.
            expect(effects).toEqual(['bootstrap']);
            expect(installedActionAdmissions).toBe(1);
            expect(inspections).toHaveBeenCalledOnce();
            expect(policyPaths).toEqual(['prepare-policy', 'admit-policy', 'submit-intent', 'report-intent']);
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: managed.id } })).toMatchObject({
                controllerMachineId: null, desired: 'start', observation: { power: 'running' } });
            expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } })).toMatchObject([
                { localId: input.localId, status: 'queued' },
            ]);
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
                pendingActivationStatus: 'waiting', pendingActivationRequestId: input.localId,
            });
            expect(await db.artifact.count({ where: { accountId: custodian.id } })).toBe(1);
            const settledPublications = await readManagedPublications();
            expect(settledPublications).not.toEqual(beforeWakePublications);
            await runtime.notifyChanged();
            expect(effects).toEqual(['bootstrap']);
            expect(inspections).toHaveBeenCalledOnce();
            expect(installedActionAdmissions).toBe(1);
            expect(policyPaths).toEqual(['prepare-policy', 'admit-policy', 'submit-intent', 'report-intent']);
            expect(await readManagedPublications()).toEqual(settledPublications);
            return;
        }
        runtime.notifyChanged();
        let artifactId = '';
        // Real Artifact persistence and the shared coordinator decide readiness.
        await expect.poll(async () => {
            if (policyResult || policyError) throw new Error(`Policy settled before Ask: ${JSON.stringify({ policyResult,
                policyError: policyError instanceof Error ? policyError.message : policyError, censusFailures,
                policyOwnerFailure, installedActionAdmissions, policyPaths })}`);
            const approvals = await readPowerApprovals(custodian.id, async id => {
                const response = await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`,
                    headers: { authorization: `Bearer ${token}` } });
                expect(response.statusCode, response.body).toBe(200);
                return response.json().body;
            });
            artifactId = approvals.find(approval => approval.liveWaiters === 1)?.id ?? '';
            return { approvals, policyPaths };
        }, { timeout: 10_000 }).toMatchObject({ approvals: expect.arrayContaining([expect.objectContaining({ status: 'open', liveWaiters: 1 })]) });
        if (reconnected) {
            // Native resume and daemon reconnect are the external boundary.
            // Home itself now withdraws compute demand while the admitted
            // input still owns an independent Session activation request.
            await db.managedMachine.update({ where: { id: managed.id }, data: {
                observation: { observedAt: Date.now(), availability: 'present', power: 'running', storage: 'retained' },
            } });
            await db.machine.update({ where: { id: guest.id }, data: { active: true, lastActiveAt: new Date() } });
            expect((await readCensus()).targets).toEqual([]);
            runtime.notifyChanged();
            await expect.poll(() => policyResult).toMatchObject({ ok: false, errorCode: 'cancelled' });
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
                pendingActivationStatus: 'waiting', pendingActivationRequestId: input.localId,
                pendingActivationRequestedAt: before.pendingActivationRequestedAt,
            });
            expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } }))
                .toMatchObject([{ localId: input.localId, status: 'queued' }]);
            expect(policyPaths).not.toContain('activation-failed');
            expect(effects).toEqual([]);
            return;
        }
        const report = await runWithServerHttpBaseUrl(serverUrl, () => activatePendingInactiveSession({
            credentials: { token: ownerToken, encryption: null }, machineId: guest.id, sessionId: session.id,
            requestId: input.localId, pendingVersion: before.pendingVersion,
            spawnSessionForInternalResume: async () => { throw new Error('Missing resume metadata must not spawn'); },
        }));
        expect(report).toEqual({ status: 'not-needed', reason: 'authorization-stale' });
        const failureRecords = serverLog.mock.calls.map(([entry]) => entry).filter(entry => entry && typeof entry === 'object'
            && 'event' in entry && entry.event === 'pending.activation_failure_report');
        expect(failureRecords).toEqual([{ module: 'pending-activation', event: 'pending.activation_failure_report',
            route: '/v2/sessions/:sessionId/pending/activation/fail', failureCode: 'runtime_start_failed',
            callerMachineId: null, callerInstallationId: null, sessionId: session.id, pendingId: input.localId,
            requestedAt: before.pendingActivationRequestedAt!.getTime() }]);
        runtime.notifyChanged();
        expect((await readCensus()).targets).toMatchObject([{ managedId: managed.id }]);
        expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId)).toBe(1);
        expect(getSharedBlockingApprovalCoordinator().getDetachedWaiterCount(artifactId)).toBe(0);
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
            pendingActivationStatus: 'waiting', pendingActivationRequestedAt: before.pendingActivationRequestedAt });
        expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } })).toMatchObject([{ localId: input.localId, status: 'queued' }]);
        expect(effects).toEqual([]);
        const ask = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifactId}`, headers: { authorization: `Bearer ${token}` } });
        expect(ask.statusCode, ask.body).toBe(200);
        const stored = decodePlainArtifactStoredContent(ask.json().body);
        expect(StoredApprovalRequestSchema.parse(JSON.parse(String(stored && typeof stored === 'object' ? Reflect.get(stored, 'body') : null))))
            .toMatchObject({ status: 'open', actionId: 'machines.managed.power.set', actionArgs: { intent: 'start' } });
        // A failed census observes no new authority facts. It must not turn
        // an open Ask into a managed failure through scheduler cancellation.
        censusUnavailable = true;
        runtime.notifyChanged();
        await expect.poll(() => policyError).toBeTruthy();
        expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId)).toBe(1);
        expect(getSharedBlockingApprovalCoordinator().getDetachedWaiterCount(artifactId)).toBe(0);
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ pendingActivationStatus: 'waiting' });
        censusUnavailable = false;
        // Explicit withdrawal, unlike the rejected competing report, removes
        // this origin from census and retires this exact waiter.
        expect(await updatePendingRequestedAction({ ...input, resumeWhenAvailable: false })).toMatchObject({ ok: true });
        runtime.notifyChanged();
        await expect.poll(() => getSharedBlockingApprovalCoordinator().getDetachedWaiterCount(artifactId)).toBe(1);
        expect(daemonLog).toHaveBeenCalledWith('[managed-policy.operation-abort]', { managedId: managed.id, operationId,
            reasonCode: 'policy_scheduler_aborted' });
    } finally {
        await operations.handlers.cancel({ operationId });
        await runtime.stop();
        await sockets.close();
        await guestClient?.shutdown();
        serverLog.mockRestore(); daemonLog.mockRestore();
        post.mockRestore();
        await actionSocket?.close();
        restore(); await app.close();
    }
}), 30_000);


it('delivers a stored-credential finite CLI entry through real Home admission without controller inventory', async () =>
    await withConfiguredDaemonTestHome({ prefix: 'finite-controller-admission-' }, async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const homeId = await getOrCreateServerIdentityId();
        const signing = nacl.sign.keyPair();
        const machine = (active: boolean) => db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            installationId: randomUUID(), installationPublicKey: signing.publicKey, active,
            operationProtocolCapabilities: CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1, operationProtocolCapabilitiesRevision: 1,
            metadata: encodePlainMachineStoredContent({ host: 'wake', platform: 'linux', happyCliVersion: 'test', homeDir: '/tmp' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        // Finite custody is admitted independently of the guest presence projection.
        // The controller's absent requester grant is the deciding condition here.
        const controller = await machine(true), guest = await machine(true);
        await db.managedMachine.create({ data: { homeId, custodianAccountId: owner.id,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId!,
            admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Finite', choices: {} },
            resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            enrolledMachineId: guest.id, desired: 'stop', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
            observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' } } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        await writeStoredCredentialsForServerId(configuration.activeServerId, { token, encryption: null });
        const credentials = await readStoredCredentialsForServerId(configuration.activeServerId);
        if (!credentials) throw new Error('Expected stored credentials');
        const serverUrl = 'https://finite-admission.example';
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        machinesRoutes(app); registerAccountEncryptionRoutes(app); registerAccountSecurityRoutes(app); featuresRoutes(app);
        registerAccountProfileRoute(app); registerAccountSettingsRoutes(app);
        let delivered = false;
        registerExternalActionRoutes(app, { dispatch: async request => {
            const authorization = request.executionAuthorization;
            const wake = authorization?.managedFiniteWake;
            expect(wake?.target.controller).toEqual({ machineId: controller.id, installationId: controller.installationId });
            if (!authorization || !wake) throw new Error('Expected Home-admitted finite controller');
            expect(openExternalActionRequesterAccountContextV1({ authorization, serverIdentityId: homeId,
                machineId: controller.id, installationId: controller.installationId!, installationPrivateKey: signing.secretKey,
                purpose: { kind: 'managed_finite_wake', target: wake.target } })).toMatchObject({ token });
            delivered = true;
            // Guest execution is the external boundary; no real compute is started.
            return { kind: 'placement_error', code: 'action_not_admitted' };
        } });
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
        const actualGet = axios.get;
        let controllerReads = 0;
        const inventory = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            if (new URL(String(url), serverUrl).pathname === `/v1/machines/${controller.id}`) {
                controllerReads++;
                throw new Error('Requester inventory has no controller grant');
            }
            return actualGet(url, config);
        });
        try {
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId: configuration.activeServerId, serverIdentityId: homeId, serverApiUrl: serverUrl,
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const result = await executor.execute('session.spawn_new', SessionSpawnNewInputV2Schema.parse({
                creationKey: 'finite-admission', executionTarget: { serverId: configuration.activeServerId, machineId: guest.id },
                directory: { kind: 'path', path: '/tmp' }, permissionMode: 'read-only',
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            }), { surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'session.spawn_new' }, actionRequestId: randomUUID() });
            expect(delivered, JSON.stringify({ result, controllerReads })).toBe(true);
            expect(controllerReads).toBe(0);
        } finally { inventory.mockRestore(); restore(); await app.close(); }
    }));
