import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import axios from 'axios';
import { AccountSettingsSchema, MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent, type ActionExecuteResult } from '@happier-dev/protocol';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { auth } from '../../../../server/sources/app/auth/auth';
import { setMachineAccessGrantInTx } from '../../../../server/sources/app/machines/machineAccess';
import { createSessionMachineAccessKeyInTx } from '../../../../server/sources/app/accessKeys/sessionMachineAccessKeyMutations';
import { enqueuePendingMessage, updatePendingRequestedAction } from '../../../../server/sources/app/session/pending/pendingMessageService';
import { createPresentUserSessionAccessAuthentication } from '../../../../server/sources/app/session/access/sessionAccessAuthentication.testkit';
import { getOrCreateServerIdentityId } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { sessionPendingRoutes } from '../../../../server/sources/app/api/routes/session/pendingRoutes';
import { registerSessionListingRoutes } from '../../../../server/sources/app/api/routes/session/registerSessionListingRoutes';
import { artifactsRoutes } from '../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { registerAccountEncryptionRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerAccountSecurityRoutes } from '../../../../server/sources/app/api/routes/auth/registerAccountSecurityRoutes';
import { registerManagedMachineRoutes } from '../../../../server/sources/app/machines/managed/managedRoutes';
import { machinesRoutes } from '../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { createReleaseLessDeclarationV1 } from '../../../../server/sources/app/plugins/availability/currentDeclaration';
import { logger as serverLogger } from '../../../../server/sources/utils/logging/log';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { configuration } from '@/configuration';
import { ApiClient } from '@/api/api';
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

let database: LightSqliteHarness;
beforeAll(async () => {
    database = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-wake-approval-', initAuth: true, initEncrypt: true,
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
}, 120_000);
afterAll(async () => { resetActiveAccountSettingsSnapshotForTests(); if (database) await database.close(); });

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

