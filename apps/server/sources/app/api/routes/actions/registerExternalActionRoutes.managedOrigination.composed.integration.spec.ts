import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Server } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    MACHINE_PLAIN_DATA_KEY_MARKER, ARTIFACT_PLAIN_DATA_KEY_MARKER, PluginManifestV2Schema, encodePlainMachineStoredContent, encodePlainArtifactStoredContent,
    MachineOperationProtocolCapabilitiesV1Schema, signAccountContentKeyBindingV1,
} from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionDaemonDispatchRequestSchema, createExternalActionDaemonDispatchResponseV1, createExternalActionDaemonDispatchResponse,
    prepareExternalActionResponseEnvelopeV1, prepareExternalActionResponseV2, openExternalActionRequestV2, openExternalActionResponseV2, sealExternalActionRequestV2,
    computeActionInputApprovalDigestV1, computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { ManagedAcquireInputV1Schema, ManagedAdmissionOutputV1Schema, ManagedControlAdmissionInputV1Schema, ManagedControllerSubmitOutputV1Schema, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ActionsSettingsV1Schema, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import type { ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import {
    defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema,
    MachineProvisionerPowerResultV1Schema, MachineProvisionerResizeResultV1Schema,
} from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { createExternalActionDaemonDispatcher, type ExternalActionForwardRpcCall } from '@/app/api/socket/externalActionDispatcher';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '@/app/api/socket/machineSocketInstallationProof';
import { auth } from '@/app/auth/auth';
import { verifyCurrentExternalActionPrincipal } from '@/app/auth/externalActionExecutionAuthorization';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { resolveMachineAccess } from '@/app/machines/machineAccess';
import { createMachinePreset } from '@/app/machines/managed/machinePresetService';
import { db, initDbPostgres } from '@/storage/db';
import { createDbMaintenanceClient } from '@/storage/prisma';
import { readDatabaseTransactionConfigFromEnv } from '@/config/databaseTransactions';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { deriveAccountEncryptionCurrentnessFromRow } from '@/app/encryption/accountContentKeyAdmission';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { handleActionsCommand } from '../../../../../../cli/src/cli/commands/actions';
import { createCliActionExecutorFromCredentials } from '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionExecutor } from '../../../../../../cli/src/session/actions/createCliActionExecutor';
import { executeExternalAction } from '../../../../../../cli/src/daemon/externalActions/executeExternalAction';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '../../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { installAxiosFastifyAdapter } from '../../../../../../cli/src/testkit/http/axiosAdapter';
import { accountSettingsParse, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { ApprovalRequestV2Schema, resolveApprovalExecutor } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createCliApprovalsArtifactStore } from '../../../../../../cli/src/session/actions/approvals/artifactStore';
import { runWithServerHttpBaseUrl } from '../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '../../../../../../cli/src/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '../../../../../../cli/src/settings/accountSettings/accountSettingsScopeKey';
import { createAccountServerActionDeps } from '../../../../../../cli/src/api/accountServerActionDeps';
import { createActionExecutor, type ActionExecuteResult, type ActionExecutorDeps } from '@happier-dev/protocol';
import { seedBundledManagedAvailability } from '@/app/machines/managed/managedProjectionVolume.testkit';
import { managedQb56Input, managedQb56RequestId } from './managedQb56Input.testkit';
import { snapshotEnv, restoreEnv } from '@/testkit/env';
import { admitManagedAcquire } from '@/app/machines/managed/managedAcquire';
import { createManagedMachineControllerClient, type ManagedMachineAcquisitionDriverInput } from '../../../../../../cli/src/machines/managed/acquire';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { prepareRequesterAccountActionContext } from '../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { registerAccountProfileRoute } from '../account/registerAccountProfileRoute';
import { registerAccountEncryptionRoutes } from '../account/registerAccountEncryptionRoutes';
import { createRequesterCurrentnessSocketHarness } from '../../../../../../cli/src/testkit/backends/requesterCurrentnessSocketHarness';
import { artifactsRoutes } from '../artifacts/artifactsRoutes';
import { initEncrypt } from '@/modules/encrypt';
import { dispatchOriginalAccountAction, dispatchLocalManagedMachineAgentIsolation, verifyExternalActionExecutionAuthorizationCurrent, createExternalActionAuthorizedRequestHeaders } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { sealManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import * as daemonPublication from '../../../../../../cli/src/daemon/multiDaemon';
import { createDaemonControlApp } from '../../../../../../cli/src/daemon/controlServer';
import { resolveManagedControlControllerTarget } from '../../../../../../cli/src/daemon/externalActions/reconcileExternalActionTarget';
import { registerPluginAvailabilityRoutes } from '@/app/plugins/availability/routes';
import { buildAuthoredAccountActionRelease } from '../../../../../../cli/src/plugins/runtime/accountPluginActions.testkit';
import { encodePluginUiArtifactArchiveBodyV1 } from '@happier-dev/protocol/plugins/ui';
import type { RequesterAccountActionContext } from '../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionContext';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { DEVCONTAINER_PLUGIN } from '@happier-dev/plugins-devcontainer';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { createDaemonManagedMachineActionAdapter } from '../../../../../../cli/src/daemon/startup/managedMachineActionAdapter';
import { readSettings, updateSettings } from '../../../../../../cli/src/persistence';
import { configuration } from '../../../../../../cli/src/configuration';
import { normalizePluginManifestV2 } from '../../../../../../cli/src/plugins/manifest/normalize';
import { activateContributionModule } from '../../../../../../cli/src/plugins/runtime/lifecycle/activation/activateContributionModule';
import { createPluginRuntimeOccurrenceId } from '../../../../../../cli/src/plugins/runtime/runtimeSlots';
import { fixture as nativeCustodyFixture } from '../../../../../../cli/src/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createPluginInvocationServiceBinding, createPluginInvocationServicesFactory } from '../../../../../../cli/src/plugins/runtime/invocation/services/factory';
import { createTargetActionHostBindingResolver } from '../../../../../../cli/src/plugins/runtime/hostAccess/resolve';
import { createUnavailableManagedServices } from '../../../../../../cli/src/plugins/runtime/invocation/services/managedServicesAdapter';
import { createManagedServicesOwner } from '../../../../../../cli/src/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '../../../../../../cli/src/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createEnrollmentJourneyProviderAuthority } from '../../../../../../cli/src/machines/managed/enrollmentJourney.testkit';
import { createHostActionOperationRuntime } from '../../../../../../cli/src/daemon/actionOperations/createHostActionOperationRuntime';

const nativeVendor = vi.hoisted(() => ({ request: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>() }));
// test-policy-boundary: only the provider's third-party HTTP transport is substituted.
vi.mock('undici', async importOriginal => {
    const original = await importOriginal<typeof import('undici')>();
    return { ...original, fetch: (url: string, init?: RequestInit) => new URL(String(url)).origin === 'https://native-provider.test'
        ? nativeVendor.request(String(url), init) : original.fetch(url, init) };
});

describe('composed CLI managed Action origination', () => {
    const homeId = managedQb56Input.selection.homeId;
    const capabilities = MachineOperationProtocolCapabilitiesV1Schema.parse({ externalActionExecutionAuthorization: { protocolVersions: [1] } });
    let harness: LightSqliteHarness;
    const initialEnv = snapshotEnv();
    beforeAll(async () => {
        const cliRoot = resolve(import.meta.dirname, '../../../../../../cli');
        nativeRelease = await buildAuthoredAccountActionRelease({ manifest: fixtureManifests.native,
            artifactId: 'portable', accountArtifactId: crypto.randomUUID(), manifestExport: null,
            activateExport: 'activate', archiveDigestCharacter: 'a', source: { manifest: fixtureManifests.native,
                projectRoot: cliRoot, entryPath: join(cliRoot, 'src/testkit/machines/nativeAccountControlPlugin.testkit.ts') } });
        Object.assign(process.env, { HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__ENABLED: 'true',
            HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: String(16 * 1024 * 1024),
            HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: String(256 * 1024 * 1024) });
        if (process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            if (process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error('Use only the disposable PostgreSQL DB-contract harness');
            }
            Object.assign(process.env, { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' });
            process.env.HANDY_MASTER_SECRET = crypto.randomUUID();
            initDbPostgres();
            await db.$connect();
            await auth.init();
            await initEncrypt();
            return;
        }
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-origination-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
    }, 120_000);
    afterAll(async () => {
        try { if (harness) await harness.close(); else await db.$disconnect(); }
        finally { restoreEnv(initialEnv); }
    });

    function createFixtureManifest(nativeControls: boolean) {
        const launch = defineProtocolObject({ image: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const native = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const roles = defineMachineProvisionerSchemas({ launch, resource: native });
        const actions = [
            { id: 'check', inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
            { id: 'acquire', inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
            { id: 'bootstrap', inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
            { id: 'inspect', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
            { id: 'power', inputSchema: roles.powerInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
            ...(nativeControls ? [{ id: 'resize', inputSchema: roles.resizeInput.jsonSchema, resultSchema: MachineProvisionerResizeResultV1Schema.jsonSchema }] : []),
            { id: 'destroy', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        ];
        return PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'fixture.origination', version: '1.0.0',
            displayName: 'Compute', description: 'Managed origination fixture', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
            ...(nativeControls ? { hostAccess: { required: [{ id: 'native-provider', capability: 'network',
                reason: 'Control the retained native provider resource.', scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://native-provider.test' }],
                    methods: ['POST'] } }], optional: [] } } : {}), contributes: {
                machineProvisioners: [{ id: 'compute', title: 'Compute', icon: 'machine', resourceKind: 'VM', schemaVersion: 1,
                    launchSchema: launch.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
                    billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
                    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy', ...(nativeControls ? { resize: 'resize' } : {}) },
                    ...(nativeControls ? { resize: { cpuCores: { kind: 'supported', requiresRestart: false, changes: 'any' },
                        memoryBytes: { kind: 'unsupported', code: 'unsupported' }, diskBytes: { kind: 'unsupported', code: 'unsupported' } } } : {}) }],
                actions: actions.map(action => ({ ...action, title: action.id, execution: nativeControls
                    ? { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } : { target: 'daemon' },
                    surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe', ...(nativeControls ? { hostAccess: ['native-provider'] } : {}) })),
            } });
    }
    // Parse every declaration at collection before the database and public CLI factory are started.
    const fixtureManifests = { daemon: createFixtureManifest(false), native: createFixtureManifest(true) };
    let nativeRelease: Awaited<ReturnType<typeof buildAuthoredAccountActionRelease>>;

    async function fixture(online: boolean, mode: 'plain' | 'e2ee' = 'plain', qb56 = false, nativeControls = false) {
        const signing = mode === 'e2ee' ? tweetnacl.sign.keyPair() : null;
        const content = signing ? tweetnacl.box.keyPair() : null;
        const account = await db.account.create({ data: { encryptionMode: mode,
            publicKey: signing ? Buffer.from(signing.publicKey).toString('hex') : null,
            ...(signing && content ? { contentPublicKey: new Uint8Array(content.publicKey),
                contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey,
                    contentPublicKey: content.publicKey }) } : {}) } });
        expect(deriveAccountEncryptionCurrentnessFromRow(account),
            'Fixture must satisfy the real Account-mode/content-key admission before Session creation')
            .toMatchObject({ status: 'ready', currentness: { encryptionMode: mode } });
        const keys = tweetnacl.sign.keyPair();
        const controller = qb56 ? managedQb56Input.selection.controller
            : { machineId: crypto.randomUUID(), installationId: crypto.randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id,
            metadata: mode === 'e2ee' ? 'retained-machine-ciphertext' : encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: mode === 'e2ee' ? null : decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: controller.installationId, installationPublicKey: new Uint8Array(keys.publicKey),
            active: online, pluginMaterializationRevision: BigInt(1),
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: capabilities } });
        expect(await resolveMachineAccess({ actorAccountId: account.id, machineId: controller.machineId }),
            'Origination fixture must be ready before online placement under the real Machine-mode owner').toMatchObject({
            owned: true, role: 'manage', encryptionMode: mode, accessState: 'ready', installationId: controller.installationId,
        });
        if (qb56) {
            await seedBundledManagedAvailability(account.id, homeId, controller);
            const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
            return { account, controller, keys, token, input: managedQb56Input, requestId: managedQb56RequestId };
        }
        const manifest = nativeControls ? fixtureManifests.native : fixtureManifests.daemon;
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: manifest.id, enabled: true,
            writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: homeId,
            machineId: controller.machineId, materializationId: controller.installationId, pluginId: manifest.id,
            version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false,
            archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true,
            trustState: 'trusted', observedAt: new Date() } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const input = { enrollmentIdentity: { kind: 'guestProcess' as const, role: 'sandbox' as const }, selection: { kind: 'one-off' as const, homeId, controller,
            launch: { provider: { pluginId: manifest.id, localId: 'compute' }, schemaVersion: 1, name: 'Reviewed', choices: { image: 'linux' } },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
        return { account, controller, keys, token, input, manifest, requestId: crypto.randomUUID() };
    }

    async function app(forwardRpc: ExternalActionForwardRpcCall, configureHttp: (instance: AppFastify) => void,
        phases: Array<{ phase: string; elapsedMs: number; status?: number }>) {
        const instance = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        instance.setValidatorCompiler(validatorCompiler);
        instance.setSerializerCompiler(serializerCompiler);
        const starts = new WeakMap<object, number>();
        instance.addHook('onRequest', async request => { starts.set(request, performance.now()); });
        instance.addHook('onResponse', async (request, reply) => {
            phases.push({ phase: `${request.method} ${request.routeOptions.url}`, status: reply.statusCode,
                elapsedMs: performance.now() - (starts.get(request) ?? performance.now()) });
        });
        enableAuthentication(instance);
        // Only socket delivery is substituted; routes, admission, auth and dispatch stay real.
        registerExternalActionRoutes(instance, { dispatch: createExternalActionDaemonDispatcher({ io: {} as Server, forwardRpc }) });
        machinesRoutes(instance);
        configureHttp(instance);
        await instance.ready();
        return instance;
    }

    it.each([['power', 'missing'], ['resize', 'missing'], ['power', 'signed'], ['resize', 'signed'],
        ['power', 'account'], ['resize', 'account'], ['power', 'explicit'], ['resize', 'explicit'],
        ['power', 'unreachable'], ['resize', 'unreachable'], ['deferred', 'missing']] as const)(
        'roots terminal Account-native %s before effects (signer=%s)', async (control, signer) => {
        const selected = await fixture(true, 'plain', false, true);
        if (!('manifest' in selected) || !selected.manifest) throw new Error('Expected native fixture');
        // Real author compilation, release projection and Home storage back the portable provider.
        const nativeReleaseFacts = nativeRelease.release;
        const release = await db.accountPluginRelease.create({ data: { accountId: selected.account.id, pluginId: selected.manifest.id,
            version: nativeReleaseFacts.ref.version, archiveDigestSha256: nativeReleaseFacts.archiveDigestSha256,
            normalizedManifest: nativeReleaseFacts.normalizedManifest, collectionContracts: nativeReleaseFacts.collectionContracts,
            uiSlots: nativeReleaseFacts.uiSlots, packageAssetArchive: nativeReleaseFacts.packageAssetArchive } });
        // Account execution consumes the canonical web slot of the portable artifact.
        for (const slot of nativeReleaseFacts.uiSlots.filter(slot => slot.platform === 'web')) {
            const hosted = nativeRelease.hostedArtifacts.find(hosted => hosted.graphArtifactId === slot.artifactId);
            if (!hosted) throw new Error('Expected compiled Account artifact');
            const artifactId = crypto.randomUUID();
            await db.artifact.create({ data: { id: artifactId, accountId: selected.account.id,
                header: decodeBase64(encodePlainArtifactStoredContent(hosted.archive.header), 'base64'),
                body: decodeBase64(encodePlainArtifactStoredContent({ body: encodePluginUiArtifactArchiveBodyV1(hosted.archive.body) }), 'base64'),
                dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64') } });
            await db.accountPluginUiArtifact.create({ data: { releaseId: release.id, contributionId: slot.contributionId,
                tier: slot.tier, platform: slot.platform, artifactId, artifactDigest: slot.artifactDigest,
                compatibility: { hostUiApiRange: slot.hostUiApiRange } } });
        }
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: selected.account.id, pluginId: selected.manifest.id } },
            data: { desiredVersion: selected.manifest.version, offlineUiHosting: 'enabled', releaseLessDeclaration: null } });
        const accountCredentials = { token: selected.token, encryption: null, credentialProvenance: 'stored_session' as const };
        const terminalCredentials = { ...accountCredentials, token: await auth.createToken(selected.account.id, undefined,
            { kind: 'terminal', authority: 'account_automation' }) };
        const provisioner = selected.manifest.contributes.machineProvisioners[0]!;
        const launch = selected.input.selection.launch;
        const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: selected.account.id,
            metadata: encodePlainMachineStoredContent({ host: 'retained-guest', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: selected.account.id,
            enrolledMachineId: guest.id, admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            desired: 'stop', desiredWhen: 'now', intentRevision: 1, launch,
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'native-resource' } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained', size: { cpuCores: 1 } } } });
        const actionId = control === 'resize' ? 'machines.managed.resize' : 'machines.managed.power.set';
        const input = control !== 'resize' ? { homeId, managedId: row.id, ...(control === 'deferred' ? { when: 'after-idle' } : { expectedRevision: 1, when: 'now' }), intent: 'stop' }
            : { homeId, managedId: row.id, size: { cpuCores: 2 } };
        const serverUrl = 'http://native-root-composed.test';
        const settings = (['machines.managed.power.set', 'machines.managed.resize'] as const).reduce((settings, actionId) =>
            setActionApprovalOverride({ settings, actionId, surface: 'cli', approvalRequired: false }),
            ActionsSettingsV1Schema.parse({ v: 1 }));
        const storedSettings = { actionsSettingsV1: settings };
        const policy = { getActionsSettings: () => settings, getAccountSettings: () => accountSettingsParse(storedSettings) };
        const native: string[] = [];
        const rootAuthentications: string[] = [];
        const rootAuthorities: string[] = [];
        let dispatchedRoot: ReturnType<typeof ExternalActionDaemonDispatchRequestSchema.parse> | undefined;
        const receiverInput = { token: selected.token, credentials: accountCredentials, serverId: homeId, serverIdentityId: homeId,
            serverHttpBaseUrl: serverUrl, externalActionMachineRequestPrivateKey: selected.keys.secretKey,
            externalActionMachineInstallationId: selected.controller.installationId };
        const accountHome = await mkdtemp(join(tmpdir(), 'native-account-control-'));
        nativeVendor.request.mockImplementation(async url => {
            const role = new URL(url).pathname.slice(1);
            native.push(role);
            return Response.json(role === 'inspect'
                ? { observedAt: 2, availability: 'present', power: 'stopped', storage: 'retained', size: { cpuCores: 2 } }
                : { kind: 'confirmed' });
        });
        const prepareRequester = (authorization: Parameters<typeof prepareRequesterAccountActionContext>[0]['authorization'], signal?: AbortSignal) =>
            prepareRequesterAccountActionContext({ authorization, ...(signal ? { signal } : {}), purpose: { kind: 'external_action' },
                machineId: selected.controller.machineId, installationId: selected.controller.installationId,
                installationPrivateKey: selected.keys.secretKey, serverId: homeId, serverIdentityId: homeId,
                serverHttpBaseUrl: serverUrl, ownCredentials: accountCredentials, isCurrent: async () => true,
                createExecutor: context => createReceiver(context) });
        function createReceiver(context?: RequesterAccountActionContext) {
            const host = context ? { ...receiverInput, token: context.credentials.token, credentials: context.credentials,
                savedSecretOperationContext: context.savedSecretOperationContext, isCredentialCurrent: context.isCurrent } : receiverInput;
            return createCliActionExecutor({ ...host, sessionId: '', mode: 'plain', ctx: null, happyHomeDir: accountHome,
                actionsSettingsProvider: policy, accountServerActionDeps: createAccountServerActionDeps(host),
                prepareApprovalExecutionAuthorization: async ({ authorization, signal }) => {
                    const prepared = await prepareRequester(authorization, signal);
                    if (!prepared) return null;
                    const { actionsSettings, ...context } = prepared;
                    return { ...context, ...(actionsSettings ? { actionsSettings } : {}) };
                } });
        }
        const receiver = createReceiver();
        const resolveTarget = createDaemonExternalActionTargetResolver({ credentials: accountCredentials, serverApiUrl: serverUrl });
        const phases: Array<{ phase: string; elapsedMs: number; status?: number }> = [];
        const instance = await app(async request => {
            const dispatch = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            dispatchedRoot = dispatch;
            if ('authentication' in dispatch.principal) rootAuthentications.push(dispatch.principal.authentication.kind);
            rootAuthorities.push(dispatch.principal.authority);
            const result = await executeExternalAction({ ...dispatch, executor: receiver,
                currentMachineId: selected.controller.machineId, currentInstallationId: selected.controller.installationId,
                currentServerId: homeId, externalActionMachineRequestPrivateKey: selected.keys.secretKey,
                prepareRequesterAccountContext: request => prepareRequester(request.authorization, request.signal),
                verifyExecutionAuthorization: async ({ authorization }) => await verifyCurrentExternalActionPrincipal(authorization.binding) !== null,
                resolveTarget });
            if (result.kind !== 'response') throw new Error(`Native root rejected: ${result.kind}`);
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(result.prepared) };
        }, http => {
            registerAccountProfileRoute(http);
            registerAccountEncryptionRoutes(http);
            registerPluginAvailabilityRoutes(http);
            artifactsRoutes(http);
            http.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: storedSettings }, version: 1 }));
        }, phases);
        const restoreHttp = installAxiosFastifyAdapter({ app: instance, origin: serverUrl });
        const sockets = await createRequesterCurrentnessSocketHarness();
        const daemon = createDaemonControlApp({ getChildren: () => [], machineId: selected.controller.machineId,
            controlToken: 'native-test-control', stopSession: async () => false,
            spawnSession: async () => { throw new Error('No native-control process spawn'); }, requestShutdown: () => {}, onHappySessionWebhook: () => {},
            externalActionApi: { currentServerId: homeId, currentAccountId: selected.account.id, executor: receiver, resolveTarget,
                resolveInstallationId: () => selected.controller.installationId,
                resolvePluginExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: selected.controller.machineId }),
                verifyPat: async () => { throw new Error('No PAT'); },
                resolveManagedControlControllerTarget: (actionId, rawInput, signal) => resolveManagedControlControllerTarget({
                    actionId, rawInput, credentials: accountCredentials, serverHttpBaseUrl: serverUrl, signal }),
                executeOriginalAccountAction: request => dispatchOriginalAccountAction({ credentials: accountCredentials,
                    serverHttpBaseUrl: serverUrl, serverIdentityId: homeId, actionId: request.actionId, input: request.input,
                    requestId: request.actionRequestId!, target: request.target ?? { kind: 'machine', machineId: selected.controller.machineId },
                    authority: request.authority, signal: request.signal,
                    invocation: { caller: { kind: 'host' }, surface: request.surface ?? 'cli', authority: request.authority } }) } });
        const publication = vi.spyOn(daemonPublication, 'resolveLiveDaemonControlTargetForServer').mockResolvedValue(null);
        const invocationContext = () => ({ surface: 'cli' as const,
            authority: signer === 'account' ? 'present_user' as const : 'account_automation' as const, actionRequestId: crypto.randomUUID(),
            ...(signer === 'explicit' ? { externalActionTarget: { kind: 'machine' as const, machineId: selected.controller.machineId } } : {}) });
        const sender = () => createCliActionExecutorFromCredentials({ credentials: signer === 'account' ? accountCredentials : terminalCredentials, serverId: homeId,
            serverIdentityId: homeId, serverApiUrl: serverUrl, actionsSettingsProvider: policy, happyHomeDir: accountHome });
        try {
            const unsigned = await instance.inject({ method: 'POST', url: '/v1/machines/managed/controller/report-resize',
                headers: { authorization: `Bearer ${terminalCredentials.token}` },
                payload: { homeId, managedId: row.id, requestId: crypto.randomUUID(), result: { kind: 'confirmed' } } });
            expect(unsigned.statusCode, unsigned.body).toBe(403);
            if (control === 'deferred') {
                const deferred = await sender().execute(actionId, input, invocationContext());
                expect(deferred, JSON.stringify({ deferred, phases })).toMatchObject({ ok: true, result: { kind: 'accepted' } });
                expect(native).toEqual([]);
                expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } }))
                    .toMatchObject({ desiredWhen: 'after-idle', intentRevision: 2 });
                return;
            }
            if (signer === 'missing') {
                const refused = await sender().execute(actionId, input, invocationContext());
                expect(refused, JSON.stringify({ refused, phases })).toMatchObject({ ok: false, errorCode: 'daemon_unavailable', effectAttempted: false });
                expect(native).toEqual([]);
                expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ intentRevision: 1, admittedInput: {} });
                return;
            }
            if (signer === 'signed' || signer === 'unreachable') {
                await daemon.listen({ host: '127.0.0.1', port: 0 });
                const address = daemon.server.address();
                if (!address || typeof address === 'string') throw new Error('Expected loopback daemon listener');
                publication.mockResolvedValue({ pid: process.pid, httpPort: address.port, accountId: selected.account.id,
                    machineId: selected.controller.machineId, controlToken: 'native-test-control' });
                if (signer === 'unreachable') await daemon.close();
            }
            const result = await sender().execute(actionId, input, invocationContext());
            if (signer === 'unreachable') {
                expect(result, JSON.stringify({ result, phases })).toMatchObject({ ok: false, errorCode: 'daemon_unavailable' });
                expect(native).toEqual([]);
                expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } }))
                    .toMatchObject({ intentRevision: 1, admittedInput: {} });
                return;
            }
            expect(result, JSON.stringify({ result, phases })).toMatchObject({ ok: true });
            expect(native).toContain(control);
            if (signer === 'signed') {
                expect(rootAuthentications).toEqual(['account']);
                expect(rootAuthorities).toEqual(['account_automation']);
            }
            if (signer === 'explicit') expect(rootAuthentications).toEqual(['terminal']);
            expect(phases.filter(phase => phase.phase.endsWith(`/report-${control === 'power' ? 'intent' : 'resize'}`)).map(phase => phase.status))
                .toEqual(control === 'resize' ? [403, 200] : [200]);
            if (signer === 'signed') {
                const authorization = dispatchedRoot?.executionAuthorization;
                if (!authorization || !dispatchedRoot) throw new Error('Expected actual Home-issued native root');
                const path = managedMachineActionEndpointPathV1('machines.managed.get');
                for (const managedId of [row.id, crypto.randomUUID()]) {
                    const body = { homeId, managedId };
                    const observed = await instance.inject({ method: 'POST', url: path, payload: body,
                        headers: createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: actionId,
                            target: dispatchedRoot.target, installationId: selected.controller.installationId,
                            privateKey: selected.keys.secretKey, method: 'POST', path, body }) });
                    expect(observed.statusCode, observed.body).toBe(managedId === row.id ? 200 : 401);
                }
            }
        } finally { publication.mockRestore(); nativeVendor.request.mockReset(); restoreHttp(); await sockets.close(); await daemon.close(); await instance.close();
            await rm(accountHome, { recursive: true, force: true }); }
    });

    it.each(['plain', 'e2ee'] as const)('admits software-only setup currentness through its signed %s Account root', async mode => {
        const selected = await fixture(true, mode);
        const actionId = 'machines.setup.apply';
        const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
        const root = { homeId, machineId: target.machineId };
        const input = { ...root, targets: [{ ...root, desiredRevision: 0,
            sources: [{ kind: 'direct', setup: {} }], recipePlans: [], exclusions: [] }] };
        const binding = { serverIdentityId: homeId, accountId: selected.account.id,
            authentication: { kind: 'account' as const, tokenEpoch: selected.account.tokenEpoch },
            actionId, requestId: selected.requestId, target };
        // Home never opens E2EE Action content. This test exercises its real
        // signed preparation read, with no optional app-preparation carrier.
        const envelope = mode === 'plain' ? { v: 1 as const, requestId: selected.requestId, target, input }
            : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input, material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(23) },
                randomBytes: tweetnacl.randomBytes });
        const instance = await app(async () => { throw new Error('A currentness read cannot dispatch setup'); },
            registerAccountEncryptionRoutes, []);
        try {
            const minted = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}/execution-authorization`,
                headers: { authorization: `Bearer ${selected.token}` },
                payload: { v: 1, machineId: target.machineId, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding.deploymentPreparationAdmission).toMatchObject({
                operation: 'setup', machineTargets: [target.machineId], deployments: [] });
            const path = '/v1/account/encryption/currentness';
            const headers = createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: actionId,
                target, installationId: selected.controller.installationId, privateKey: selected.keys.secretKey,
                method: 'GET', path });
            const observed = await instance.inject({ method: 'GET', url: path, headers });
            expect(observed.statusCode, observed.body).toBe(200);
            expect(observed.json()).toMatchObject({ mode });
            const unrelatedPath = '/v1/account/encryption';
            const other = await instance.inject({ method: 'GET', url: unrelatedPath,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: actionId,
                    target, installationId: selected.controller.installationId, privateKey: selected.keys.secretKey,
                    method: 'GET', path: unrelatedPath }) });
            expect(other.statusCode).toBe(401);
        } finally { await instance.close(); }
    });

    it.each([
        { mode: 'plain', scenario: 'declared' }, { mode: 'e2ee', scenario: 'declared' },
        { mode: 'plain', scenario: 'undeclared' }, { mode: 'plain', scenario: 'foreign Account' },
        { mode: 'plain', scenario: 'other guest' }, { mode: 'plain', scenario: 'other Home' },
    ] as const)('admits only the reviewed local terminal Create isolation child through real Home ($mode $scenario)', async ({ mode, scenario }) => {
        const selected = await fixture(true, mode);
        const caller = scenario === 'foreign Account' ? await fixture(true, mode) : selected;
        const token = await auth.createToken(caller.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const secret = new Uint8Array(32).fill(23);
        const credentials = { token, credentialProvenance: 'stored_session' as const,
            encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret } };
        const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
        const guestKeys = tweetnacl.sign.keyPair();
        const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: caller.account.id, active: true,
            metadata: mode === 'e2ee' ? 'guest-ciphertext' : encodePlainMachineStoredContent({ host: 'guest', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier' }),
            dataEncryptionKey: mode === 'e2ee' ? null : decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(guestKeys.publicKey),
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: capabilities } });
        const parentInput = ManagedAcquireInputV1Schema.parse({ ...selected.input,
            enrollmentIdentity: scenario === 'undeclared' ? { kind: 'existingUser', role: 'adopted' }
                : { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none' } });
        const actionId = 'machines.agentIsolation.set';
        const childInput = { serverId: scenario === 'other Home' ? 'srv_other' : homeId,
            machineId: scenario === 'other guest' ? caller.controller.machineId : guest.id, enabled: true,
            expectedMetadataVersion: 0, expectedPolicy: { enabled: false }, expectedPlanDigest: 'reviewed-plan' };
        const phases: Array<{ phase: string; elapsedMs: number; status?: number }> = [];
        let effects = 0;
        let childResult: ActionExecuteResult | undefined;
        let deliveryFailure: unknown;
        const instance = await app(async request => {
            try {
                const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
                expect(admitted.actionId).toBe(actionId);
                expect(admitted.principal).toMatchObject({ accountId: caller.account.id, authority: 'account_automation',
                    authentication: { kind: 'terminal' } });
                const authorization = admitted.executionAuthorization;
                if (!authorization || !('authentication' in authorization.binding)) throw new Error('Missing original terminal admission');
                expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).not.toBeNull();
                expect(authorization.binding).toMatchObject({ machineId: guest.id, managedContinuation: {
                    creationRequestId: selected.requestId, controller: selected.controller } });
                const binding = authorization.binding;
                const encryptionBinding = { serverIdentityId: homeId, accountId: caller.account.id, authentication: binding.authentication,
                    actionId, requestId: selected.requestId, target: admitted.envelope.target! } satisfies ExternalActionEncryptionBindingV2;
                const input = admitted.envelope.v === 1 ? admitted.envelope.input
                    : openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: encryptionBinding, envelope: admitted.envelope, material })?.input;
                expect(input).toEqual(childInput);
                // Substitute only delivery to the native guest; Home auth, retained
                // creation admission, CLI provenance and encrypted transport are real.
                effects++;
                const execution = { ok: true as const, result: { kind: 'accepted', operationId: 'isolation', metadataVersion: 1,
                    status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } } };
                const prepared = admitted.envelope.v === 1 ? prepareExternalActionResponseEnvelopeV1({ v: 1,
                    actionId, requestId: selected.requestId, execution }) : prepareExternalActionResponseV2({ binding: encryptionBinding,
                        executedMachineId: guest.id, request: admitted.envelope, execution, material, randomBytes: tweetnacl.randomBytes });
                return { ok: true, result: createExternalActionDaemonDispatchResponse(prepared) };
            } catch (error) { deliveryFailure = error; throw error; }
        }, http => { http.get('/v1/account/encryption', async () => ({ mode, updatedAt: 1 })); }, phases);
        const restoreHttp = installAxiosFastifyAdapter({ app: instance, origin: 'http://managed-seam.test' });
        try {
            const parent = createActionExecutor({ managedMachineAction: async ({ context }) => {
                const admitted = await admitManagedAcquire({ custodianAccountId: selected.account.id,
                    requesterAccountId: selected.account.id, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
                        v: 1, requestId: selected.requestId, target: { kind: 'machine', machineId: selected.controller.machineId }, input: parentInput }),
                    input: { input: parentInput, requestId: selected.requestId, continuationPresent: false } });
                // Provider allocation and guest enrollment are the system boundary.
                await db.managedMachine.update({ where: { id: admitted.machine.id }, data: { allocation: 'bound',
                    enrolledMachineId: guest.id, resource: { contributionRef: selected.input.selection.launch.provider,
                        schemaVersion: 1, value: { id: 'native-guest' } } } });
                childResult = await dispatchLocalManagedMachineAgentIsolation({ actionId, input: childInput, homeId, context, credentials,
                    custodianAccountId: caller.account.id, serverHttpBaseUrl: 'http://managed-seam.test', isCurrent: async () => true,
                    managedContinuation: { managedId: admitted.machine.id, creationRequestId: selected.requestId, expectedIntentRevision: 0 } });
                return childResult.ok ? { managedId: admitted.machine.id } : childResult;
            } });
            const result = await parent.execute('machines.managed.acquire', parentInput, { surface: 'ui', authority: 'present_user',
                actionCaller: { kind: 'host' }, runtimeAccountId: caller.account.id, serverId: homeId, serverIdentityId: homeId,
                actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
                actionRequestId: selected.requestId, externalActionTarget: { kind: 'machine', machineId: selected.controller.machineId },
                presentUserConfirmation: { actionId: 'machines.managed.acquire', accountId: caller.account.id, serverId: homeId,
                    requestId: selected.requestId, target: { kind: 'machine', machineId: selected.controller.machineId },
                    inputDigest: computeActionInputApprovalDigestV1('machines.managed.acquire', parentInput) } });
            if (deliveryFailure) throw deliveryFailure;
            expect(childResult, JSON.stringify(result)).toBeDefined();
            if (scenario === 'declared') {
                expect(childResult, childResult?.ok === false ? childResult.errorCode : 'local isolation outcome')
                    .toMatchObject({ ok: true, result: { kind: 'accepted', operationId: 'isolation' } });
                expect(result).toMatchObject({ ok: true });
                expect(effects).toBe(1);
            } else {
                expect(childResult).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
                expect(effects).toBe(0);
            }
        } finally { restoreHttp(); await instance.close(); }
    });

    it.skipIf(!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)('commits the acquire Action while provider usage holds Account content admission', async () => {
        const selected = await fixture(true);
        const instance = await app(async () => {
            const row = await db.managedMachine.findFirstOrThrow({ where: {
                homeId, admittedActionRequestId: selected.requestId,
            } });
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({ v: 1,
                actionId: 'machines.managed.acquire', requestId: selected.requestId,
                execution: { ok: true, result: { managedId: row.id } } })) };
        }, () => {}, []);
        const usageClient = await createDbMaintenanceClient('postgres', process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL!);
        const ready = Promise.withResolvers<number>();
        const release = Promise.withResolvers<void>();
        // The loaded usage writer retains this admission during its record work.
        // Keep all Action, authorization, managed and publication owners real.
        const holder = usageClient.$transaction(async tx => {
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`
                SELECT pg_backend_pid() AS pid FROM "Account" WHERE id = ${selected.account.id} FOR KEY SHARE
            `;
            ready.resolve(pid);
            await release.promise;
        }, { timeout: readDatabaseTransactionConfigFromEnv(process.env, 'postgres').timeoutMs });
        const holderOutcome = Promise.allSettled([holder]);
        const holderReady = Promise.race([ready.promise, holder.then(() => { throw new Error('Usage holder missed rendezvous'); })]);
        const pending = holderReady.then(() => instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
            headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1, requestId: selected.requestId,
                target: { kind: 'machine', machineId: selected.controller.machineId }, input: selected.input } }));
        let settled = false;
        void pending.then(() => { settled = true; }, () => { settled = true; });
        try {
            const pid = await holderReady;
            while (!settled) {
                const [state] = await usageClient.$queryRaw<Array<{ blocked: boolean }>>`
                    SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                        WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
                `;
                expect(state.blocked, 'usage content admission must not block the acquire Action').toBe(false);
            }
            const response = await pending;
            expect(response.statusCode, response.body).toBe(200);
            const row = await db.managedMachine.findFirstOrThrow({ where: { homeId, admittedActionRequestId: selected.requestId } });
            expect(response.json()).toMatchObject({ execution: { ok: true, result: { managedId: row.id } } });
            expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
                accountId: selected.account.id, kind: 'account', entityId: row.id,
            } } })).not.toBeNull();
        } finally {
            release.resolve();
            await Promise.allSettled([pending]);
            const [outcome] = await holderOutcome;
            await usageClient.$disconnect();
            await instance.close();
            if (outcome.status === 'rejected') throw outcome.reason;
        }
    });

    it('commits CLOUD11 enrollment identity before awaiting a slow daemon boundary without retaining an interactive transaction', async () => {
        const selected = await fixture(true);
        const input = { ...selected.input, enrollmentIdentity: { kind: 'dedicatedDaemonUser' as const,
            username: 'happier', serviceMode: 'user' as const, role: 'server' as const,
            adminAccessAtCreation: 'preauthorized' as const } };
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let activeTransactions = 0;
        let transactionStarts = 0;
        const originalTransaction = db.$transaction;
        const instance = await app(async () => {
            try {
                expect(transactionStarts).toBeGreaterThan(0);
                expect(activeTransactions).toBe(0);
                const row = await db.managedMachine.findFirstOrThrow({ where: {
                    homeId, admittedActionRequestId: selected.requestId,
                } });
                expect(row).toMatchObject({ admittedInput: { computeInput: { enrollmentIdentity: input.enrollmentIdentity } },
                    allocation: 'unsubmitted', creationState: 'active' });
                entered.resolve();
                // A held transport stands for arbitrarily slow controller/provider
                // work; it must consume no interactive transaction lifetime.
                await release.promise;
                expect(activeTransactions).toBe(0);
                return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({ v: 1,
                    actionId: 'machines.managed.acquire', requestId: selected.requestId,
                    execution: { ok: true, result: { managedId: row.id } } })) };
            } catch (error) { entered.reject(error); throw error; }
        }, () => {}, []);
        // Observe the database boundary until commit/rollback settles, not just
        // until its callback returns. All transactional domain work stays real.
        db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args: unknown[]) {
            if (typeof args[0] !== 'function') return Reflect.apply(target, receiver, args);
            transactionStarts++;
            activeTransactions++;
            try {
                return Promise.resolve(Reflect.apply(target, receiver, args))
                    .finally(() => { activeTransactions--; });
            } catch (error) { activeTransactions--; throw error; }
        } });
        const pending = Promise.resolve(instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
            headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1, requestId: selected.requestId,
                target: { kind: 'machine', machineId: selected.controller.machineId }, input } }));
        try {
            await Promise.race([entered.promise, pending.then(response => {
                throw new Error(`Managed request settled before the daemon boundary: ${response.statusCode}`);
            })]);
            expect(activeTransactions).toBe(0);
            release.resolve();
            const response = await pending;
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ execution: { ok: true, result: { managedId: expect.any(String) } } });
        } finally {
            release.resolve();
            await Promise.allSettled([pending]);
            db.$transaction = originalTransaction;
            await instance.close();
        }
    });

    it.each(['valid', 'invalid', 'qb56'] as const)('invokes managed Create through CLI, Home and the real approval executor with %s refreshed policy', async policy => {
        const selected = await fixture(true, 'plain', policy === 'qb56');
        const credentials = { token: selected.token, credentialProvenance: 'stored_session' as const, encryption: null };
        const storedSettings = { actionsSettingsV1: { v: 1, actions: {
            'machines.managed.acquire': { approvalRequiredSurfaces: ['cli'] },
        } } };
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(storedSettings),
            rawSettings: storedSettings, settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials) });
        const approvals: unknown[] = [];
        const phases: Array<{ phase: string; elapsedMs: number; status?: number }> = [];
        let effects = 0;
        const receiver = createCliActionExecutor({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
            serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: 'http://managed-seam.test',
            runtimeActionMachineId: selected.controller.machineId,
            externalActionMachineRequestPrivateKey: selected.keys.secretKey,
            externalActionMachineInstallationId: selected.controller.installationId,
            managedMachineAction: async () => { effects++; throw new Error('Create must ask before native execution'); },
        });
        let deliveryFailure: unknown;
        const instance = await app(async request => {
            try {
                const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
                const result = await executeExternalAction({ ...admitted, executor: receiver,
                    currentAccountId: selected.account.id, currentMachineId: selected.controller.machineId,
                    currentInstallationId: selected.controller.installationId,
                    currentServerId: homeId, externalActionMachineRequestPrivateKey: selected.keys.secretKey,
                    // Socket delivery is substituted; its current Home proof is verified by the real HTTP port.
                    verifyExecutionAuthorization: async ({ authorization }) => {
                        return await verifyCurrentExternalActionPrincipal(authorization.binding) !== null;
                    },
                    resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
                });
                if (result.kind !== 'response') throw new Error(`Daemon rejected managed ingress: ${result.kind} (${result.errorCode})`);
                return { ok: true, result: createExternalActionDaemonDispatchResponseV1(result.prepared) };
            } catch (error) { deliveryFailure = error; throw error; }
        }, http => {
            http.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
            http.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: storedSettings },
                version: policy === 'invalid' ? 'invalid' : 2 }));
            http.post('/v1/artifacts', async request => {
                const raw = request.body;
                if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string'
                    || !('body' in raw) || typeof raw.body !== 'string') throw new Error('Invalid Artifact request');
                const stored = decodePlainArtifactStoredContent(raw.body);
                if (!stored || typeof stored !== 'object' || !('body' in stored) || typeof stored.body !== 'string') {
                    throw new Error('Invalid approval Artifact body');
                }
                approvals.push(ApprovalRequestV2Schema.parse(JSON.parse(stored.body)));
                return { id: raw.id, headerVersion: 1, bodyVersion: 1 };
            });
        }, phases);
        const restoreHttp = installAxiosFastifyAdapter({ app: instance, origin: 'http://managed-seam.test' });
        const began = performance.now();
        let output = '';
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
            output += String(chunk);
            const callback = args.find(argument => typeof argument === 'function');
            if (typeof callback === 'function') callback();
            return true;
        });
        const previousExitCode = process.exitCode;
        try {
            await handleActionsCommand(['invoke', 'machines.managed.acquire', '--machine-id', selected.controller.machineId,
                '--request-id', selected.requestId, '--input-json', JSON.stringify(selected.input), '--json'], {
                readCredentialsFn: async () => credentials,
                getServerProfileFn: async () => { throw new Error('No saved profile in this isolated fixture'); },
                createExecutorFn: options => createCliActionExecutorFromCredentials({ ...options,
                    serverId: homeId, serverIdentityId: homeId, serverApiUrl: 'http://managed-seam.test' }),
            });
            if (deliveryFailure) throw deliveryFailure;
            phases.push({ phase: 'cli-create-to-ask', elapsedMs: performance.now() - began });
            expect(JSON.parse(output)).toMatchObject(policy === 'invalid'
                ? { ok: false, kind: 'actions_invoke', error: { code: 'ACCOUNT_SETTINGS_CONTENT_INVALID' } }
                : { ok: true, kind: 'actions_invoke', data: { kind: 'approval_request_created', actionId: 'machines.managed.acquire' } });
            expect(approvals).toHaveLength(policy === 'invalid' ? 0 : 1);
            expect(effects).toBe(0);
            // Home admission precedes controller policy preparation. A refused
            // refresh cannot roll back that already committed request.
            expect(await db.managedMachine.count({ where: { homeId, admittedActionRequestId: selected.requestId } })).toBe(1);
            if (policy === 'qb56') {
                const row = await db.managedMachine.findFirstOrThrow({ where: { homeId, admittedActionRequestId: selected.requestId } });
                expect(row).toMatchObject({ allocation: 'unsubmitted', creationState: 'active', intentRevision: 0 });
                const started = performance.now();
                const executor = createActionExecutor(createAccountServerActionDeps({ token: credentials.token,
                    serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: 'http://managed-seam.test' }) as Parameters<typeof createActionExecutor>[0]);
                // Replay of an already approved Account Cancel; the actual Home
                // authority, route, transaction and strict acknowledgement remain real.
                const canceled = await executor.execute('machines.managed.cancel', { homeId, managedId: row.id,
                    expectedIntentRevision: 0 }, { surface: 'cli', authority: 'present_user', bypassApprovals: true });
                phases.push({ phase: 'cli-approved-cancel', elapsedMs: performance.now() - started });
                expect(canceled).toMatchObject({ ok: true, result: { machine: { id: row.id,
                    creationState: 'canceled', allocation: 'confirmed-absent', intentRevision: 1 } } });
                expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } }))
                    .toMatchObject({ creationState: 'canceled', allocation: 'confirmed-absent', intentRevision: 1 });
            }
        } finally {
            stdout.mockRestore(); process.exitCode = previousExitCode;
            restoreHttp(); resetActiveAccountSettingsSnapshotForTests(); await instance.close();
            if (policy === 'qb56') console.info('qb58-replay-phases', JSON.stringify(phases));
        }
    });

    it.each([
        { mode: 'plain', delegated: true, surface: 'cli' }, { mode: 'e2ee', delegated: true, surface: 'cli' },
        { mode: 'plain', delegated: true, surface: 'ui' }, { mode: 'plain', delegated: false, surface: 'ui' },
    ] as const)('consumes only admitted delegation with custodian credentials under approval policy ($mode, $surface, delegated=$delegated)', async ({ mode, delegated, surface }) => {
        const selected = await fixture(true);
        const requester = await fixture(true, mode);
        const team = await db.team.create({ data: { name: 'Reviewed Team compute' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: selected.account.id, role: 'owner' },
            { teamId: team.id, accountId: requester.account.id, role: 'member' },
        ] });
        if (!delegated) await db.machineAccountGrant.create({ data: { machineId: selected.controller.machineId,
            accountId: requester.account.id, accessLevel: 'admin', createdByAccountId: selected.account.id } });
        const presetId = crypto.randomUUID();
        expect(await createMachinePreset({ accountId: selected.account.id,
            authentication: { authenticationAuthority: 'present_user' }, input: {
                id: presetId, homeId, name: 'Delegated guest', owner: { kind: 'team', teamId: team.id },
                launch: selected.input.selection.launch, controller: selected.controller, teamAcquireDelegated: delegated,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            } })).toMatchObject({ kind: 'saved' });
        const access = await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: selected.controller.machineId });
        if (delegated) expect(access).toBeNull();
        else expect(access).toMatchObject({ role: 'manage' });
        const input = ManagedAcquireInputV1Schema.parse({ enrollmentIdentity: selected.input.enrollmentIdentity,
            selection: { kind: 'preset', homeId, id: presetId, revision: 0 }, controller: selected.controller,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const credentials = { token: selected.token, credentialProvenance: 'stored_session' as const, encryption: null };
        const storedSettings = { actionsSettingsV1: { v: 1, actions: {
            'machines.managed.acquire': { approvalRequiredSurfaces: ['ui'] },
        } } };
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(storedSettings),
            rawSettings: storedSettings, settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials) });
        const serverHttpBaseUrl = 'http://managed-seam.test';
        const actionId = 'machines.managed.acquire';
        const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
        const binding = { serverIdentityId: homeId, accountId: requester.account.id,
            authentication: { kind: 'account' as const, tokenEpoch: requester.account.tokenEpoch },
            actionId, requestId: crypto.randomUUID(), target };
        const material = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
        const envelope = mode === 'plain' ? { v: 1 as const, requestId: binding.requestId, target, input }
            : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                binding, material, input, randomBytes: tweetnacl.randomBytes });
        let nativeEffects = 0;
        let artifactWrites = 0;
        const receiver = createCliActionExecutor({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
            serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl,
            runtimeActionMachineId: selected.controller.machineId,
            externalActionMachineRequestPrivateKey: selected.keys.secretKey,
            externalActionMachineInstallationId: selected.controller.installationId,
            managedMachineAction: async ({ actionId: effectActionId, context }) => {
                const row = await db.managedMachine.findUniqueOrThrow({ where: { homeId_admittedActionRequestId: {
                    homeId, admittedActionRequestId: binding.requestId } } });
                expect(row).toMatchObject({ custodianAccountId: selected.account.id,
                    admittedInput: { enrollmentAccountId: requester.account.id } });
                const client = createManagedMachineControllerClient({ token: credentials.token, serverUrl: serverHttpBaseUrl,
                    homeId, controller: selected.controller, externalActionMachineRequestPrivateKey: selected.keys.secretKey } as ManagedMachineAcquisitionDriverInput,
                { requestId: binding.requestId, context }, effectActionId);
                await client.post('/v1/machines/managed/controller/submit', { homeId, managedId: row.id,
                    expectedIntentRevision: 0, requestId: binding.requestId, controller: selected.controller },
                ManagedControllerSubmitOutputV1Schema);
                nativeEffects++;
                return { managedId: row.id };
            },
        });
        const instance = await app(async request => {
            const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            expect(request.targetUserId).toBe(selected.account.id);
            expect(admitted.executionAuthorization?.binding).toMatchObject({ accountId: requester.account.id,
                custodianAccountId: selected.account.id });
            const result = await executeExternalAction({ ...admitted, executor: receiver,
                currentAccountId: selected.account.id, currentMachineId: selected.controller.machineId,
                currentInstallationId: selected.controller.installationId, currentServerId: homeId,
                currentServerHttpBaseUrl: serverHttpBaseUrl, externalActionMachineRequestPrivateKey: selected.keys.secretKey,
                verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                    privateKey: selected.keys.secretKey, installationId: selected.controller.installationId, serverHttpBaseUrl }),
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
                prepareRequesterAccountContext: async () => { throw new Error('Delegation must not acquire requester credentials'); },
            });
            if (result.kind !== 'response') throw new Error(`Daemon rejected delegated ingress: ${result.kind}`);
            return { ok: true, result: createExternalActionDaemonDispatchResponse(result.prepared) };
        }, http => {
            http.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
            http.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: storedSettings }, version: 2 }));
            http.post('/v1/artifacts', async () => { artifactWrites++; throw new Error('Delegation must not write a private Ask'); });
        }, []);
        const restoreHttp = installAxiosFastifyAdapter({ app: instance, origin: serverHttpBaseUrl });
        try {
            const issued = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}/execution-authorization`,
                headers: { authorization: `Bearer ${requester.token}` },
                payload: { v: 1, machineId: target.machineId, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = sealManagedControllerActionCodecV1({
                authorization: ExternalActionExecutionAuthorizationV1Schema.parse(issued.json()), material,
                invocation: { caller: { kind: 'host' }, surface, authority: 'present_user' },
                installationPublicKey: selected.keys.publicKey, randomBytes: tweetnacl.randomBytes });
            if (delegated && mode === 'plain' && surface === 'cli') {
                const origin = buildApprovalExecutionOriginV1({ actionId, input, targetSessionId: null, context: {
                    surface, authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: binding.requestId,
                    runtimeAccountId: requester.account.id, serverId: homeId, serverIdentityId: homeId,
                    defaultSessionMachineId: selected.controller.machineId, externalActionTarget: target,
                    externalActionExecutionAuthorization: authorization,
                    signExternalActionApprovalInput: request => signExternalActionApprovalInputV1({
                        authorizationToken: authorization.token, actionId: request.actionId, target: request.target,
                        input: request.input, privateKey: selected.keys.secretKey }),
                } });
                expect(origin).not.toBeNull();
                const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: Date.now(), updatedAtMs: Date.now(),
                    createdBy: { surface: 'cli' }, executionOriginV1: origin, actionId, actionArgs: input,
                    summary: 'Create reviewed Team guest', requestInputDigest: computeActionInputApprovalDigestV1(actionId, input) });
                const privateApprovals = createCliApprovalsArtifactStore({ credentials, serverId: homeId, serverHttpBaseUrl });
                await expect(privateApprovals.approvalsCreate({ request, serverId: homeId }))
                    .rejects.toMatchObject({ code: 'credential_scope_denied' });
                const other = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: selected.account.id,
                    metadata: encodePlainMachineStoredContent({ host: 'other', platform: 'linux', happyCliVersion: 'test',
                        homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
                    dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
                    installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(selected.keys.publicKey) } });
                await expect(auth.mintExternalActionExecutionAuthorization({ ...authorization.binding,
                    managedAcquireDelegation: undefined, machineId: other.id, target: { kind: 'machine', machineId: other.id } },
                { input })).rejects.toMatchObject({ code: 'credential_scope_denied' });
            }
            const executed = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1,
                    machineId: target.machineId, envelope, executionAuthorization: authorization } });
            expect(executed.statusCode, executed.body).toBe(200);
            const response = executed.json();
            const execution = envelope.v === 1 ? response.execution
                : openExternalActionResponseV2({ envelope: response, request: envelope, binding, material });
            expect(execution, JSON.stringify(execution)).toMatchObject(delegated
                ? { ok: true, result: { managedId: expect.any(String) } }
                : { ok: false, errorCode: 'action_interactive_review_required' });
            expect(nativeEffects).toBe(delegated ? 1 : 0);
            expect(artifactWrites).toBe(0);
            expect(authorization.binding.managedAcquireDelegation).toBe(delegated ? true : undefined);
            await expect(auth.mintExternalActionExecutionAuthorization({ ...authorization.binding,
                managedAcquireDelegation: true }, { input })).rejects.toMatchObject({ code: 'credential_scope_denied' });
            if (delegated) expect(await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: target.machineId })).toBeNull();
        } finally { restoreHttp(); resetActiveAccountSettingsSnapshotForTests(); await instance.close(); }
    });

    it.each([
        { actionId: 'machines.managed.cancel', creator: true, manage: false }, { actionId: 'machines.managed.delete', creator: true, manage: false },
        { actionId: 'machines.managed.cancel', creator: true, manage: true }, { actionId: 'machines.managed.delete', creator: true, manage: true },
        { actionId: 'machines.managed.cancel', creator: false, manage: true }, { actionId: 'machines.managed.delete', creator: false, manage: true },
    ] as const)('allows delegated creator recovery with custodian custody through the real $actionId entry (creator=$creator, Manage=$manage)', async ({ actionId, creator, manage }) => {
        const selected = await fixture(true);
        const requester = await fixture(true);
        const stranger = await fixture(true);
        const team = await db.team.create({ data: { name: 'Creator recovery Team' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: selected.account.id, role: 'owner' },
            { teamId: team.id, accountId: requester.account.id, role: 'member' },
            { teamId: team.id, accountId: stranger.account.id, role: 'member' },
        ] });
        const presetId = crypto.randomUUID();
        expect(await createMachinePreset({ accountId: selected.account.id,
            authentication: { authenticationAuthority: 'present_user' }, input: {
                id: presetId, homeId, name: 'Creator guest', owner: { kind: 'team', teamId: team.id },
                launch: selected.input.selection.launch, controller: selected.controller, teamAcquireDelegated: true,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            } })).toMatchObject({ kind: 'saved' });
        const acquireInput = ManagedAcquireInputV1Schema.parse({ enrollmentIdentity: selected.input.enrollmentIdentity,
            selection: { kind: 'preset', homeId, id: presetId, revision: 0 }, controller: selected.controller,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const admitted = await admitManagedAcquire({ custodianAccountId: selected.account.id,
            requesterAccountId: creator ? requester.account.id : selected.account.id, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
                v: 1, requestId: selected.requestId, target: { kind: 'machine', machineId: selected.controller.machineId }, input: acquireInput }),
            input: { input: acquireInput, requestId: selected.requestId, continuationPresent: false } });
        if (actionId === 'machines.managed.delete') await db.managedMachine.update({ where: { id: admitted.machine.id }, data: {
            allocation: 'bound', resource: { contributionRef: selected.input.selection.launch.provider,
                schemaVersion: 1, value: { id: 'creator-native-resource' } },
        } });
        if (manage) await db.machineAccountGrant.create({ data: { machineId: selected.controller.machineId,
            accountId: requester.account.id, accessLevel: 'admin', createdByAccountId: selected.account.id } });
        const input = actionId === 'machines.managed.cancel'
            ? { homeId, managedId: admitted.machine.id, expectedIntentRevision: 0 }
            : { homeId, managedId: admitted.machine.id, expectedRevision: 0, intent: 'delete' as const,
                when: 'now' as const, reviewedDependencies: true };
        const credentials = { token: selected.token, credentialProvenance: 'stored_session' as const, encryption: null };
        const storedSettings = { actionsSettingsV1: { v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } } };
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(storedSettings),
            rawSettings: storedSettings, settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials) });
        const serverHttpBaseUrl = 'http://managed-seam.test';
        const connection = { token: credentials.token, serverUrl: serverHttpBaseUrl, homeId,
            controller: selected.controller, externalActionMachineRequestPrivateKey: selected.keys.secretKey } as ManagedMachineAcquisitionDriverInput;
        let controllerAdmissions = 0;
        let artifactWrites = 0;
        const accountActions = createAccountServerActionDeps({ token: credentials.token, credentials, serverId: homeId,
            serverIdentityId: homeId, serverHttpBaseUrl, externalActionMachineRequestPrivateKey: selected.keys.secretKey,
            externalActionMachineInstallationId: selected.controller.installationId });
        const receiver = createCliActionExecutor({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
            serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl, runtimeActionMachineId: selected.controller.machineId,
            externalActionMachineRequestPrivateKey: selected.keys.secretKey,
            externalActionMachineInstallationId: selected.controller.installationId,
            managedMachineAction: async request => {
                if (request.actionId === 'machines.managed.cancel') return accountActions.managedMachineAction!(request);
                // Stop at real Home admission, before the external native provider effect.
                const client = createManagedMachineControllerClient(connection,
                    { requestId: request.context.actionRequestId!, context: request.context }, request.actionId);
                const result = await client.post('/v1/machines/managed/controller/admit-control',
                    ManagedControlAdmissionInputV1Schema.parse({ action: request.actionId, input: request.input,
                        requestId: request.context.actionRequestId }), ManagedAdmissionOutputV1Schema);
                controllerAdmissions++;
                return { kind: 'accepted', managedId: result.machine.id, intentRevision: result.machine.intentRevision };
            },
        });
        const instance = await app(async request => {
            const dispatch = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            expect(dispatch.executionAuthorization?.binding).toMatchObject({ accountId: requester.account.id,
                custodianAccountId: selected.account.id });
            const result = await executeExternalAction({ ...dispatch, executor: receiver,
                currentAccountId: selected.account.id, currentMachineId: selected.controller.machineId,
                currentInstallationId: selected.controller.installationId, currentServerId: homeId,
                currentServerHttpBaseUrl: serverHttpBaseUrl, externalActionMachineRequestPrivateKey: selected.keys.secretKey,
                verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                    privateKey: selected.keys.secretKey, installationId: selected.controller.installationId, serverHttpBaseUrl }),
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
                prepareRequesterAccountContext: async () => { throw new Error('Recovery must not acquire requester credentials'); },
            });
            if (result.kind !== 'response') throw new Error(`Daemon rejected creator recovery: ${result.kind}`);
            return { ok: true, result: createExternalActionDaemonDispatchResponse(result.prepared) };
        }, http => {
            registerAccountProfileRoute(http); registerAccountEncryptionRoutes(http); artifactsRoutes(http);
            http.addHook('onRequest', async request => { if (request.method === 'POST' && request.url === '/v1/artifacts') artifactWrites++; });
            http.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: storedSettings }, version: 2 }));
        }, []);
        const restoreHttp = installAxiosFastifyAdapter({ app: instance, origin: serverHttpBaseUrl });
        try {
            for (const actor of manage ? [stranger] : [requester, stranger]) expect(await resolveMachineAccess({ actorAccountId: actor.account.id,
                machineId: selected.controller.machineId })).toBeNull();
            const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
            const issue = (token: string) => instance.inject({ method: 'POST', url: `/v1/actions/${actionId}/execution-authorization`,
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: target.machineId,
                    envelope: { v: 1, requestId: crypto.randomUUID(), target, input } } });
            expect((await issue(stranger.token)).statusCode).toBe(409);
            if (creator && actionId === 'machines.managed.cancel') {
                const cancelPath = managedMachineActionEndpointPathV1(actionId);
                const unsignedStranger = await instance.inject({ method: 'POST', url: cancelPath,
                    headers: { authorization: `Bearer ${stranger.token}` }, payload: input });
                expect(unsignedStranger.statusCode, unsignedStranger.body).toBe(403);
                const unsignedCreator = await instance.inject({ method: 'POST', url: cancelPath,
                    headers: { authorization: `Bearer ${requester.token}` }, payload: { ...input, expectedIntentRevision: 99 } });
                expect(unsignedCreator.statusCode, unsignedCreator.body).toBe(409);
                expect(unsignedCreator.json()).toMatchObject({ code: 'intent_changed' });
            }
            if (!manage) {
                const forbidden = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.power.set/execution-authorization',
                    headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1, machineId: target.machineId,
                        envelope: { v: 1, requestId: crypto.randomUUID(), target, input: { homeId, managedId: admitted.machine.id,
                            when: 'now', expectedRevision: 0, intent: 'stop' } } } });
                expect(forbidden.statusCode, forbidden.body).toBe(409);
            }
            const requestId = crypto.randomUUID();
            const envelope = { v: 1 as const, requestId, target, input };
            const issued = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}/execution-authorization`,
                headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1, machineId: target.machineId, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const rootAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(rootAuthorization.binding.managedAdmission && 'authority' in rootAuthorization.binding.managedAdmission
                ? rootAuthorization.binding.managedAdmission.authority : undefined).toBe(creator ? 'creator_recovery' : undefined);
            await expect(auth.mintExternalActionExecutionAuthorization({ ...rootAuthorization.binding,
                managedAdmission: { ...rootAuthorization.binding.managedAdmission!, authority: 'creator_recovery' } }, { input })).rejects.toMatchObject({ code: 'credential_scope_denied' });
            if (creator) {
                const alteredBinding = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                    headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1, machineId: target.machineId,
                        envelope, executionAuthorization: { ...rootAuthorization,
                            binding: { ...rootAuthorization.binding, managedAdmission: { ...rootAuthorization.binding.managedAdmission!, authority: undefined } } } } });
                expect(alteredBinding.statusCode, alteredBinding.body).toBe(403);
                expect(alteredBinding.json()).toMatchObject({ error: 'credential_scope_denied' });
                await db.machineAccountGrant.create({ data: { machineId: selected.controller.machineId,
                    accountId: stranger.account.id, accessLevel: 'admin', createdByAccountId: selected.account.id } });
                const replayedByManager = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                    headers: { authorization: `Bearer ${stranger.token}` }, payload: { v: 1, machineId: target.machineId,
                        envelope, executionAuthorization: rootAuthorization } });
                expect(replayedByManager.statusCode, replayedByManager.body).toBe(403);
                expect(replayedByManager.json()).toMatchObject({ error: 'credential_scope_denied' });
                const path = actionId === 'machines.managed.cancel'
                    ? managedMachineActionEndpointPathV1(actionId) : '/v1/machines/managed/controller/admit-control';
                const body = actionId === 'machines.managed.cancel' ? { ...input, expectedIntentRevision: 99 }
                    : { action: actionId, requestId, input: { ...input, expectedRevision: 99 } };
                const tampered = await instance.inject({ method: 'POST', url: path, payload: body,
                    headers: createExternalActionAuthorizedRequestHeaders({ authorization: rootAuthorization,
                        effectActionId: actionId, target, installationId: selected.controller.installationId,
                        privateKey: selected.keys.secretKey, method: 'POST', path, body }) });
                expect(tampered.statusCode, tampered.body).toBe(401);
            }
            if (!creator && actionId === 'machines.managed.delete') {
                // Nondelegated managers retain the original requester-credential/Ask path.
                expect(() => sealManagedControllerActionCodecV1({ authorization: rootAuthorization,
                    material: { type: 'dataKey', machineKey: tweetnacl.randomBytes(32) },
                    installationPublicKey: selected.keys.publicKey, randomBytes: tweetnacl.randomBytes }))
                    .toThrow('managed_controller_codec_root_mismatch');
                return;
            }
            const authorization = sealManagedControllerActionCodecV1({
                authorization: rootAuthorization,
                material: { type: 'dataKey', machineKey: tweetnacl.randomBytes(32) },
                invocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'present_user' },
                installationPublicKey: selected.keys.publicKey, randomBytes: tweetnacl.randomBytes });
            const execution = creator ? await dispatchOriginalAccountAction({ actionId, input, requestId, target,
                credentials: { token: requester.token, credentialProvenance: 'stored_session', encryption: null },
                serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl, authority: 'present_user',
                invocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'present_user' },
                onRequesterSessionCredentialDisclosure: async () => { throw new Error('Creator recovery must not disclose requester credentials'); },
            }) : await (async () => {
                const executed = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                    headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1, machineId: target.machineId,
                        envelope, executionAuthorization: authorization } });
                expect(executed.statusCode, executed.body).toBe(200);
                return executed.json().execution;
            })();
            expect(execution, JSON.stringify(execution)).toMatchObject(creator ? { ok: true }
                : { ok: false, errorCode: 'approval_origin_unavailable' });
            const row = await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } });
            expect(row).toMatchObject(!creator ? { creationState: 'active', intentRevision: 0 } : actionId === 'machines.managed.cancel'
                ? { creationState: 'canceled', allocation: 'confirmed-absent', intentRevision: 1 }
                : { desired: 'delete', allocation: 'bound', intentRevision: 1 });
            expect(controllerAdmissions).toBe(creator && actionId === 'machines.managed.delete' ? 1 : 0);
            expect(artifactWrites).toBe(0);
            const access = await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: target.machineId });
            if (!manage) expect(access).toBeNull();
            else expect(access).toMatchObject({ role: 'manage' });
        } finally { restoreHttp(); resetActiveAccountSettingsSnapshotForTests(); await instance.close(); }
    });

    it('releases the delegated preset slot when a member deletes canceled uncertain Devcontainer creation through native reconciliation', async () => {
        const selected = await fixture(true);
        const requester = await fixture(true);
        const manifest = normalizePluginManifestV2(DEVCONTAINER_PLUGIN.manifest);
        const declaration = createReleaseLessDeclarationV1(PluginManifestV2Schema.parse(manifest));
        await db.accountPluginIntent.create({ data: { accountId: selected.account.id, pluginId: manifest.id,
            enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: selected.account.id, serverIdentityId: homeId,
            machineId: selected.controller.machineId, materializationId: crypto.randomUUID(), pluginId: manifest.id,
            version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false,
            archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true,
            trustState: 'trusted', observedAt: new Date() } });
        const team = await db.team.create({ data: { name: 'Uncertain creation recovery' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: selected.account.id, role: 'owner' },
            { teamId: team.id, accountId: requester.account.id, role: 'member' },
        ] });
        const presetId = crypto.randomUUID();
        expect(await createMachinePreset({ accountId: selected.account.id,
            authentication: { authenticationAuthority: 'present_user' }, input: {
                id: presetId, homeId, name: 'One container at a time', owner: { kind: 'team', teamId: team.id },
                launch: { provider: { pluginId: manifest.id, localId: 'devcontainer' }, schemaVersion: 1, name: 'Recovery container',
                    choices: { runtime: 'docker', configuration: { kind: 'image', image: 'ubuntu:24.04' } } },
                controller: selected.controller, teamAcquireDelegated: true, simultaneousLimit: { maximum: 1 },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            } })).toMatchObject({ kind: 'saved' });
        const acquireInput = ManagedAcquireInputV1Schema.parse({ enrollmentIdentity: selected.input.enrollmentIdentity,
            selection: { kind: 'preset', homeId, id: presetId, revision: 0 }, controller: selected.controller,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const acquire = (requestId: string) => admitManagedAcquire({ custodianAccountId: selected.account.id,
            requesterAccountId: requester.account.id, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
                v: 1, requestId, target: { kind: 'machine', machineId: selected.controller.machineId }, input: acquireInput }),
            input: { input: acquireInput, requestId, continuationPresent: false } });
        const admitted = await acquire(crypto.randomUUID());
        // The reported failure retains no native identity after uncertain acquisition/cancel.
        await db.managedMachine.update({ where: { id: admitted.machine.id }, data: {
            creationState: 'canceled', allocation: 'may-exist', desired: 'delete', desiredWhen: 'now',
        } });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } }))
            .toMatchObject({ creationState: 'canceled', allocation: 'may-exist', resource: null, nativeOperationRef: null });
        await expect(acquire(crypto.randomUUID())).rejects.toMatchObject({ code: 'preset_limit_reached' });
        expect(await resolveMachineAccess({ actorAccountId: requester.account.id,
            machineId: selected.controller.machineId })).toBeNull();

        const activation = await activateContributionModule({ pluginId: manifest.id, manifest,
            occurrenceId: createPluginRuntimeOccurrenceId(manifest.id), moduleNamespace: { activate: DEVCONTAINER_PLUGIN.activate },
            isOccurrenceCurrent: () => true });
        expect(activation.status, JSON.stringify(activation.diagnostics)).toBe('active');
        const actionHandlers = new Map<string, ActionHandler>();
        for (const registration of activation.registrations) {
            // The registration host deliberately erases author callback inputs at capture.
            if (registration.family === 'actions') actionHandlers.set(registration.localId, registration.value as ActionHandler);
        }
        for (const action of manifest.contributes.actions) if (!actionHandlers.has(action.id)) {
            actionHandlers.set(action.id, async () => { throw new Error('Client-only Action must not run on the controller'); });
        }
        const nativeRequests: string[][] = [];
        const unavailableManaged = createUnavailableManagedServices();
        const managedServices = createManagedServicesOwner({ processSupervisorHost: createManagedServiceProcessSupervisorHost({}),
            resolveScope: seed => seed, dependencies: { ...unavailableManaged.dependencies, status: async id => ({
                state: 'ready', id, version: '1.0.0', sourceId: 'system',
                executable: { kind: 'managedDependency', id: { pluginId: manifest.id, localId: id } },
            }) } });
        const invocationServices = createPluginInvocationServicesFactory({ loggerSink: { write() {} }, managedServices });
        const native = nativeCustodyFixture({ fixtureManifest: manifest, actionHandlers,
            resolveHostBinding: createTargetActionHostBindingResolver({
                createServiceBinding: (occurrence, id) => createPluginInvocationServiceBinding(occurrence, id),
            }),
            createServices: (seed, binding) => {
                const services = invocationServices(seed, binding);
                // Only installed-tool discovery and process IO cross the native boundary.
                return { ...services, exec: { ...services.exec, run: async request => {
                    nativeRequests.push([...(request.args ?? [])]);
                    expect(request.args).toEqual(['ps', '--all', '--no-trunc', '--filter',
                        `label=happier.managed-machine=${admitted.machine.id}`, '--format', '{{.ID}}']);
                    return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
                        stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
                } } };
            },
        });
        const credentials = { token: selected.token, credentialProvenance: 'stored_session' as const, encryption: null };
        const serverHttpBaseUrl = 'https://managed-seam.test';
        const operations = createHostActionOperationRuntime({ machineId: selected.controller.machineId,
            custodyBinding: { serverId: homeId, installationId: selected.controller.installationId },
            resolveAccountId: async () => selected.account.id });
        const priorSettings = await readSettings();
        await updateSettings(current => ({ ...current, servers: { ...current.servers,
            [configuration.activeServerId]: { id: configuration.activeServerId, name: 'Composed controller',
                serverUrl: serverHttpBaseUrl, webappUrl: serverHttpBaseUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
                homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverHttpBaseUrl,
                    revision: 1, endpoints: [{ kind: 'https', url: serverHttpBaseUrl }] } },
        } }));
        let cleanupAdmission: Parameters<typeof operations.handlers.getV2>[1];
        const managedMachineAction = createDaemonManagedMachineActionAdapter({ credentials,
            machineId: selected.controller.machineId, serverBaseUrl: serverHttpBaseUrl, serverId: homeId,
            managedProviderOperationAuthority: createEnrollmentJourneyProviderAuthority('/tmp/member-delete-no-provider-credentials'),
            installationIdentity: { installationId: selected.controller.installationId, privateKey: selected.keys.secretKey },
            resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: selected.controller.machineId, serverIdentityId: homeId }),
            acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry,
                source: 'active', durableRevision: 1, release: async () => {} }),
            observeActionExecution: request => operations.observeExecution({ ...request, rpcContext: cleanupAdmission }),
        });
        const storedSettings = { actionsSettingsV1: { v: 1,
            actions: { 'machines.managed.delete': { approvalRequiredSurfaces: ['cli'] } } } };
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(storedSettings),
            rawSettings: storedSettings, settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials) });
        const receiver = createCliActionExecutor({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
            serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl, runtimeActionMachineId: selected.controller.machineId,
            externalActionMachineRequestPrivateKey: selected.keys.secretKey,
            externalActionMachineInstallationId: selected.controller.installationId,
            runActionOperation: operations.runActionOperation, managedMachineAction,
        });
        let artifactWrites = 0;
        const instance = await app(async request => {
            const dispatch = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            expect(dispatch.executionAuthorization?.binding).toMatchObject({ accountId: requester.account.id,
                custodianAccountId: selected.account.id });
            const target = { id: 'controller-socket', data: { clientType: 'machine-scoped', userId: selected.account.id,
                machineId: selected.controller.machineId,
                [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: selected.controller.installationId },
                timeout: () => ({ emitWithAck: async () => { throw new Error('Socket delivery is the substituted boundary'); } }),
            };
            expect(await request.targetGuard?.filterTargets([target])).toEqual([target]);
            cleanupAdmission = { machineAdmission: await request.createMachineAdmission?.({ target }) ?? undefined };
            expect(cleanupAdmission.machineAdmission).toMatchObject({ actorAccountId: requester.account.id,
                custodianAccountId: selected.account.id, machineId: selected.controller.machineId });
            const result = await executeExternalAction({ ...dispatch, executor: receiver,
                currentAccountId: selected.account.id, currentMachineId: selected.controller.machineId,
                currentInstallationId: selected.controller.installationId, currentServerId: homeId,
                currentServerHttpBaseUrl: serverHttpBaseUrl, externalActionMachineRequestPrivateKey: selected.keys.secretKey,
                machineAdmission: cleanupAdmission.machineAdmission,
                verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                    privateKey: selected.keys.secretKey, installationId: selected.controller.installationId, serverHttpBaseUrl }),
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
                prepareRequesterAccountContext: async () => { throw new Error('Delete must not acquire member credentials'); },
            });
            if (result.kind !== 'response') throw new Error(`Daemon rejected cleanup: ${result.kind}`);
            return { ok: true, result: createExternalActionDaemonDispatchResponse(result.prepared) };
        }, http => {
            registerAccountProfileRoute(http); registerAccountEncryptionRoutes(http); artifactsRoutes(http);
            http.addHook('onRequest', async request => { if (request.method === 'POST' && request.url === '/v1/artifacts') artifactWrites++; });
            http.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: storedSettings }, version: 2 }));
        }, []);
        const restoreHttp = installAxiosFastifyAdapter({ app: instance, origin: serverHttpBaseUrl });
        try {
            const input = { homeId, managedId: admitted.machine.id, expectedRevision: admitted.machine.intentRevision,
                intent: 'delete', when: 'now', reviewedDependencies: true };
            const execution = await dispatchOriginalAccountAction({ actionId: 'machines.managed.delete', input,
                requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: selected.controller.machineId },
                credentials: { token: requester.token, credentialProvenance: 'stored_session', encryption: null },
                serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl, authority: 'present_user',
                invocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'present_user' },
                onRequesterSessionCredentialDisclosure: async () => { throw new Error('Delete must not disclose member credentials'); },
            });
            expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true, result: { managedId: admitted.machine.id } });
            const listed = operations.store.list({ accountId: requester.account.id, machineId: selected.controller.machineId });
            expect(listed.items, JSON.stringify(execution)).toHaveLength(1);
            const operationId = listed.items[0]!.operationId;
            const terminal = await operations.handlers.getV2({ operationId, waitForTerminal: true }, cleanupAdmission);
            const cleaned = await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } });
            const next = await acquire(crypto.randomUUID());
            expect(next.machine.id).not.toBe(admitted.machine.id);
            expect(next.machine.preset?.id).toBe(presetId);
            expect(cleaned).toMatchObject({ creationState: 'canceled', allocation: 'confirmed-absent', resource: null, nativeOperationRef: null });
            expect(terminal).toMatchObject({ kind: 'found', operation: { state: 'succeeded', actionId: 'machines.managed.delete',
                domainRef: { kind: 'managedMachine', id: admitted.machine.id } } });
            expect(nativeRequests).toHaveLength(1);
            for (const actionId of ['action.operations.get', 'action.operations.list'] as const) {
                const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
                const readInput = { serverId: homeId, machineId: target.machineId,
                    managed: { homeId, managedId: admitted.machine.id },
                    ...(actionId === 'action.operations.get' ? { operationId } : {}) };
                const issued = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}/execution-authorization`,
                    headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1,
                        machineId: target.machineId, envelope: { v: 1, requestId: crypto.randomUUID(), target, input: readInput } } });
                expect(issued.statusCode, issued.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
                expect(authorization.binding.managedAdmission).toMatchObject({ actionId,
                    input: { managedId: admitted.machine.id } });
                const readContext = { ...cleanupAdmission, callerInputAuthorization: authorization };
                if (actionId === 'action.operations.get') expect(await operations.handlers.getV2({ operationId }, readContext))
                    .toMatchObject({ kind: 'found', operation: { operationId, state: 'succeeded' } });
                else expect((await operations.handlers.listV2({}, readContext)).items.map(item => item.operationId)).toEqual([operationId]);
            }
            expect(artifactWrites).toBe(0);
            expect(await resolveMachineAccess({ actorAccountId: requester.account.id,
                machineId: selected.controller.machineId })).toBeNull();
        } finally {
            restoreHttp(); resetActiveAccountSettingsSnapshotForTests(); await instance.close();
            await updateSettings(current => ({ ...current, servers: priorSettings.servers }));
            await native.targetActionInvocations.dispose(); await activation.dispose(); await managedServices.dispose();
        }
    });

    it.each(['machines.managed.cancel', 'machines.managed.setup.skip'] as const)(
        'preserves terminal CLI approval through Home and the real %s boundary', async actionId => {
        const selected = await fixture(true);
        const token = await auth.createToken(selected.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const credentials = { token, credentialProvenance: 'stored_session' as const, encryption: null };
        const serverHttpBaseUrl = 'http://managed-seam.test';
        const admitted = await admitManagedAcquire({ custodianAccountId: selected.account.id,
            requesterAccountId: selected.account.id, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
                v: 1, requestId: selected.requestId, target: { kind: 'machine', machineId: selected.controller.machineId }, input: selected.input }),
            input: { input: selected.input, requestId: selected.requestId, continuationPresent: false } });
        if (actionId === 'machines.managed.setup.skip') {
            // Provider enrollment is outside this authorization composition.
            await db.managedMachine.update({ where: { id: admitted.machine.id }, data: {
                allocation: 'bound', enrolledMachineId: selected.controller.machineId,
                presetId: crypto.randomUUID(), presetRevision: 1, machineSetup: { setup: {}, state: 'pending' },
                resource: { contributionRef: selected.input.selection.launch.provider, schemaVersion: 1, value: { id: 'retained-vm' } },
            } });
        }
        const input = { homeId, managedId: admitted.machine.id, expectedIntentRevision: 0 };
        const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } });
        const storedSettings = { actionsSettingsV1: settings };
        let issuedAuthorization: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(storedSettings),
            rawSettings: storedSettings, settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials) });
        const resolveTarget = createDaemonExternalActionTargetResolver({ credentials });
        const prepareRequester = (authorization: Parameters<typeof prepareRequesterAccountActionContext>[0]['authorization']) =>
            prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
                machineId: selected.controller.machineId, installationId: selected.controller.installationId,
                installationPrivateKey: selected.keys.secretKey, serverId: homeId, serverIdentityId: homeId,
                serverHttpBaseUrl, ownCredentials: credentials, isCurrent: async () => true, createExecutor: () => receiver });
        const receiver = createCliActionExecutor({ token, credentials, sessionId: '', mode: 'plain', ctx: null,
            serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl,
            externalActionMachineRequestPrivateKey: selected.keys.secretKey,
            externalActionMachineInstallationId: selected.controller.installationId,
            managedMachineAction: createAccountServerActionDeps({ token, credentials, serverId: homeId,
                serverIdentityId: homeId, serverHttpBaseUrl,
                externalActionMachineRequestPrivateKey: selected.keys.secretKey,
                externalActionMachineInstallationId: selected.controller.installationId }).managedMachineAction,
            isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({
                accountId: selected.account.id, machineId: selected.controller.machineId, serverId: homeId,
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: selected.controller.machineId }),
                resolveTarget, isAccountCurrent: async () => true,
                listAccountApiTokens: async () => { throw new Error('Terminal roots do not list PATs'); },
                externalActionMachinePublicKey: selected.keys.publicKey,
                verifyExternalExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                    privateKey: selected.keys.secretKey, installationId: selected.controller.installationId, serverHttpBaseUrl }),
            }),
            prepareApprovalExecutionAuthorization: async ({ authorization }) => {
                const prepared = await prepareRequester(authorization);
                if (!prepared) return null;
                const { actionsSettings, ...context } = prepared;
                return { ...context, ...(actionsSettings ? { actionsSettings } : {}) };
            },
        });
        const instance = await app(async request => {
            const dispatch = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            issuedAuthorization = dispatch.executionAuthorization;
            if (!issuedAuthorization) throw new Error('Missing Home authorization');
            const result = await executeExternalAction({ ...dispatch, executor: receiver,
                currentMachineId: selected.controller.machineId, currentInstallationId: selected.controller.installationId,
                currentServerId: homeId, externalActionMachineRequestPrivateKey: selected.keys.secretKey,
                prepareRequesterAccountContext: request => prepareRequester(request.authorization),
                verifyExecutionAuthorization: async ({ authorization }) => await verifyCurrentExternalActionPrincipal(authorization.binding) !== null,
                resolveTarget });
            if (result.kind !== 'response') throw new Error(`Daemon rejected creation recovery: ${result.kind}`);
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(result.prepared) };
        }, http => {
            registerAccountProfileRoute(http); registerAccountEncryptionRoutes(http); artifactsRoutes(http);
            http.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: storedSettings }, version: 1 }));
        }, []);
        const restoreHttp = installAxiosFastifyAdapter({ app: instance, origin: serverHttpBaseUrl });
        const sockets = await createRequesterCurrentnessSocketHarness();
        try {
            const bare = await instance.inject({ method: 'POST', url: managedMachineActionEndpointPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: input });
            expect(bare.statusCode, bare.body).toBe(403);
            const other = await fixture(true);
            const foreign = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}/execution-authorization`,
                headers: { authorization: `Bearer ${other.token}` }, payload: { v: 1, machineId: selected.controller.machineId,
                    envelope: { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: selected.controller.machineId }, input } } });
            expect(foreign.statusCode, foreign.body).toBe(409);
            expect(foreign.json()).toMatchObject({ code: 'target_unavailable' });
            const sender = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId: homeId, serverIdentityId: homeId, serverApiUrl: serverHttpBaseUrl,
                actionsSettingsProvider: { getActionsSettings: () => settings, getAccountSettings: () => accountSettingsParse(storedSettings) } });
            const asked = await sender.execute(actionId, input, { surface: 'cli', authority: 'present_user' });
            expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId } });
            if (!asked.ok || !asked.result || typeof asked.result !== 'object' || !('artifactId' in asked.result)
                || typeof asked.result.artifactId !== 'string') throw new Error('Missing terminal approval');
            const artifactId = asked.result.artifactId;
            if (!issuedAuthorization) throw new Error('Missing Home authorization');
            const path = managedMachineActionEndpointPathV1(actionId);
            for (const tampered of [{ ...input, expectedIntentRevision: 99 }, { ...input, managedId: crypto.randomUUID() }]) {
                const refused = await instance.inject({ method: 'POST', url: path, payload: tampered,
                    headers: createExternalActionAuthorizedRequestHeaders({ authorization: issuedAuthorization,
                        effectActionId: actionId, target: { kind: 'machine', machineId: selected.controller.machineId },
                        installationId: selected.controller.installationId, privateKey: selected.keys.secretKey,
                        method: 'POST', path, body: tampered }) });
                expect(refused.statusCode, refused.body).toBe(401);
            }
            const decided = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => receiver.execute('approval.request.decide',
                { artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user',
                    serverId: homeId, serverIdentityId: homeId, runtimeAccountId: selected.account.id }));
            expect(decided).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } }))
                .toMatchObject(actionId === 'machines.managed.cancel' ? { creationState: 'canceled', intentRevision: 1 }
                    : { machineSetup: { state: 'skipped' } });
        } finally { restoreHttp(); await sockets.close(); resetActiveAccountSettingsSnapshotForTests(); await instance.close(); }
    });

    it.each(['cli', 'mcp'] as const)('preserves the admitted %s power root through Ask and approved controller admission', async surface => {
        const selected = await fixture(true);
        const acquireInput = ManagedAcquireInputV1Schema.parse({ ...selected.input,
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } });
        const credentials = { token: selected.token, credentialProvenance: 'stored_session' as const, encryption: null };
        const admitted = await admitManagedAcquire({ custodianAccountId: selected.account.id,
            requesterAccountId: selected.account.id, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
                v: 1, requestId: selected.requestId, target: { kind: 'machine', machineId: selected.controller.machineId }, input: acquireInput }),
            input: { input: acquireInput, requestId: selected.requestId, continuationPresent: false } });
        await db.managedMachine.update({ where: { id: admitted.machine.id }, data: { allocation: 'bound',
            resource: { contributionRef: selected.input.selection.launch.provider, schemaVersion: 1, value: { id: 'retained-vm' } } } });
        const storedSettings = { actionsSettingsV1: { v: 1, actions: {
            'machines.managed.power.set': { approvalRequiredSurfaces: ['cli', 'mcp'] },
            'machines.managed.delete': { approvalRequiredSurfaces: ['cli', 'mcp'] },
        } } };
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(storedSettings),
            rawSettings: storedSettings, settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials) });
        const phases: Array<{ phase: string; elapsedMs: number; status?: number }> = [];
        let controllerAdmissions = 0;
        // This composition ends at real Home controller admission, before native activation.
        const connection = { token: credentials.token, serverUrl: 'http://managed-seam.test', homeId,
            controller: selected.controller, externalActionMachineRequestPrivateKey: selected.keys.secretKey } as ManagedMachineAcquisitionDriverInput;
        const resolveTarget = createDaemonExternalActionTargetResolver({ credentials });
        const prepareRequester = (request: Parameters<typeof prepareRequesterAccountActionContext>[0]['authorization'], signal?: AbortSignal) =>
            prepareRequesterAccountActionContext({ authorization: request, ...(signal ? { signal } : {}),
                purpose: { kind: 'external_action' }, machineId: selected.controller.machineId,
                installationId: selected.controller.installationId, installationPrivateKey: selected.keys.secretKey,
                serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: connection.serverUrl,
                ownCredentials: credentials, isCurrent: async () => true, createExecutor: () => receiver });
        const receiver = createCliActionExecutor({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
            serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: connection.serverUrl,
            externalActionMachineRequestPrivateKey: selected.keys.secretKey,
            externalActionMachineInstallationId: selected.controller.installationId,
            isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({
                accountId: selected.account.id, machineId: selected.controller.machineId, serverId: homeId,
                // Installation identity is the OS boundary; Home verifies its actual key below.
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId,
                    machineId: selected.controller.machineId }),
                resolveTarget, isAccountCurrent: async () => true,
                listAccountApiTokens: async () => { throw new Error('Account roots do not list PATs'); },
                externalActionMachinePublicKey: selected.keys.publicKey,
                verifyExternalExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                    privateKey: selected.keys.secretKey, installationId: selected.controller.installationId,
                    serverHttpBaseUrl: connection.serverUrl }),
            }),
            prepareApprovalExecutionAuthorization: async ({ authorization, signal }) => {
                const prepared = await prepareRequester(authorization, signal);
                if (!prepared) return null;
                const { actionsSettings, ...context } = prepared;
                return { ...context, ...(actionsSettings ? { actionsSettings } : {}) };
            },
            managedMachineAction: async ({ actionId, input, context }) => {
                const client = createManagedMachineControllerClient(connection, { requestId: context.actionRequestId!, context }, actionId);
                if (actionId === 'machines.managed.get') return await client.post('/v1/machines/managed/actions/get', input, ManagedMachineV1Schema);
                const admitted = await client.post('/v1/machines/managed/controller/admit-control',
                    ManagedControlAdmissionInputV1Schema.parse({ action: actionId, input, requestId: context.actionRequestId }),
                    ManagedAdmissionOutputV1Schema);
                controllerAdmissions++;
                return { kind: 'accepted', managedId: admitted.machine.id, intentRevision: admitted.machine.intentRevision };
            },
        });
        const instance = await app(async request => {
            const dispatch = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            const result = await executeExternalAction({ ...dispatch, executor: receiver,
                currentMachineId: selected.controller.machineId, currentInstallationId: selected.controller.installationId,
                currentServerId: homeId, externalActionMachineRequestPrivateKey: selected.keys.secretKey,
                prepareRequesterAccountContext: request => prepareRequester(request.authorization, request.signal),
                verifyExecutionAuthorization: async ({ authorization }) => await verifyCurrentExternalActionPrincipal(authorization.binding) !== null,
                resolveTarget,
            });
            if (result.kind !== 'response') throw new Error(`Daemon rejected managed ingress: ${result.kind}`);
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(result.prepared) };
        }, http => {
            registerAccountProfileRoute(http);
            registerAccountEncryptionRoutes(http);
            http.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: storedSettings }, version: 2 }));
            artifactsRoutes(http);
        }, phases);
        const restoreHttp = installAxiosFastifyAdapter({ app: instance, origin: connection.serverUrl });
        const sockets = await createRequesterCurrentnessSocketHarness();
        try {
            const approvals = createCliApprovalsArtifactStore({ credentials, serverId: homeId, serverHttpBaseUrl: connection.serverUrl });
            for (const intent of ['stop', 'start', 'delete'] as const) {
                const before = await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } });
                const previousAdmissions = controllerAdmissions;
                const actionId = intent === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set';
                const result = await dispatchOriginalAccountAction({ actionId,
                    input: { homeId, managedId: admitted.machine.id, when: 'now', expectedRevision: before.intentRevision,
                        ...(intent === 'delete' ? { intent: 'delete', reviewedDependencies: true } : { intent }) },
                    requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: selected.controller.machineId }, credentials,
                    serverHttpBaseUrl: connection.serverUrl, serverIdentityId: homeId,
                    invocation: { caller: { kind: 'host' }, surface, authority: 'account_automation' }, authority: 'account_automation' });
                expect(result, JSON.stringify({ intent, phases })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId } });
                if (!result.ok || !result.result || typeof result.result !== 'object' || !('artifactId' in result.result)
                    || typeof result.result.artifactId !== 'string') throw new Error('Missing approval Artifact');
                const artifactId = result.result.artifactId;
                const request = ApprovalRequestV2Schema.parse(await runWithServerHttpBaseUrl(connection.serverUrl,
                    () => approvals.approvalsGet({ artifactId })));
                expect(controllerAdmissions).toBe(previousAdmissions);
                const decision = await runWithServerHttpBaseUrl(connection.serverUrl, () => receiver.execute('approval.request.decide',
                    { artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user', serverId: homeId,
                        serverIdentityId: homeId, runtimeAccountId: selected.account.id }));
                expect(decision, JSON.stringify({ intent, decision })).toMatchObject({ ok: true,
                    result: { status: 'executed', execution: { ok: true, result: { kind: 'accepted' } } } });
                expect(resolveApprovalExecutor(request), `${intent} must retain Home's selected controller`)
                    .toEqual({ kind: 'daemon', machineId: selected.controller.machineId });
                expect(controllerAdmissions).toBe(previousAdmissions + 1);
                expect(await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } }))
                    .toMatchObject({ desired: intent, intentRevision: before.intentRevision + 1 });
            }
        } finally { restoreHttp(); await sockets.close(); resetActiveAccountSettingsSnapshotForTests(); await instance.close(); }
    });

});
