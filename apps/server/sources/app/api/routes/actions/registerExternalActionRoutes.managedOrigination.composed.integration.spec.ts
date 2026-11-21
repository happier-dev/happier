import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { ACTION_OPERATION_CANCEL_ACTION_ID_V1, ACTION_OPERATION_GET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/operations/actionIdsV1';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/methodsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRequesterActionOperationV1 } from '@happier-dev/protocol/actions/operations/requesterReadV1';
import { resolveExternalActionExecutionMachineAdmissionInTx } from '@/app/auth/externalActionExecutionAuthorization';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { resolveMachineRetentionPolicyV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { createManagedMachinePresetAcquireOverrideV1, projectManagedMachinePresetForRecipientV1,
    openManagedMachinePresetContentV1, sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
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
import { bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
    ExternalActionExecutionAuthorizationV1Schema, ExternalActionDaemonDispatchRequestSchema, createExternalActionDaemonDispatchResponseV1, createExternalActionDaemonDispatchResponse,
    prepareExternalActionResponseEnvelopeV1, prepareExternalActionResponseV2, openExternalActionRequestV2, openExternalActionResponseV2, sealExternalActionRequestV2,
    computeActionInputApprovalDigestV1, computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sealManagedCreationActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { deriveSessionCreationTagV1, SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { ManagedAcceptedV1Schema, ManagedAcquireInputV1Schema, ManagedAdmissionOutputV1Schema, ManagedControlAdmissionInputV1Schema, ManagedControllerSubmitOutputV1Schema, managedMachineActionEndpointPathV1, managedWorkspaceAttachmentIdV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { resolveManagedMachineEnrollmentAgentIsolationV1 } from '@happier-dev/protocol/machines/managed/enrollmentIdentityV1';
import { ActionsSettingsV1Schema, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import type { ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import {
    defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema,
    MachineProvisionerPowerResultV1Schema, MachineProvisionerResizeResultV1Schema,
    MachineProvisionerNativeExecResultV1Schema, MachineProvisionerPutFileResultV1Schema, MachineProvisionerNativeStreamResultV1Schema,
} from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { createExternalActionDaemonDispatcher, type ExternalActionForwardRpcCall } from '@/app/api/socket/externalActionDispatcher';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '@/app/api/socket/machineSocketInstallationProof';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { auth } from '@/app/auth/auth';
import { verifyCurrentExternalActionPrincipal } from '@/app/auth/externalActionExecutionAuthorization';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { createPluginAvailabilityOperations } from '@/app/plugins/availability/operations';
import { resolveMachineAccess, resolveMachineAdmission } from '@/app/machines/machineAccess';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createDeploymentEnvironmentInTx } from '@/app/deployments/deploymentEnvironmentService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { inTx } from '@/storage/inTx';
import { archiveMachinePreset, createMachinePreset, readMachinePresetRecipientCensus, restoreMachinePreset, updateMachinePreset } from '@/app/machines/managed/machinePresetService';
import { storedPlainPrivateLabel } from '@/testkit/privateLabelFixture';
import { db, initDbPostgres } from '@/storage/db';
import { createDbMaintenanceClient } from '@/storage/prisma';
import { readDatabaseTransactionConfigFromEnv } from '@/config/databaseTransactions';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { deriveAccountEncryptionCurrentnessFromRow } from '@/app/encryption/accountContentKeyAdmission';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { registerDeploymentRoutes } from '../deployments/deploymentRoutes';
import { handleActionsCommand } from '../../../../../../cli/src/cli/commands/actions';
import { createCliActionExecutorFromCredentials } from '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionExecutor } from '../../../../../../cli/src/session/actions/createCliActionExecutor';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '../../../../../../cli/src/api/clientCompatibility/cliClientCompatibility';
import { executeExternalAction } from '../../../../../../cli/src/daemon/externalActions/executeExternalAction';
import type { RpcHandler } from '../../../../../../cli/src/api/rpc/types';
import { registerExternalActionRpcHandler } from '../../../../../../cli/src/rpc/handlers/externalAction';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '../../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { installAxiosFastifyAdapter } from '../../../../../../cli/src/testkit/http/axiosAdapter';
import { accountSettingsParse, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { ApprovalRequestV2Schema, resolveApprovalExecutor } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createCliApprovalsArtifactStore } from '../../../../../../cli/src/session/actions/approvals/artifactStore';
import { runWithServerHttpBaseUrl } from '../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '../../../../../../cli/src/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '../../../../../../cli/src/settings/accountSettings/accountSettingsScopeKey';
import { createAccountServerActionDeps } from '../../../../../../cli/src/api/accountServerActionDeps';
import { createActionExecutor, type ActionExecuteResult, type ActionExecutorDeps, type ActionExecutorContext } from '@happier-dev/protocol';
import { prepareReviewedChildAuthorization } from './reviewedChildAuthorization.composed.testkit';
import { seedBundledManagedAvailability } from '@/app/machines/managed/managedProjectionVolume.testkit';
import { managedQb56Input, managedQb56RequestId } from './managedQb56Input.testkit';
import { snapshotEnv, restoreEnv } from '@/testkit/env';
import { prepareManagedOpaquePresetAcquireV1, prepareManagedOpaquePresetReportV1 } from '@happier-dev/cli-common/machines/managed';
import { submitManagedAcquire, reportManagedAcquire } from '@/app/machines/managed/managedMutations';
import { admitManagedAcquire } from '@/app/machines/managed/managedAcquire';
import { createManagedMachineControllerClient, type ManagedMachineAcquisitionDriverInput } from '../../../../../../cli/src/machines/managed/acquire';
import { ManagedMachineV1Schema, isManagedOpaquePresetMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { prepareRequesterAccountActionContext } from '../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { registerAccountProfileRoute } from '../account/registerAccountProfileRoute';
import { registerAccountEncryptionRoutes } from '../account/registerAccountEncryptionRoutes';
import { createRequesterCurrentnessSocketHarness } from '../../../../../../cli/src/testkit/backends/requesterCurrentnessSocketHarness';
import { captureStdout } from '../../../../../../cli/src/testkit/logger/captureOutput';
import { artifactsRoutes } from '../artifacts/artifactsRoutes';
import { registerAutomationActionIndexRoutes } from '../automations/registerAutomationActionIndexRoutes';
import { openArtifactStoredContentBytes } from '@/app/artifacts/artifactStoredContent';
import { ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
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
import { admitManagedControl, requireManagedPolicyPurposeInTx } from '@/app/machines/managed/managedMutations';
import { cancelManagedCreation } from '@/app/machines/managed/managedRead';

const nativeVendor = vi.hoisted(() => ({ request: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>() }));
// Terminal input is the OS boundary; keep the real presenter and approval decision.
vi.mock('../../../../../../cli/src/terminal/prompts/promptInput', async importOriginal => ({
    ...await importOriginal<typeof import('../../../../../../cli/src/terminal/prompts/promptInput')>(),
    promptInput: async () => 'no',
}));

describe('composed CLI managed Action origination', () => {
    const homeId = managedQb56Input.selection.homeId;
    const capabilities = MachineOperationProtocolCapabilitiesV1Schema.parse({ externalActionExecutionAuthorization: { protocolVersions: [1] } });
    let harness: LightSqliteHarness;
    const initialEnv = snapshotEnv();
    beforeAll(async () => {
        const cliRoot = resolve(import.meta.dirname, '../../../../../../cli');
        // test-policy-boundary: resolve the importing CLI's external transport; server and CLI may own different Undici versions.
        vi.doMock(createRequire(join(cliRoot, 'package.json')).resolve('undici'), async importOriginal => {
            const original = await importOriginal<typeof import('undici')>();
            return { ...original, fetch: (url: string, init?: RequestInit) => new URL(String(url)).origin === 'https://native-provider.test'
                ? nativeVendor.request(String(url), init) : original.fetch(url, init) };
        });
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

    function createFixtureManifest(nativeControls: boolean, workspaceAttachment = false) {
        const launch = defineProtocolObject({ image: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const text = defineProtocolString({ minLength: 1 });
        const native = workspaceAttachment
            ? defineProtocolObject({ id: text, agent: text, managedId: text }, { policy: 'closed' })
            : defineProtocolObject({ id: text }, { policy: 'closed' });
        const roles = defineMachineProvisionerSchemas({ launch, resource: native });
        const actions = [
            { id: 'check', inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
            { id: 'acquire', inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
            { id: 'bootstrap', inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
            { id: 'inspect', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
            { id: 'power', inputSchema: roles.powerInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
            ...(nativeControls ? [{ id: 'resize', inputSchema: roles.resizeInput.jsonSchema, resultSchema: MachineProvisionerResizeResultV1Schema.jsonSchema }] : []),
            { id: 'destroy', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
            ...(workspaceAttachment ? [
                { id: 'exec', inputSchema: roles.execInput.jsonSchema, resultSchema: MachineProvisionerNativeExecResultV1Schema.jsonSchema },
                { id: 'put', inputSchema: roles.putFileInput.jsonSchema, resultSchema: MachineProvisionerPutFileResultV1Schema.jsonSchema },
                { id: 'stream', inputSchema: roles.streamInput.jsonSchema, resultSchema: MachineProvisionerNativeStreamResultV1Schema.jsonSchema },
            ] : []),
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
                    ...(workspaceAttachment ? {
                        workspaceAttachment: { when: { op: 'eq', path: 'image', value: 'linux' }, resourceIdentityPaths: ['id', 'agent'] },
                        bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put', stream: 'stream' },
                    } : {}),
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

    async function fixture(online: boolean, mode: 'plain' | 'e2ee' = 'plain', qb56 = false, nativeControls = false, workspaceAttachment = false) {
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
            await seedBundledManagedAvailability(account.id, homeId, controller, ['machine-lima.json']);
            const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
            // The current Lima contract derives native identity from allocation;
            // retain the capture's user choices without its old instance identity.
            const { instance: _legacyInstance, ...choices } = managedQb56Input.selection.launch.choices;
            const launch = { ...managedQb56Input.selection.launch, choices };
            const parsed = ManagedAcquireInputV1Schema.parse({ ...managedQb56Input,
                selection: { ...managedQb56Input.selection, launch },
                reviewedFacts: { ...managedQb56Input.reviewedFacts, launch } });
            if (parsed.selection.kind !== 'one-off') throw new Error('QB56 replay must retain one-off selection');
            return { account, controller, keys, token, input: { ...parsed, selection: parsed.selection }, requestId: managedQb56RequestId };
        }
        const manifest = workspaceAttachment ? createFixtureManifest(false, true)
            : nativeControls ? fixtureManifests.native : fixtureManifests.daemon;
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

    it('admits requester operation reads with one Machine carrier read and distinct signed HTTP purposes', async () => {
        const owner = await fixture(true);
        const { machineId, installationId } = owner.controller;
        const actionId = ACTION_OPERATION_GET_ACTION_ID_V1;
        const target = { kind: 'machine' as const, machineId };
        const requestId = crypto.randomUUID();
        const binding = { actionId, target, requestId, accountId: owner.account.id, serverIdentityId: homeId,
            authentication: { kind: 'account' as const, tokenEpoch: owner.account.tokenEpoch } };
        const envelope = { ...sealExternalActionRequestV2({ binding,
            material: { type: 'dataKey', machineKey: tweetnacl.randomBytes(32) },
            projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
            randomBytes: tweetnacl.randomBytes,
            input: { serverId: homeId, machineId, operationId: crypto.randomUUID() } }), requesterOperationRead: true as const };
        const instance = await app(async () => { throw new Error('Issuance and proof verification do not dispatch'); }, () => {}, []);
        // Observe the real persistence boundary without replacing its decisions or replies.
        const delegate = db.machine;
        const { findUnique, findFirst } = delegate;
        const readUnique = vi.spyOn(delegate, 'findUnique').mockImplementation(findUnique.bind(delegate));
        const readFirst = vi.spyOn(delegate, 'findFirst').mockImplementation(findFirst.bind(delegate));
        try {
            const issue = (requestEnvelope: unknown) => instance.inject({
                method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${owner.token}` },
                payload: { v: 1, machineId, envelope: requestEnvelope },
            });
            const wrongTarget = { kind: 'session' as const, sessionId: crypto.randomUUID() };
            const malformedTarget = await issue({ ...envelope, target: wrongTarget });
            expect(malformedTarget.json()).toMatchObject({ code: 'invalid_envelope', requestId });
            await expect.soft(auth.mintExternalActionExecutionAuthorization({ ...binding, machineId, target: wrongTarget,
                requesterOperationRead: true, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }))
                .rejects.toMatchObject({ code: 'invalid_envelope' });
            readUnique.mockClear();
            readFirst.mockClear();
            const issued = await issue(envelope);
            expect(issued.statusCode, JSON.stringify({ body: issued.json(),
                machineUniqueReads: readUnique.mock.calls.length, machineFirstReads: readFirst.mock.calls.length })).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(authorization.binding).toMatchObject({ machineId, installationId, custodianAccountId: owner.account.id });
            expect(authorization.requesterOperationReadInstallationPublicKey).toBe(Buffer.from(owner.keys.publicKey).toString('base64url'));
            const carrierReads = [...readUnique.mock.calls, ...readFirst.mock.calls]
                .filter(([query]) => query.where?.id === machineId);
            expect.soft(carrierReads).toHaveLength(1);

            const machinePath = `/v1/machines/${encodeURIComponent(machineId)}`;
            const verifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const signed = (method: 'GET' | 'POST', path: string, key = owner.keys.secretKey) => {
                const body = method === 'POST' ? { v: 1 } : undefined;
                return instance.inject({ method, url: path, ...(body ? { payload: body } : {}),
                    headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                        ...createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: actionId,
                            target, installationId, method, path, body, privateKey: key }) } });
            };
            expect((await signed('POST', verifyPath)).statusCode).toBe(200);
            expect((await signed('GET', machinePath)).statusCode).toBe(200);
            const otherPurpose = await signed('GET', `${machinePath}?include=unrelated`);
            expect(otherPurpose.statusCode).toBe(401);
            expect(otherPurpose.json()).toMatchObject({ authorizationRefusal: 'verification_purpose' });
            const otherSigner = await signed('GET', machinePath, tweetnacl.sign.keyPair().secretKey);
            expect(otherSigner.statusCode).toBe(401);
            expect(otherSigner.json()).toMatchObject({ authorizationRefusal: 'machine_signature' });
        } finally {
            readUnique.mockRestore();
            readFirst.mockRestore();
            // Prisma retains overridden delegate keys after a spy deletes the own descriptor.
            delegate.findUnique = findUnique;
            delegate.findFirst = findFirst;
            await instance.close();
        }
    });

    it('lets only the admitted requester stop and observe an exact received operation after the grant ends', async () => {
        const owner = await fixture(true);
        const requester = await fixture(true);
        const { machineId, installationId } = owner.controller;
        const grant = await db.machineGrant.create({ data: { principalKind: 'account', machineId,
            accountId: requester.account.id, accessLevel: 'admin', createdByAccountId: owner.account.id } });
        const admission = await resolveMachineAdmission({ machineId, actorAccountId: requester.account.id, requireOnline: true });
        expect(admission.kind).toBe('admitted');
        if (admission.kind !== 'admitted') throw new Error('Missing Machine admission');
        const { kind: _kind, ...machineAdmission } = admission;
        const pendingOperationId = crypto.randomUUID();
        const source = await inTx(tx => createProjectSourceInTx(tx, requester.account.id, {
            serverId: homeId, requestKey: crypto.randomUUID(), name: 'Pending Project', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const detail = createDeploymentEnvironmentDetailV1();
        const artifact = await createArtifact({ actorUserId: requester.account.id, artifactId: crypto.randomUUID(),
            header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Pending' })),
            body: decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(detail.content) })),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, requester.account.id, {
            serverId: homeId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machineId,
            contentArtifactId: artifact.artifact.id, contentHeaderVersion: artifact.artifact.headerVersion,
            contentBodyVersion: artifact.artifact.bodyVersion,
        }));
        if (!created.ok) throw new Error(created.error);
        const requestKey = crypto.randomUUID();
        const pendingDeploy = { t: 'plain', v: { sourceIntent: { kind: 'repository',
            projectSourceId: source.source.id, sourceRevision: source.source.revision, sha: 'a'.repeat(40),
            compose: { path: 'compose.yaml', profiles: [], services: [], primaryService: 'app' } },
            requestKey, targetLinkId: 'pending-link', actionOperationId: pendingOperationId } };
        await db.deploymentEnvironment.update({ where: { id: created.environmentId }, data: { pendingDeployContent: { pendingDeploy,
            admission: { requesterAccountId: requester.account.id, serverId: homeId, requestKey, actionOperationId: pendingOperationId,
                controller: { machineId, installationId }, environmentRevision: 2 } }, revision: { increment: 1 } } });
        const credentials = { token: owner.token, credentialProvenance: 'stored_session' as const, encryption: null };
        const storedSettings = { actionsSettingsV1: { v: 1, actions: {},
            approvalWaivedSurfaces: { [ACTION_OPERATION_CANCEL_ACTION_ID_V1]: ['cli'] } } };
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(storedSettings),
            rawSettings: storedSettings, settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials) });
        const serverHttpBaseUrl = 'http://requester-operation.test';
        const operations = createHostActionOperationRuntime({ machineId, custodyBinding: { serverId: homeId, installationId },
            resolveAccountId: async () => owner.account.id });
        const receiver = createCliActionExecutor({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
            serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl, runtimeActionMachineId: machineId,
            externalActionMachineRequestPrivateKey: owner.keys.secretKey, externalActionMachineInstallationId: installationId,
            machineActionDirectTargetTransport: { machineId, invoke: async (method, request, options) => {
                if (method === ACTION_OPERATION_RPC_METHODS_V2.get) return operations.handlers.getV2(request, options?.rpcContext);
                expect(method).toBe(ACTION_OPERATION_RPC_METHODS_V1.cancel);
                return operations.handlers.cancel(request, options?.rpcContext);
            } },
        });
        const instance = await app(async request => {
            const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            expect(request.targetUserId).toBe(owner.account.id);
            const result = await executeExternalAction({ ...admitted, executor: receiver,
                currentAccountId: owner.account.id, currentMachineId: machineId,
                currentInstallationId: installationId, currentServerId: homeId,
                currentServerHttpBaseUrl: serverHttpBaseUrl, externalActionMachineRequestPrivateKey: owner.keys.secretKey,
                ...(request.machineAdmission ? { machineAdmission: request.machineAdmission } : {}),
                verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                    privateKey: owner.keys.secretKey, installationId, serverHttpBaseUrl }),
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
                prepareRequesterAccountContext: async () => { throw new Error('Exact operation access cannot acquire requester credentials'); },
            });
            if (result.kind !== 'response') throw new Error(`Daemon rejected requester operation ingress: ${result.kind}`);
            return { ok: true, result: createExternalActionDaemonDispatchResponse(result.prepared) };
        }, http => {
            http.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
            http.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: storedSettings }, version: 2 }));
            registerAutomationActionIndexRoutes(http);
            registerDeploymentRoutes(http);
        }, []);
        const restoreHttp = installAxiosFastifyAdapter({ app: instance, origin: serverHttpBaseUrl });
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        let cancellations = 0;
        let operationId: string | undefined;
        const observed = operations.observeExecution({ actionId: 'machines.managed.acquire', input: owner.input,
            rpcContext: { machineAdmission },
            execute: async ({ signal }) => {
                signal.addEventListener('abort', () => { cancellations++; finish.resolve(); }, { once: true });
                started.resolve();
                await finish.promise;
                return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
            },
            onOperation: operation => { operationId = operation.operationId; },
        });
        try {
            await Promise.race([started.promise, observed]);
            if (!operationId) throw new Error('Missing accepted operation');
            const address = { serverId: homeId, machineId, operationId };
            await db.machineGrant.delete({ where: { id: grant.id } });
            expect(await resolveMachineAccess({ actorAccountId: requester.account.id, machineId })).toBeNull();
            const pairedCli = async (accountId: string) => {
                const token = await auth.createToken(accountId, undefined, { kind: 'terminal', authority: 'account_automation' });
                return createCliActionExecutorFromCredentials({ credentials: { token, credentialProvenance: 'stored_session', encryption: null },
                    serverId: homeId, serverIdentityId: homeId, serverApiUrl: serverHttpBaseUrl,
                    actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse(storedSettings.actionsSettingsV1),
                        getAccountSettings: () => accountSettingsParse(storedSettings) },
                });
            };
            const requesterCli = await pairedCli(requester.account.id);
            const ownerCli = await pairedCli(owner.account.id);
            const context = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: homeId, serverIdentityId: homeId } as const;
            expect(await requesterCli.execute(ACTION_OPERATION_GET_ACTION_ID_V1, address, context)).toMatchObject({
                ok: true, result: { kind: 'found', operation: { state: 'running', scope: { accountId: requester.account.id, machineId } } },
            });
            const otherStop = await ownerCli.execute(ACTION_OPERATION_CANCEL_ACTION_ID_V1, address, context);
            expect.soft(otherStop, JSON.stringify(otherStop)).toMatchObject({ ok: true, result: { kind: 'not_found' } });
            expect(cancellations).toBe(0);
            const stopped = await requesterCli.execute(ACTION_OPERATION_CANCEL_ACTION_ID_V1, address, context);
            expect(stopped, JSON.stringify(stopped)).toMatchObject({ ok: true, result: { kind: 'requested' } });
            expect(cancellations).toBe(1);
            expect(await requesterCli.execute(ACTION_OPERATION_GET_ACTION_ID_V1, { ...address, waitForTerminal: true }, context)).toMatchObject({
                ok: true, result: { kind: 'found', operation: { state: 'cancelled' } },
            });
            const retainedAddress = { ...address, operationId: pendingOperationId };
            expect(await ownerCli.execute(ACTION_OPERATION_CANCEL_ACTION_ID_V1, retainedAddress, context)).toMatchObject({
                ok: true, result: { kind: 'not_found' },
            });
            expect(await requesterCli.execute(ACTION_OPERATION_CANCEL_ACTION_ID_V1, retainedAddress, context)).toMatchObject({
                ok: true, result: { kind: 'requested' },
            });
            expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } })).pendingDeployContent).toBeNull();
        } finally {
            finish.resolve();
            await observed;
            restoreHttp();
            resetActiveAccountSettingsSnapshotForTests();
            await instance.close();
        }
    });

    async function admitPresetThroughHttp(selected: Awaited<ReturnType<typeof fixture>>,
        requester: Awaited<ReturnType<typeof fixture>>, input: ReturnType<typeof ManagedAcquireInputV1Schema.parse>, requestId: string) {
        const instance = await app(async () => { throw new Error('Only signed native admission is exercised'); }, () => {}, []);
        try {
            const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
            const envelope = { v: 1 as const, requestId, target, input };
            const issued = await instance.inject({ method: 'POST',
                url: '/v1/actions/machines.managed.acquire/execution-authorization',
                headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1, machineId: target.machineId, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const body = { requestId, input, continuationPresent: false, originalActionEnvelope: envelope,
                presetPolicy: { retention: input.retention, wakeOnAcceptedMessage: input.wakeOnAcceptedMessage } };
            const response = await instance.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit', payload: body,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: 'machines.managed.acquire',
                    target, installationId: selected.controller.installationId, method: 'POST',
                    path: '/v1/machines/managed/controller/admit', body, privateKey: selected.keys.secretKey }) });
            if (response.statusCode !== 200) throw Object.assign(new Error(response.body), { code: response.json().code });
            return ManagedAdmissionOutputV1Schema.parse(response.json());
        } finally { await instance.close(); }
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
            await db.artifact.create({ data: { id: artifactId, accountId: selected.account.id, headerVersion: 1, bodyVersion: 1,
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
            if (signer === 'signed' || signer === 'account' || signer === 'unreachable') {
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
                            target: authorization.binding.target, installationId: selected.controller.installationId,
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
            ...resolveManagedMachineEnrollmentAgentIsolationV1(parentInput.enrollmentIdentity),
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
                    actionId, requestId: admitted.envelope.requestId, target: admitted.envelope.target! } satisfies ExternalActionEncryptionBindingV2;
                const input = admitted.envelope.v === 1 ? admitted.envelope.input
                    : openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: encryptionBinding, envelope: admitted.envelope, material })?.input;
                expect(input).toEqual(childInput);
                // Substitute only delivery to the native guest; Home auth, retained
                // creation admission, CLI provenance and encrypted transport are real.
                effects++;
                const execution = { ok: true as const, result: { kind: 'accepted', operationId: 'isolation', metadataVersion: 1,
                    status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } } };
                const prepared = admitted.envelope.v === 1 ? prepareExternalActionResponseEnvelopeV1({ v: 1,
                    actionId, requestId: admitted.envelope.requestId, execution }) : prepareExternalActionResponseV2({ binding: encryptionBinding,
                        executedMachineId: guest.id, request: admitted.envelope, execution, material, randomBytes: tweetnacl.randomBytes });
                return { ok: true, result: createExternalActionDaemonDispatchResponse(prepared) };
            } catch (error) { deliveryFailure = error; throw error; }
        }, registerAccountEncryptionRoutes, phases);
        const restoreHttp = installAxiosFastifyAdapter({ app: instance, origin: 'http://managed-seam.test' });
        try {
            let admittedManagedId: string | undefined;
            const admitParent = async () => {
                const admitted = await admitManagedAcquire({ custodianAccountId: selected.account.id,
                    requesterAccountId: selected.account.id, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
                        v: 1, requestId: selected.requestId, target: { kind: 'machine', machineId: selected.controller.machineId }, input: parentInput }),
                    input: { input: parentInput, requestId: selected.requestId, continuationPresent: false } });
                admittedManagedId = admitted.machine.id;
                // Provider allocation and guest enrollment are the system boundary.
                await db.managedMachine.update({ where: { id: admitted.machine.id }, data: { allocation: 'bound',
                    enrolledMachineId: guest.id, resource: { contributionRef: selected.input.selection.launch.provider,
                        schemaVersion: 1, value: { id: 'native-guest' } } } });
                return admitted.machine.id;
            };
            const dispatchChild = async (context: ActionExecutorContext) => {
                if (!admittedManagedId) throw new Error('Managed parent did not admit the child');
                childResult = await dispatchLocalManagedMachineAgentIsolation({ actionId, input: childInput, homeId, context, credentials,
                    custodianAccountId: caller.account.id, serverHttpBaseUrl: 'http://managed-seam.test', isCurrent: async () => true,
                    managedContinuation: { managedId: admittedManagedId, creationRequestId: selected.requestId, expectedIntentRevision: 0 } });
                return childResult;
            };
            const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user',
                actionCaller: { kind: 'host' }, runtimeAccountId: caller.account.id, serverId: homeId, serverIdentityId: homeId,
                actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
                actionRequestId: selected.requestId, externalActionTarget: { kind: 'machine', machineId: selected.controller.machineId },
                presentUserConfirmation: { actionId: 'machines.managed.acquire', accountId: caller.account.id, serverId: homeId,
                    requestId: selected.requestId, target: { kind: 'machine', machineId: selected.controller.machineId },
                    inputDigest: computeActionInputApprovalDigestV1('machines.managed.acquire', parentInput) } };
            let result: ActionExecuteResult;
            if (scenario === 'declared') {
                const managedId = await admitParent();
                const prepared = await prepareReviewedChildAuthorization({ actionId: 'machines.managed.acquire', input: parentInput,
                    context, managedId, child: { action: actionId, role: actionId, input: childInput }, execute: dispatchChild });
                childResult = prepared.execution;
                result = prepared.parentExecution;
            } else {
                result = await createActionExecutor({ managedMachineAction: async ({ context }) => {
                    const managedId = await admitParent();
                    const child = await dispatchChild(context);
                    return child.ok ? { managedId } : child;
                } }).execute('machines.managed.acquire', parentInput, context);
            }
            if (deliveryFailure) throw deliveryFailure;
            expect(childResult, JSON.stringify(result)).toBeDefined();
            if (scenario === 'declared') {
                expect(childResult, JSON.stringify({ execution: childResult, phases }))
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

    it.each(['valid', 'invalid-envelope', 'qb56'] as const)('invokes managed Create through CLI and Home with %s Settings', async policy => {
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
        function createReceiver(context?: RequesterAccountActionContext) {
            const requester = context ? { token: context.credentials.token, credentials: context.credentials,
                savedSecretOperationContext: context.savedSecretOperationContext, isCredentialCurrent: context.isCurrent }
                : { token: credentials.token, credentials };
            return createCliActionExecutor({ ...requester, sessionId: '', mode: 'plain', ctx: null,
                serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: 'http://managed-seam.test',
                runtimeActionMachineId: selected.controller.machineId,
                externalActionMachineRequestPrivateKey: selected.keys.secretKey,
                externalActionMachineInstallationId: selected.controller.installationId,
                managedMachineAction: async () => { effects++; throw new Error('Create must ask before native execution'); },
            });
        }
        const receiver = createReceiver();
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
                    prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
                        purpose: { kind: 'external_action' }, machineId: selected.controller.machineId,
                        installationId: selected.controller.installationId, installationPrivateKey: selected.keys.secretKey,
                        serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: 'http://managed-seam.test',
                        ownCredentials: credentials, isCurrent: async () => true, createExecutor: createReceiver }),
                    resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
                });
                if (policy === 'invalid-envelope') {
                    // Requester custody refuses malformed Settings before the
                    // approval executor can acquire policy or create an artifact.
                    expect(result).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
                    return { ok: true, result };
                }
                if (result.kind !== 'response') throw new Error(`Daemon rejected managed ingress: ${result.kind} (${result.errorCode}): ${JSON.stringify(result.failureCause)}`);
                return { ok: true, result: createExternalActionDaemonDispatchResponseV1(result.prepared) };
            } catch (error) { deliveryFailure = error; throw error; }
        }, http => {
            registerAccountProfileRoute(http);
            registerAccountEncryptionRoutes(http);
            http.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: storedSettings },
                version: policy === 'invalid-envelope' ? 'invalid' : 2 }));
            artifactsRoutes(http);
        }, phases);
        const restoreHttp = installAxiosFastifyAdapter({ app: instance, origin: 'http://managed-seam.test' });
        const sockets = await createRequesterCurrentnessSocketHarness();
        const began = performance.now();
        const stdout = captureStdout();
        const notices = vi.spyOn(console, 'error').mockImplementation(() => {});
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
            expect(JSON.parse(stdout.text()), stdout.text()).toMatchObject(policy === 'invalid-envelope'
                ? { ok: false, kind: 'actions_invoke', error: { code: 'invalid_envelope' } }
                : { ok: false, kind: 'actions_invoke', error: { code: 'approval_rejected' } });
            for (const artifact of await db.artifact.findMany({ where: { accountId: selected.account.id } })) {
                const opened = openArtifactStoredContentBytes({ accountId: artifact.accountId, artifactId: artifact.id,
                    mode: 'plain', field: 'body', dataEncryptionKey: artifact.dataEncryptionKey, content: artifact.body });
                if (!opened) throw new Error('Approval Artifact must open in its Account mode');
                const stored = ArtifactBodyEnvelopeV1StoredSchema.parse(
                    decodePlainArtifactStoredContent(Buffer.from(opened).toString('base64')));
                if (typeof stored.body !== 'string') throw new Error('Approval Artifact must contain a text body');
                approvals.push(ApprovalRequestV2Schema.parse(JSON.parse(stored.body)));
            }
            expect(approvals).toHaveLength(policy === 'invalid-envelope' ? 0 : 1);
            if (policy !== 'invalid-envelope') {
                expect(approvals[0]).toMatchObject({ status: 'rejected', decision: { kind: 'reject' } });
                expect(notices.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
                    v: 1, ok: true, kind: 'actions_invoke', data: { kind: 'approval_request_created',
                        artifactId: expect.any(String), actionId: 'machines.managed.acquire' },
                });
            }
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
            notices.mockRestore();
            stdout.restore(); process.exitCode = previousExitCode;
            await sockets.close();
            restoreHttp(); resetActiveAccountSettingsSnapshotForTests(); await instance.close();
            if (policy === 'qb56') console.info('qb58-replay-phases', JSON.stringify(phases));
        }
    });

    it.each([{ mode: 'plain', mutation: 'none', presetMode: 'plain' }, { mode: 'e2ee', mutation: 'none', presetMode: 'plain' },
        { mode: 'plain', mutation: 'archive', presetMode: 'plain' }, { mode: 'e2ee', mutation: 'archive', presetMode: 'plain' },
        { mode: 'plain', mutation: 'edit', presetMode: 'plain' }, { mode: 'e2ee', mutation: 'edit', presetMode: 'plain' },
        { mode: 'e2ee', mutation: 'archive', presetMode: 'e2ee' },
        { mode: 'plain', mutation: 'archive', presetMode: 'plain', enrolled: true }] as const)(
      'admits a $mode Session through its exact shared preset without controller Use after $mutation ($presetMode preset, enrolled: $enrolled)', async fixtureOptions => {
        const { mode, mutation, presetMode } = fixtureOptions;
        const enrolled = 'enrolled' in fixtureOptions;
        const selected = await fixture(true, presetMode);
        const requester = await fixture(true, mode);
        const team = await db.team.create({ data: { name: 'Session compute' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: selected.account.id, role: 'owner' },
            { teamId: team.id, accountId: requester.account.id, role: 'member' },
        ] });
        const presetId = crypto.randomUUID();
        const census = presetMode === 'e2ee' ? await readMachinePresetRecipientCensus({ accountId: selected.account.id,
            authentication: { authenticationAuthority: 'present_user' }, input: { homeId,
                owner: { kind: 'team', teamId: team.id }, controller: selected.controller } }) : null;
        if (presetMode === 'e2ee' && census?.kind !== 'ready') throw new Error('Expected canonical encrypted recipient census');
        const authoredContent = { v: 1 as const, name: 'Session guest', launch: selected.input.selection.launch };
        const content = presetMode === 'plain'
            ? sealManagedMachinePresetContentV1({ presetId, mode: 'plain', content: authoredContent })
            : sealManagedMachinePresetContentV1({ presetId, mode: 'e2ee', content: authoredContent,
                recipientCensus: census!.kind === 'ready' ? census!.recipients : [], randomBytes: tweetnacl.randomBytes });
        expect(await createMachinePreset({ accountId: selected.account.id,
            authentication: { authenticationAuthority: 'present_user' }, input: {
                id: presetId, homeId, contentEncryptionMode: presetMode, ...content, owner: { kind: 'team', teamId: team.id },
                controller: selected.controller, teamAcquireDelegated: true,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            } })).toMatchObject({ kind: 'saved' });
        expect(await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: selected.controller.machineId })).toBeNull();
        const acquisition = { selection: { kind: 'preset', homeId, id: presetId, revision: 0 }, controller: selected.controller } as const;
        const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
        const spawn = { agentTarget, executionTarget: { serverId: homeId, machineId: selected.controller.machineId },
            directory: { kind: 'managed' }, sessionPlacement: { kind: 'preset', homeId, presetId } } as const;
        const actionId = SESSION_SPAWN_NEW_ACTION_ID_V1;
        const instance = await app(async () => { throw new Error('Only Home root admission is exercised'); }, () => {}, []);
        const issue = async (input: unknown, admission: ReturnType<typeof projectApiTokenSessionSpawnAdmissionV1>) => {
            const target = { kind: 'machine' as const, machineId: admission.executionTarget.machineId };
            const binding = { serverIdentityId: homeId, accountId: requester.account.id,
                authentication: { kind: 'account' as const, tokenEpoch: requester.account.tokenEpoch },
                actionId, requestId: crypto.randomUUID(), target };
            const material = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
            const envelope = { ...(mode === 'plain' ? { v: 1 as const, requestId: binding.requestId, target, input }
                : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                    binding, material, input, randomBytes: tweetnacl.randomBytes })), sessionSpawnAdmission: admission };
            const response = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}/execution-authorization`,
                headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1, machineId: target.machineId, envelope } });
            return { response, envelope };
        };
        try {
            // Ordinary owner admission remains a working control under each Account mode.
            const ordinary = { agentTarget, executionTarget: { serverId: homeId, machineId: requester.controller.machineId }, directory: { kind: 'managed' } } as const;
            const control = await issue(ordinary, projectApiTokenSessionSpawnAdmissionV1(ordinary));
            expect(control.response.statusCode).toBe(200);
            const projection = projectApiTokenSessionSpawnAdmissionV1(spawn, { managedPresetAcquisition: acquisition });
            const issued = await issue(spawn, projection);
            expect(issued.response.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.response.json());
            expect(authorization.binding).toMatchObject({ accountId: requester.account.id, custodianAccountId: selected.account.id,
                machineId: selected.controller.machineId, installationId: selected.controller.installationId,
                sessionPresetAcquisition: acquisition });
            if (mutation !== 'none') expect(authorization.binding.sessionPresetAcquisition?.admission?.presetContent).toEqual(content);
            if (mutation !== 'none') {
                const verifyBinding = async (binding?: typeof authorization.binding) => {
                    const body = { v: 1 as const, ...(binding ? { binding } : {}),
                        ...(authorization.binding.admittedMachineRole ? { admittedMachineRole: authorization.binding.admittedMachineRole } : {}) };
                    const path = `/v1/actions/${actionId}/execution-authorization/verify`;
                    return instance.inject({ method: 'POST', url: path, payload: body,
                        headers: createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: actionId,
                            target: authorization.binding.target, installationId: selected.controller.installationId,
                            privateKey: selected.keys.secretKey, method: 'POST', path, body }) });
                };
                const verifiedSnapshot = await verifyBinding(authorization.binding);
                expect(verifiedSnapshot.statusCode).toBe(200);
                const omittedSnapshot = await verifyBinding();
                expect(omittedSnapshot.statusCode).toBe(401);
                for (const changed of [
                    { ...authorization.binding.sessionPresetAcquisition!.admission!, delegated: false },
                    { ...authorization.binding.sessionPresetAcquisition!.admission!, preset: {
                        ...authorization.binding.sessionPresetAcquisition!.admission!.preset, wakeOnAcceptedMessage: true } },
                    { ...authorization.binding.sessionPresetAcquisition!.admission!, presetContent: {
                        ...authorization.binding.sessionPresetAcquisition!.admission!.presetContent,
                        content: content.content.t === 'plain' ? { t: 'plain' as const, v: { substituted: true } }
                            : { t: 'encrypted' as const, c: Buffer.alloc(64, 19).toString('base64') } } },
                    ...(presetMode === 'e2ee' ? [{ ...authorization.binding.sessionPresetAcquisition!.admission!, presetContent: {
                        ...authorization.binding.sessionPresetAcquisition!.admission!.presetContent, recipients: [] } }] : []),
                ]) {
                    const tampered = await verifyBinding({ ...authorization.binding, sessionPresetAcquisition: {
                        ...authorization.binding.sessionPresetAcquisition!, admission: changed } });
                    expect(tampered.statusCode).toBe(401);
                    expect(tampered.json()).toMatchObject({ error: 'invalid_token' });
                }
            }
            await expect(auth.mintExternalActionExecutionAuthorization(authorization.binding, { input: spawn }))
                .rejects.toMatchObject({ code: 'credential_scope_denied' });
            const presetContentOverride = presetMode === 'plain' ? createManagedMachinePresetAcquireOverrideV1({ presetId, mode: 'plain',
                projection: projectManagedMachinePresetForRecipientV1({ ...content, recipientAccountId: selected.account.id }),
                enrollmentIdentity: selected.input.enrollmentIdentity }) : undefined;
            const childInput = ManagedAcquireInputV1Schema.parse({ ...acquisition, ...(presetContentOverride ? { presetContentOverride } : {}),
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
            const unboundAdmission = { custodianAccountId: selected.account.id, requesterAccountId: requester.account.id,
                requestEnvelopeDigest: authorization.binding.requestEnvelopeDigest,
                input: { requestId: authorization.binding.requestId, input: childInput, acquisitionMode: 'resource-bound' as const,
                    continuationPresent: false, originalActionEnvelope: issued.envelope } };
            await expect(admitManagedAcquire(unboundAdmission)).rejects.toMatchObject({ code: 'invalid_request' });
            await expect(admitManagedAcquire({ ...unboundAdmission, sessionPresetAcquisition: {
                ...acquisition, selection: { ...acquisition.selection, revision: 1 },
            } })).rejects.toMatchObject({ code: 'invalid_request' });
            const child = async (input: typeof childInput, root = authorization, envelope = issued.envelope,
                requestId = root.binding.requestId) => {
                const body = { requestId, input, ...(enrolled ? {} : { acquisitionMode: 'resource-bound' }),
                    continuationPresent: enrolled, originalActionEnvelope: envelope };
                const path = '/v1/machines/managed/controller/admit';
                return instance.inject({ method: 'POST', url: path, payload: body,
                    headers: createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: 'machines.managed.acquire',
                        target: root.binding.target, installationId: selected.controller.installationId,
                        privateKey: selected.keys.secretKey, method: 'POST', path, body,
                        reviewedChild: { actionId: 'machines.managed.acquire', role: 'acquire-session-sandbox',
                            inputDigest: computeActionInputApprovalDigestV1('machines.managed.acquire', input) } }) });
            };
            const substitutedChild = await child(ManagedAcquireInputV1Schema.parse({ ...childInput,
                selection: { ...acquisition.selection, revision: 1 } }));
            expect(substitutedChild.statusCode).toBe(401);
            expect(substitutedChild.json()).toMatchObject({ error: 'invalid_token' });
            if (enrolled) {
                // This controller cannot enroll for a Session root without the admitted preset, even for its own Account.
                const ownRoot = ExternalActionExecutionAuthorizationV1Schema.parse(control.response.json());
                const unboundInput = ManagedAcquireInputV1Schema.parse({ ...childInput, controller: requester.controller });
                const path = '/v1/machines/managed/controller/admit';
                const body = { requestId: ownRoot.binding.requestId, input: unboundInput, continuationPresent: true,
                    originalActionEnvelope: control.envelope };
                const withoutPreset = await instance.inject({ method: 'POST', url: path, payload: body,
                    headers: createExternalActionAuthorizedRequestHeaders({ authorization: ownRoot, effectActionId: 'machines.managed.acquire',
                        target: ownRoot.binding.target, installationId: requester.controller.installationId,
                        privateKey: requester.keys.secretKey, method: 'POST', path, body,
                        reviewedChild: { actionId: 'machines.managed.acquire', role: 'acquire-session-sandbox',
                            inputDigest: computeActionInputApprovalDigestV1('machines.managed.acquire', unboundInput) } }) });
                expect(withoutPreset.statusCode).toBe(401);
                const wrongRequest = await child(childInput, authorization, issued.envelope, crypto.randomUUID());
                expect(wrongRequest.statusCode).toBe(401);
            }
            // The admitted Session retains its exact snapshot through its first allocation.
            const change = { accountId: selected.account.id, authentication: { authenticationAuthority: 'present_user' as const },
                input: { homeId, id: presetId, expectedRevision: 0 } };
            if (mutation !== 'none') expect(mutation === 'archive' ? await archiveMachinePreset(change) : await updateMachinePreset({ ...change,
                input: { ...change.input, patch: { wakeOnAcceptedMessage: true } } })).toMatchObject({ kind: 'saved' });
            const admittedChild = await child(childInput);
            expect(admittedChild.statusCode).toBe(200);
            expect(admittedChild.json()).toMatchObject({ replayed: false, machine: { enrollmentAccountId: requester.account.id,
                custodianAccountId: selected.account.id, preset: { id: presetId, revision: 0 }, wakeOnAcceptedMessage: false } });
            if (enrolled) {
                const { machine } = ManagedAdmissionOutputV1Schema.parse(admittedChild.json());
                const guestId = requester.controller.machineId;
                // Native allocation and enrollment publish the retained actual Guest.
                await db.managedMachine.update({ where: { id: machine.id }, data: { allocation: 'bound', enrolledMachineId: guestId } });
                const continuation = { managedId: machine.id, creationRequestId: authorization.binding.requestId,
                    expectedIntentRevision: machine.intentRevision };
                const guestInput = { agentTarget, executionTarget: { serverId: homeId, machineId: guestId }, directory: { kind: 'managed' } } as const;
                const plainEnvelope = { v: 1 as const, requestId: authorization.binding.requestId,
                    target: { kind: 'machine' as const, machineId: guestId }, input: guestInput,
                    sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(guestInput) };
                const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user',
                    creationKey: SessionCreationKeyV1Schema.parse('original-creation') });
                const guestEnvelope = sealManagedCreationActionCodecV1({ authorization, actionId, continuation, envelope: plainEnvelope,
                    recipient: { ...requester.controller, installationPublicKey: Buffer.from(requester.keys.publicKey).toString('base64url') },
                    sessionCreationTag, randomBytes: tweetnacl.randomBytes });
                const relay = async (envelope = guestEnvelope, managedContinuation = continuation) => {
                    const path = bindExternalActionExecutionAuthorizationHttpPathV1(actionId);
                    const body = { v: 1 as const, machineId: guestId, envelope, managedContinuation };
                    return instance.inject({ method: 'POST', url: path, payload: body,
                        headers: createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: actionId,
                            target: authorization.binding.target, installationId: selected.controller.installationId,
                            privateKey: selected.keys.secretKey, method: 'POST', path, body }) });
                };
                const guest = await relay();
                expect(guest.statusCode, guest.body).toBe(200);
                expect(ExternalActionExecutionAuthorizationV1Schema.parse(guest.json()).binding).toMatchObject({
                    accountId: requester.account.id, custodianAccountId: requester.account.id, machineId: guestId,
                    managedContinuation: { ...continuation, controller: selected.controller,
                        acquireRequestEnvelopeDigest: authorization.binding.requestEnvelopeDigest },
                });
                expect((await relay(plainEnvelope)).statusCode).not.toBe(200);
                expect((await relay(guestEnvelope, { ...continuation, expectedIntentRevision: machine.intentRevision + 1 })).statusCode).not.toBe(200);
            }
            const absent = await issue(spawn, projectApiTokenSessionSpawnAdmissionV1(spawn));
            expect(absent.response.statusCode).toBe(409);
            for (const altered of [
                { ...acquisition, selection: { ...acquisition.selection, id: crypto.randomUUID() } },
                { ...acquisition, selection: { ...acquisition.selection, revision: acquisition.selection.revision + 2 } },
                { ...acquisition, controller: { ...selected.controller, machineId: crypto.randomUUID() } },
                { ...acquisition, controller: { ...selected.controller, installationId: crypto.randomUUID() } },
            ]) {
                const refused = await issue(spawn, { ...projection, managedPresetAcquisition: altered });
                expect(refused.response.statusCode).toBe(409);
            }
            const direct = { agentTarget, executionTarget: spawn.executionTarget, directory: spawn.directory };
            const directProjection = projectApiTokenSessionSpawnAdmissionV1(direct);
            expect((await issue(direct, directProjection)).response.statusCode).toBe(409);
            if (mode === 'plain') {
                const staleCapture = await issue(direct, projection);
                expect(staleCapture.response.statusCode).toBe(409);
                const changedInput = await issue({ ...spawn, sessionPlacement: { ...spawn.sessionPlacement, presetId: crypto.randomUUID() } }, projection);
                expect(changedInput.response.statusCode).toBe(409);
            }
            // Withdrawal applies at the next root; the accepted carrier consumes its signed tuple.
            expect(await resolveExternalActionExecutionMachineAdmissionInTx(db, {
                actorAccountId: requester.account.id, machineId: selected.controller.machineId, actionId,
                executionBinding: authorization.binding, envelope: issued.envelope,
            })).toMatchObject({ kind: 'admitted', installationId: selected.controller.installationId });
            const withdrawn = await issue(spawn, projection);
            expect(withdrawn.response.statusCode).toBe(mutation === 'none' ? 200 : 409);
        } finally { await instance.close(); }
    });

    it('binds a probed workspace only from its exact signed installed controller before retention', async () => {
        const selected = await fixture(true, 'plain', false, false, true);
        // The daemon has reported its installed occurrence, and its asynchronous declaration claim is pending.
        await db.accountPluginIntent.delete({ where: { accountId_pluginId: {
            accountId: selected.account.id, pluginId: selected.input.selection.launch.provider.pluginId,
        } } });
        const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
        const input = { ...selected.input, selection: { ...selected.input.selection, attachWorkspace: true as const,
            retention: { kind: 'unused' as const, afterMs: 60_000, effect: 'delete' as const }, wakeOnAcceptedMessage: true } };
        const envelope = { v: 1 as const, requestId: selected.requestId, target, input };
        const path = '/v1/machines/managed/controller/admit';
        const rows = () => db.managedMachine.count({ where: { homeId, admittedActionRequestId: envelope.requestId } });
        const instance = await app(async () => { throw new Error('Only signed native admission is exercised'); }, () => {}, []);
        try {
            const issued = await instance.inject({ method: 'POST',
                url: '/v1/actions/machines.managed.acquire/execution-authorization',
                headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1, machineId: target.machineId, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const managedId = managedWorkspaceAttachmentIdV1(homeId, selected.account.id, envelope.requestId);
            const resource = { contributionRef: input.selection.launch.provider, schemaVersion: 1,
                value: { id: 'chosen', agent: 'main', managedId } };
            const preparedAttachment = { resource, platform: { os: 'linux', arch: 'x64', home: '/home/guest' } };
            const body = { requestId: envelope.requestId, input, continuationPresent: false, originalActionEnvelope: envelope, preparedAttachment };
            const post = (payload: unknown, privateKey = selected.keys.secretKey) => instance.inject({
                method: 'POST', url: path, payload: JSON.stringify(payload),
                headers: { 'content-type': 'application/json', ...createExternalActionAuthorizedRequestHeaders({
                    authorization, effectActionId: 'machines.managed.acquire', target,
                    installationId: selected.controller.installationId, method: 'POST', path, body: payload, privateKey,
                }) },
            });
            expect(await rows()).toBe(0);
            expect((await post(body, tweetnacl.sign.keyPair().secretKey)).statusCode).toBe(401);
            expect((await post({ ...body, input: { ...input, selection: { ...input.selection,
                launch: { ...input.selection.launch, choices: { image: 'different' } } } } })).statusCode).toBe(403);
            expect((await post({ requestId: envelope.requestId, input,
                continuationPresent: false, originalActionEnvelope: envelope })).statusCode).toBe(403);
            const pending = await post(body);
            expect(pending.statusCode, pending.body).toBe(409);
            expect(pending.json()).toEqual({ code: 'provider_unavailable' });
            expect(await rows()).toBe(0);
            await createPluginAvailabilityOperations().claimCollectionWriters({ accountId: selected.account.id,
                input: { manifest: selected.manifest }, publisher: selected.controller });
            const bound = await post(body);
            expect(bound.statusCode, bound.body).toBe(200);
            const accepted = ManagedAdmissionOutputV1Schema.parse(bound.json());
            expect(accepted).toMatchObject({ replayed: false, machine: {
                id: managedId, allocation: 'bound', resource,
                workspaceAttachment: preparedAttachment.platform, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
            expect(accepted.machine).not.toHaveProperty('guestCli');
            expect(accepted.machine).not.toHaveProperty('enrolledMachineId');
            const replay = await post(body);
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toMatchObject({ replayed: true, machine: { id: accepted.machine.id } });
            expect(await rows()).toBe(1);
            const attachAgain = async (nativeId: string, agent = 'main') => {
                const nextInput = { ...input, selection: { ...input.selection,
                    launch: { ...input.selection.launch, name: 'Renamed workspace' } } };
                const nextEnvelope = { ...envelope, input: nextInput, requestId: crypto.randomUUID() };
                const issued = await instance.inject({ method: 'POST',
                    url: '/v1/actions/machines.managed.acquire/execution-authorization',
                    headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1, machineId: target.machineId, envelope: nextEnvelope } });
                expect(issued.statusCode, issued.body).toBe(200);
                const nextAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
                const payload = { ...body, input: nextInput, requestId: nextEnvelope.requestId, originalActionEnvelope: nextEnvelope,
                    preparedAttachment: { ...preparedAttachment, resource: { ...resource, value: { id: nativeId, agent,
                        managedId: managedWorkspaceAttachmentIdV1(homeId, selected.account.id, nextEnvelope.requestId) } } } };
                const response = await instance.inject({ method: 'POST', url: path, payload: JSON.stringify(payload),
                    headers: { 'content-type': 'application/json', ...createExternalActionAuthorizedRequestHeaders({
                        authorization: nextAuthorization, effectActionId: 'machines.managed.acquire', target,
                        installationId: selected.controller.installationId, method: 'POST', path, body: payload, privateKey: selected.keys.secretKey,
                    }) },
                });
                expect(response.statusCode, response.body).toBe(200);
                return ManagedAdmissionOutputV1Schema.parse(response.json());
            };
            const reopened = await attachAgain('chosen');
            expect(reopened).toMatchObject({ replayed: true, machine: { id: accepted.machine.id, resource } });
            expect((await attachAgain('other')).machine.id).not.toBe(accepted.machine.id);
            expect((await attachAgain('chosen', 'secondary')).machine.id).not.toBe(accepted.machine.id);
            const row = await db.managedMachine.findUniqueOrThrow({ where: { id: accepted.machine.id } });
            const selection = { homeId, managedId: row.id };
            await expect(requireManagedPolicyPurposeInTx(db, row, { kind: 'retention' }, { admission: true }))
                .rejects.toMatchObject({ code: 'permission_denied' });
            await expect(cancelManagedCreation({ actorAccountId: selected.account.id, input: { ...selection, expectedIntentRevision: 0 } }))
                .rejects.toMatchObject({ code: 'native_intent_unsupported' });
            await expect(admitManagedControl({ actorAccountId: selected.account.id, custodianAccountId: selected.account.id,
                input: { action: 'machines.managed.delete', requestId: crypto.randomUUID(),
                    input: { ...selection, intent: 'delete', when: 'now', reviewedDependencies: true, expectedRevision: 0 } } }))
                .rejects.toMatchObject({ code: 'native_intent_unsupported' });
            const retired = await admitManagedControl({ actorAccountId: selected.account.id, custodianAccountId: selected.account.id,
                input: { action: 'machines.managed.retire', requestId: crypto.randomUUID(),
                    input: { ...selection, expectedIntentRevision: 0, manualResponsibility: true } } });
            expect(retired.machine).toMatchObject({ archivedAt: expect.any(Number), allocation: 'bound', resource });
            const reopenedAfterRetire = await attachAgain('chosen');
            expect(reopenedAfterRetire.replayed).toBe(false);
            expect(reopenedAfterRetire.machine.id).not.toBe(accepted.machine.id);
        } finally { await instance.close(); }
    });

    it('preserves foreign controller Manage for one-off acquire admission', async () => {
        const selected = await fixture(true);
        const requester = await fixture(true);
        await db.machineGrant.create({ data: { principalKind: 'account', machineId: selected.controller.machineId,
            accountId: requester.account.id, accessLevel: 'admin', createdByAccountId: selected.account.id } });
        const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: selected.input };
        const instance = await app(async () => { throw new Error('Only native HTTP admission is exercised'); }, () => {}, []);
        try {
            const issued = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire/execution-authorization',
                headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1, machineId: target.machineId, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            let authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(authorization.binding.managedAcquireDelegation).toBeUndefined();
            const attach = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire/execution-authorization',
                headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1, machineId: target.machineId,
                    envelope: { ...envelope, requestId: crypto.randomUUID(), input: { ...selected.input,
                        selection: { ...selected.input.selection, attachWorkspace: true } } } } });
            expect(attach.statusCode, attach.body).toBe(409);
            expect(attach.json()).toMatchObject({ code: 'target_unavailable' });
            const body = { requestId: envelope.requestId, input: selected.input, continuationPresent: false };
            const admitted = await instance.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit', payload: body,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: 'machines.managed.acquire', target,
                    installationId: selected.controller.installationId, method: 'POST', path: '/v1/machines/managed/controller/admit',
                    body, privateKey: selected.keys.secretKey }) });
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(admitted.json()).toMatchObject({ replayed: false, machine: {
                enrollmentAccountId: requester.account.id, custodianAccountId: selected.account.id } });
            await db.machineGrant.deleteMany({ where: { machineId: selected.controller.machineId, accountId: requester.account.id } });
            const reissued = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire/execution-authorization',
                headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1, machineId: target.machineId, envelope } });
            expect(reissued.statusCode, reissued.body).toBe(200);
            authorization = ExternalActionExecutionAuthorizationV1Schema.parse(reissued.json());
            expect(authorization.binding.managedAcquireDelegation).toBeUndefined();
            const replayed = await instance.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit', payload: body,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: 'machines.managed.acquire', target,
                    installationId: selected.controller.installationId, method: 'POST', path: '/v1/machines/managed/controller/admit',
                    body, privateKey: selected.keys.secretKey }) });
            expect(replayed.statusCode, replayed.body).toBe(200);
            expect(replayed.json()).toMatchObject({ replayed: true, machine: { id: admitted.json().machine.id } });
        } finally { await instance.close(); }
    });

    it.each([['plain', 'none'], ['e2ee', 'none'], ['plain', 'member'], ['plain', 'owner'], ['plain', 'member-archived'], ['plain', 'member-equal'], ['plain', 'pool-manager'], ['plain', 'manager'], ['e2ee', 'manager']] as const)(
        'admits omitted preset policy only from the exact signed native root (%s, Session source=%s)', async (mode, sessionSource) => {
        const selected = await fixture(true);
        const requester = sessionSource === 'owner' ? selected : await fixture(true, mode);
        const team = await db.team.create({ data: { name: 'Native policy Team' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: selected.account.id, role: 'owner' },
            ...(requester.account.id === selected.account.id ? [] : [{ teamId: team.id, accountId: requester.account.id, role: 'member' }]),
        ] });
        const poolId = sessionSource === 'pool-manager' ? crypto.randomUUID() : undefined;
        if (poolId) {
            await db.machinePool.create({ data: { id: poolId, accountId: selected.account.id, teamId: team.id,
                name: 'Managed controller pool', members: { create: { machineId: selected.controller.machineId, priorityTier: 0 } } } });
        }
        if (poolId || sessionSource === 'manager') {
            await db.machineGrant.create({ data: { principalKind: 'account', machineId: selected.controller.machineId,
                accountId: requester.account.id, accessLevel: 'admin', createdByAccountId: selected.account.id } });
            expect(await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: selected.controller.machineId }))
                .toMatchObject({ role: 'manage' });
        }
        const id = crypto.randomUUID();
        const content = { t: 'plain' as const, v: { v: 1, name: 'Private native policy', launch: selected.input.selection.launch } };
        expect(await createMachinePreset({ accountId: selected.account.id,
            authentication: { authenticationAuthority: 'present_user' }, input: {
                id, homeId, owner: { kind: 'team', teamId: team.id }, contentEncryptionMode: 'plain', content, recipients: [],
                ...(poolId ? { controllerPoolId: poolId } : { controller: selected.controller }), teamAcquireDelegated: true,
            } })).toMatchObject({ kind: 'saved' });
        const policy = resolveMachineRetentionPolicyV1({ billing: { location: 'cloud', stoppedBilling: 'billed' },
                nativeCapabilities: { supportedIntents: ['delete'], finiteOnly: true } });
        let input = ManagedAcquireInputV1Schema.parse({ selection: { kind: 'preset', homeId, id, revision: 0 },
            controller: selected.controller,
            ...(sessionSource === 'member-equal' ? { retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage } : {}),
            presetContentOverride: { content: { ...content,
                v: { ...content.v, enrollmentIdentity: selected.input.enrollmentIdentity } } } });
        const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
        const binding = { serverIdentityId: homeId, accountId: requester.account.id,
            authentication: { kind: 'account' as const, tokenEpoch: requester.account.tokenEpoch },
            actionId: 'machines.managed.acquire', requestId: crypto.randomUUID(), target };
        const material = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
        let envelope = mode === 'plain' ? { v: 1 as const, requestId: binding.requestId, target, input }
            : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                binding, material, input, randomBytes: tweetnacl.randomBytes });
        let deliveries = 0;
        const instance = await app(async () => {
            deliveries++;
            return { ok: true, result: {
                kind: 'invalid_request', errorCode: 'present_user_required', requestId: binding.requestId,
            } };
        }, () => {}, []);
        try {
            const issue = (session?: Readonly<{ origin: ReturnType<typeof SessionActionRpcOriginV1Schema.parse>;
                source: typeof selected.controller; privateKey: Uint8Array }>) => instance.inject({ method: 'POST',
                url: '/v1/actions/machines.managed.acquire/execution-authorization', headers: { authorization: `Bearer ${requester.token}` },
                payload: { v: 1, machineId: target.machineId, envelope, ...(session ? {
                    sessionActionOrigin: session.origin, sessionActionSource: session.source,
                    installationProof: signMachineInstallationProof({ privateKey: session.privateKey,
                        payload: { version: 1, accountId: requester.account.id, ...session.source,
                            externalActionOrigin: { homeId, actionId: binding.actionId, requestId: binding.requestId,
                                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: session.origin } } }),
                } : {}) } });
            const presetDelegate = db.managedMachinePreset;
            const originalFindFirst = presetDelegate.findFirst;
            let presetReads = 0;
            // Count the real database boundary; keep admission and signing real.
            presetDelegate.findFirst = ((...args: Parameters<typeof originalFindFirst>) => {
                presetReads += 1;
                return originalFindFirst.apply(presetDelegate, args);
            }) as typeof originalFindFirst;
            let issued;
            try {
                issued = await issue();
            } finally { presetDelegate.findFirst = originalFindFirst; }
            expect(issued.statusCode, issued.body).toBe(200);
            const initialPresetReads = presetReads;
            let authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            if (sessionSource === 'manager' && mode === 'e2ee') {
                // The custodian opens omitted policy. Relay must reach that boundary before a managed row exists.
                const refused = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
                    headers: { authorization: `Bearer ${selected.token}` },
                    payload: { v: 1, machineId: target.machineId, envelope, executionAuthorization: authorization } });
                expect(refused.statusCode, refused.body).toBe(403);
                expect(refused.json()).toMatchObject({ error: 'credential_scope_denied' });
                expect(deliveries).toBe(0);
                const relayed = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
                    headers: { authorization: `Bearer ${requester.token}` },
                    payload: { v: 1, machineId: target.machineId, envelope, executionAuthorization: authorization } });
                expect(relayed.statusCode, relayed.body).toBe(403);
                expect(relayed.json()).toMatchObject({ error: 'present_user_required' });
                expect(deliveries).toBe(1);
                expect(await db.managedMachine.count({ where: { homeId, admittedActionRequestId: binding.requestId } })).toBe(0);
            }
            if (sessionSource !== 'pool-manager') expect(authorization.binding.managedAcquireDelegation)
                .toBe(requester.account.id !== selected.account.id && sessionSource !== 'manager' ? true : undefined);
            let sourceKeys: typeof selected.keys | undefined;
            if (sessionSource !== 'none') {
                const source = sessionSource === 'owner' ? await fixture(true) : requester;
                if (sessionSource === 'owner') await db.machine.update({ where: { id: source.controller.machineId },
                    data: { accountId: selected.account.id } });
                sourceKeys = source.keys;
                // Socket ownership is the external boundary; DB Session-source admission remains real.
                instance.resolveCurrentSessionMachine = async () => source.controller.machineId;
                const session = await db.session.create({ data: { accountId: requester.account.id,
                    tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
                await db.accessKey.create({ data: { accountId: requester.account.id,
                    machineId: source.controller.machineId, sessionId: session.id, data: 'opaque-session-key' } });
                const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
                    caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 },
                    sourceTurnId: 'native-policy-turn', callerPermissionMode: 'default', requestId: binding.requestId,
                    causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } });
                if (sessionSource === 'member-archived') {
                    expect(await archiveMachinePreset({ accountId: selected.account.id,
                        authentication: { authenticationAuthority: 'present_user' }, input: { id, homeId, expectedRevision: 0 } }))
                        .toMatchObject({ kind: 'saved', preset: { revision: 1 } });
                    // Author the predictable post-restore revision while the preset is archived.
                    input = ManagedAcquireInputV1Schema.parse({ ...input, selection: { kind: 'preset', homeId, id, revision: 2 } });
                    envelope = { v: 1, requestId: binding.requestId, target, input };
                }
                const sessionActionSource = { machineId: source.controller.machineId, installationId: source.controller.installationId };
                if (sessionSource === 'member-archived') {
                    // Construct an unqualified root while no current preset admission exists.
                    authorization = await auth.mintExternalActionExecutionAuthorization({ ...authorization.binding,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                        managedAcquireDelegation: undefined, sessionActionOrigin: origin, sessionActionSource },
                    { input, resolveCurrentSessionMachine: async () => source.controller.machineId });
                } else {
                    const sourced = await issue({ origin, source: sessionActionSource, privateKey: source.keys.secretKey });
                    expect(sourced.statusCode, sourced.body).toBe(200);
                    authorization = ExternalActionExecutionAuthorizationV1Schema.parse(sourced.json());
                }
                expect(authorization.binding).toMatchObject({ sessionActionOrigin: origin,
                    ...(sessionSource === 'member' || sessionSource === 'member-equal'
                        ? { managedAcquireDelegation: true } : {}) });
                if (sessionSource === 'member-archived') {
                    expect(authorization.binding.managedAcquireDelegation).toBeUndefined();
                    expect(await restoreMachinePreset({ accountId: selected.account.id,
                        authentication: { authenticationAuthority: 'present_user' }, input: { id, homeId, expectedRevision: 1 } }))
                        .toMatchObject({ kind: 'saved', preset: { revision: 2 } });
                }
            }
            const body = { requestId: binding.requestId, input, continuationPresent: false,
                presetPolicy: { retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage },
                originalActionEnvelope: envelope };
            const send = (payload: typeof body, privateKey = selected.keys.secretKey) => instance.inject({ method: 'POST',
                url: '/v1/machines/managed/controller/admit', payload,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: binding.actionId,
                    target, installationId: selected.controller.installationId, method: 'POST',
                    path: '/v1/machines/managed/controller/admit', body: payload, privateKey }) });
            const reissueRetained = async () => {
                const origin = authorization.binding.sessionActionOrigin;
                const source = authorization.binding.sessionActionSource;
                if (origin && (!source || !sourceKeys)) throw new Error('Missing installed Session source');
                presetReads = 0;
                let reissued;
                presetDelegate.findFirst = ((...args: Parameters<typeof originalFindFirst>) => {
                    presetReads += 1;
                    return originalFindFirst.apply(presetDelegate, args);
                }) as typeof originalFindFirst;
                try {
                    reissued = await issue(origin && source && sourceKeys
                        ? { origin, source, privateKey: sourceKeys.secretKey } : undefined);
                } finally { presetDelegate.findFirst = originalFindFirst; }
                expect(reissued.statusCode, reissued.body).toBe(200);
                expect(presetReads).toBe(0);
                authorization = ExternalActionExecutionAuthorizationV1Schema.parse(reissued.json());
                expect(authorization.binding.managedAcquireDelegation).toBe(requester.account.id !== selected.account.id ? true : undefined);
                expect((await send(body, unrelated.keys.secretKey)).statusCode).toBe(401);
                if (sourceKeys && sessionSource !== 'owner' && sessionSource !== 'member-equal') {
                    const row = await db.managedMachine.findUniqueOrThrow({ where: { homeId_admittedActionRequestId: {
                        homeId, admittedActionRequestId: binding.requestId } } });
                    await db.managedMachine.update({ where: { id: row.id }, data: { custodianAccountId: unrelated.account.id } });
                    try {
                        expect((await send(body, sourceKeys.secretKey)).statusCode).toBe(401);
                        expect(await db.managedMachine.count({ where: { homeId, admittedActionRequestId: binding.requestId } })).toBe(1);
                    } finally {
                        await db.managedMachine.update({ where: { id: row.id }, data: { custodianAccountId: row.custodianAccountId } });
                    }
                }
                const replayed = await send(body, sourceKeys?.secretKey ?? selected.keys.secretKey);
                expect(replayed.statusCode, replayed.body).toBe(200);
                expect(replayed.json()).toMatchObject({ replayed: true });
                const changedRoot = await send({ ...body, originalActionEnvelope: { ...envelope, idempotencyKey: 'changed-retained-root' } });
                expect(changedRoot.statusCode, changedRoot.body).toBe(403);
            };
            const unrelated = await fixture(true);
            expect((await send(body, unrelated.keys.secretKey)).statusCode).toBe(401);
            const changed = { ...body, input: { ...input, selection: { ...input.selection, revision: 1 } } };
            expect((await send(changed)).statusCode).toBe(403);
            const changedEnvelope = { ...body, originalActionEnvelope: { ...envelope, idempotencyKey: 'foreign-root' } };
            expect((await send(changedEnvelope)).statusCode).toBe(403);
            const requesterOnly = await instance.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit', payload: body,
                headers: { authorization: `Bearer ${requester.token}` } });
            expect(requesterOnly.statusCode).toBe(403);
            if (sessionSource === 'member' || sessionSource === 'member-archived') {
                if (!sourceKeys) throw new Error('Missing member Session source keys');
                const forged = await send({ ...body,
                    presetPolicy: { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true } }, sourceKeys.secretKey);
                expect(forged.statusCode, forged.body).toBe(sessionSource === 'member-archived' ? 403 : 401);
                if (sessionSource === 'member-archived') {
                    expect(forged.json()).toMatchObject({ code: 'permission_denied' });
                    expect(await db.managedMachine.count({ where: { homeId, admittedActionRequestId: binding.requestId } })).toBe(0);
                    const unqualifiedAuthorization = authorization;
                    const origin = authorization.binding.sessionActionOrigin;
                    const source = authorization.binding.sessionActionSource;
                    if (!origin || !source) throw new Error('Missing installed Session source');
                    const qualified = await issue({ origin, source, privateKey: sourceKeys.secretKey });
                    expect(qualified.statusCode, qualified.body).toBe(200);
                    authorization = ExternalActionExecutionAuthorizationV1Schema.parse(qualified.json());
                    expect(authorization.binding.managedAcquireDelegation).toBe(true);
                    const admitted = await send(body);
                    expect(admitted.statusCode, admitted.body).toBe(200);
                    expect(admitted.json()).toMatchObject({ replayed: false, machine: { retention: policy.retention, wakeOnAcceptedMessage: false } });
                    await reissueRetained();
                    expect(await archiveMachinePreset({ accountId: selected.account.id,
                        authentication: { authenticationAuthority: 'present_user' }, input: { id, homeId, expectedRevision: 2 } }))
                        .toMatchObject({ kind: 'saved', preset: { revision: 3 } });
                    authorization = unqualifiedAuthorization;
                    const replayed = await send(body, sourceKeys.secretKey);
                    expect(replayed.statusCode, replayed.body).toBe(200);
                    expect(replayed.json()).toMatchObject({ replayed: true, machine: { id: admitted.json().machine.id } });
                    return;
                }
            }
            expect(await db.managedMachine.count({ where: { homeId, admittedActionRequestId: binding.requestId } })).toBe(0);
            await db.managedMachinePreset.update({ where: { id }, data: { retentionOverride: { kind: 'until-delete' } } });
            expect((await send(body)).statusCode).toBe(403);
            await db.managedMachinePreset.update({ where: { id }, data: { retentionOverride: null } });
            const accepted = await send(body);
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(initialPresetReads).toBe(requester.account.id === selected.account.id ? 0 : 1);
            expect(authorization.binding.managedAcquireDelegation).toBe(requester.account.id !== selected.account.id
                && sessionSource !== 'manager' ? true : undefined);
            expect(ManagedAdmissionOutputV1Schema.parse(accepted.json()).machine).toMatchObject({
                retention: policy.retention, wakeOnAcceptedMessage: false, custodianAccountId: selected.account.id,
                enrollmentAccountId: requester.account.id });
            expect(accepted.json().machine).not.toHaveProperty('launch');
            expect((await send(body)).json()).toMatchObject({ replayed: true });
            if (sessionSource === 'owner') {
                if (!sourceKeys) throw new Error('Missing owner Session source keys');
                const ownSource = await send(body, sourceKeys.secretKey);
                expect(ownSource.statusCode, ownSource.body).toBe(200);
            }
            await reissueRetained();
            const row = await db.managedMachine.findUniqueOrThrow({ where: { homeId_admittedActionRequestId: { homeId, admittedActionRequestId: binding.requestId } } });
            const { presetContentOverride: _override, ...computeInput } = input;
            expect(row.admittedInput).toMatchObject({ computeInput, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) });
            if (sessionSource === 'member-equal') expect(row.admittedInput).toMatchObject({
                computeInput: { retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage } });
            else expect(row.admittedInput).not.toHaveProperty('computeInput.retention');
        } finally { await instance.close(); }
    });

    it.each([
        { mode: 'plain', delegated: true, surface: 'cli' }, { mode: 'e2ee', delegated: true, surface: 'cli' },
        { mode: 'plain', delegated: true, surface: 'ui' }, { mode: 'plain', delegated: false, surface: 'ui' },
    ] as const)('consumes only admitted delegation with custodian credentials under approval policy ($mode, $surface, delegated=$delegated)', async ({ mode, delegated, surface }) => {
        const selected = await fixture(true);
        const requester = await fixture(true, mode);
        const otherMember = mode === 'e2ee' ? await fixture(true, mode) : null;
        const team = await db.team.create({ data: { name: 'Reviewed Team compute' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: selected.account.id, role: 'owner' },
            { teamId: team.id, accountId: requester.account.id, role: 'member' },
            ...(otherMember ? [{ teamId: team.id, accountId: otherMember.account.id, role: 'member' as const }] : []),
        ] });
        if (!delegated) await db.machineGrant.create({ data: { principalKind: 'account', machineId: selected.controller.machineId,
            accountId: requester.account.id, accessLevel: 'admin', createdByAccountId: selected.account.id } });
        const presetId = crypto.randomUUID();
        const presetContent = sealManagedMachinePresetContentV1({ presetId, mode: 'plain',
            content: { v: 1, name: 'Delegated guest', launch: selected.input.selection.launch }, randomBytes: tweetnacl.randomBytes });
        const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({ presetId, mode: 'plain',
            projection: projectManagedMachinePresetForRecipientV1({ ...presetContent, recipientAccountId: selected.account.id }),
            enrollmentIdentity: selected.input.enrollmentIdentity });
        expect(presetContentOverride).not.toBeNull();
        expect(await createMachinePreset({ accountId: selected.account.id,
            authentication: { authenticationAuthority: 'present_user' }, input: {
                id: presetId, homeId, contentEncryptionMode: 'plain', ...presetContent, owner: { kind: 'team', teamId: team.id },
                controller: selected.controller, teamAcquireDelegated: delegated,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            } })).toMatchObject({ kind: 'saved' });
        const access = await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: selected.controller.machineId });
        if (delegated) expect(access).toBeNull();
        else expect(access).toMatchObject({ role: 'manage' });
        const input = ManagedAcquireInputV1Schema.parse({ presetContentOverride,
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
        const signedMachineLookups: Array<{ kind: string; ownMachine: boolean; status: number; phase?: string }> = [];
        const operations = createHostActionOperationRuntime({ machineId: target.machineId,
            custodyBinding: { serverId: homeId, installationId: selected.controller.installationId },
            resolveAccountId: async () => selected.account.id });
        const receiver = createCliActionExecutor({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
            serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl,
            runtimeActionMachineId: selected.controller.machineId,
            externalActionMachineRequestPrivateKey: selected.keys.secretKey,
            externalActionMachineInstallationId: selected.controller.installationId,
            machineActionDirectTargetTransport: { machineId: target.machineId, invoke: async (method, request, options) => {
                expect(method).toBe(ACTION_OPERATION_RPC_METHODS_V2.get);
                return operations.handlers.getV2(request, options?.rpcContext);
            } },
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
                if (otherMember) {
                    expect(context.machineAdmission?.actorAccountId).toBe(requester.account.id);
                    const observed = await operations.observeExecution({ actionId, input, rpcContext: context, actionContext: context,
                        actionRequestId: binding.requestId, execute: async ({ operationAcceptance }) => {
                            if (!operationAcceptance) throw new Error('Missing operation observer');
                            const result = { managedId: row.id, operation: { operationId: operationAcceptance.operationId } };
                            operationAcceptance.accept(result);
                            return { ok: true, result };
                        } });
                    if (!observed.ok) throw new Error(observed.errorCode);
                    return observed.result;
                }
                return { managedId: row.id };
            },
        });
        const instance = await app(async request => {
            const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            expect(request.targetUserId).toBe(selected.account.id);
            const read = admitted.actionId === ACTION_OPERATION_GET_ACTION_ID_V1;
            expect(admitted.executionAuthorization?.binding).toMatchObject({
                accountId: admitted.principal.accountId,
                custodianAccountId: selected.account.id });
            if (!read) expect(admitted.principal.accountId).toBe(requester.account.id);
            const authorization = admitted.executionAuthorization;
            if (read && authorization?.binding.requesterOperationRead && 'authentication' in authorization.binding) {
                const path = `/v1/machines/${encodeURIComponent(target.machineId)}`;
                const lookup = async (path: string) => instance.inject({ method: 'GET', url: path,
                    headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                        ...createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: ACTION_OPERATION_GET_ACTION_ID_V1,
                            target, installationId: selected.controller.installationId, method: 'GET', path,
                            privateKey: selected.keys.secretKey }) } });
                const exact = await lookup(path);
                signedMachineLookups.push({ kind: authorization.binding.authentication.kind,
                    ownMachine: authorization.binding.accountId === selected.account.id, status: exact.statusCode,
                    phase: exact.statusCode === 401 ? exact.json().authorizationRefusal : undefined });
                const unrelated = await lookup(`${path}?include=unrelated`);
                expect(unrelated.statusCode).toBe(401);
                expect(unrelated.json()).toMatchObject({ authorizationRefusal: 'verification_purpose' });
            }
            const result = await executeExternalAction({ ...admitted, executor: receiver,
                currentAccountId: selected.account.id, currentMachineId: selected.controller.machineId,
                currentInstallationId: selected.controller.installationId, currentServerId: homeId,
                currentServerHttpBaseUrl: serverHttpBaseUrl, externalActionMachineRequestPrivateKey: selected.keys.secretKey,
                ...(request.machineAdmission ? { machineAdmission: request.machineAdmission } : {}),
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
                const wrongController = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}/execution-authorization`,
                    headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1, machineId: other.id,
                        envelope: { ...envelope, target: { kind: 'machine', machineId: other.id } } } });
                expect(wrongController.statusCode, wrongController.body).toBe(409);
                expect(wrongController.json()).toMatchObject({ code: 'target_unavailable' });
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
            if (otherMember) {
                const operationId = execution?.ok ? ManagedAcceptedV1Schema.parse(execution.result).operation?.operationId : undefined;
                if (!operationId) throw new Error('Missing accepted operation');
                const address = { serverId: homeId, machineId: target.machineId, operationId, waitForTerminal: true as const };
                const read = (member: typeof requester) => readRequesterActionOperationV1({ input: address,
                    accountId: member.account.id, serverIdentityId: homeId, tokenEpoch: member.account.tokenEpoch,
                    requestId: crypto.randomUUID(), randomBytes: tweetnacl.randomBytes,
                    request: async (url, payload) => {
                        const response = await instance.inject({ method: 'POST', url, payload,
                            headers: { authorization: `Bearer ${member.token}` } });
                        return { status: response.statusCode, value: response.json() };
                    },
                });
                expect.soft(await read(requester)).toMatchObject({ ok: true, result: { kind: 'found', operation: {
                    operationId, state: 'succeeded', scope: { accountId: requester.account.id, machineId: target.machineId },
                } } });
                expect.soft(await read(otherMember)).toMatchObject({ ok: true, result: { kind: 'not_found' } });
                const browserOwnMachine = await read(selected);
                expect.soft(browserOwnMachine, JSON.stringify(browserOwnMachine)).toMatchObject({ ok: true, result: { kind: 'not_found' } });
                const readWithPairedCli = async (member: typeof requester) => {
                    const token = await auth.createToken(member.account.id, undefined,
                        { kind: 'terminal', authority: 'account_automation' });
                    const pairedCli = createCliActionExecutorFromCredentials({
                        credentials: { token, credentialProvenance: 'stored_session', encryption: null },
                        serverId: homeId, serverIdentityId: homeId, serverApiUrl: serverHttpBaseUrl,
                        actionsSettingsProvider: {
                            getActionsSettings: () => ActionsSettingsV1Schema.parse(storedSettings.actionsSettingsV1),
                            getAccountSettings: () => accountSettingsParse(storedSettings),
                        },
                    });
                    return pairedCli.execute(ACTION_OPERATION_GET_ACTION_ID_V1, address, {
                        surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                        serverId: homeId, serverIdentityId: homeId, actionRequestId: crypto.randomUUID(),
                    });
                };
                const ownRead = await readWithPairedCli(requester);
                expect.soft(ownRead, JSON.stringify(ownRead)).toMatchObject({ ok: true, result: { kind: 'found', operation: {
                    operationId, state: 'succeeded', scope: { accountId: requester.account.id, machineId: target.machineId },
                } } });
                expect.soft(await readWithPairedCli(otherMember)).toMatchObject({ ok: true, result: { kind: 'not_found' } });
                expect.soft(await readWithPairedCli(selected)).toMatchObject({ ok: true, result: { kind: 'not_found' } });
                expect(signedMachineLookups).toEqual([
                    { kind: 'account', ownMachine: false, status: 404 },
                    { kind: 'account', ownMachine: false, status: 404 },
                    { kind: 'account', ownMachine: true, status: 200 },
                    { kind: 'terminal', ownMachine: false, status: 404 },
                    { kind: 'terminal', ownMachine: false, status: 404 },
                    { kind: 'terminal', ownMachine: true, status: 200 },
                ]);
                expect(await resolveMachineAccess({ actorAccountId: otherMember.account.id, machineId: target.machineId })).toBeNull();
            }
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
        const presetContent = sealManagedMachinePresetContentV1({ presetId, mode: 'plain',
            content: { v: 1, name: 'Creator guest', launch: selected.input.selection.launch }, randomBytes: tweetnacl.randomBytes });
        const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({ presetId, mode: 'plain',
            projection: projectManagedMachinePresetForRecipientV1({ ...presetContent, recipientAccountId: selected.account.id }),
            enrollmentIdentity: selected.input.enrollmentIdentity });
        expect(presetContentOverride).not.toBeNull();
        expect(await createMachinePreset({ accountId: selected.account.id,
            authentication: { authenticationAuthority: 'present_user' }, input: {
                id: presetId, homeId, contentEncryptionMode: 'plain', ...presetContent, owner: { kind: 'team', teamId: team.id },
                controller: selected.controller, teamAcquireDelegated: true,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            } })).toMatchObject({ kind: 'saved' });
        const acquireInput = ManagedAcquireInputV1Schema.parse({ presetContentOverride,
            selection: { kind: 'preset', homeId, id: presetId, revision: 0 }, controller: selected.controller,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const admitted = await admitPresetThroughHttp(selected, creator ? requester : selected, acquireInput, selected.requestId);
        if (actionId === 'machines.managed.delete') {
            if (!isManagedOpaquePresetMachineV1(admitted.machine)) throw new Error('Expected opaque preset admission');
            const prepared = await prepareManagedOpaquePresetAcquireV1({ content: presetContent.content,
                override: presetContentOverride, provisioner: fixtureManifests.daemon.contributes.machineProvisioners![0],
                open: content => openManagedMachinePresetContentV1({ presetId, mode: 'plain', content }) });
            if (!prepared) throw new Error('Expected valid admitted preset content');
            const reported = prepareManagedOpaquePresetReportV1({ machine: admitted.machine,
                content: prepared.content, opened: prepared.opened, recipients: presetContent.recipients,
                accountId: selected.account.id, randomBytes: tweetnacl.randomBytes,
                nativeResult: { kind: 'bound', resource: { contributionRef: selected.input.selection.launch.provider,
                    schemaVersion: 1, value: { id: 'creator-native-resource' } } } });
            if (!reported) throw new Error('Expected sealed native acquisition snapshot');
            const correlation = { homeId, managedId: admitted.machine.id, expectedIntentRevision: 0,
                requestId: selected.requestId, controller: selected.controller };
            await submitManagedAcquire(correlation);
            await reportManagedAcquire({ ...correlation, result: { kind: 'bound' }, presetContent: reported.content });
        }
        if (manage) await db.machineGrant.create({ data: { principalKind: 'account', machineId: selected.controller.machineId,
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
                if (request.actionId === 'machines.managed.cancel' || request.actionId === 'machines.managed.get')
                    return accountActions.managedMachineAction!(request);
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
                await db.machineGrant.create({ data: { principalKind: 'account', machineId: selected.controller.machineId,
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
                : { ok: false, errorCode: actionId === 'machines.managed.cancel' ? 'credential_scope_denied' : 'approval_origin_unavailable' });
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
        const presetContent = sealManagedMachinePresetContentV1({ presetId, mode: 'plain',
            content: { v: 1, name: 'One container at a time', launch: {
                provider: { pluginId: manifest.id, localId: 'devcontainer' }, schemaVersion: 1, name: 'Recovery container',
                choices: { runtime: 'docker', configuration: { kind: 'image', image: 'ubuntu:24.04' } } } },
            randomBytes: tweetnacl.randomBytes });
        const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({ presetId, mode: 'plain',
            projection: projectManagedMachinePresetForRecipientV1({ ...presetContent, recipientAccountId: selected.account.id }),
            enrollmentIdentity: selected.input.enrollmentIdentity });
        expect(presetContentOverride).not.toBeNull();
        expect(await createMachinePreset({ accountId: selected.account.id,
            authentication: { authenticationAuthority: 'present_user' }, input: {
                id: presetId, homeId, contentEncryptionMode: 'plain', ...presetContent, owner: { kind: 'team', teamId: team.id },
                controller: selected.controller, teamAcquireDelegated: true, simultaneousLimit: { maximum: 1 },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            } })).toMatchObject({ kind: 'saved' });
        const acquireInput = ManagedAcquireInputV1Schema.parse({ presetContentOverride,
            selection: { kind: 'preset', homeId, id: presetId, revision: 0 }, controller: selected.controller,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const acquire = (requestId: string) => admitPresetThroughHttp(selected, requester, acquireInput, requestId);
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

    it('executes an Account-approved agent install on the Manage requester’s exact Machine after a terminal Ask', async () => {
        const owner = await fixture(true);
        const member = await fixture(true);
        const machineId = owner.controller.machineId;
        const installationId = owner.controller.installationId;
        await db.machineGrant.create({ data: { principalKind: 'account', machineId, accountId: member.account.id,
            accessLevel: 'admin', createdByAccountId: owner.account.id } });
        const credentials = { token: member.token, credentialProvenance: 'stored_session' as const, encryption: null };
        const terminalToken = await auth.createToken(member.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const ownerCredentials = { ...credentials, token: owner.token };
        const serverHttpBaseUrl = 'http://managed-seam.test';
        const actionId = 'machines.agents.install';
        const input = { machineId, agentId: 'opencode', intent: 'install', consent: { vendorRecipe: true } };
        const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } });
        const storedSettings = { actionsSettingsV1: settings };
        const actionsSettingsProvider = { getActionsSettings: () => settings, getAccountSettings: () => accountSettingsParse(storedSettings) };
        const resolveTarget = createDaemonExternalActionTargetResolver({ credentials: ownerCredentials });
        const verifyExecutionAuthorization = (request: Omit<Parameters<typeof verifyExternalActionExecutionAuthorizationCurrent>[0],
            'privateKey' | 'installationId' | 'serverHttpBaseUrl'>) =>
            verifyExternalActionExecutionAuthorizationCurrent({ ...request, privateKey: owner.keys.secretKey, installationId, serverHttpBaseUrl });
        const prepareRequester = (authorization: Parameters<typeof prepareRequesterAccountActionContext>[0]['authorization']) =>
            prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
                machineId, installationId, installationPrivateKey: owner.keys.secretKey, serverId: homeId, serverIdentityId: homeId,
                serverHttpBaseUrl, ownCredentials: ownerCredentials, isCurrent: async () => true, createExecutor: () => receiver });
        const installed: unknown[] = [];
        const receiver = createCliActionExecutorFromCredentials({ credentials, machineId, serverId: homeId,
            serverIdentityId: homeId, serverApiUrl: serverHttpBaseUrl, pluginActionExecutionOwner: 'current_process',
            externalActionMachineRequestPrivateKey: owner.keys.secretKey, externalActionMachineInstallationId: installationId,
            actionsSettingsProvider, isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({
                accountId: member.account.id, machineId, serverId: homeId,
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId }),
                resolveTarget, isAccountCurrent: async () => true,
                listAccountApiTokens: async () => { throw new Error('An Account approval cannot use a PAT'); },
                externalActionMachinePublicKey: owner.keys.publicKey, verifyExternalExecutionAuthorization: verifyExecutionAuthorization,
            }),
            machineActionDirectTargetTransport: { machineId, invoke: async (method, payload, options) => {
                expect(method).toBe(RPC_METHODS.DAEMON_AGENTS_INSTALL_START);
                const admission = options?.rpcContext?.machineAdmission;
                expect(admission).toMatchObject({ actorAccountId: member.account.id, custodianAccountId: owner.account.id,
                    machineId, installationId, role: 'manage' });
                installed.push(payload);
                return { ok: true, jobId: 'approved-opencode-install' };
            } },
        });
        let receive: RpcHandler | undefined;
        registerExternalActionRpcHandler({ registerHandler: (_method, handler) => { receive = handler; } }, {
            executor: receiver, machineId, resolveAccountId: async () => owner.account.id,
            resolveInstallationId: () => installationId, currentServerId: homeId, currentServerHttpBaseUrl: serverHttpBaseUrl,
            externalActionMachineRequestPrivateKey: owner.keys.secretKey, verifyExecutionAuthorization, resolveTarget,
            prepareRequesterAccountContext: request => prepareRequester(request.authorization),
        });
        const phases: Array<{ phase: string; elapsedMs: number; status?: number }> = [];
        const instance = await app(async request => {
            if (!receive) throw new Error('Missing daemon RPC handler');
            const socket = { id: 'controller-socket', data: { clientType: 'machine-scoped', userId: owner.account.id, machineId,
                [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: installationId },
                timeout: () => ({ emitWithAck: async () => { throw new Error('Socket delivery is the substituted boundary'); } }) };
            const machineAdmission = request.machineAdmission ?? await request.createMachineAdmission?.({ target: socket });
            return { ok: true, result: await receive(request.callParams, { authorization: request.authorization,
                signal: new AbortController().signal,
                ...(machineAdmission ? { machineAdmission } : {}) }) };
        }, http => {
            registerAccountProfileRoute(http);
            registerAccountEncryptionRoutes(http);
            registerAutomationActionIndexRoutes(http);
            artifactsRoutes(http);
            http.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: storedSettings }, version: 1 }));
        }, phases);
        const restoreHttp = installAxiosFastifyAdapter({ app: instance, origin: serverHttpBaseUrl });
        const sockets = await createRequesterCurrentnessSocketHarness();
        try {
            const createSender = (token: string) => createCliActionExecutorFromCredentials({ credentials: { ...credentials, token },
                serverId: homeId, serverIdentityId: homeId, serverApiUrl: serverHttpBaseUrl, actionsSettingsProvider,
                onRequesterSessionCredentialDisclosure: async () => true });
            const terminal = createSender(terminalToken);
            const asked = await terminal.execute(actionId, input, { surface: 'cli', authority: 'present_user' });
            expect(asked, JSON.stringify({ asked, phases })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId } });
            if (!asked.ok || !asked.result || typeof asked.result !== 'object' || !('artifactId' in asked.result)
                || typeof asked.result.artifactId !== 'string') throw new Error('Missing install approval');
            expect(installed).toHaveLength(0);
            const decision = { artifactId: asked.result.artifactId, decision: 'approve' };
            const refused = await terminal.execute('approval.request.decide', decision, { surface: 'cli', authority: 'present_user' });
            expect(refused, JSON.stringify({ refused, phases })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
            expect(installed).toHaveLength(0);
            const decided = await createSender(member.token).execute('approval.request.decide', decision, { surface: 'cli', authority: 'present_user' });
            expect(decided, JSON.stringify({ decided, phases })).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
            expect(installed).toMatchObject([{ agentId: 'opencode', intent: 'install' }]);
        } finally { restoreHttp(); await sockets.close(); await instance.close(); }
    });

    it.each([
        { direction: 'Stop', intent: 'stop', previousIntent: 'start', previousPower: 'running', expectedRevision: 0 },
        { direction: 'Start', intent: 'start', previousIntent: 'stop', previousPower: 'stopped', expectedRevision: 1 },
    ] as const)('dispatches immediate $direction of an E2EE managed guest using its foreign Manage grant', async ({
        intent, previousIntent, previousPower, expectedRevision,
    }) => {
        const selected = await fixture(true, 'e2ee');
        const requester = await fixture(true, 'e2ee');
        const requesterToken = await auth.createToken(requester.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const dataKey = tweetnacl.randomBytes(32);
        const custodianKey = selected.account.contentPublicKey!;
        const recipientKey = requester.account.contentPublicKey!;
        const sealFor = (recipientPublicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey, randomBytes: tweetnacl.randomBytes,
        }));
        const ownerEnvelope = sealFor(custodianKey);
        await db.machine.update({ where: { id: selected.controller.machineId }, data: { dataEncryptionKey: ownerEnvelope } });
        await db.machineGrant.create({ data: { principalKind: 'account', machineId: selected.controller.machineId,
            accountId: requester.account.id, accessLevel: 'admin', createdByAccountId: selected.account.id } });
        await db.machineKeyEnvelope.create({ data: { machineId: selected.controller.machineId,
            recipientAccountId: requester.account.id, encryptedDataKey: sealFor(recipientKey),
            machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(ownerEnvelope),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipientKey) } });
        expect(await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: selected.controller.machineId }))
            .toMatchObject({ accessState: 'ready', owned: false, role: 'manage', encryptionMode: 'e2ee' });
        const actionId = 'machines.managed.power.set';
        const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
        const acquireInput = ManagedAcquireInputV1Schema.parse(selected.input);
        const admitted = await admitManagedAcquire({ custodianAccountId: selected.account.id,
            requesterAccountId: selected.account.id, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
                v: 1, requestId: selected.requestId, target, input: acquireInput }),
            input: { input: acquireInput, requestId: selected.requestId, continuationPresent: false } });
        await db.managedMachine.update({ where: { id: admitted.machine.id }, data: { allocation: 'bound',
            desired: previousIntent, intentRevision: expectedRevision,
            enrolledMachineId: (await fixture(true, 'e2ee')).controller.machineId,
            observation: { observedAt: Date.now(), availability: 'present', power: previousPower, storage: 'retained',
                billing: { location: 'local', stoppedBilling: 'not-billed' } },
            resource: { contributionRef: selected.input.selection.launch.provider, schemaVersion: 1, value: { id: 'retained-vm' } } } });
        const credentials = { token: selected.token, credentialProvenance: 'stored_session' as const,
            encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(17) } };
        const storedSettings = { actionsSettingsV1: { v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } } };
        const serverHttpBaseUrl = 'http://managed-seam.test';
        const connection = { token: credentials.token, serverUrl: serverHttpBaseUrl, homeId,
            controller: selected.controller, externalActionMachineRequestPrivateKey: selected.keys.secretKey } as ManagedMachineAcquisitionDriverInput;
        const phases: Array<{ phase: string; elapsedMs: number; status?: number }> = [];
        let artifactWrites = 0;
        const receiver = createCliActionExecutor({ token: credentials.token, credentials, sessionId: '', mode: 'e2ee', ctx: null,
            serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl, runtimeActionMachineId: selected.controller.machineId,
            externalActionMachineRequestPrivateKey: selected.keys.secretKey,
            externalActionMachineInstallationId: selected.controller.installationId,
            managedMachineAction: async ({ actionId, input, context }) => {
                const client = createManagedMachineControllerClient(connection, { requestId: context.actionRequestId!, context }, actionId);
                if (actionId === 'machines.managed.get') return await client.post('/v1/machines/managed/actions/get', input, ManagedMachineV1Schema);
                const result = await client.post('/v1/machines/managed/controller/admit-control',
                    ManagedControlAdmissionInputV1Schema.parse({ action: actionId, input, requestId: context.actionRequestId }),
                    ManagedAdmissionOutputV1Schema);
                return { kind: 'accepted', managedId: result.machine.id, intentRevision: result.machine.intentRevision };
            },
        });
        let receive: RpcHandler | undefined;
        registerExternalActionRpcHandler({ registerHandler: (_method, handler) => { receive = handler; } }, {
            executor: receiver, machineId: selected.controller.machineId,
            resolveAccountId: async () => selected.account.id,
            resolveInstallationId: () => selected.controller.installationId,
            currentServerId: homeId, currentServerHttpBaseUrl: serverHttpBaseUrl,
            externalActionMachineRequestPrivateKey: selected.keys.secretKey,
            verifyExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
                privateKey: selected.keys.secretKey, installationId: selected.controller.installationId, serverHttpBaseUrl }),
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
            prepareRequesterAccountContext: async () => { throw new Error('Manage power must not open requester Account custody'); },
        });
        const appInstance = await app(async request => {
            const dispatch = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            expect(dispatch.executionAuthorization?.binding).toMatchObject({ accountId: requester.account.id,
                custodianAccountId: selected.account.id, authentication: { kind: 'terminal' },
                managedAdmission: { actionId, input: { homeId, managedId: admitted.machine.id, when: 'now', intent, expectedRevision } } });
            expect(request.admittedMachineTarget).toMatchObject({ custodianAccountId: selected.account.id,
                machineId: selected.controller.machineId,
                installationId: selected.controller.installationId });
            if (!receive) throw new Error('Controller RPC handler was not registered');
            const socket = { id: 'controller-socket', data: { clientType: 'machine-scoped', userId: selected.account.id,
                machineId: selected.controller.machineId,
                [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: selected.controller.installationId },
                timeout: () => ({ emitWithAck: async () => { throw new Error('Socket delivery is the substituted boundary'); } }),
            };
            const machineAdmission = request.machineAdmission ?? await request.createMachineAdmission?.({ target: socket });
            const result = await receive(request.callParams, { authorization: request.authorization,
                ...(machineAdmission ? { machineAdmission } : {}) });
            return { ok: true, result };
        }, http => {
            registerAccountProfileRoute(http);
            registerAccountEncryptionRoutes(http);
            registerAutomationActionIndexRoutes(http);
            artifactsRoutes(http);
            http.addHook('onRequest', async request => {
                if (request.method === 'POST' && request.url === '/v1/artifacts') artifactWrites++;
            });
        }, phases);
        const restoreHttp = installAxiosFastifyAdapter({ app: appInstance, origin: serverHttpBaseUrl });
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(storedSettings),
            rawSettings: storedSettings, settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials) });
        try {
            const requestId = crypto.randomUUID();
            const input = { homeId, managedId: admitted.machine.id, intent, when: 'now', expectedRevision };
            const execution = await dispatchOriginalAccountAction({ actionId, requestId, target, input,
                credentials: { token: requesterToken, credentialProvenance: 'stored_session', encryption: null },
                serverHttpBaseUrl, serverId: homeId, serverIdentityId: homeId, authority: 'present_user',
                invocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'present_user' },
                onRequesterSessionCredentialDisclosure: async () => { throw new Error('Manage power must not disclose requester credentials'); },
            });
            expect(execution, JSON.stringify({ execution, phases })).toMatchObject({ ok: true });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } }))
                .toMatchObject({ desired: intent, intentRevision: expectedRevision + 1 });
            expect(artifactWrites).toBe(0);
        } finally { restoreHttp(); resetActiveAccountSettingsSnapshotForTests(); await appInstance.close(); }
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
            registerAutomationActionIndexRoutes(http);
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