it('keeps the real fire-time Ask and original input waiting when a competing runtime failure arrives before compute starts', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
    const homeId = await getOrCreateServerIdentityId();
    const signing = nacl.sign.keyPair();
    const machine = (active: boolean) => db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
        installationId: randomUUID(), active, installationPublicKey: signing.publicKey,
        metadata: encodePlainMachineStoredContent({ host: 'wake-fixture', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/wake', happyHomeDir: '/home/wake/.happier' }),
        dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } } } });
    const controller = await machine(true), guest = await machine(false);
    for (const target of [controller, guest]) await inTx(tx => setMachineAccessGrantInTx(tx, {
        actorAccountId: custodian.id, machineId: target.id, principal: { kind: 'account', accountId: owner.id }, level: 'admin' }));
    const effects: string[] = [];
    const native = nativeFixture({ privateNative: true, supportedIntents: ['start', 'delete'], onNativeRole: role => { effects.push(role); } });
    const manifest = native.runtimeRegistry.contributes.activationTargets[0]!.manifest;
    const declaration = createReleaseLessDeclarationV1(manifest);
    await db.machine.update({ where: { id: controller.id }, data: { pluginMaterializationRevision: BigInt(1) } });
    await db.accountPluginIntent.create({ data: { accountId: custodian.id, pluginId: manifest.id, enabled: true,
        writableCollections: [], releaseLessDeclaration: declaration } });
    await db.pluginMachineMaterialization.create({ data: { accountId: custodian.id, serverIdentityId: homeId,
        machineId: controller.id, materializationId: controller.installationId!, pluginId: manifest.id,
        version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false,
        archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true,
        trustState: 'trusted', observedAt: new Date() } });
    const managed = await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
        controllerMachineId: controller.id, controllerInstallationId: controller.installationId!, enrolledMachineId: guest.id,
        admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
        launch: { provider: { pluginId: manifest.id, localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        resource: { contributionRef: { pluginId: manifest.id, localId: 'vm' }, schemaVersion: 1, value: {} },
        desired: 'stop', retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true,
        observation: { observedAt: 1, availability: 'present', power: 'stopped' } } });
    const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', active: false } });
    expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: owner.id, sessionId: session.id,
        machineId: guest.id, data: 'fixture-encrypted-key' }))).toMatchObject({ ok: true });
    const input = { actorUserId: owner.id, authentication: createPresentUserSessionAccessAuthentication(), sessionId: session.id,
        localId: randomUUID(), targetMachineId: guest.id, requestedAction: { v: 1, kind: 'enqueue' },
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'original queued input' } } } } as const;
    expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
    const token = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
    const serverUrl = 'https://wake-home.example';
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [configuration.activeServerId]: {
        id: configuration.activeServerId, name: 'Wake Home', serverUrl, webappUrl: serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } } } }));
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    sessionPendingRoutes(app); registerManagedMachineRoutes(app); registerAccountEncryptionRoutes(app); artifactsRoutes(app);
    registerSessionListingRoutes(app);
    registerAccountSecurityRoutes(app);
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
    // Process when online enters through the same Action and real HTTP PATCH
    // as the client, rather than arming the authorization inside the fixture.
    const processWhenOnline = await runWithServerHttpBaseUrl(serverUrl, () => createActionExecutor(createCliActionDeps({
        token: ownerToken, credentials: { token: ownerToken, encryption: null }, sessionId: session.id, mode: 'plain', ctx: null,
    })).execute('session.pending.action.set', {
        sessionId: session.id, localId: input.localId, requestedAction: input.requestedAction, resumeWhenAvailable: true,
    }, { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'session.pending.action.set' } }));
    expect(processWhenOnline).toMatchObject({ ok: true, result: { didUpdate: true } });
    const before = await db.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(before).toMatchObject({ pendingActivationStatus: 'waiting', pendingActivationRequestId: input.localId });
    const sockets = await createRequesterCurrentnessSocketHarness();
    const unavailable = async (): Promise<never> => { throw new Error('No provider credentials required before Ask'); };
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
        purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
            projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable }),
        requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
        createRedactionLease: () => ({ add() {}, close() {} }) });
    const operationId = randomUUID();
    const operations = createHostActionOperationRuntime({ machineId: controller.id, resolveAccountId: async () => custodian.id,
        generateOperationId: () => operationId });
    const adapter = createDaemonManagedMachineActionAdapter({ credentials, machineId: controller.id, serverBaseUrl: serverUrl,
        serverId: configuration.activeServerId, installationIdentity: { installationId: controller.installationId!, privateKey: signing.secretKey },
        managedProviderOperationAuthority: authority,
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: controller.id }),
        acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
        observeActionExecution: request => operations.observeExecution(request),
        executeManagedPolicyAction: (current, context, runApproved, purpose) => executeManagedMachinePolicyAction({ machine: current, purpose, context,
            runApproved, serverId: configuration.activeServerId, createExecutor: overrides => createCliActionExecutorFromCredentials({
                credentials, serverId: configuration.activeServerId, serverApiUrl: serverUrl, serverIdentityId: homeId,
                machineId: controller.id, readCredentials: async () => credentials, ...overrides }) }) });
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
    let censusUnavailable = false;
    const post = vi.spyOn(axios, 'post').mockImplementation((url, data, config) => censusUnavailable
        && String(url).endsWith('/v1/machines/managed/controller/policies')
        ? Promise.resolve({ status: 503, data: { error: 'temporarily_unavailable' } }) : actualPost(url, data, config));
    try {
        runtime.notifyChanged();
        let artifactId = '';
        // Real Artifact persistence and the shared coordinator decide readiness.
        await expect.poll(async () => {
            if (policyResult || policyError) throw new Error(`Policy settled before Ask: ${JSON.stringify({ policyResult,
                policyError: policyError instanceof Error ? policyError.message : policyError })}`);
            const artifacts = await db.artifact.findMany({ where: { accountId: custodian.id } });
            artifactId = artifacts[0]?.id ?? '';
            return artifactId ? getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId) : 0;
        }, { timeout: 10_000 }).toBe(1);
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
        expect(daemonLog).toHaveBeenCalledWith('[managed-policy.abort]', { managedId: managed.id, reasonCode: 'retention_satisfied' });
        expect(daemonLog).toHaveBeenCalledWith('[managed-policy.operation-abort]', { managedId: managed.id, operationId,
            reasonCode: 'policy_scheduler_aborted' });
    } finally {
        await operations.handlers.cancel({ operationId });
        await runtime.stop();
        await sockets.close();
        serverLog.mockRestore(); daemonLog.mockRestore();
        post.mockRestore();
        restore(); await app.close();
    }
}, 30_000);
