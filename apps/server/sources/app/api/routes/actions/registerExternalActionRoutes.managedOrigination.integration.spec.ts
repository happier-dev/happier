import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import Fastify, { type InjectOptions } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Server, Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { createPersistentTokenGenerator, decodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    MACHINE_PLAIN_DATA_KEY_MARKER, PluginManifestV2Schema, encodePlainMachineStoredContent, ManagedAcquireInputV1Schema,
    AUTHORITY_CEILING_HEADER_V1,
    SESSION_CREATION_AUTHORIZATION_HEADER_V1,
    MachineOperationProtocolCapabilitiesV1Schema,
    signMachineInstallationProof, signAccountContentKeyBindingV1,
} from '@happier-dev/protocol';
import {
    ExternalActionDaemonDispatchRequestSchema, createExternalActionDaemonDispatchResponseV1, createExternalActionDaemonDispatchResponse,
    ExternalActionRequestEnvelopeSchema,
    prepareExternalActionResponseEnvelopeV1, prepareExternalActionResponseV2, openExternalActionResponseV2,
    sealExternalActionRequestV2, ExternalActionExecutionAuthorizationV1Schema,
    bindExternalActionExecutionAuthorizationHttpPathV1, computeExternalActionRequestEnvelopeDigestV1,
    bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    signExternalActionMachineRequestV1, encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRpcRequestV1,
} from '@happier-dev/protocol/actions';
import { EXTERNAL_ACTION_REVIEWED_CHILD_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { encodeReviewedActionChildHttpProofV1, encodeExternalActionHttpBodyV1,
    EXTERNAL_ACTION_HTTP_BODY_HEADER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { MachineSetupSourcesApplyInputV1Schema, ManagedControllerContextOutputV1Schema, ManagedEnrollmentCorrelationV1Schema,
    ManagedControllerCredentialDeliveryReportV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { sealManagedCreationActionCodecV1, openManagedCreationActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import {
    defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema,
    MachineProvisionerPowerResultV1Schema,
} from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { createExternalActionDaemonDispatcher, type ExternalActionForwardRpcCall } from '@/app/api/socket/externalActionDispatcher';
import { auth } from '@/app/auth/auth';
import { projectExternalActionBoundPrincipal, verifyCurrentExternalActionPrincipal, verifyExternalActionDomainExecutionRequest,
    verifyExternalActionMachineRpcExecution, resolveExternalActionExecutionMachineAdmissionInTx,
    verifyWorkflowExternalActionRequesterAuthorization } from '@/app/auth/externalActionExecutionAuthorization';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { resolveMachineAccess, removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { db, isPrismaErrorCode } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { registerSessionCreateOrLoadRoute } from '@/app/api/routes/session/registerSessionCreateOrLoadRoute';
import { registerAccountProfileRoute } from '@/app/api/routes/account/registerAccountProfileRoute';
import { currentAccountStoredContentCompatibilityHeaders, qualifyCurrentAccountStoredContentSocket } from '@/app/api/testkit/accountStoredContentCompatibility';
import { createAuthenticatedFakeSocket, createFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '@/app/api/testkit/socketHarness';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import * as externalActionDispatcher from '@/app/api/socket/externalActionDispatcher';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { getAccountSessionSocketRoom } from '@/app/api/socketRooms';
import { inTx, type Tx } from '@/storage/inTx';
import { SessionActionRpcOriginV1Schema, SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { deriveAccountEncryptionCurrentnessFromRow } from '@/app/encryption/accountContentKeyAdmission';
import { registerManagedMachineRoutes } from '@/app/machines/managed/managedRoutes';
import { cancelManagedCreation, getManagedMachine } from '@/app/machines/managed/managedRead';
import { createMachinePreset } from '@/app/machines/managed/machinePresetService';
import { admitManagedAcquire } from '@/app/machines/managed/managedAcquire';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createNativeSessionTeamCredentialFixture, TEST_AUTHENTICATION } from '@/app/teams/credentials/sessionBinding.testkit';
import { completeSessionTeamCredentialNativeDeliveryInTx, submitSessionTeamCredentialNativeDeliveryInTx, stampSessionTeamCredentialNativeDeliveryInTx, writeSessionTeamCredentialBindingsInTx,
    readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx } from '@/app/teams/credentials/sessionBinding';
import { readSessionTeamCredentialNativeSelectionInTx } from '@/app/teams/credentials/nativeDeliveryRead';
import { admitManagedControl, submitManagedIntent, submitManagedAcquire, reportManagedAcquire,
    linkManagedEnrollmentInTx } from '@/app/machines/managed/managedMutations';
import { readManagedCredentialDeliveryAuthorityInTx } from '@/app/machines/managed/credentialDeliveryAdmission';
import { registerTeamCredentialResourceRoutes } from '@/app/teams/credentials/registerTeamCredentialResourceRoutes';
import { computeTeamCredentialNativeBindingReadDigestV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { deriveMachineSetupCombinedRunIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';

async function completeAppliedNativeDelivery(input: Parameters<typeof completeSessionTeamCredentialNativeDeliveryInTx>[1]) {
    const selected = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, input));
    if (!selected.ok) throw new Error('Expected submitted native selection');
    const cohort = await inTx(tx => readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx(tx, {
        accountId: input.accountId, request: { ...input, managedId: selected.binding.managedId }, authentication: input.authentication,
    }));
    if (!cohort.ok) throw new Error('Expected qualified submitted native cohort');
    const completion = { ...input, appliedPolicy: { ownedBindingKeys: cohort.ownedBindings.map(row => row.safeFacet.bindingKey),
        desiredBindingKeys: cohort.desiredBindings.map(row => row.safeFacet.bindingKey) } };
    return inTx(tx => completeSessionTeamCredentialNativeDeliveryInTx(tx, completion));
}

const mountedPluginInvocation = (machineId: string) => ({ kind: 'mountedPluginSurface' as const, mountedBinding: {
    pluginId: 'happier.inspector', contributionLocalId: 'inspector-page', occurrenceId: 'chosen-by-the-sender',
    sourceCustody: { kind: 'development' as const, registeredRootId: 'inspector-root' }, materializationRef: { machineId, pluginId: 'happier.inspector',
        materializationId: 'installed-inspector' } } });

describe('ordinary Account managed Action origination', () => {
    const homeId = `srv_${'a'.repeat(32)}`;
    const capabilities = MachineOperationProtocolCapabilitiesV1Schema.parse({ externalActionExecutionAuthorization: { protocolVersions: [1] } });
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-origination-', initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1' } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function fixture(online: boolean, mode: 'plain' | 'e2ee' = 'plain') {
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
        const controller = { machineId: crypto.randomUUID(), installationId: crypto.randomUUID() };
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
        const launch = defineProtocolObject({ image: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const native = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const roles = defineMachineProvisionerSchemas({ launch, resource: native });
        const actions = [
            { id: 'check', inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
            { id: 'acquire', inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
            { id: 'bootstrap', inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
            { id: 'inspect', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
            { id: 'destroy', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        ];
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'fixture.origination', version: '1.0.0',
            displayName: 'Compute', description: 'Managed origination fixture', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {
                machineProvisioners: [{ id: 'compute', title: 'Compute', icon: 'machine', resourceKind: 'VM', schemaVersion: 1,
                    launchSchema: launch.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
                    billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['delete'] },
                    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' } }],
                actions: actions.map(action => ({ ...action, title: action.id, execution: { target: 'daemon' },
                    surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' })),
            } });
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

    async function sourceFixture(selected: Readonly<{ account: Readonly<{ id: string }>;
        controller: Readonly<{ machineId: string }> }>, existingSessionId?: string) {
        const session = existingSessionId ? await db.session.findUniqueOrThrow({ where: { id: existingSessionId } })
            : await db.session.create({ data: { accountId: selected.account.id,
                tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        expect(session.accountId).toBe(selected.account.id);
        if (!existingSessionId) await expect(inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: selected.account.id,
            machineId: selected.controller.machineId, sessionId: session.id, data: 'opaque-access-key' })))
            .resolves.toMatchObject({ ok: true });
        const publisher = { data: {} };
        const presence = createSessionPublisherPresence();
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: selected.account.id, machineId: selected.controller.machineId, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const discovery = { visible: true };
        // Socket discovery is the boundary; publisher authority comes from
        // the actual persistence/presence owner, never a fixture fence.
        const io = { in: (room: string) => ({ fetchSockets: async () => discovery.visible
            && room === getAccountSessionSocketRoom(selected.account.id, session.id) ? [publisher] : [] }) } as unknown as Server;
        return { session, presence, io, discovery, publisher };
    }

    async function app(forwardRpc: ExternalActionForwardRpcCall, afterSessionAuthentication?: () => Promise<void>,
        source?: Readonly<{ io: Server; presence: ReturnType<typeof createSessionPublisherPresence>;
            afterResolution?: () => Promise<void> }>, onRequestError?: (error: Error) => void,
        homeRpc?: AppFastify['forwardRpcForUser']) {
        const instance = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        instance.setValidatorCompiler(validatorCompiler);
        instance.setSerializerCompiler(serializerCompiler);
        if (onRequestError) instance.addHook('onError', async (_request, _reply, error) => { onRequestError(error); });
        enableAuthentication(instance);
        if (homeRpc) instance.decorate('forwardRpcForUser', homeRpc);
        if (source) {
            const resolvePublisher = async (input: Readonly<{ accountId: string; sessionId: string }>) => {
                const authority = await externalActionDispatcher.resolveCurrentSessionPublisherFromServer({ ...source, ...input });
                // Interleave another genuine publisher write at the discovery
                // boundary, without replacing its admission/currentness logic.
                await source.afterResolution?.();
                return authority;
            };
            instance.decorate('resolveCurrentSessionPublisher', resolvePublisher);
            instance.decorate('resolveCurrentSessionMachine', async (input: Readonly<{ accountId: string; sessionId: string }>) =>
                (await resolvePublisher(input))?.machineId ?? null);
        }
        if (afterSessionAuthentication) instance.addHook('onRoute', options => {
            if (options.url !== '/v1/sessions') return;
            const preceding = options.preHandler;
            // HTTP boundary interleaving: retire the real DB row after the
            // actual authentication hook, before the real Session transaction.
            options.preHandler = [...(Array.isArray(preceding) ? preceding : preceding ? [preceding] : []),
                async () => { await afterSessionAuthentication(); }];
        });
        // Only the socket delivery boundary is replaced. DB, auth, schema,
        // Machine/managed admission and dispatcher remain the actual owners.
        registerExternalActionRoutes(instance, { dispatch: createExternalActionDaemonDispatcher({ io: source?.io ?? {} as Server,
            ...(source ? { sessionPublisherPresence: source.presence } : {}), forwardRpc }) });
        registerSessionCreateOrLoadRoute(instance);
        registerAccountProfileRoute(instance);
        registerManagedMachineRoutes(instance);
        registerTeamCredentialResourceRoutes(instance);
        await instance.ready();
        return instance;
    }

    it.each([false, true])('reads the requester profile for a contained connected-account Action (member: %s)', async member => {
        const selected = await fixture(true);
        const requester = member ? (await fixture(false)).account : selected.account;
        if (member) await inTx(tx => setEligibleMachineAccessGrantInTx(tx, {
            actorAccountId: selected.account.id, machineId: selected.controller.machineId,
            principal: { kind: 'account', accountId: requester.id }, level: 'admin' }));
        const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
        const input = { action: { pluginId: selected.manifest.id, localId: 'check' }, input: {} };
        const requestId = crypto.randomUUID();
        const envelope = { v: 1 as const, requestId, target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: homeId,
            accountId: requester.id, authentication: { kind: 'account', tokenEpoch: requester.tokenEpoch },
            actionId: 'action.invoke', machineId: selected.controller.machineId, target, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const instance = await app(async () => { throw new Error('Profile preparation does not dispatch an Action'); });
        const read = (path = '/v1/account/profile', effectActionId = 'connectedServices.accounts.list', keys = selected.keys) => instance.inject({
            method: 'GET', url: path, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId, target, installationId: selected.controller.installationId,
                    requestId, method: 'GET', path, privateKey: keys.secretKey }),
            },
        });
        try {
            const profile = await read();
            if (member) {
                expect(profile.statusCode).toBe(401);
                expect(profile.json()).toMatchObject({ authorizationRefusal: 'machine_admission_after_principal' });
                return;
            }
            expect(profile.statusCode, profile.body).toBe(200);
            expect(profile.json()).toMatchObject({ id: requester.id, connectedAccountsV4: [], connectedAccountGroupsV4: [] });
            expect((await read('/v1/account/profile', 'connectedServices.catalog.list')).statusCode).toBe(401);
            expect((await read('/v1/account/profile?accountId=another-account')).statusCode).toBe(401);
            expect((await read('/v1/account/profile', 'connectedServices.accounts.list', tweetnacl.sign.keyPair())).statusCode).toBe(401);
            for (const [path, body] of [['/v1/account/profile', { unexpected: true }], ['/v2/account/settings', undefined]] as const) {
                expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
                    effectActionId: 'connectedServices.accounts.list', encodedTarget: encodeExternalActionResolvedTargetV1(target),
                    method: 'GET', path, body,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'connectedServices.accounts.list', target, installationId: selected.controller.installationId,
                        requestId, method: 'GET', path, body, privateKey: selected.keys.secretKey }),
                })).toBeNull();
            }
        } finally { await instance.close(); }
    });

    it.each([['plain', false], ['e2ee', false], ['plain', true]] as const)(
        'prepares the requester profile without expanding connected inventory Machine custody (%s Account, member: %s)', async (mode, member) => {
        const actionId = 'sessions.spawn.connected_services.list';
        const selected = await fixture(true, mode);
        const requester = member ? (await fixture(false, mode)).account : selected.account;
        if (requester.id !== selected.account.id) {
            await inTx(tx => setEligibleMachineAccessGrantInTx(tx, {
                actorAccountId: selected.account.id, machineId: selected.controller.machineId,
                principal: { kind: 'account', accountId: requester.id }, level: 'admin' }));
            expect(await resolveMachineAccess({ actorAccountId: requester.id, machineId: selected.controller.machineId }))
                .toMatchObject({ role: 'manage', accessState: 'ready' });
        }
        const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
        const input = { agentId: 'codex', includeDefaults: false };
        const requestId = crypto.randomUUID();
        const envelope = { v: 1 as const, requestId, target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: homeId,
            accountId: requester.id, authentication: { kind: 'account', tokenEpoch: requester.tokenEpoch },
            actionId, machineId: selected.controller.machineId, target, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const instance = await app(async () => { throw new Error('Profile preparation does not dispatch an Action'); });
        const read = (path = '/v1/account/profile', effectActionId: string = actionId, keys = selected.keys) => instance.inject({
            method: 'GET', url: path, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId, target, installationId: selected.controller.installationId,
                    requestId, method: 'GET', path, privateKey: keys.secretKey }),
            },
        });
        try {
            const profile = await read();
            if (member) {
                // This inventory has no requester RPC placement: even a shared
                // Machine administrator cannot turn it into custodian access.
                expect(profile.statusCode).toBe(401);
                expect(profile.json()).toMatchObject({ authorizationRefusal: 'machine_admission_after_principal' });
                return;
            }
            expect(profile.statusCode, profile.body).toBe(200);
            expect(profile.json()).toMatchObject({ id: requester.id });
            for (const path of ['/v1/account/encryption/currentness', '/v2/account/settings',
                '/v1/account/entity-rows/connected-accounts/purposes']) {
                expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
                    effectActionId: actionId, encodedTarget: encodeExternalActionResolvedTargetV1(target),
                    method: 'GET', path, body: undefined, routeInput: {},
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: actionId, target, installationId: selected.controller.installationId, requestId,
                        method: 'GET', path, privateKey: selected.keys.secretKey }),
                }), path).toMatchObject({ principal: { accountId: requester.id } });
            }
            expect((await read('/v1/account/profile', actionId, tweetnacl.sign.keyPair())).statusCode).toBe(401);
            expect((await read('/v1/account/profile', 'agents.backends.list')).statusCode).toBe(401);
            expect((await read('/v1/account/profile?accountId=another-account')).statusCode).toBe(401);
            await db.machine.update({ where: { id: selected.controller.machineId }, data: { installationId: crypto.randomUUID() } });
            expect((await read()).statusCode).toBe(401);
        } finally { await instance.close(); }
    });

    it('binds a portable Account creation setup child to its retained acquire digest and enrolled guest', async () => {
        const selected = await fixture(true);
        const presetId = crypto.randomUUID();
        const setup = { scripts: [{ body: 'echo admitted' }] };
        await db.managedMachinePreset.create({ data: { id: presetId, homeId, custodianAccountId: selected.account.id,
            name: 'Portable setup', launch: selected.input.selection.launch, setup } });
        const digest = 'a'.repeat(43);
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: selected.account.id,
            controllerMachineId: null, controllerInstallationId: null, enrolledMachineId: selected.controller.machineId,
            admittedActionRequestId: selected.requestId, admittedInput: { enrollmentAccountId: selected.account.id,
                requestEnvelopeDigest: digest, machineSetup: { requestEnvelopeDigest: digest } },
            launch: selected.input.selection.launch, allocation: 'bound', resource: { contributionRef: selected.input.selection.launch.provider,
                schemaVersion: 1, value: { id: 'portable-resource' } }, presetId, presetRevision: 0,
            machineSetup: { setup, state: 'pending' }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true } });
        const sources = [{ kind: 'accountPreset', presetId, presetRevision: 0, setup }, { kind: 'direct', setup: {} }];
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target: { kind: 'machine' as const, machineId: selected.controller.machineId },
            input: { homeId, machineId: selected.controller.machineId, sources, mode: 'effects' } };
        const instance = await app(async () => { throw new Error('Proof issuance must not dispatch a native effect'); });
        const body = { v: 1, machineId: selected.controller.machineId, envelope,
            managedContinuation: { managedId: row.id, creationRequestId: selected.requestId, expectedIntentRevision: 0 } };
        const post = (payload: object = body, token = selected.token) => instance.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.setup.plan'),
            headers: { authorization: `Bearer ${token}` }, payload });
        try {
            const response = await post();
            expect(response.statusCode, response.body).toBe(200);
            const child = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(child.binding.managedContinuation).toEqual({ ...body.managedContinuation, acquireRequestEnvelopeDigest: digest });
            const pluginEnvelope = { ...envelope, pluginInvocation: mountedPluginInvocation(selected.controller.machineId) };
            const pluginChild = await post({ ...body, envelope: pluginEnvelope });
            expect(pluginChild.statusCode, pluginChild.body).toBe(403);
            expect(pluginChild.json()).toEqual({ error: 'credential_scope_denied' });
            // The refusal is the child's: the same claim stays admitted on the Account's own root.
            const { managedContinuation: _child, ...ownBody } = body;
            const ownPlugin = await post({ ...ownBody, envelope: pluginEnvelope });
            expect(ownPlugin.statusCode, ownPlugin.body).toBe(200);
            expect(ExternalActionExecutionAuthorizationV1Schema.parse(ownPlugin.json()).binding).toMatchObject({
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(pluginEnvelope) });
            const terminal = await auth.createToken(selected.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
            expect((await post(body, terminal)).statusCode).not.toBe(200);
            // Use the existing Home-token issuer, as the compatibility auth tests do.
            const seed = process.env.HANDY_MASTER_SECRET;
            if (!seed) throw new Error('test_auth_seed_unavailable');
            const legacyIssuer = await createPersistentTokenGenerator({ service: 'handy', seed });
            const legacyToken = await legacyIssuer.new({ user: selected.account.id });
            expect(await auth.verifyLegacyHomeToken(legacyToken)).toMatchObject({ legacy: true, authTokenKind: 'account' });
            const legacy = await post(body, legacyToken);
            expect(legacy.statusCode, legacy.body).toBe(403);
            expect(legacy.json()).toEqual({ error: 'credential_scope_denied' });
            expect((await post({ ...body, managedContinuation: { ...body.managedContinuation, creationRequestId: 'other-acquire' } })).statusCode).not.toBe(200);
            await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: null } });
            expect((await post()).statusCode).not.toBe(200);
        } finally { await instance.close(); }
    });

    it.each([
        { kind: 'account', mode: 'plain' }, { kind: 'terminal', mode: 'plain' }, { kind: 'terminal', mode: 'e2ee' },
    ] as const)('routes $kind/$mode Session input through committed custody during a publisher gap', async ({ kind, mode }) => {
        const selected = await fixture(true, mode);
        await db.machine.update({ where: { id: selected.controller.machineId }, data: {
            operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({ ...capabilities,
                sessionInputAdmission: { protocolVersions: [1, 2] } }),
        } });
        const source = await sourceFixture(selected);
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
        const target = { kind: 'session' as const, sessionId: source.session.id };
        const binding = (actionId: string, requestId: string) => ({ serverIdentityId: homeId,
            accountId: selected.account.id, authentication: { kind, tokenEpoch: selected.account.tokenEpoch },
            actionId, requestId, target });
        const token = await auth.createToken(selected.account.id, undefined, {
            kind, authority: kind === 'account' ? 'present_user' : 'account_automation',
        });
        expect((await source.presence.closePublisher({ socket: source.publisher })).status).toBe('closed');
        source.discovery.visible = false;
        expect(await externalActionDispatcher.resolveCurrentSessionMachineFromServer({
            io: source.io, presence: source.presence, accountId: selected.account.id, sessionId: source.session.id,
        })).toBeNull();
        const instance = await app(async request => {
            const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            expect(admitted.executionAuthorization?.binding).toMatchObject({
                accountId: selected.account.id, machineId: selected.controller.machineId,
                installationId: selected.controller.installationId,
                target: { kind: 'session', sessionId: source.session.id },
            });
            const execution = { ok: true as const, result: { status: 'accepted', localId: 'restart-gap-input' } };
            if (admitted.envelope.v === 2) return { ok: true, result: createExternalActionDaemonDispatchResponse(prepareExternalActionResponseV2({
                binding: binding(admitted.actionId, admitted.envelope.requestId), request: admitted.envelope,
                executedMachineId: selected.controller.machineId, execution, material, randomBytes: length => new Uint8Array(length).fill(8),
            })) };
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId: admitted.actionId, requestId: admitted.envelope.requestId,
                execution,
            })) };
        }, undefined, source);
        const input = { sessionId: source.session.id, message: 'queued during replacement', localId: 'restart-gap-input' };
        const requestId = crypto.randomUUID();
        const envelope = mode === 'plain' ? { v: 1 as const, requestId, target, input }
            : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: binding('session.message.send', requestId), material,
                input, randomBytes: length => new Uint8Array(length).fill(9) });
        const send = (actionId = 'session.message.send') => instance.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
            headers: { authorization: `Bearer ${token}` }, payload: actionId === 'session.message.send' ? envelope
                : { v: 1, requestId: crypto.randomUUID(), target, input } });
        const expectUnavailable = (response: Awaited<ReturnType<typeof send>>) => {
            if (mode === 'e2ee') expect(response.json()).toMatchObject({ code: 'target_unavailable' });
            else expect(response.json()).toMatchObject({ execution: { ok: false, errorCode: 'target_unavailable' } });
        };
        try {
            const response = await send();
            expect(response.statusCode, response.body).toBe(200);
            const opened = envelope.v === 2 ? openExternalActionResponseV2({ envelope: response.json(),
                binding: binding('session.message.send', requestId), material, request: envelope }) : response.json().execution;
            expect(opened).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'restart-gap-input' } });
            // Other Session effects still require the current publisher. Archived
            // Sessions and replacement installations cannot inherit input custody.
            expect((await send('session.stop')).json()).toMatchObject({ execution: { ok: false, errorCode: 'target_unavailable' } });
            await db.session.update({ where: { id: source.session.id }, data: { archivedAt: new Date() } });
            expectUnavailable(await send());
            await db.session.update({ where: { id: source.session.id }, data: { archivedAt: null } });
            await db.machine.update({ where: { id: selected.controller.machineId }, data: { installationId: crypto.randomUUID() } });
            expectUnavailable(await send());
        } finally { await instance.close(); }
    });

    it.each([
        ['terminal', 'account_automation'], ['account', 'account_automation'], ['account', 'present_user'],
    ] as const)('relays an original %s catalog root with %s authority only while its installation is current', async (kind, authority) => {
        const selected = await fixture(true);
        const token = await auth.createToken(selected.account.id, undefined, {
            kind, authority: kind === 'account' ? 'present_user' : 'account_automation',
        });
        const envelope = { v: 1 as const, requestId: selected.requestId,
            target: { kind: 'machine' as const, machineId: selected.controller.machineId },
            input: { homeId, controller: selected.controller } };
        // Socket delivery is the boundary; authentication, capability placement,
        // exact installed custody and currentness remain the real Home owners.
        const instance = await app(async request => {
            const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            expect(admitted.principal).toMatchObject({ accountId: selected.account.id, authority,
                authentication: { kind } });
            expect(admitted.executionAuthorization).toBeDefined();
            expect(admitted.executionAuthorization?.binding).toMatchObject(selected.controller);
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId: 'machines.provisioners.list', requestId: selected.requestId,
                execution: { ok: true, result: { controller: selected.controller, provisioners: [] } },
            })) };
        });
        const headers = { authorization: `Bearer ${token}`,
            ...(authority === 'account_automation' ? { [AUTHORITY_CEILING_HEADER_V1]: authority } : {}) };
        try {
            const direct = await instance.inject({ method: 'POST', url: '/v1/actions/machines.provisioners.list', headers,
                payload: envelope });
            expect(direct.statusCode, direct.body).toBe(200);
            const minted = await instance.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.provisioners.list'), headers,
                payload: { v: 1, machineId: selected.controller.machineId, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const executionAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const relay = () => instance.inject({ method: 'POST', url: '/v1/actions/machines.provisioners.list', headers,
                payload: { v: 1, machineId: selected.controller.machineId, envelope, executionAuthorization } });
            const current = await relay();
            expect(current.statusCode, current.body).toBe(200);
            expect(current.json()).toMatchObject({ execution: { ok: true, result: { controller: selected.controller, provisioners: [] } } });
            await db.machine.update({ where: { id: selected.controller.machineId }, data: { installationId: crypto.randomUUID(),
                installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey) } });
            const retired = await relay();
            expect(retired.statusCode, retired.body).toBe(403);
            expect(retired.json()).toMatchObject({ error: 'credential_scope_denied' });
        } finally { await instance.close(); }
    });

    it.each(['account', 'machine'] as const)(
        'originates a Provider describe %s input variant through the real Account proof route', async placement => {
            const selected = await fixture(true);
            const actionId = 'providers.connections.describe';
            const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
            const envelope = { v: 1 as const, requestId: selected.requestId, target,
                input: placement === 'machine' ? { machineId: selected.controller.machineId } : {} };
            const instance = await app(async request => {
                const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
                expect(admitted.principal).toMatchObject({ accountId: selected.account.id,
                    authentication: { kind: 'account' } });
                expect(admitted.executionAuthorization).toBeDefined();
                expect(admitted.executionAuthorization?.binding).toMatchObject({ actionId, target,
                    machineId: selected.controller.machineId });
                return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                    v: 1, actionId, requestId: selected.requestId,
                    execution: { ok: true, result: { connections: [] } },
                })) };
            });
            try {
                const headers = { authorization: `Bearer ${selected.token}` };
                const minted = await instance.inject({ method: 'POST',
                    url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId), headers,
                    payload: { v: 1, machineId: selected.controller.machineId, envelope } });
                expect(minted.statusCode, minted.body).toBe(200);
                const executionAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
                const relayed = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}`, headers,
                    payload: { v: 1, machineId: selected.controller.machineId, envelope, executionAuthorization } });
                expect(relayed.statusCode, relayed.body).toBe(200);
                expect(relayed.json()).toMatchObject({ execution: { ok: true, result: { connections: [] } } });
            } finally { await instance.close(); }
        },
    );

    it.each(['terminal', 'account'] as const)(
        'admits the original %s session fork root without inventing Session requester provenance', async kind => {
        const selected = await fixture(true);
        const { session, presence, io } = await sourceFixture(selected);
        const token = await auth.createToken(selected.account.id, undefined, {
            kind, authority: kind === 'terminal' ? 'account_automation' : 'present_user',
        });
        const actionId = 'session.fork';
        const envelope = { v: 1 as const, requestId: selected.requestId,
            target: { kind: 'session' as const, sessionId: session.id },
            input: { sessionId: session.id, strategy: 'replay', forkPoint: { type: 'latest' } } };
        const result = { sessionId: 'forked-session' };
        const instance = await app(async request => {
            const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            expect(admitted.actionId).toBe(actionId);
            expect(admitted.principal).toMatchObject({ accountId: selected.account.id, authentication: { kind } });
            expect(admitted.principal).not.toHaveProperty('sessionActionOrigin');
            expect(admitted.executionAuthorization).toBeDefined();
            expect(admitted.executionAuthorization?.binding).toMatchObject(selected.controller);
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId, requestId: selected.requestId, execution: { ok: true, result },
            })) };
        }, undefined, { io, presence });
        const headers = { authorization: `Bearer ${token}` };
        try {
            const direct = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}`, headers, payload: envelope });
            expect(direct.statusCode, direct.body).toBe(200);
            expect(direct.json()).toMatchObject({ execution: { ok: true, result } });
            const minted = await instance.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId), headers,
                payload: { v: 1, machineId: selected.controller.machineId, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const executionAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const relay = () => instance.inject({ method: 'POST', url: `/v1/actions/${actionId}`, headers,
                payload: { v: 1, machineId: selected.controller.machineId, envelope, executionAuthorization } });
            const verifyCodec = (path = `/v1/machines/${encodeURIComponent(selected.controller.machineId)}`,
                method = 'GET', body?: unknown, effectActionId = actionId) => verifyExternalActionDomainExecutionRequest({
                authorizationToken: executionAuthorization.token, effectActionId,
                encodedTarget: encodeExternalActionResolvedTargetV1(executionAuthorization.binding.target), method, path, body,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: executionAuthorization.token,
                    effectActionId, target: executionAuthorization.binding.target,
                    installationId: executionAuthorization.binding.installationId, requestId: executionAuthorization.binding.requestId,
                    method, path, body, privateKey: selected.keys.secretKey }),
            });
            expect(await verifyCodec()).toMatchObject({ binding: { actionId, target: envelope.target } });
            expect((await relay()).statusCode).toBe(200);
            expect(await verifyCodec('/v1/machines/another-machine')).toBeNull();
            expect(await verifyCodec(undefined, 'POST', {})).toBeNull();
            expect(await verifyCodec(undefined, 'GET', undefined, 'session.message.send')).toBeNull();
            await db.accessKey.deleteMany({ where: { accountId: selected.account.id,
                machineId: selected.controller.machineId, sessionId: session.id } });
            expect(await verifyCurrentExternalActionPrincipal(executionAuthorization.binding)).toBeNull();
            expect(await verifyCodec()).toBeNull();
            expect((await relay()).statusCode).toBe(403);
            await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: selected.account.id,
                machineId: selected.controller.machineId, sessionId: session.id, data: 'opaque-access-key' }));
            await db.machine.update({ where: { id: selected.controller.machineId }, data: { installationId: crypto.randomUUID(),
                installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey) } });
            expect((await relay()).statusCode).toBe(403);
        } finally { await instance.close(); }
    });

    it.each(['terminal', 'account'] as const)(
        'refuses an original %s root with no access to the target Session', async kind => {
        const selected = await fixture(true);
        const foreign = await fixture(true);
        const { session, presence, io } = await sourceFixture(foreign);
        const token = await auth.createToken(selected.account.id, undefined, {
            kind, authority: kind === 'terminal' ? 'account_automation' : 'present_user',
        });
        const envelope = { v: 1 as const, requestId: selected.requestId,
            target: { kind: 'session' as const, sessionId: session.id },
            input: { sessionId: session.id, strategy: 'replay', forkPoint: { type: 'latest' } } };
        const instance = await app(async () => { throw new Error('An inaccessible Session must never dispatch'); },
            undefined, { io, presence });
        const headers = { authorization: `Bearer ${token}` };
        try {
            const direct = await instance.inject({ method: 'POST', url: '/v1/actions/session.fork', headers, payload: envelope });
            expect(direct.statusCode).toBe(200);
            expect(direct.json()).toMatchObject({ execution: { ok: false, errorCode: 'target_unavailable' } });
            const minted = await instance.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('session.fork'), headers,
                payload: { v: 1, machineId: selected.controller.machineId, envelope } });
            expect(minted.statusCode).toBe(409);
            expect(minted.json()).toMatchObject({ error: 'invalid_request', code: 'target_unavailable' });
        } finally { await instance.close(); }
    });

    it.each(['terminal', 'account'] as const)(
        'refuses self-approval and unexposed placement for an original %s automation root', async kind => {
        const selected = await fixture(true);
        const { session, presence, io } = await sourceFixture(selected);
        const token = await auth.createToken(selected.account.id, undefined, {
            kind, authority: kind === 'terminal' ? 'account_automation' : 'present_user',
        });
        const instance = await app(async () => { throw new Error('A refused root must never dispatch'); }, undefined, { io, presence });
        const headers = { authorization: `Bearer ${token}`, [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' };
        try {
            for (const actionId of ['session.permission.respond', 'approval.request.decide', 'ui.find']) {
                const envelope = { v: 1, requestId: crypto.randomUUID(),
                    target: { kind: 'session', sessionId: session.id }, input: {} };
                for (const url of [`/v1/actions/${actionId}`, bindExternalActionExecutionAuthorizationHttpPathV1(actionId)]) {
                    const response = await instance.inject({ method: 'POST', url, headers,
                        payload: url.endsWith('/execution-authorization')
                            ? { v: 1, machineId: selected.controller.machineId, envelope } : envelope });
                    expect(response.statusCode, response.body).toBe(401);
                    expect(response.json()).toMatchObject({ error: 'invalid_token' });
                }
            }
        } finally { await instance.close(); }
    });

    it.each(['machines.work.summary.get', 'machines.terminal.list'] as const)(
        'relays the original terminal %s root with automation authority and exact installed custody', async actionId => {
        const selected = await fixture(true);
        const token = await auth.createToken(selected.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const envelope = { v: 1 as const, requestId: selected.requestId,
            target: { kind: 'machine' as const, machineId: selected.controller.machineId },
            input: { serverId: homeId, machineId: selected.controller.machineId } };
        const result = actionId === 'machines.work.summary.get' ? { kind: 'current', requesters: [] } : { ok: true, terminals: [] };
        const delivered: unknown[] = [];
        const instance = await app(async request => {
            const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            expect(admitted.actionId).toBe(actionId);
            expect(admitted.envelope).toEqual(envelope);
            expect(admitted.principal).toMatchObject({ accountId: selected.account.id, authority: 'account_automation',
                authentication: { kind: 'terminal' } });
            expect(admitted.principal).not.toHaveProperty('sessionActionOrigin');
            expect(admitted.executionAuthorization).toBeDefined();
            expect(admitted.executionAuthorization?.binding).toMatchObject(selected.controller);
            delivered.push(admitted);
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId, requestId: selected.requestId, execution: { ok: true, result },
            })) };
        });
        const headers = { authorization: `Bearer ${token}`, [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' };
        try {
            const direct = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}`, headers, payload: envelope });
            expect(direct.statusCode, direct.body).toBe(200);
            expect(direct.json()).toMatchObject({ execution: { ok: true, result } });
            const minted = await instance.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId), headers,
                payload: { v: 1, machineId: selected.controller.machineId, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const executionAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(await verifyCurrentExternalActionPrincipal(executionAuthorization.binding)).toMatchObject({
                authority: 'account_automation', authentication: { kind: 'terminal' },
            });
            const machinePath = `/v1/machines/${encodeURIComponent(selected.controller.machineId)}`;
            const verifyMachineRead = (path = machinePath, method = 'GET', body?: unknown,
                effectActionId = actionId, privateKey = selected.keys.secretKey) => verifyExternalActionDomainExecutionRequest({
                authorizationToken: executionAuthorization.token, effectActionId,
                encodedTarget: encodeExternalActionResolvedTargetV1(executionAuthorization.binding.target), method, path, body,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: executionAuthorization.token,
                    effectActionId, target: executionAuthorization.binding.target,
                    installationId: executionAuthorization.binding.installationId, requestId: executionAuthorization.binding.requestId,
                    method, path, body, privateKey }),
            });
            // The actual CLI Machine RPC owner reads this exact codec row before
            // socket emission. Each negative purpose has its own valid signature.
            expect(await verifyMachineRead()).toMatchObject({ binding: executionAuthorization.binding,
                principal: { accountId: selected.account.id, authority: 'account_automation' } });
            expect(await verifyMachineRead(`/v1/machines/${crypto.randomUUID()}`)).toBeNull();
            expect(await verifyMachineRead(`${machinePath}?machineId=${crypto.randomUUID()}`)).toBeNull();
            expect(await verifyMachineRead(machinePath, 'GET', {})).toBeNull();
            expect(await verifyMachineRead(machinePath, 'POST')).toBeNull();
            expect(await verifyMachineRead('/v1/account/encryption')).toBeNull();
            expect(await verifyMachineRead(machinePath, 'GET', undefined,
                actionId === 'machines.work.summary.get' ? 'machines.terminal.list' : 'machines.work.summary.get')).toBeNull();
            expect(await verifyMachineRead(machinePath, 'GET', undefined, actionId, tweetnacl.sign.keyPair().secretKey)).toBeNull();
            const relay = () => instance.inject({ method: 'POST', url: `/v1/actions/${actionId}`, headers,
                payload: { v: 1, machineId: selected.controller.machineId, envelope, executionAuthorization } });
            const current = await relay();
            expect(current.statusCode, current.body).toBe(200);
            expect(current.json()).toMatchObject({ execution: { ok: true, result } });
            await db.machine.update({ where: { id: selected.controller.machineId }, data: { installationId: crypto.randomUUID(),
                installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey) } });
            const retired = await relay();
            expect(retired.statusCode, retired.body).toBe(403);
            expect(retired.json()).toMatchObject({ error: 'credential_scope_denied' });
            expect(await verifyMachineRead()).toBeNull();
            expect(delivered).toHaveLength(2);
        } finally { await instance.close(); }
    });

    it.each(['ui.current_context.read'] as const)(
        'refuses the unadmitted %s root for an original terminal credential before delivery', async actionId => {
        const selected = await fixture(true);
        const token = await auth.createToken(selected.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const envelope = { v: 1 as const, requestId: selected.requestId,
            target: { kind: 'machine' as const, machineId: selected.controller.machineId },
            input: actionId === 'computer.target.close' ? { machineId: selected.controller.machineId } : {} };
        let delivered = false;
        const instance = await app(async () => { delivered = true; return { ok: false, error: 'unexpected_delivery' }; });
        const headers = { authorization: `Bearer ${token}`, [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' };
        try {
            const direct = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}`, headers, payload: envelope });
            expect(direct.statusCode, direct.body).toBe(403);
            const minted = await instance.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId), headers,
                payload: { v: 1, machineId: selected.controller.machineId, envelope } });
            expect(minted.statusCode, minted.body).toBe(403);
            expect(minted.json()).toMatchObject({ error: 'credential_scope_denied' });
            expect(delivered).toBe(false);
        } finally { await instance.close(); }
    });

    it.each(['account', 'terminal'] as const)('issues a FIN Setup child with only its invocation provenance from a captured %s Session requester', async kind => {
        const selected = await fixture(true);
        const source = await sourceFixture(selected);
        const instance = await app(async () => { throw new Error('Authorization must not execute Setup'); }, undefined, source);
        const actionId = 'machines.setup.apply';
        const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
        const input = { homeId, machineId: selected.controller.machineId, targets: [{ homeId,
            machineId: selected.controller.machineId, desiredRevision: 0,
            sources: [{ kind: 'direct', setup: {} }], recipePlans: [] }] };
        const envelope = { v: 1 as const, requestId: selected.requestId, target, input };
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: source.session.id, starterDepth: 0, turnDepth: 1 },
            sourceTurnId: 'captured-setup-turn', callerPermissionMode: 'default', requestId: selected.requestId });
        const token = await auth.createToken(selected.account.id, undefined, { kind,
            authority: kind === 'account' ? 'present_user' : 'account_automation',
            authenticationEvidence: [{ kind: 'home_method', methodId: 'email_password' }] });
        const installationProof = signMachineInstallationProof({ privateKey: selected.keys.secretKey,
            payload: { version: 1, accountId: selected.account.id, ...selected.controller,
                externalActionOrigin: { homeId, actionId, requestId: selected.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        try {
            const issued = await instance.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1,
                    machineId: selected.controller.machineId, envelope, sessionActionOrigin: origin,
                    sessionActionSource: selected.controller, installationProof } });
            expect(issued.statusCode, issued.body).toBe(200);
            const parent = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            if (!('authentication' in parent.binding)) throw new Error('Expected signed Account authentication');
            expect(parent.binding).toMatchObject({ authentication: { kind, tokenEpoch: selected.account.tokenEpoch,
                evidence: [{ kind: 'home_method', methodId: 'email_password' }] }, sessionActionOrigin: origin });
            const requestId = crypto.randomUUID();
            const workflowActionOrigin = { runId: deriveMachineSetupCombinedRunIdV1({ homeId,
                accountId: selected.account.id, requestId: selected.requestId }), requestId };
            const workflowAdmission = await verifyWorkflowExternalActionRequesterAuthorization({ authorization: parent,
                origin: workflowActionOrigin, publisherAccountId: selected.account.id,
                publisherCustodianAccountId: selected.account.id, publisherMachineId: selected.controller.machineId,
                publisherInstallationId: selected.controller.installationId });
            if (!workflowAdmission) throw new Error('Expected the captured Setup requester');
            const { authority, ...principal } = workflowAdmission.principal;
            expect(authority).toBe('account_automation');
            const child = await auth.mintExternalActionExecutionAuthorization({ ...principal, serverIdentityId: homeId,
                machineId: selected.controller.machineId, target, actionId, requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ ...envelope, requestId }),
                admittedMachineRole: 'manage' }, { workflowAdmission });
            expect(child.binding).toMatchObject({ accountId: selected.account.id,
                authentication: parent.binding.authentication, workflowActionOrigin });
            expect(child.binding).not.toHaveProperty('sessionActionOrigin');
            expect(child.binding).not.toHaveProperty('sessionActionSource');
            expect(child.binding).not.toHaveProperty('authenticationEvidence');
            expect(await auth.verifyExternalActionExecutionAuthorization(child.token)).toEqual(child.binding);
        } finally { await instance.close(); }
    });

    it('originates Session Account automation only from its genuine installed current publisher proof', async () => {
        const selected = await fixture(true);
        const { session, presence, io, discovery } = await sourceFixture(selected);
        let replaceAfterResolution = false;
        const instance = await app(async () => ({ ok: false, error: 'mint must not execute' }), undefined, { io, presence,
            afterResolution: async () => {
                if (!replaceAfterResolution) return;
                const replacement = { data: {} };
                expect((await presence.registerPublisher({ socket: replacement,
                    binding: { accountId: selected.account.id, machineId: selected.controller.machineId, sessionId: session.id },
                    completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
            } });
        const envelope = { v: 1 as const, requestId: selected.requestId,
            target: { kind: 'machine' as const, machineId: selected.controller.machineId }, input: selected.input };
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 1 },
            sourceTurnId: 'admitted-turn', callerPermissionMode: 'default', requestId: selected.requestId });
        const installationProof = signMachineInstallationProof({ privateKey: selected.keys.secretKey,
            payload: { version: 1, accountId: selected.account.id, ...selected.controller,
                externalActionOrigin: { homeId, actionId: 'machines.managed.acquire', requestId: selected.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        const mint = (sessionActionOrigin = origin) => instance.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
            headers: { authorization: `Bearer ${selected.token}` },
            payload: { v: 1, machineId: selected.controller.machineId, envelope, sessionActionOrigin,
                sessionActionSource: selected.controller, installationProof } });
        try {
            const issued = await mint();
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(authorization.binding)
                .toMatchObject({ authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch }, sessionActionOrigin: origin });
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding))
                .toMatchObject({ accountId: selected.account.id, authority: 'account_automation', sessionActionOrigin: origin });
            const forged = await mint({ ...origin, sourceTurnId: 'unattested-turn' });
            expect(forged.statusCode, forged.body).toBe(403);
            replaceAfterResolution = true;
            const superseded = await mint();
            expect(superseded.statusCode, superseded.body).toBe(409);
            expect(superseded.json()).toMatchObject({ error: 'invalid_request', code: 'target_unavailable' });
            replaceAfterResolution = false;
            discovery.visible = false;
            const unavailable = await mint();
            expect(unavailable.statusCode, unavailable.body).toBe(403);
            expect(unavailable.json()).toMatchObject({ error: 'credential_scope_denied' });
            expect(await db.managedMachine.count({ where: { homeId, admittedActionRequestId: selected.requestId } })).toBe(0);
        } finally { await instance.close(); }
    });

    it('relays only the exact admitted original Session root and preserves its opaque requester carrier', async () => {
        const selected = await fixture(true);
        const source = await sourceFixture(selected);
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: source.session.id, starterDepth: 1, turnDepth: 2 },
            sourceTurnId: 'original-relay-turn', callerPermissionMode: 'default', workspaceWrites: 'deny', requestId: selected.requestId });
        const envelope = { v: 1 as const, requestId: selected.requestId,
            target: { kind: 'machine' as const, machineId: selected.controller.machineId }, input: selected.input };
        let delivered = 0;
        let admitted: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
        const instance = await app(async params => {
            const dispatched = ExternalActionDaemonDispatchRequestSchema.parse(params.callParams);
            expect(dispatched.executionAuthorization).toEqual(admitted);
            expect(dispatched.principal).toMatchObject({ accountId: selected.account.id, authority: 'account_automation', sessionActionOrigin: origin });
            expect(dispatched.envelope).toEqual(envelope);
            delivered += 1;
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId: dispatched.actionId, requestId: dispatched.envelope.requestId,
                execution: { ok: true, result: { admitted: true } },
            })) };
        }, undefined, source);
        try {
            const installationProof = signMachineInstallationProof({ privateKey: selected.keys.secretKey,
                payload: { version: 1, accountId: selected.account.id, ...selected.controller,
                    externalActionOrigin: { homeId, actionId: 'machines.managed.acquire', requestId: selected.requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
            const minted = await instance.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1, machineId: selected.controller.machineId, envelope,
                    sessionActionOrigin: origin, sessionActionSource: selected.controller, installationProof } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            // Home transports, but never opens or treats this ciphertext as authority.
            admitted = { ...root, requesterAccountContext: { kind: 'installation_sealed_v1',
                installationId: root.binding.installationId, ciphertext: 'opaque' } };
            const body = { v: 1, machineId: selected.controller.machineId, envelope, executionAuthorization: admitted };
            const path = '/v1/actions/machines.managed.acquire';
            const post = (payload: InjectOptions['payload'] = body, bearer = false) => instance.inject({ method: 'POST', url: path, payload,
                headers: bearer ? { authorization: `Bearer ${selected.token}` } : {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: root.binding.actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: root.binding.actionId, target: root.binding.target, installationId: root.binding.installationId,
                        requestId: root.binding.requestId, method: 'POST', path, body: payload, privateKey: selected.keys.secretKey }),
                } });
            const relayed = await post();
            expect(relayed.statusCode, relayed.body).toBe(200);
            expect(relayed.json()).toMatchObject({ execution: { ok: true, result: { admitted: true } } });
            expect(delivered).toBe(1);
            expect((await post(body, true)).statusCode).toBe(200);
            expect(delivered).toBe(2);
            expect((await post({ ...body, envelope: { ...envelope, input: { ...selected.input,
                selection: { ...selected.input.selection, launch: { ...selected.input.selection.launch, name: 'Different request' } } } } })).statusCode).toBe(401);
            expect((await post({ ...body, executionAuthorization: { ...admitted, binding: { ...root.binding,
                sessionActionOrigin: { ...origin, sourceTurnId: 'upgraded-origin' } } } })).statusCode).toBe(401);
            expect((await post({ ...body, sessionActionOrigin: origin, sessionActionSource: selected.controller, installationProof })).statusCode).toBe(401);
            await db.machine.update({ where: { id: selected.controller.machineId }, data: { installationId: crypto.randomUUID() } });
            expect((await post()).statusCode).toBe(401);
            expect(delivered).toBe(2);
        } finally { await instance.close(); }
    });

    it('dispatches the exact fresh reviewer approval root through the shared Use target guard', async () => {
        const reviewer = await fixture(true);
        const destination = await fixture(true);
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: destination.account.id,
            machineId: destination.controller.machineId,
            principal: { kind: 'account', accountId: reviewer.account.id }, level: 'view' }));
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(),
            target: { kind: 'machine' as const, machineId: destination.controller.machineId },
            input: { artifactId: crypto.randomUUID(), decision: 'approve' as const, serverIdentityId: homeId } };
        let carrier: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
        const delivered: unknown[] = [];
        const transportErrors: unknown[] = [];
        const instance = await app(async params => {
            try {
                const dispatch = ExternalActionDaemonDispatchRequestSchema.parse(params.callParams);
                expect(params.targetUserId).toBe(destination.account.id);
                expect(params.method).toBe(`${destination.controller.machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`);
                expect(dispatch.actionId).toBe('approval.request.decide');
                expect(dispatch.envelope).toEqual(envelope);
                expect(dispatch.executionAuthorization).toEqual(carrier);
                expect(dispatch.principal).toMatchObject({ accountId: reviewer.account.id, authority: 'present_user',
                    authentication: { kind: 'account', tokenEpoch: reviewer.account.tokenEpoch } });
                expect(dispatch.principal).not.toHaveProperty('sessionActionOrigin');
                delivered.push(dispatch);
                return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                    v: 1, actionId: dispatch.actionId, requestId: dispatch.envelope.requestId,
                    execution: { ok: true, result: { replayed: true } },
                })) };
            } catch (error) { transportErrors.push(error); throw error; }
        });
        try {
            const minted = await instance.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('approval.request.decide'),
                headers: { authorization: `Bearer ${reviewer.token}` },
                payload: { v: 1, machineId: destination.controller.machineId, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            carrier = { ...root, requesterAccountContext: { kind: 'installation_sealed_v1',
                installationId: root.binding.installationId, ciphertext: 'opaque' } };
            const body = { v: 1, machineId: destination.controller.machineId, envelope, executionAuthorization: carrier };
            const relay = (payload: InjectOptions['payload'] = body) => instance.inject({ method: 'POST', url: '/v1/actions/approval.request.decide',
                headers: { authorization: `Bearer ${reviewer.token}` }, payload });
            const result = await relay();
            if (transportErrors.length > 0) throw transportErrors[0];
            expect(result.statusCode, result.body).toBe(200);
            expect(result.json(), result.body).toMatchObject({ execution: { ok: true, result: { replayed: true } } });
            expect(delivered).toHaveLength(1);
            const substituted = await relay({ ...body, envelope: { ...envelope,
                input: { ...envelope.input, artifactId: crypto.randomUUID() } } });
            expect(substituted.statusCode, substituted.body).toBe(403);
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: destination.account.id,
                machineId: destination.controller.machineId,
                principal: { kind: 'account', accountId: reviewer.account.id } }));
            const retired = await relay();
            expect(retired.statusCode, retired.body).toBe(403);
            expect(delivered).toHaveLength(1);
        } finally { await instance.close(); }
    });

    it('does not let controller Manage bypass accepted native Session binding authority', async () => {
        const controller = await fixture(true);
        const session = await db.session.create({ data: { accountId: controller.account.id,
            tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(),
            target: { kind: 'machine' as const, machineId: controller.controller.machineId },
            input: { homeId, managedId: crypto.randomUUID(), sessionId: session.id, bindingKey: 'unaccepted',
                expectedResourceRevision: 0, expectedSourceRevision: 'unaccepted', expectedProviderTicket: 'unaccepted' } };
        expect(await resolveExternalActionExecutionMachineAdmissionInTx(db, {
            actorAccountId: controller.account.id, machineId: controller.controller.machineId,
            actionId: 'machines.managed.credentials.install', envelope,
            authentication: { authenticationAuthority: 'present_user' },
        })).toMatchObject({ kind: 'denied' });
    });

    it('prepares accepted native authority at direct ordinary Action ingress before controller dispatch', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        const keys = tweetnacl.sign.keyPair();
        for (const machine of [f.controller, f.guest]) await db.machine.update({ where: { id: machine.id }, data: {
            active: true, installationPublicKey: new Uint8Array(keys.publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'native-direct', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/native', happyHomeDir: '/home/native/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            operationProtocolCapabilities: capabilities, operationProtocolCapabilitiesRevision: 1,
        } });
        await db.session.update({ where: { id: f.session.id }, data: { active: true } });
        await expect(inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: f.creator.id,
            machineId: f.guest.id, sessionId: f.session.id, data: 'native-direct-session-key' }))).resolves.toMatchObject({ ok: true });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const pending = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id }));
        if (!pending.ok) throw new Error(pending.code);
        const input = { homeId, managedId: f.row.id, sessionId: f.session.id, bindingKey: pending.binding.safeFacet.bindingKey,
            expectedResourceRevision: pending.binding.resourceRevision, expectedSourceRevision: pending.binding.safeFacet.sourceRevision,
            expectedProviderTicket: pending.binding.safeFacet.providerTicket };
        let dispatched = false;
        const instance = await app(async call => {
            const request = ExternalActionDaemonDispatchRequestSchema.parse(call.callParams);
            expect(request.executionAuthorization?.binding).toMatchObject({ accountId: f.creator.id,
                custodianAccountId: f.custodian.id, managedAdmission: { actionId: 'machines.managed.credentials.install', input } });
            expect(await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id })))
                .toMatchObject({ ok: true, binding: { installation: 'prepared', delivery: { safeFacet: pending.binding.safeFacet } } });
            dispatched = true;
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId: request.actionId, requestId: request.envelope.requestId,
                execution: { ok: true, result: { kind: 'refused', code: 'provider_unavailable' } },
            })) };
        }, undefined, undefined, undefined, async call => ({ ok: true, result:
            call.method.endsWith(':machines.provisioners.check')
                ? { available: true, nativeCredentialDelivery: { status: 'supported' } } : f.sourceResponse }));
        const token = await auth.createToken(f.creator.id, undefined, { kind: 'account', authority: 'present_user' });
        try {
            const result = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.credentials.install',
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, requestId: crypto.randomUUID(),
                    target: { kind: 'machine', machineId: f.controller.id }, input } });
            expect(result.statusCode, result.body).toBe(200);
            expect(dispatched).toBe(true);
        } finally { await instance.close(); }
    });

    it.each([false, 'refused', 'unknown'] as const)('prepares only an accepted native selection before ordinary member issuance without a controller grant (terminal settlement: %s)', async terminalSettlement => {
        const f = await createNativeSessionTeamCredentialFixture();
        const controllerKeys = tweetnacl.sign.keyPair();
        const guestKeys = tweetnacl.sign.keyPair();
        for (const [machineId, keys] of [[f.controller.id, controllerKeys], [f.guest.id, guestKeys]] as const) {
            await db.machine.update({ where: { id: machineId }, data: { active: true,
                metadata: encodePlainMachineStoredContent({ host: 'native', platform: 'linux', happyCliVersion: 'test',
                    homeDir: '/home/native', happyHomeDir: '/home/native/.happier' }),
                dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
                installationPublicKey: new Uint8Array(keys.publicKey),
                operationProtocolCapabilities: capabilities, operationProtocolCapabilitiesRevision: 1 } });
        }
        await db.session.update({ where: { id: f.session.id }, data: { active: true } });
        await expect(inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: f.creator.id,
            machineId: f.guest.id, sessionId: f.session.id, data: 'opaque-native-session-key' }))).resolves.toMatchObject({ ok: true });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const pending = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id }));
        if (!pending.ok) throw new Error(pending.code);
        expect(pending.binding.delivery).toBeNull();
        const facet = pending.binding.safeFacet;
        const input = { homeId, managedId: f.row.id, sessionId: f.session.id, bindingKey: facet.bindingKey,
            expectedResourceRevision: f.credential.revision, expectedSourceRevision: facet.sourceRevision,
            expectedProviderTicket: facet.providerTicket };
        const calls: string[] = [];
        const publisherSource = await sourceFixture({ account: f.creator, controller: { machineId: f.guest.id } }, f.session.id);
        const instance = await app(async () => { throw new Error('Issuance must not dispatch an effect'); }, undefined, publisherSource, undefined,
            async call => {
                expect(call.userId).toBe(f.custodian.id);
                calls.push(call.method);
                if (call.method === `${f.controller.id}:machines.provisioners.check`) return { ok: true,
                    result: { available: true, nativeCredentialDelivery: { status: 'supported' } } };
                expect(call.method).toBe(`${f.controller.id}:${RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION}`);
                return { ok: true, result: f.sourceResponse };
            });
        const token = await auth.createToken(f.creator.id, undefined, { kind: 'account', authority: 'present_user' });
        const issue = (value = input) => instance.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.credentials.install'),
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: f.controller.id,
                envelope: { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: f.controller.id }, input: value } } });
        try {
            expect(await resolveMachineAccess({ actorAccountId: f.creator.id, machineId: f.controller.id })).toBeNull();
            const issued = await issue();
            expect(issued.statusCode, issued.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(root.binding).toMatchObject({
                accountId: f.creator.id, custodianAccountId: f.custodian.id, machineId: f.controller.id,
                managedAdmission: { actionId: 'machines.managed.credentials.install', input } });
            const currentPath = '/v1/machines/managed/controller/current';
            const currentBody = { homeId, managedId: f.row.id, expectedIntentRevision: 0,
                requestId: f.row.admittedActionRequestId,
                controller: { machineId: f.controller.id, installationId: f.controller.installationId! } };
            const current = await instance.inject({ method: 'POST', url: currentPath, payload: currentBody, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.managed.credentials.install',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: 'machines.managed.credentials.install', target: root.binding.target,
                    installationId: root.binding.installationId, requestId: root.binding.requestId,
                    method: 'POST', path: currentPath, body: currentBody, privateKey: controllerKeys.secretKey }),
            } });
            expect(current.statusCode, current.body).toBe(200);
            const reportPath = '/v1/machines/managed/controller/report';
            const reportBody = { homeId, managedId: f.row.id, expectedIntentRevision: 0,
                requestId: f.row.admittedActionRequestId,
                controller: { machineId: f.controller.id, installationId: f.controller.installationId! },
                credentialDelivery: { request: input, result: { kind: 'confirmed' as const, binding: facet } } };
            const submitBody = { ...reportBody, credentialDelivery: { request: input, phase: 'submitted' as const } };
            const competing = ExternalActionExecutionAuthorizationV1Schema.parse((await issue()).json());
            const sourceRequestId = crypto.randomUUID();
            const sourceEnvelope = { v: 1 as const, requestId: sourceRequestId,
                target: { kind: 'machine' as const, machineId: f.controller.id }, input };
            const source = { machineId: f.guest.id, installationId: f.guest.installationId! };
            const origin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller: { kind: 'session', sessionId: f.session.id,
                starterDepth: 0, turnDepth: 0 }, sourceTurnId: 'native-owner-turn', callerPermissionMode: 'default', requestId: sourceRequestId });
            const sourced = await instance.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.credentials.install'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: f.controller.id,
                    envelope: sourceEnvelope, sessionActionOrigin: origin, sessionActionSource: source,
                    installationProof: signMachineInstallationProof({ privateKey: guestKeys.secretKey, payload: {
                        version: 1, accountId: f.creator.id, ...source, externalActionOrigin: { homeId,
                            actionId: 'machines.managed.credentials.install', requestId: sourceRequestId,
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(sourceEnvelope), origin },
                    } }) } });
            expect(sourced.statusCode, sourced.body).toBe(200);
            const sourceRoot = ExternalActionExecutionAuthorizationV1Schema.parse(sourced.json());
            const siblingCredential = await db.teamCredentialResource.create({ data: {
                teamId: f.team.id, custodianAccountId: f.custodian.id, displayName: 'Sibling native resource',
                sessionUsePolicy: f.credential.sessionUsePolicy, disclosureCeiling: f.credential.disclosureCeiling,
                sourceBindingJson: f.credential.sourceBindingJson,
                memberGrants: { create: { teamMembershipId: f.membership.id, deliveryMode: '["vendor-native"]' } },
            } });
            const sibling = await db.session.create({ data: { accountId: f.creator.id,
                tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain', active: true } });
            await expect(inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: f.creator.id,
                machineId: f.guest.id, sessionId: sibling.id, data: 'opaque-sibling-session-key' }))).resolves.toMatchObject({ ok: true });
            await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: sibling.id,
                accountId: f.creator.id, intents: [{ ...f.intent, resourceId: siblingCredential.id,
                    expectedResourceRevision: siblingCredential.revision }], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
            const siblingBinding = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: sibling.id }));
            if (!siblingBinding.ok) throw new Error(siblingBinding.code);
            const siblingInput = { ...input, sessionId: sibling.id, bindingKey: siblingBinding.binding.safeFacet.bindingKey,
                expectedResourceRevision: siblingCredential.revision };
            const contextPath = '/v1/machines/managed/controller/context';
            const contextBody = { homeId, managedId: f.row.id, expectedIntentRevision: 0,
                controller: { machineId: f.controller.id, installationId: f.controller.installationId! },
                includeNativeCredentialBindings: true };
            const context = await instance.inject({ method: 'POST', url: contextPath, payload: contextBody, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.managed.credentials.install',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: 'machines.managed.credentials.install', target: root.binding.target,
                    installationId: root.binding.installationId, requestId: root.binding.requestId,
                    method: 'POST', path: contextPath, body: contextBody, privateKey: controllerKeys.secretKey }),
            } });
            expect(context.statusCode, context.body).toBe(200);
            expect(ManagedControllerContextOutputV1Schema.parse(context.json()).nativeCredentialBindings?.map(binding => binding.safeFacet.bindingKey))
                .toEqual([facet.bindingKey]);
            expect(ManagedControllerContextOutputV1Schema.parse(context.json())).toMatchObject({
                nativeCredentialDesiredBindingKeys: [facet.bindingKey],
            });
            await expect(inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: sibling.id,
                accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION })))
                .resolves.toMatchObject({ ok: true });
            const siblingMutation = { ...siblingInput, accountId: f.creator.id, requestId: crypto.randomUUID(),
                operation: 'install' as const, authentication: TEST_AUTHENTICATION };
            await expect(inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, siblingMutation)))
                .resolves.toEqual({ ok: true, submitted: true });
            await expect(completeAppliedNativeDelivery({ ...siblingMutation, outcome: 'confirmed' }))
                .resolves.toEqual({ ok: true });
            const report = (body: ReturnType<typeof ManagedControllerCredentialDeliveryReportV1Schema.parse> = reportBody, privateKey = controllerKeys.secretKey,
                authorization = root) => instance.inject({ method: 'POST',
                url: reportPath, payload: body, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.managed.credentials.install',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'machines.managed.credentials.install', target: authorization.binding.target,
                        installationId: authorization.binding.installationId, requestId: authorization.binding.requestId,
                        method: 'POST', path: reportPath, body, privateKey }),
                } });
            if (!terminalSettlement) {
                expect((await report(submitBody, guestKeys.secretKey, sourceRoot)).statusCode).toBe(401);
                return;
            }
            const submitted = await report(submitBody);
            expect(submitted.statusCode, submitted.body).toBe(200);
            expect(submitted.json()).toMatchObject({ submitted: true });
            expect((await report(submitBody)).json()).toMatchObject({ submitted: false });
            // Losing the completion transport must leave a durable obstacle to
            // a different ordinary Action, even with the same accepted inputs.
            const pendingCalls = calls.length;
            expect((await issue()).statusCode).toBe(409);
            expect((await issue(siblingInput)).statusCode).toBe(409);
            expect((await report(reportBody, controllerKeys.secretKey, competing)).statusCode).toBe(401);
            expect(calls).toHaveLength(pendingCalls);
            const applied = await inTx(tx => readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx(tx, {
                accountId: f.creator.id, request: input, authentication: TEST_AUTHENTICATION,
            }));
            if (!applied.ok) throw new Error('Expected the submitted native policy cohort');
            const completed = await report({ ...reportBody, credentialDelivery: { ...reportBody.credentialDelivery,
                appliedPolicy: { ownedBindingKeys: applied.ownedBindings.map(row => row.safeFacet.bindingKey),
                    desiredBindingKeys: applied.desiredBindings.map(row => row.safeFacet.bindingKey) } } });
            expect(completed.statusCode, completed.body).toBe(200);
            expect((await report(reportBody, guestKeys.secretKey)).statusCode).toBe(401);
            expect(completed.json().credentialDeliveryResult).toEqual({ kind: 'confirmed', binding: facet });
            expect(await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id })))
                .toMatchObject({ ok: true, binding: { installation: 'confirmed' } });
            expect((await report(submitBody, controllerKeys.secretKey, sourceRoot)).json()).toMatchObject({ submitted: true });
            await db.teamCredentialResource.update({ where: { id: f.credential.id }, data: { enabled: false } });
            await db.session.update({ where: { id: f.session.id }, data: { active: false, archivedAt: new Date() } });
            const terminalCalls = calls.length;
            expect((await issue()).statusCode).toBe(409);
            expect((await report(submitBody, controllerKeys.secretKey, sourceRoot)).statusCode).toBe(401);
            const terminalBody = { ...reportBody, credentialDelivery: { request: input,
                result: terminalSettlement === 'unknown'
                    ? { kind: 'unknown' as const, code: 'action_outcome_unknown' as const }
                    : { kind: 'refused' as const, code: 'provider_authorization_changed' as const } } };
            await db.machine.update({ where: { id: f.controller.id }, data: { revokedAt: new Date() } });
            expect((await report(terminalBody, controllerKeys.secretKey, sourceRoot)).statusCode).toBe(401);
            await db.machine.update({ where: { id: f.controller.id }, data: { revokedAt: null } });
            const terminalReport = await report(terminalBody, controllerKeys.secretKey, sourceRoot);
            expect(terminalReport.statusCode, terminalReport.body).toBe(200);
            expect(terminalReport.json().credentialDeliveryResult).toEqual(terminalBody.credentialDelivery.result);
            const settled = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id }));
            expect(settled).toMatchObject({ ok: true, binding: { installation: terminalSettlement === 'unknown' ? 'unknown' : 'confirmed' } });
            if (!settled.ok) throw new Error(settled.code);
            expect(settled.binding.submission).toBeUndefined();
            expect(calls).toHaveLength(terminalCalls);
            if (terminalSettlement === 'unknown') return;
            await db.teamCredentialResource.update({ where: { id: f.credential.id }, data: { enabled: true } });
            await db.session.update({ where: { id: f.session.id }, data: { active: true, archivedAt: null } });
            await db.teamCredentialResource.update({ where: { id: siblingCredential.id }, data: { memberGrants: { deleteMany: {} } } });
            const withoutWithdrawnPeer = await issue();
            expect(withoutWithdrawnPeer.statusCode, withoutWithdrawnPeer.body).toBe(200);
            await db.teamCredentialResource.update({ where: { id: siblingCredential.id }, data: {
                memberGrants: { create: { teamMembershipId: f.membership.id, deliveryMode: '["vendor-native"]' } },
            } });
            const before = calls.length;
            expect((await issue({ ...input, bindingKey: 'foreign-binding' })).statusCode).toBe(409);
            expect(calls).toHaveLength(before);
            const unknownRequestId = crypto.randomUUID();
            await expect(inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, { ...input, accountId: f.creator.id,
                requestId: unknownRequestId, operation: 'install', authentication: TEST_AUTHENTICATION })))
                .resolves.toEqual({ ok: true, submitted: true });
            await expect(inTx(tx => completeSessionTeamCredentialNativeDeliveryInTx(tx, { ...input, accountId: f.creator.id,
                requestId: unknownRequestId, operation: 'install', outcome: 'unknown', authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
            const unknownBefore = calls.length;
            expect((await issue({ ...input, sessionId: sibling.id, bindingKey: siblingBinding.binding.safeFacet.bindingKey })).statusCode).toBe(409);
            expect(calls).toHaveLength(unknownBefore);
            expect(await resolveMachineAccess({ actorAccountId: f.creator.id, machineId: f.controller.id })).toBeNull();
        } finally { await instance.close(); }
    });

    it.each(['retire', 'submit'] as const)('refuses unimplemented native binding power and transition effects before %s', async phase => {
        const f = await createNativeSessionTeamCredentialFixture();
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const effect = phase === 'retire' ? admitManagedControl({ actorAccountId: f.custodian.id,
            custodianAccountId: f.custodian.id, authentication: { authenticationAuthority: 'present_user' },
            input: { action: 'machines.managed.retire', requestId: crypto.randomUUID(), input: { homeId,
                managedId: f.row.id, expectedIntentRevision: 0, manualResponsibility: true } } })
            : submitManagedIntent({ homeId, managedId: f.row.id, expectedIntentRevision: 0,
                requestId: f.row.admittedActionRequestId,
                controller: { machineId: f.controller.id, installationId: f.controller.installationId! } });
        await expect(effect).rejects.toMatchObject({ code: 'credential_unavailable' });
        const unchanged = await db.managedMachine.findUniqueOrThrow({ where: { id: f.row.id } });
        expect(unchanged.archivedAt).toBeNull();
        expect(unchanged.intentRevision).toBe(0);
    });

    it('admits only exact installed owning-Session release after use authority and activity end', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        const keys = tweetnacl.sign.keyPair();
        for (const machine of [f.controller, f.guest]) await db.machine.update({ where: { id: machine.id }, data: {
            active: true, installationPublicKey: new Uint8Array(keys.publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'native-release', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/native', happyHomeDir: '/home/native/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            operationProtocolCapabilities: capabilities, operationProtocolCapabilitiesRevision: 1,
        } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const ready = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
        if (!ready.ok) throw new Error(ready.code);
        const facet = ready.binding.safeFacet;
        const input = { homeId, managedId: f.row.id, sessionId: f.session.id, bindingKey: facet.bindingKey,
            operation: 'release' as const, expectedResourceRevision: ready.binding.resourceRevision,
            expectedSourceRevision: facet.sourceRevision, expectedProviderTicket: facet.providerTicket };
        const installRequestId = crypto.randomUUID();
        await expect(inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, { ...input, accountId: f.creator.id,
            requestId: installRequestId, operation: 'install', authentication: TEST_AUTHENTICATION })))
            .resolves.toEqual({ ok: true, submitted: true });
        await expect(completeAppliedNativeDelivery({ ...input, accountId: f.creator.id,
            requestId: installRequestId, operation: 'install', outcome: 'confirmed', authentication: TEST_AUTHENTICATION })).resolves.toEqual({ ok: true });
        const peer = await db.session.create({ data: { accountId: f.creator.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: peer.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const peerReady = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: peer.id,
            accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
        if (!peerReady.ok) throw new Error(peerReady.code);
        const peerInput = { ...input, sessionId: peer.id, bindingKey: peerReady.binding.safeFacet.bindingKey };
        const peerInstall = { ...peerInput, accountId: f.creator.id, requestId: crypto.randomUUID(), operation: 'install' as const,
            authentication: TEST_AUTHENTICATION };
        await expect(inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, peerInstall))).resolves.toEqual({ ok: true, submitted: true });
        await expect(completeAppliedNativeDelivery({ ...peerInstall, outcome: 'confirmed' })).resolves.toEqual({ ok: true });
        await db.session.updateMany({ where: { id: { in: [f.session.id, peer.id] } }, data: { active: false, archivedAt: new Date() } });
        await db.teamCredentialResource.update({ where: { id: f.credential.id }, data: { enabled: false } });
        await db.teamMembership.update({ where: { id: f.membership.id }, data: { status: 'suspended' } });
        const instance = await app(async () => { throw new Error('Release issuance must not dispatch'); }, undefined, undefined, undefined,
            async () => { throw new Error('Release must not qualify or prepare withdrawn source'); });
        const token = await auth.createToken(f.creator.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const issue = (value: typeof input & { executionRunId?: string } = input, source = { machineId: f.guest.id,
            installationId: f.guest.installationId! }) => {
            const requestId = crypto.randomUUID();
            const envelope = { v: 1 as const, requestId, target: { kind: 'machine' as const, machineId: f.controller.id }, input: value };
            const origin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller: { kind: 'session', sessionId: value.sessionId,
                starterDepth: 0, turnDepth: 0 }, sourceTurnId: 'owning-session-terminal', callerPermissionMode: 'default', requestId });
            return instance.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.credentials.install'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: f.controller.id, envelope,
                    sessionActionOrigin: origin, sessionActionSource: source,
                    installationProof: signMachineInstallationProof({ privateKey: keys.secretKey,
                        payload: { version: 1, accountId: f.creator.id, ...source, externalActionOrigin: { homeId,
                            actionId: 'machines.managed.credentials.install', requestId,
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } }) } });
        };
        try {
            expect(await inTx(tx => readManagedCredentialDeliveryAuthorityInTx(tx, { actorAccountId: f.creator.id,
                machineId: f.controller.id, request: input, authentication: { env: process.env, authority: 'account_automation', authenticationEvidence: undefined },
                sessionActionSource: { machineId: f.guest.id, installationId: f.guest.installationId! },
                sessionActionOrigin: SessionActionRpcOriginV1Schema.parse({ v: 1, caller: { kind: 'session', sessionId: f.session.id,
                    starterDepth: 0, turnDepth: 0 }, sourceTurnId: 'owning-session-terminal', callerPermissionMode: 'default', requestId: 'diagnostic' }) })))
                .not.toBeNull();
            const released = await issue();
            expect(released.statusCode, released.body).toBe(200);
            expect(released.json().binding).toMatchObject({ accountId: f.creator.id, custodianAccountId: f.custodian.id,
                sessionActionSource: { machineId: f.guest.id, installationId: f.guest.installationId },
                managedAdmission: { actionId: 'machines.managed.credentials.install', input } });
            expect((await issue({ ...input, bindingKey: 'foreign-binding' })).statusCode).not.toBe(200);
            expect((await issue({ ...input, executionRunId: 'failed-run-borrow' })).statusCode).not.toBe(200);
            expect((await issue(input, { machineId: f.controller.id, installationId: f.controller.installationId! })).statusCode).not.toBe(200);
            for (const [index, selection] of [input].entries()) {
                const issued = index === 0 ? released : await issue(selection);
                expect(issued.statusCode, issued.body).toBe(200);
                const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
                const controllerPost = (path: string, body: object) => instance.inject({ method: 'POST', url: path, payload: body, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.managed.credentials.install',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: 'machines.managed.credentials.install', target: root.binding.target,
                        installationId: root.binding.installationId, requestId: root.binding.requestId,
                        method: 'POST', path, body, privateKey: keys.secretKey }),
                } });
                const correlation = { homeId, managedId: f.row.id, expectedIntentRevision: 0,
                    controller: { machineId: f.controller.id, installationId: f.controller.installationId! } };
                const context = await controllerPost('/v1/machines/managed/controller/context', {
                    ...correlation, includeNativeCredentialBindings: true,
                });
                expect(context.statusCode, context.body).toBe(200);
                const policy = ManagedControllerContextOutputV1Schema.parse(context.json());
                expect(policy).toMatchObject({ nativeCredentialDesiredBindingKeys: [] });
                expect(policy.nativeCredentialBindings).toHaveLength(2 - index);
                const submit = await controllerPost('/v1/machines/managed/controller/report', { ...correlation,
                    requestId: f.row.admittedActionRequestId, credentialDelivery: { request: selection, phase: 'submitted' } });
                expect(submit.statusCode, submit.body).toBe(200);
                expect(submit.json()).toMatchObject({ submitted: true });
                const claimedContext = await controllerPost('/v1/machines/managed/controller/context', {
                    ...correlation, includeNativeCredentialBindings: true,
                });
                expect(claimedContext.statusCode, claimedContext.body).toBe(200);
                const applied = ManagedControllerContextOutputV1Schema.parse(claimedContext.json());
                if (!applied.nativeCredentialBindings || !applied.nativeCredentialDesiredBindingKeys) throw new Error('Expected applied native cohort');
                const confirmed = await controllerPost('/v1/machines/managed/controller/report', { ...correlation,
                    requestId: f.row.admittedActionRequestId, credentialDelivery: { request: selection,
                        appliedPolicy: { ownedBindingKeys: applied.nativeCredentialBindings.map(binding => binding.safeFacet.bindingKey),
                            desiredBindingKeys: applied.nativeCredentialDesiredBindingKeys },
                        result: { kind: 'confirmed', binding: facet } } });
                expect(confirmed.statusCode, confirmed.body).toBe(200);
                expect(confirmed.json()).toMatchObject({ credentialDeliveryResult: { kind: 'confirmed' } });
                expect(await db.sessionTeamCredentialBinding.count({ where: { nativeManagedId: f.row.id } })).toBe(1 - index);
            }
            expect(await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: peer.id })))
                .toMatchObject({ ok: true, binding: { installation: 'prepared', safeFacet: peerReady.binding.safeFacet } });
            const peerRead = { purpose: 'vendor_native_binding' as const, homeId, teamId: f.team.id,
                resourceId: f.credential.id, sessionId: peer.id, managedId: f.row.id,
                bindingKey: peerReady.binding.safeFacet.bindingKey, expectedResourceRevision: peerReady.binding.resourceRevision,
                expectedSourceRevision: peerReady.binding.safeFacet.sourceRevision, expectedProviderTicket: peerReady.binding.safeFacet.providerTicket,
                machineId: f.guest.id, installationId: f.guest.installationId! };
            const diagnostic = await instance.inject({ method: 'POST',
                url: `/v2/teams/${f.team.id}/credential-resources/${f.credential.id}/direct-material`,
                headers: { authorization: `Bearer ${token}` }, payload: { ...peerRead,
                    proof: signMachineInstallationProof({ privateKey: keys.secretKey, payload: { version: 1,
                        accountId: f.creator.id, machineId: f.guest.id, installationId: f.guest.installationId!,
                        nativeCredentialBindingRead: { requestBodyDigest: computeTeamCredentialNativeBindingReadDigestV1(peerRead) } } }) } });
            expect(diagnostic.statusCode, diagnostic.body).toBe(200);
            expect(diagnostic.json()).toEqual({ status: 'prepared', binding: peerReady.binding.safeFacet });
            expect((await issue(peerInput)).statusCode).not.toBe(200);
            expect(await resolveMachineAccess({ actorAccountId: f.creator.id, machineId: f.controller.id })).toBeNull();
        } finally { await instance.close(); }
    });

    it.each(['exact', 'pool'] as const)('admits only an explicitly delegated Team %s preset through issuance, dispatch and installed-controller proof without a Machine grant', async targetKind => {
        const controller = await fixture(true);
        const requester = await fixture(true);
        const outsider = await fixture(true);
        const team = await db.team.create({ data: { name: 'Delegated compute' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: controller.account.id, role: 'owner' },
            { teamId: team.id, accountId: requester.account.id, role: 'member' },
        ] });
        const pool = targetKind === 'pool' ? await db.machinePool.create({ data: {
            id: crypto.randomUUID(), accountId: controller.account.id, teamId: team.id, name: 'Team compute',
            members: { create: { machineId: controller.controller.machineId, priorityTier: 0 } },
        } }) : null;
        const preset = { id: crypto.randomUUID(), homeId, name: 'Team guest', owner: { kind: 'team' as const, teamId: team.id },
            launch: controller.input.selection.launch,
            ...(pool ? { controllerPoolId: pool.id } : { controller: controller.controller }), teamAcquireDelegated: true,
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        expect(await createMachinePreset({ accountId: controller.account.id,
            authentication: { authenticationAuthority: 'present_user' }, input: preset })).toMatchObject({ kind: 'saved' });
        expect(await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: controller.controller.machineId })).toBeNull();
        expect(resolveMachineRpcRoutePolicy('machines.managed.acquire').sharedMachineAccess).toBe('manage');
        const input = ManagedAcquireInputV1Schema.parse({ enrollmentIdentity: controller.input.enrollmentIdentity,
            selection: { kind: 'preset', homeId, id: preset.id, revision: 0 }, controller: controller.controller,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(),
            target: { kind: 'machine' as const, machineId: controller.controller.machineId }, input };
        let delivered = 0;
        const instance = await app(async params => {
            const request = ExternalActionDaemonDispatchRequestSchema.parse(params.callParams);
            const root = request.executionAuthorization;
            if (!root) throw new Error('Missing signed acquisition');
            expect(params.targetUserId).toBe(controller.account.id);
            expect(root.binding).toMatchObject({ accountId: requester.account.id, custodianAccountId: controller.account.id,
                machineId: controller.controller.machineId, installationId: controller.controller.installationId });
            const row = await db.managedMachine.findUniqueOrThrow({ where: { homeId_admittedActionRequestId: {
                homeId, admittedActionRequestId: envelope.requestId } } });
            const body = { homeId, managedId: row.id, expectedIntentRevision: 0,
                requestId: envelope.requestId, controller: controller.controller };
            const path = '/v1/machines/managed/controller/submit';
            const submit = (privateKey: Uint8Array) => instance.inject({ method: 'POST', url: path, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: request.actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: request.actionId, target: root.binding.target, installationId: root.binding.installationId,
                    requestId: root.binding.requestId, method: 'POST', path, body, privateKey }),
            } });
            expect((await submit(requester.keys.secretKey)).statusCode).toBe(401);
            const submitted = await submit(controller.keys.secretKey);
            expect(submitted.statusCode, submitted.body).toBe(200);
            expect(submitted.json()).toMatchObject({ submitted: true });
            delivered += 1;
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId: request.actionId, requestId: envelope.requestId,
                execution: { ok: true, result: { managedId: row.id } },
            })) };
        });
        const issue = (token = requester.token, requestedEnvelope = envelope) => instance.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
            headers: { authorization: `Bearer ${token}` },
            payload: { v: 1, machineId: requestedEnvelope.target.machineId, envelope: requestedEnvelope } });
        try {
            expect((await issue(outsider.token)).statusCode).toBe(409);
            if (pool) {
                const outside = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: controller.account.id,
                    metadata: encodePlainMachineStoredContent({ host: 'outside', platform: 'linux', happyCliVersion: 'test',
                        homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
                    dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
                    installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(controller.keys.publicKey),
                    active: true, pluginMaterializationRevision: BigInt(1),
                    operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: capabilities } });
                const installed = await db.pluginMachineMaterialization.findFirstOrThrow({ where: {
                    accountId: controller.account.id, machineId: controller.controller.machineId } });
                await db.pluginMachineMaterialization.create({ data: { accountId: controller.account.id,
                    serverIdentityId: homeId, machineId: outside.id, materializationId: outside.installationId!,
                    pluginId: installed.pluginId, version: installed.version, sourceClass: installed.sourceClass,
                    portableRelease: installed.portableRelease, archiveDigestSha256: installed.archiveDigestSha256,
                    uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
                const forged = await issue(requester.token, { ...envelope, requestId: crypto.randomUUID(),
                    target: { kind: 'machine', machineId: outside.id }, input: ManagedAcquireInputV1Schema.parse({ ...input,
                        controller: { machineId: outside.id, installationId: outside.installationId! } }) });
                expect(forged.statusCode, forged.body).toBe(409);
                expect(await db.managedMachine.count({ where: { presetId: preset.id } })).toBe(0);
            }
            const issued = await issue();
            expect(issued.statusCode, issued.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const unrelated = await instance.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.provisioners.list'),
                headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1,
                    machineId: controller.controller.machineId, envelope: { ...envelope,
                        requestId: crypto.randomUUID(), input: { homeId, controller: controller.controller } } } });
            expect(unrelated.statusCode).toBe(409);
            const oneOff = await issue(requester.token, { ...envelope, requestId: crypto.randomUUID(), input: controller.input });
            expect(oneOff.statusCode).toBe(409);
            const executed = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
                headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1,
                    machineId: controller.controller.machineId, envelope, executionAuthorization: root } });
            expect(executed.statusCode, executed.body).toBe(200);
            expect(executed.json(), executed.body).toMatchObject({ execution: { ok: true } });
            expect(delivered).toBe(1);
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: requester.account.id } },
                data: { status: 'suspended' } });
            expect((await issue(requester.token, { ...envelope, requestId: crypto.randomUUID() })).statusCode).toBe(409);
            expect(await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: controller.controller.machineId })).toBeNull();
        } finally { await instance.close(); }
    });

    it.each(['exact', 'pool'] as const)('refuses a delegated Team %s preset after its custodian leaves while preserving owned acquire', async targetKind => {
        const controller = await fixture(true);
        const requester = await fixture(true);
        const team = await db.team.create({ data: { name: 'Custodian withdrawal' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: controller.account.id, role: 'owner' },
            { teamId: team.id, accountId: requester.account.id, role: 'member' },
        ] });
        const pool = targetKind === 'pool' ? await db.machinePool.create({ data: {
            id: crypto.randomUUID(), accountId: controller.account.id, teamId: team.id, name: 'Published compute',
            members: { create: { machineId: controller.controller.machineId, priorityTier: 0 } },
        } }) : null;
        const presetId = crypto.randomUUID();
        expect(await createMachinePreset({ accountId: controller.account.id,
            authentication: { authenticationAuthority: 'present_user' }, input: {
                id: presetId, homeId, name: 'Delegated guest', owner: { kind: 'team', teamId: team.id },
                launch: controller.input.selection.launch,
                ...(pool ? { controllerPoolId: pool.id } : { controller: controller.controller }),
                teamAcquireDelegated: true, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            } })).toMatchObject({ kind: 'saved' });
        const input = ManagedAcquireInputV1Schema.parse({ enrollmentIdentity: controller.input.enrollmentIdentity,
            selection: { kind: 'preset', homeId, id: presetId, revision: 0 }, controller: controller.controller,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const instance = await app(async () => { throw new Error('Authorization issuance must not dispatch acquisition'); });
        const issue = (token: string, acquireInput: typeof input) => instance.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1,
                machineId: controller.controller.machineId, envelope: { v: 1, requestId: crypto.randomUUID(),
                    target: { kind: 'machine', machineId: controller.controller.machineId }, input: acquireInput } } });
        try {
            const active = await issue(requester.token, input);
            expect(active.statusCode, active.body).toBe(200);
            await db.teamMembership.delete({ where: { teamId_accountId: { teamId: team.id, accountId: controller.account.id } } });
            const removed = await issue(requester.token, input);
            expect(removed.statusCode, removed.body).toBe(409);
            expect(removed.json(), removed.body).toMatchObject({ error: 'invalid_request', code: 'target_unavailable' });
            // Leaving the Team withdraws delegation, not the custodian's own compute authority.
            const owned = await issue(controller.token, controller.input);
            expect(owned.statusCode, owned.body).toBe(200);
            expect(await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: controller.controller.machineId })).toBeNull();
        } finally { await instance.close(); }
    });

    it.each(['machines.managed.inspect', 'machines.managed.bootstrap.retry', 'action.operations.list', 'action.operations.get'] as const)(
        'authorizes only the creator resource for sealed %s recovery on the custodian controller', async actionId => {
        const controller = await fixture(true);
        const requester = await fixture(true, 'e2ee');
        // Retained creator recovery must survive removal of original Machine
        // access, independently of any later preset delegation policy.
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: controller.account.id,
            machineId: controller.controller.machineId, principal: { kind: 'account', accountId: requester.account.id }, level: 'admin' }));
        const created = await admitManagedAcquire({ custodianAccountId: controller.account.id, requesterAccountId: requester.account.id,
            authentication: { authenticationAuthority: 'present_user' }, requestEnvelopeDigest: 'recovery-admission',
            input: { input: controller.input, requestId: crypto.randomUUID(), continuationPresent: false } });
        await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: controller.account.id,
            machineId: controller.controller.machineId, principal: { kind: 'account', accountId: requester.account.id } }));
        const unrelated = await admitManagedAcquire({ custodianAccountId: controller.account.id, requesterAccountId: controller.account.id,
            requestEnvelopeDigest: 'unrelated-admission', input: { input: controller.input,
                requestId: crypto.randomUUID(), continuationPresent: false } });
        const instance = await app(async () => { throw new Error('Proof issuance cannot perform a native effect'); });
        const makeEnvelope = (managedId: string) => sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId,
            accountId: requester.account.id, authentication: { kind: 'account', tokenEpoch: requester.account.tokenEpoch },
            actionId, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: controller.controller.machineId } },
            input: actionId === 'action.operations.list' || actionId === 'action.operations.get'
                ? { serverId: homeId, machineId: controller.controller.machineId, managed: { homeId, managedId },
                    ...(actionId === 'action.operations.get' ? { operationId: 'retained-operation' } : {}) }
                : { homeId, managedId, ...(actionId === 'machines.managed.bootstrap.retry' ? { expectedIntentRevision: 0 } : {}) },
            material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) }, randomBytes: length => new Uint8Array(length).fill(3) });
        const issue = (managedId: string) => instance.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId), headers: { authorization: `Bearer ${requester.token}` },
            payload: { v: 1, machineId: controller.controller.machineId, envelope: makeEnvelope(managedId) } });
        try {
            if (actionId === 'action.operations.list' || actionId === 'action.operations.get') {
                const ordinary = await instance.inject({ method: 'POST',
                    url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId), headers: { authorization: `Bearer ${controller.token}` },
                    payload: { v: 1, machineId: controller.controller.machineId, envelope: { v: 1, requestId: crypto.randomUUID(),
                        target: { kind: 'machine', machineId: controller.controller.machineId }, input: { serverId: homeId,
                            machineId: controller.controller.machineId, ...(actionId === 'action.operations.get' ? { operationId: 'ordinary' } : {}) } } } });
                expect(ordinary.statusCode, ordinary.body).toBe(200);
                expect(ordinary.json().binding.managedAdmission).toBeUndefined();
            }
            expect((await issue(unrelated.machine.id)).statusCode).toBe(409);
            const issued = await issue(created.machine.id);
            expect(issued.statusCode, issued.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(root.binding).toMatchObject({ accountId: requester.account.id, custodianAccountId: controller.account.id,
                managedAdmission: { actionId, input: { homeId, managedId: created.machine.id } } });
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const body = { v: 1, admittedMachineRole: root.binding.admittedMachineRole };
            const verify = (privateKey: Uint8Array) => instance.inject({ method: 'POST', url: path, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: actionId, target: root.binding.target, installationId: root.binding.installationId,
                    requestId: root.binding.requestId, method: 'POST', path, body, privateKey }),
            } });
            expect((await verify(requester.keys.secretKey)).statusCode).toBe(401);
            expect((await verify(controller.keys.secretKey)).statusCode).toBe(200);
            if (actionId === 'action.operations.list' || actionId === 'action.operations.get') {
                const rpc = async (operationId = 'retained-operation') => {
                    const method = `${controller.controller.machineId}:${actionId === 'action.operations.list'
                        ? ACTION_OPERATION_RPC_METHODS_V2.list : ACTION_OPERATION_RPC_METHODS_V2.get}`;
                    const request = { method, requestId: crypto.randomUUID(), params: actionId === 'action.operations.list' ? {} : { operationId } };
                    return verifyExternalActionMachineRpcExecution({ v: 1, authorization: root, effectActionId: actionId,
                        target: root.binding.target, installationId: root.binding.installationId,
                        machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token, effectActionId: actionId,
                            target: root.binding.target, installationId: root.binding.installationId, ...request,
                            privateKey: controller.keys.secretKey }) }, request);
                };
                expect(await rpc()).toMatchObject({ binding: { accountId: requester.account.id } });
                if (actionId === 'action.operations.get') expect(await rpc('unrelated-operation')).toBeNull();
            }
            if (actionId === 'machines.managed.inspect' || actionId === 'machines.managed.bootstrap.retry') {
                const contextPath = '/v1/machines/managed/controller/context';
                const context = (managedId: string) => {
                    const contextBody = { homeId, managedId, expectedIntentRevision: 0, controller: controller.controller };
                    return instance.inject({ method: 'POST', url: contextPath, payload: contextBody, headers: {
                        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                            effectActionId: actionId, target: root.binding.target, installationId: root.binding.installationId,
                            requestId: root.binding.requestId, method: 'POST', path: contextPath, body: contextBody,
                            privateKey: controller.keys.secretKey }),
                    } });
                };
                expect((await context(unrelated.machine.id)).statusCode).toBe(401);
                expect((await context(created.machine.id)).statusCode).toBe(200);
            }
            expect(await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: controller.controller.machineId })).toBeNull();
        } finally { await instance.close(); }
    });

    it.each(['same-account', 'shared-manage'] as const)(
        'dispatches an original Session acquire to a selected foreign controller with %s provenance', async access => {
        const requester = await fixture(true);
        const destination = await fixture(true);
        if (access === 'same-account') {
            await db.machine.update({ where: { id: destination.controller.machineId }, data: { accountId: requester.account.id } });
            await db.pluginMachineMaterialization.updateMany({ where: { machineId: destination.controller.machineId },
                data: { accountId: requester.account.id } });
        } else {
            await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: destination.account.id,
                machineId: destination.controller.machineId, principal: { kind: 'account', accountId: requester.account.id }, level: 'admin' }));
        }
        const custodianAccountId = access === 'same-account' ? requester.account.id : destination.account.id;
        expect(await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: destination.controller.machineId }))
            .toMatchObject({ role: 'manage', accessState: 'ready', installationId: destination.controller.installationId });
        const source = await sourceFixture(requester);
        const deliveredRequests: string[] = [];
        const transportAssertionErrors: unknown[] = [];
        const instance = await app(async params => {
            try {
            const dispatch = ExternalActionDaemonDispatchRequestSchema.parse(params.callParams);
            const row = await db.managedMachine.findUniqueOrThrow({ where: { homeId_admittedActionRequestId: {
                homeId, admittedActionRequestId: dispatch.envelope.requestId!,
            } } });
            // The durable allocation is admitted before the actual socket boundary.
            expect(row).toMatchObject({ custodianAccountId, allocation: 'unsubmitted',
                controllerMachineId: destination.controller.machineId, controllerInstallationId: destination.controller.installationId });
            expect(params.targetUserId).toBe(custodianAccountId);
            expect(params.method).toBe(`${destination.controller.machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`);
            expect(dispatch.envelope).toEqual(payload.envelope);
            expect(dispatch.principal).toMatchObject({ accountId: requester.account.id, authority: 'account_automation',
                authentication: { kind: 'account', tokenEpoch: requester.account.tokenEpoch }, sessionActionOrigin: payload.sessionActionOrigin });
            expect(dispatch.executionAuthorization?.binding).toMatchObject({ accountId: requester.account.id, custodianAccountId,
                machineId: destination.controller.machineId, installationId: destination.controller.installationId,
                sessionActionSource: requester.controller, sessionActionOrigin: payload.sessionActionOrigin,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(payload.envelope) });
            deliveredRequests.push(dispatch.envelope.requestId!);
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId: dispatch.actionId, requestId: dispatch.envelope.requestId,
                execution: { ok: true, result: { managedId: row.id } },
            })) };
            } catch (error) {
                // The relay intentionally converts transport exceptions to a
                // typed failure; retain fixture assertion errors for diagnosis.
                transportAssertionErrors.push(error);
                throw error;
            }
        }, undefined, source);
        const makePayload = (requestId: string) => {
            const envelope = { v: 1 as const, requestId,
                target: { kind: 'machine' as const, machineId: destination.controller.machineId }, input: destination.input };
            const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
                caller: { kind: 'session', sessionId: source.session.id, starterDepth: 1, turnDepth: 2 },
                sourceTurnId: 'admitted-foreign-controller-turn', callerPermissionMode: 'default', requestId });
            const installationProof = signMachineInstallationProof({ privateKey: requester.keys.secretKey,
                payload: { version: 1, accountId: requester.account.id, ...requester.controller,
                    externalActionOrigin: { homeId, actionId: 'machines.managed.acquire', requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
            return { v: 1 as const, machineId: destination.controller.machineId, envelope, sessionActionOrigin: origin,
                sessionActionSource: requester.controller, installationProof };
        };
        const payload = makePayload(crypto.randomUUID());
        const post = (body: ReturnType<typeof makePayload>) => instance.inject({ method: 'POST',
            url: '/v1/actions/machines.managed.acquire', headers: { authorization: `Bearer ${requester.token}` }, payload: body });
        try {
            const executed = await post(payload);
            if (transportAssertionErrors.length > 0) throw transportAssertionErrors[0];
            expect(executed.statusCode, executed.body).toBe(200);
            const row = await db.managedMachine.findUniqueOrThrow({ where: { homeId_admittedActionRequestId: {
                homeId, admittedActionRequestId: payload.envelope.requestId,
            } } });
            expect(executed.json(), executed.body).toMatchObject({ execution: { ok: true, result: { managedId: row.id } } });
            expect(deliveredRequests).toEqual([payload.envelope.requestId]);

            const forged = makePayload(crypto.randomUUID());
            const refused = await post({ ...forged, sessionActionOrigin: { ...forged.sessionActionOrigin, sourceTurnId: 'unattested-turn' } });
            expect(refused.statusCode, refused.body).toBe(403);
            expect(await db.managedMachine.count({ where: { homeId, admittedActionRequestId: forged.envelope.requestId } })).toBe(0);

            source.discovery.visible = false;
            const withdrawn = makePayload(crypto.randomUUID());
            const stale = await post(withdrawn);
            expect(stale.statusCode, stale.body).toBe(403);
            expect(await db.managedMachine.count({ where: { homeId, admittedActionRequestId: withdrawn.envelope.requestId } })).toBe(0);
            expect(deliveredRequests).toEqual([payload.envelope.requestId]);
        } finally { await instance.close(); }
    });

    it.each([
        { actionId: 'machines.managed.acquire', placement: 'machine', mode: 'plain' },
        { actionId: 'machines.managed.bootstrap.retry', placement: 'machine', mode: 'plain' },
        { actionId: 'machines.managed.acquire', placement: 'account', mode: 'plain' },
        { actionId: 'machines.managed.bootstrap.retry', placement: 'account', mode: 'plain' },
        { actionId: 'machines.managed.acquire', placement: 'account', mode: 'e2ee' },
        { actionId: 'machines.managed.bootstrap.retry', placement: 'account', mode: 'e2ee' },
    ] as const)('retains only an issued Acquire bound fact from $mode $placement $actionId after its Session publisher retires and creation is canceled', async ({ actionId, placement, mode }) => {
        const base = await fixture(true, mode);
        const declared = base.manifest.contributes.machineProvisioners?.[0];
        if (!declared) throw new Error('Expected the declared compute fixture');
        const provisioner = placement === 'account'
            ? { ...declared, billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const } } : declared;
        const { controller: machineController, ...accountSelection } = base.input.selection;
        const controller = placement === 'machine' ? machineController : undefined;
        const input = ManagedAcquireInputV1Schema.parse({ ...base.input,
            selection: placement === 'machine' ? base.input.selection : accountSelection,
            ...(placement === 'account' ? { reviewedFacts: { launch: base.input.selection.launch, provisioner,
                optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                retentionCapabilities: provisioner.retention, retention: base.input.selection.retention,
                wakeOnAcceptedMessage: base.input.selection.wakeOnAcceptedMessage } } : {}),
        });
        if (input.selection.kind !== 'one-off') throw new Error('Expected one-off compute admission');
        const selected = { ...base, input: { ...input, selection: input.selection } };
        const source = await sourceFixture(selected);
        const instance = await app(async () => { throw new Error('Fact reporting must not dispatch another Action'); }, undefined, source);
        const makeEnvelope = (rootActionId: typeof actionId, requestId: string, value: unknown) => {
            const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
            return mode === 'plain' ? { v: 1 as const, requestId, target, input: value }
                : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId, accountId: selected.account.id,
                    authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch },
                    actionId: rootActionId, requestId, target }, input: value,
                    material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
                    randomBytes: length => new Uint8Array(length).fill(3) });
        };
        const envelope = makeEnvelope('machines.managed.acquire', selected.requestId, selected.input);
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: source.session.id, starterDepth: 0, turnDepth: 1 },
            sourceTurnId: 'issued-native-acquire-turn', callerPermissionMode: 'default', requestId: selected.requestId });
        const installationProof = signMachineInstallationProof({ privateKey: selected.keys.secretKey,
            payload: { version: 1, accountId: selected.account.id, ...selected.controller,
                externalActionOrigin: { homeId, actionId: 'machines.managed.acquire', requestId: selected.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        try {
            const issued = await instance.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1,
                    machineId: selected.controller.machineId, envelope, sessionActionOrigin: origin,
                    sessionActionSource: selected.controller, installationProof } });
            expect(issued.statusCode, issued.body).toBe(200);
            let authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const post = (path: string, body: InjectOptions['payload']) => instance.inject({ method: 'POST', url: path, payload: body,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: authorization.binding.actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: authorization.binding.actionId, target: authorization.binding.target,
                        installationId: selected.controller.installationId, requestId: authorization.binding.requestId,
                        method: 'POST', path, body, privateKey: selected.keys.secretKey }) } });
            const admitted = await post('/v1/machines/managed/controller/admit', {
                input: selected.input, continuationPresent: false, requestId: selected.requestId,
            });
            expect(admitted.statusCode, admitted.body).toBe(200);
            const row = await db.managedMachine.findUniqueOrThrow({ where: { homeId_admittedActionRequestId: { homeId, admittedActionRequestId: selected.requestId } } });
            expect(row.controllerMachineId).toBe(controller?.machineId ?? null);
            expect(row.controllerInstallationId).toBe(controller?.installationId ?? null);
            const correlation = { homeId, managedId: row.id, requestId: selected.requestId,
                expectedIntentRevision: row.intentRevision, ...(controller ? { controller } : {}) };
            if (actionId === 'machines.managed.bootstrap.retry') {
                const retryEnvelope = makeEnvelope(actionId, crypto.randomUUID(),
                    { homeId, managedId: row.id, expectedIntentRevision: row.intentRevision });
                const retryOrigin = { ...origin, requestId: retryEnvelope.requestId };
                const retryProof = signMachineInstallationProof({ privateKey: selected.keys.secretKey,
                    payload: { version: 1, accountId: selected.account.id, ...selected.controller,
                        externalActionOrigin: { homeId, actionId, requestId: retryEnvelope.requestId,
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(retryEnvelope), origin: retryOrigin } } });
                const retry = await instance.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                    headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1,
                        machineId: selected.controller.machineId, envelope: retryEnvelope, sessionActionOrigin: retryOrigin,
                        sessionActionSource: selected.controller, installationProof: retryProof } });
                expect(retry.statusCode, retry.body).toBe(200);
                authorization = ExternalActionExecutionAuthorizationV1Schema.parse(retry.json());
                const context = await post('/v1/machines/managed/controller/context', {
                    homeId, managedId: row.id, expectedIntentRevision: row.intentRevision, ...(controller ? { controller } : {}),
                });
                expect(context.statusCode, context.body).toBe(200);
                expect(context.json()).toMatchObject({ requestId: selected.requestId });
                expect(authorization.binding.requestId).not.toBe(correlation.requestId);
            }
            const submitted = await post('/v1/machines/managed/controller/submit', correlation);
            expect(submitted.statusCode, submitted.body).toBe(200);
            expect(submitted.json()).toMatchObject({ submitted: true, machine: { allocation: 'may-exist' } });

            // Retire actual source custody after native submission, not a mock
            // of auth/currentness. The original installation remains valid.
            source.discovery.visible = false;
            await db.accessKey.deleteMany({ where: { accountId: selected.account.id, machineId: selected.controller.machineId, sessionId: source.session.id } });
            await db.session.update({ where: { id: source.session.id }, data: { active: false, archivedAt: new Date() } });
            await cancelManagedCreation({ actorAccountId: selected.account.id, input: { homeId, managedId: row.id, expectedIntentRevision: row.intentRevision } });
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toBeNull();

            const resource = { contributionRef: selected.input.selection.launch.provider, schemaVersion: 1, value: { id: 'late-paid-native' } };
            const body = { ...correlation, result: { kind: 'bound' as const, resource } };
            const report = '/v1/machines/managed/controller/report';
            if (!controller) expect((await post(report, { ...body, controller: selected.controller })).statusCode).toBe(401);
            const retained = await post(report, body);
            expect(retained.statusCode, retained.body).toBe(200);
            expect(retained.json()).toMatchObject({ machine: { id: row.id, allocation: 'bound', creationState: 'canceled', resource,
                cleanup: { disposition: 'pending', reason: 'late_allocation' } } });
            expect((await post(report, { ...body, requestId: 'unrelated-creation' })).statusCode).toBe(401);
            expect((await post(report, { ...body, expectedIntentRevision: row.intentRevision + 2 })).statusCode).toBe(401);
            expect((await post(report, { ...body, result: { kind: 'bound', resource: { ...resource, schemaVersion: 2 } } })).statusCode).toBe(409);
            expect((await post(report, { ...body, result: { kind: 'unknown', recovery: { reference: row.id, reason: 'unknown' } } })).statusCode).toBe(401);
            expect((await post('/v1/machines/managed/controller/current', correlation)).statusCode).toBe(401);
            expect((await post('/v1/machines/managed/controller/enrollment-context', { ...correlation, resource })).statusCode).toBe(401);
            expect((await post('/v1/machines/managed/controller/create-bootstrap-credential', { ...correlation, credential: {
                resourceId: crypto.randomUUID(), displayName: 'Bootstrap', kind: 'other', encryptionMode: 'plain',
                storedContent: { t: 'plain', v: { v: 1, name: 'Bootstrap', kind: 'other', value: 'must-not-be-persisted' } },
            } })).statusCode).toBe(401);
            // This exact submitted native fact retains its admitted requester
            // after Account-mode changes and credential withdrawal.
            await db.account.update({ where: { id: selected.account.id }, data: { encryptionMode: mode === 'plain' ? 'e2ee' : 'plain' } });
            expect((await post(report, body)).statusCode).toBe(200);
            await db.account.update({ where: { id: selected.account.id }, data: { encryptionMode: mode, tokenEpoch: { increment: 1 } } });
            expect((await post(report, body)).statusCode).toBe(200);
            await db.account.update({ where: { id: selected.account.id }, data: { tokenEpoch: selected.account.tokenEpoch } });
            await db.machine.update({ where: { id: selected.controller.machineId }, data: { revokedAt: new Date() } });
            expect((await post(report, body)).statusCode).toBe(401);
            await db.machine.update({ where: { id: selected.controller.machineId }, data: { revokedAt: null } });
            expect((await post(report, body)).statusCode).toBe(200);
            expect((await post(report, { ...body, result: { kind: 'bound', resource: { ...resource, value: { id: 'another-paid-resource' } } } })).statusCode).toBe(409);
            expect(await db.savedSecretResource.count({ where: { ownerAccountId: selected.account.id } })).toBe(0);
        } finally { await instance.close(); }
    });

    it.each([
        { placement: 'machine', mode: 'plain' },
        { placement: 'account', mode: 'plain' },
        { placement: 'account', mode: 'e2ee' },
    ] as const)('retains only a submitted Delete fact from a retired Workflow for $mode $placement placement', async ({ placement, mode }) => {
        const selected = await fixture(true, mode);
        const declared = selected.manifest.contributes.machineProvisioners?.[0];
        if (!declared) throw new Error('Expected the declared compute fixture');
        const provisioner = placement === 'account'
            ? { ...declared, billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const } } : declared;
        const { controller: machineController, ...accountSelection } = selected.input.selection;
        const controller = placement === 'machine' ? machineController : undefined;
        const input = ManagedAcquireInputV1Schema.parse({ ...selected.input,
            selection: placement === 'machine' ? selected.input.selection : accountSelection,
            ...(placement === 'account' ? { reviewedFacts: { launch: selected.input.selection.launch, provisioner,
                optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                retentionCapabilities: provisioner.retention, retention: selected.input.selection.retention,
                wakeOnAcceptedMessage: selected.input.selection.wakeOnAcceptedMessage } } : {}),
        });
        const created = await admitManagedAcquire({ custodianAccountId: selected.account.id, requesterAccountId: selected.account.id,
            requestEnvelopeDigest: 'a'.repeat(64), input: { input, requestId: selected.requestId, continuationPresent: false } });
        const acquisition = { homeId, managedId: created.machine.id, requestId: selected.requestId,
            expectedIntentRevision: 0, ...(controller ? { controller } : {}) };
        expect(await submitManagedAcquire(acquisition)).toMatchObject({ submitted: true });
        const resource = { contributionRef: selected.input.selection.launch.provider, schemaVersion: 1, value: { id: 'submitted-delete' } };
        await reportManagedAcquire({ ...acquisition, result: { kind: 'bound', resource } });
        // Persisted Run assignment is the real Workflow publisher boundary.
        // No lifecycle trigger or after-idle authority is involved in this immediate Delete.
        const originSession = await db.session.create({ data: { accountId: selected.account.id,
            tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const run = await db.automationRun.create({ data: { accountId: selected.account.id, originKind: 'direct', originSessionId: originSession.id,
            causeKind: null, state: 'running', workflowCustodyState: 'settled', workflowAcceptedSnapshotEnvelope: '{}',
            scheduledAt: new Date(), dueAt: new Date(), assignments: { create: { machineId: selected.controller.machineId } } } });
        const actionId = 'machines.managed.delete';
        const requestId = crypto.randomUUID();
        const target = { kind: 'machine' as const, machineId: selected.controller.machineId };
        const deleteInput = { homeId, managedId: created.machine.id, expectedRevision: 0,
            when: 'now' as const, intent: 'delete' as const, reviewedDependencies: true };
        const envelope = mode === 'plain' ? { v: 1 as const, requestId, target, input: deleteInput }
            : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId, accountId: selected.account.id,
                authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch }, actionId, requestId, target },
                input: deleteInput, material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
                randomBytes: length => new Uint8Array(length).fill(3) });
        const workflowActionOrigin = { runId: run.id, requestId };
        const installationProof = signMachineInstallationProof({ privateKey: selected.keys.secretKey,
            payload: { version: 1, accountId: selected.account.id, ...selected.controller,
                externalActionOrigin: { homeId, actionId, requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: workflowActionOrigin } } });
        const instance = await app(async () => { throw new Error('Fact reporting must not dispatch another Action'); });
        try {
            const issued = await instance.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1,
                    machineId: selected.controller.machineId, envelope, workflowActionOrigin, installationProof } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const post = (path: string, body: Record<string, unknown>) => instance.inject({ method: 'POST', url: path, payload: body,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: actionId, target: authorization.binding.target, installationId: selected.controller.installationId,
                        requestId, method: 'POST', path, body, privateKey: selected.keys.secretKey }) } });
            await admitManagedControl({ actorAccountId: selected.account.id, custodianAccountId: selected.account.id,
                input: { action: actionId, requestId, input: deleteInput } });
            const correlation = { ...acquisition, expectedIntentRevision: 1, requestId };
            expect(await submitManagedIntent(correlation)).toMatchObject({ submitted: true });
            await db.automationRun.update({ where: { id: run.id }, data: { state: 'failed' } });
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toBeNull();
            const path = '/v1/machines/managed/controller/report-intent';
            const body = { ...correlation, result: { kind: 'confirmed' }, observation: { observedAt: 10, availability: 'absent' } };
            if (!controller) expect((await post(path, { ...body, controller: selected.controller })).statusCode).toBe(401);
            const reported = await post(path, body);
            expect(reported.statusCode, reported.body).toBe(200);
            expect(reported.json()).toMatchObject({ machine: { id: created.machine.id, allocation: 'confirmed-absent', desired: 'delete' } });
            expect((await post(path, { ...body, requestId: 'another-delete' })).statusCode).toBe(401);
            expect((await post(path, { ...body, expectedIntentRevision: 2 })).statusCode).toBe(401);
            expect((await post('/v1/machines/managed/controller/current', correlation)).statusCode).toBe(401);
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } }))
                .toMatchObject({ allocation: 'confirmed-absent', controllerMachineId: controller?.machineId ?? null });
        } finally { await instance.close(); }
    });

    it.each((['plain', 'e2ee'] as const).flatMap(mode =>
        (['machine', 'account'] as const).map(placement => ({ mode, placement }))))('mints only the enrolled creation plan from a signed $mode $placement root', async ({ mode, placement }) => {
        const selected = await fixture(true, mode);
        const { controller: machineController, ...accountSelection } = selected.input.selection;
        const controller = placement === 'machine' ? machineController : undefined;
        const input = ManagedAcquireInputV1Schema.parse({ ...selected.input,
            selection: placement === 'machine' ? selected.input.selection : accountSelection });
        const guestKeys = tweetnacl.sign.keyPair();
        const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: selected.account.id, active: true,
            metadata: mode === 'plain' ? encodePlainMachineStoredContent({ host: 'guest', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }) : 'guest-ciphertext',
            dataEncryptionKey: mode === 'plain' ? decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') : null,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(guestKeys.publicKey),
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: capabilities } });
        const seal = (actionId: string, machineId: string, requestId: string, value: unknown) => mode === 'plain'
            ? { v: 1 as const, requestId, target: { kind: 'machine' as const, machineId }, input: value }
            : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId, accountId: selected.account.id,
                authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch }, actionId, requestId,
                target: { kind: 'machine', machineId } }, input: value,
                material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
                randomBytes: length => new Uint8Array(length).fill(3) });
        const instance = await app(async () => { throw new Error('Child minting must not execute setup'); });
        try {
            const issued = await instance.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1,
                    machineId: selected.controller.machineId,
                    envelope: seal('machines.managed.acquire', selected.controller.machineId, selected.requestId, input) } });
            expect(issued.statusCode, issued.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const admittedInput = { computeInput: input, continuation: null,
                machineSetup: { requestEnvelopeDigest: root.binding.requestEnvelopeDigest } };
            const preset = await db.managedMachinePreset.create({ data: { homeId, custodianAccountId: selected.account.id,
                name: 'Creation plan', launch: selected.input.selection.launch, setup: {}, revision: 1,
                controllerMachineId: controller?.machineId ?? null, controllerInstallationId: controller?.installationId ?? null } });
            const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: selected.account.id,
                controllerMachineId: controller?.machineId ?? null, controllerInstallationId: controller?.installationId ?? null,
                admittedActionRequestId: selected.requestId, admittedInput, machineSetup: { setup: {}, state: 'pending' },
                presetId: preset.id, presetRevision: 1,
                launch: selected.input.selection.launch, allocation: 'bound', resource: { contributionRef: selected.input.selection.launch.provider,
                    schemaVersion: 1, value: { id: 'enrolled-creation-plan' } }, enrolledMachineId: guest.id,
                retention: selected.input.selection.retention, wakeOnAcceptedMessage: false } });
            const path = bindExternalActionExecutionAuthorizationHttpPathV1('machines.setup.plan');
            const mint = (machineId = guest.id, creationRequestId = selected.requestId) => {
                const body = { v: 1, machineId,
                    envelope: seal('machines.setup.plan', machineId, 'creation-plan', { homeId, machineId }),
                    managedContinuation: { managedId: row.id, creationRequestId, expectedIntentRevision: 0 } };
                return instance.inject({ method: 'POST', url: path, payload: body, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: root.binding.actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: root.binding.actionId, target: root.binding.target, installationId: root.binding.installationId,
                        requestId: root.binding.requestId, method: 'POST', path, body, privateKey: selected.keys.secretKey }) } });
            };
            const minted = await mint();
            expect(minted.statusCode, minted.body).toBe(200);
            const child = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(child.binding).toMatchObject({ actionId: 'machines.setup.plan', machineId: guest.id,
                managedContinuation: { managedId: row.id, acquireRequestEnvelopeDigest: root.binding.requestEnvelopeDigest } });
            expect(child.binding.managedContinuation?.controller).toEqual(controller);
            expect(await verifyCurrentExternalActionPrincipal(child.binding)).not.toBeNull();
            expect((await mint(selected.controller.machineId)).statusCode).not.toBe(200);
            expect((await mint(guest.id, 'other-creation')).statusCode).not.toBe(200);
            if (controller) {
                // A move to another actual installation cannot carry the old
                // controller's signed root along with the retained creation.
                await db.managedMachine.update({ where: { id: row.id }, data: {
                    controllerMachineId: guest.id, controllerInstallationId: guest.installationId } });
                expect((await mint()).statusCode).not.toBe(200);
                await db.managedMachine.update({ where: { id: row.id }, data: {
                    controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId } });
            }
            await db.managedMachine.update({ where: { id: row.id }, data: { admittedInput: { ...admittedInput,
                machineSetup: { requestEnvelopeDigest: 'b'.repeat(64) } } } });
            expect((await mint()).statusCode).not.toBe(200);
        } finally { await instance.close(); }
    });

    it('binds installed acquisition HTTP phases to the exact admitted resource instead of its whole controller', async () => {
        const selected = await fixture(true);
        const instance = await app(async () => { throw new Error('Authorization must not execute native work'); });
        const post = (root: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>, path: string, body: Record<string, unknown>) =>
            instance.inject({ method: 'POST', url: path, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: root.binding.actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: root.binding.actionId, target: root.binding.target, installationId: root.binding.installationId,
                    requestId: root.binding.requestId, method: 'POST', path, body, privateKey: selected.keys.secretKey }),
            } });
        const create = async () => {
            const requestId = crypto.randomUUID();
            const envelope = { v: 1 as const, requestId, target: { kind: 'machine' as const, machineId: selected.controller.machineId },
                input: selected.input };
            const issued = await instance.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1, machineId: selected.controller.machineId, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const admitted = await post(root, '/v1/machines/managed/controller/admit', { input: selected.input, requestId, continuationPresent: false });
            expect(admitted.statusCode, admitted.body).toBe(200);
            return { root, row: await db.managedMachine.findUniqueOrThrow({ where: { homeId_admittedActionRequestId: { homeId, admittedActionRequestId: requestId } } }) };
        };
        try {
            const first = await create();
            const other = await create();
            const context = (managedId: string) => ({ homeId, managedId, expectedIntentRevision: 0, controller: selected.controller });
            expect((await post(first.root, '/v1/machines/managed/controller/context', context(first.row.id))).statusCode).toBe(200);
            const foreign = await post(first.root, '/v1/machines/managed/controller/context', context(other.row.id));
            expect(foreign.statusCode, foreign.body).toBe(401);
            const read = await post(first.root, '/v1/machines/managed/actions/get', { homeId, managedId: other.row.id });
            expect(read.statusCode, read.body).toBe(401);
            const current = await post(first.root, '/v1/machines/managed/controller/current', { ...context(other.row.id), requestId: other.root.binding.requestId });
            expect(current.statusCode, current.body).toBe(401);
        } finally { await instance.close(); }
    });

    it('retains a known offline controller row before forwarding and replays that exact allocation after reconnect', async () => {
        const selected = await fixture(false);
        let forwarded = false;
        const instance = await app(async params => {
            forwarded = true;
            const dispatch = ExternalActionDaemonDispatchRequestSchema.parse(params.callParams);
            const row = await db.managedMachine.findUniqueOrThrow({ where: { homeId_admittedActionRequestId: { homeId, admittedActionRequestId: selected.requestId } } });
            expect(row.allocation).toBe('unsubmitted');
            expect(dispatch.executionAuthorization?.binding).toMatchObject({ accountId: selected.account.id,
                custodianAccountId: selected.account.id, installationId: selected.controller.installationId,
                requestId: selected.requestId, authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch } });
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId: dispatch.actionId, requestId: dispatch.envelope.requestId,
                execution: { ok: true, result: { managedId: row.id, operation: { operationId: 'actual-daemon-operation' } } },
            })) };
        });
        const acquire = () => instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
            headers: { authorization: `Bearer ${selected.token}` },
            payload: { v: 1, requestId: selected.requestId, target: { kind: 'machine', machineId: selected.controller.machineId }, input: selected.input } });
        try {
            const waiting = await acquire();
            expect(waiting.statusCode).toBe(200);
            expect(forwarded).toBe(false);
            const row = await db.managedMachine.findUniqueOrThrow({ where: { homeId_admittedActionRequestId: { homeId, admittedActionRequestId: selected.requestId } } });
            expect(waiting.json()).toMatchObject({ execution: { ok: true, result: { managedId: row.id } } });
            expect(waiting.json().execution.result).not.toHaveProperty('operation');
            await db.machine.update({ where: { id: selected.controller.machineId }, data: { active: true } });
            const resumed = await acquire();
            expect(resumed.statusCode).toBe(200);
            expect(resumed.json(), resumed.body).toMatchObject({ execution: { ok: true, result: { managedId: row.id,
                operation: { operationId: 'actual-daemon-operation' } } } });
            expect(await db.managedMachine.count({ where: { custodianAccountId: selected.account.id } })).toBe(1);
        } finally { await instance.close(); }
    });

    it('refuses controllerless acquisition at physical Machine ingress before allocation or delivery', async () => {
        const selected = await fixture(true);
        const { controller: _controller, ...selection } = selected.input.selection;
        const input = ManagedAcquireInputV1Schema.parse({ ...selected.input, selection });
        const instance = await app(async () => { throw new Error('Refused controller admission must not reach socket delivery'); });
        try {
            const response = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
                headers: { authorization: `Bearer ${selected.token}` },
                payload: { v: 1, requestId: selected.requestId,
                    target: { kind: 'machine', machineId: selected.controller.machineId }, input } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json(), response.body).toMatchObject({ execution: { ok: false, errorCode: 'target_unavailable' } });
            expect(await db.managedMachine.count({ where: { homeId, admittedActionRequestId: selected.requestId } })).toBe(0);
        } finally { await instance.close(); }
    });

    it('refuses a viewing actor or replaced installation before creating an allocation', async () => {
        const selected = await fixture(true);
        const viewer = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        await db.machineAccountGrant.create({ data: { machineId: selected.controller.machineId,
            accountId: viewer.id, accessLevel: 'view', createdByAccountId: selected.account.id } });
        const viewerToken = await auth.createToken(viewer.id, undefined, { kind: 'account', authority: 'present_user' });
        const instance = await app(async () => { throw new Error('Refused admission must not reach socket delivery'); });
        const acquire = (token: string) => instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
            headers: { authorization: `Bearer ${token}` },
            payload: { v: 1, requestId: selected.requestId, target: { kind: 'machine', machineId: selected.controller.machineId }, input: selected.input } });
        try {
            expect((await acquire(viewerToken)).statusCode).toBe(403);
            await db.machine.update({ where: { id: selected.controller.machineId }, data: { installationId: 'replacement-installation' } });
            const replaced = await acquire(selected.token);
            expect(replaced.statusCode, replaced.body).toBe(200);
            expect(replaced.json(), replaced.body).toMatchObject({ execution: { ok: false, errorCode: 'target_unavailable' } });
            expect(await db.managedMachine.count({ where: { admittedActionRequestId: selected.requestId } })).toBe(0);
        } finally { await instance.close(); }
    });

    it('acknowledges only the durable id for sealed offline creation without opening or retaining the Agent continuation', async () => {
        const selected = await fixture(false, 'e2ee');
        const prompt = 'Private original composer text';
        const agentStart = { directory: { kind: 'path', path: '/repo' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'native.agent', localId: 'agent' } },
            creationKey: 'managed-agent-start', initialInput: { text: prompt } };
        const sealed = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId, accountId: selected.account.id,
            actionId: 'machines.managed.acquire', requestId: selected.requestId,
            target: { kind: 'machine', machineId: selected.controller.machineId },
            authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch } },
            input: ManagedAcquireInputV1Schema.parse({ ...selected.input, agentStart }), material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) },
            randomBytes: length => new Uint8Array(length).fill(2) });
        const instance = await app(async () => { throw new Error('Offline admission must not deliver to a daemon'); });
        try {
            const response = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
                headers: { authorization: `Bearer ${selected.token}` }, payload: sealed });
            expect(response.statusCode).toBe(409);
            const row = await db.managedMachine.findUniqueOrThrow({ where: { homeId_admittedActionRequestId: {
                homeId, admittedActionRequestId: selected.requestId } } });
            expect(response.json()).toEqual({ error: 'invalid_request', code: 'target_unavailable',
                requestId: selected.requestId, managedAdmission: { managedId: row.id },
                diagnostic: { reason: 'machine_offline', remedy: 'reconnect_machine', requiredFact: 'machine_online' } });
            expect(row.allocation).toBe('unsubmitted');
            expect(JSON.stringify(row)).not.toContain(prompt);
            expect(JSON.stringify(row)).not.toContain(sealed.payload.c);
            expect(JSON.stringify(response.json())).not.toContain(prompt);
            expect(response.json()).not.toHaveProperty('payload');
            expect(response.json()).not.toHaveProperty('execution');
        } finally { await instance.close(); }
    });

    it('refuses a sealed acquire with missing managed admission before retaining or forwarding it', async () => {
        const selected = await fixture(true, 'e2ee');
        const sealed = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId, accountId: selected.account.id,
            actionId: 'machines.managed.acquire', requestId: selected.requestId,
            target: { kind: 'machine', machineId: selected.controller.machineId },
            authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch } },
            input: ManagedAcquireInputV1Schema.parse(selected.input), material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) },
            randomBytes: length => new Uint8Array(length).fill(2) });
        const { managedAdmission: _admission, ...miswired } = sealed;
        const instance = await app(async () => { throw new Error('Missing admission must not reach a daemon'); });
        try {
            const response = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
                headers: { authorization: `Bearer ${selected.token}` }, payload: miswired });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: 'invalid_request', code: 'invalid_envelope', requestId: selected.requestId });
            expect(await db.managedMachine.count({ where: { admittedActionRequestId: selected.requestId } })).toBe(0);
        } finally { await instance.close(); }
    });

    it('answers a reached preset limit with its own refusal through a sealed acquire, not a missing target', async () => {
        const selected = await fixture(true, 'e2ee');
        const preset = await db.managedMachinePreset.create({ data: { homeId, custodianAccountId: selected.account.id,
            name: 'Capped', launch: selected.input.selection.launch, setup: {}, revision: 1, simultaneousMaximum: 1,
            controllerMachineId: selected.controller.machineId, controllerInstallationId: selected.controller.installationId } });
        await db.managedMachine.create({ data: { homeId, custodianAccountId: selected.account.id,
            controllerMachineId: selected.controller.machineId, controllerInstallationId: selected.controller.installationId,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: { enrollmentAccountId: selected.account.id },
            presetId: preset.id, presetRevision: 1, launch: selected.input.selection.launch, allocation: 'bound',
            resource: { contributionRef: selected.input.selection.launch.provider, schemaVersion: 1, value: { id: 'first' } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const input = ManagedAcquireInputV1Schema.parse({ ...selected.input,
            selection: { kind: 'preset', homeId, id: preset.id, revision: 1 }, controller: selected.controller,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const sealed = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId, accountId: selected.account.id,
            actionId: 'machines.managed.acquire', requestId: selected.requestId,
            target: { kind: 'machine', machineId: selected.controller.machineId },
            authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch } },
            input, material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) },
            randomBytes: length => new Uint8Array(length).fill(2) });
        const instance = await app(async () => { throw new Error('A refused admission must not reach a daemon'); });
        try {
            const response = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
                headers: { authorization: `Bearer ${selected.token}` }, payload: sealed });
            expect(response.statusCode, response.body).toBe(409);
            expect(response.json(), response.body).toMatchObject({ code: 'preset_limit_reached' });
            expect(await db.managedMachine.count({ where: { admittedActionRequestId: selected.requestId } })).toBe(0);
        } finally { await instance.close(); }
    });

    it('refuses a plaintext acquire for an encrypted Account before retaining an offline admission', async () => {
        const selected = await fixture(false, 'e2ee');
        let delivered = false;
        const instance = await app(async () => { delivered = true; return { ok: false, error: 'must not forward' }; });
        try {
            const response = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
                headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1,
                    requestId: selected.requestId, target: { kind: 'machine', machineId: selected.controller.machineId }, input: selected.input } });
            expect(response.statusCode).toBe(400);
            expect(response.json().code).toBe('invalid_encrypted_envelope');
            expect(await db.managedMachine.count({ where: { homeId, admittedActionRequestId: selected.requestId } })).toBe(0);
            expect(delivered).toBe(false);
        } finally { await instance.close(); }
    });

    it('does not initialize predecessor storage when a child becomes stale between legacy create and tag rejoin', async () => {
        const selected = await fixture(true, 'e2ee');
        const guestKeys = tweetnacl.sign.keyPair();
        const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: selected.account.id,
            active: true, metadata: 'encrypted-guest-metadata', installationId: crypto.randomUUID(),
            installationPublicKey: new Uint8Array(guestKeys.publicKey), operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: capabilities } });
        const instance = await app(async () => { throw new Error('Mint and Session rejoin do not deliver an Action'); });
        const agentStart = { directory: { kind: 'path' as const, path: '/repo' },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'native.agent', localId: 'agent' } },
            creationKey: 'retained-guest-start' };
        const rootEnvelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId,
            accountId: selected.account.id, authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch },
            actionId: 'machines.managed.acquire', requestId: selected.requestId,
            target: { kind: 'machine', machineId: selected.controller.machineId } },
            input: ManagedAcquireInputV1Schema.parse({ ...selected.input, agentStart }),
            material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) },
            randomBytes: length => new Uint8Array(length).fill(2) });
        let restoreRead: (() => void) | undefined;
        try {
            const rootResponse = await instance.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                headers: { authorization: `Bearer ${selected.token}` },
                payload: { v: 1, machineId: selected.controller.machineId, envelope: rootEnvelope } });
            expect(rootResponse.statusCode, rootResponse.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(rootResponse.json());
            const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: selected.account.id,
                controllerMachineId: selected.controller.machineId, controllerInstallationId: selected.controller.installationId,
                admittedActionRequestId: selected.requestId,
                admittedInput: { computeInput: selected.input, continuation: { requestEnvelopeDigest: root.binding.requestEnvelopeDigest } },
                launch: selected.input.selection.launch, allocation: 'bound', resource: { contributionRef: selected.input.selection.launch.provider,
                    schemaVersion: 1, value: { id: 'retained-legacy-resource' } }, enrolledMachineId: guest.id,
                retention: selected.input.selection.retention, wakeOnAcceptedMessage: false } });
            const spawnInput = { ...agentStart, executionTarget: { serverId: homeId, machineId: guest.id } };
            const envelope = { ...sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId,
                accountId: selected.account.id, authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch },
                actionId: 'session.spawn_new', requestId: 'legacy-child', target: { kind: 'machine', machineId: guest.id } },
                input: spawnInput, material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
                randomBytes: length => new Uint8Array(length).fill(3) }),
                sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(spawnInput) };
            const path = bindExternalActionExecutionAuthorizationHttpPathV1('session.spawn_new');
            const body = { v: 1, machineId: guest.id, envelope,
                managedContinuation: { managedId: row.id, creationRequestId: selected.requestId, expectedIntentRevision: 0 } };
            const childResponse = await instance.inject({ method: 'POST', url: path, payload: body,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.managed.acquire',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: 'machines.managed.acquire', target: root.binding.target,
                        installationId: root.binding.installationId, requestId: root.binding.requestId,
                        method: 'POST', path, body, privateKey: selected.keys.secretKey }) } });
            expect(childResponse.statusCode, childResponse.body).toBe(200);
            const child = ExternalActionExecutionAuthorizationV1Schema.parse(childResponse.json());
            const archivedAt = new Date();
            const retained = await db.session.create({ data: { accountId: selected.account.id, tag: crypto.randomUUID(),
                metadata: 'encrypted-predecessor-metadata', encryptionMode: 'e2ee', active: false,
                archivedAt, metadataLayoutVersion: 0, currentStorageState: 'hosted' } });
            const sessionBody = { tag: retained.tag, metadata: 'encrypted-resubmitted-metadata',
                encryptionMode: 'e2ee', currentStorageState: 'machine_only' };
            let retiredAfterUniqueFailure = false;
            const originalRead = db.session.findUnique;
            const actualRead = originalRead.bind(db.session);
            let interleavedRead = false;
            // Transparent DB-boundary interleaving only: the actual first
            // transaction really loses the existing tag's unique insert.
            const readThenRetire = (args: Parameters<typeof db.session.findUnique>[0]) => {
                if (interleavedRead) return actualRead(args);
                interleavedRead = true;
                return actualRead(args).then(async result => {
                    if (result?.id === retained.id) {
                        retiredAfterUniqueFailure = true;
                        await db.managedMachine.update({ where: { id: row.id }, data: { creationState: 'canceled', intentRevision: 1 } });
                    }
                    return result;
                });
            };
            // Prisma's delegate is a lazy proxy, not an own method descriptor.
            // Restore the actual method value rather than a spy descriptor.
            // Install the DB-boundary adapter without claiming its ordinary
            // Promise is Prisma's generic lazy client.
            Reflect.set(db.session, 'findUnique', readThenRetire);
            restoreRead = () => { db.session.findUnique = originalRead; };
            const rejoin = await instance.inject({ method: 'POST', url: '/v1/sessions', payload: sessionBody,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: child.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.spawn_new',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(child.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: child.token,
                        effectActionId: 'session.spawn_new', target: child.binding.target,
                        installationId: child.binding.installationId, requestId: child.binding.requestId,
                        method: 'POST', path: '/v1/sessions', body: sessionBody, privateKey: guestKeys.secretKey }) } });
            expect(retiredAfterUniqueFailure, rejoin.body).toBe(true);
            expect(rejoin.statusCode, rejoin.body).toBe(401);
            expect(await db.session.findUniqueOrThrow({ where: { id: retained.id } }))
                .toMatchObject({ currentStorageState: 'hosted', active: false, archivedAt,
                    metadata: retained.metadata, metadataLayoutVersion: 0 });
        } finally { restoreRead?.(); await instance.close(); }
    });

    it.each([false, true])('refuses personal setup references on another custodian while preserving shared-reference authority (reviewed child: %s)', async reviewed => {
        const source = await fixture(true);
        const target = await fixture(true);
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: target.account.id, machineId: target.controller.machineId,
            principal: { kind: 'account', accountId: source.account.id }, level: 'admin' }));
        const presetId = crypto.randomUUID();
        await db.managedMachinePreset.create({ data: { id: presetId, homeId, custodianAccountId: source.account.id, name: 'Personal tools',
            launch: source.input.selection.launch, controllerMachineId: source.controller.machineId,
            controllerInstallationId: source.controller.installationId,
            setup: { scripts: [{ body: 'echo configured' }], secretRefs: { v: 1, bindings: { TOKEN: { ref: 'same-personal-id' } } } } } });
        const input = MachineSetupSourcesApplyInputV1Schema.parse({ homeId, machineId: target.controller.machineId, sources: [
            { kind: 'accountPreset', presetId, presetRevision: 0, setup: { scripts: [{ body: 'echo configured' }],
                secretRefs: { v: 1, bindings: { TOKEN: { ref: 'same-personal-id' } } } } },
            { kind: 'direct', setup: {} },
        ] });
        const instance = await app(async () => { throw new Error('Resolving references cannot execute setup'); });
        try {
            const mint = () => instance.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.setup.apply'),
                headers: { authorization: `Bearer ${source.token}` }, payload: { v: 1, machineId: input.machineId,
                    envelope: { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: input.machineId },
                        input: { homeId, machineId: input.machineId,
                            targets: [{ ...input, desiredRevision: 0, recipePlans: [] }] } } } });
            const issued = await mint();
            expect(issued.statusCode, issued.body).toBe(200);
            let authority = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const path = '/v1/machines/setup/resolve';
            const resolve = (mismatchedReview = false) => {
                const reviewedActionId = mismatchedReview ? 'machines.setup.remove' as const : 'machines.setup.apply' as const;
                const reviewedChild = reviewed ? { actionId: reviewedActionId, role: 'setup.target',
                    inputDigest: computeActionInputApprovalDigestV1(reviewedActionId, input) } : undefined;
                return instance.inject({ method: 'POST', url: path, payload: input, headers: {
                    ...(reviewedChild ? { [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild) } : {}),
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authority.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.setup.apply',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authority.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authority.token,
                        effectActionId: 'machines.setup.apply', target: authority.binding.target, installationId: authority.binding.installationId,
                        requestId: authority.binding.requestId, method: 'POST', path, body: input,
                        ...(reviewedChild ? { reviewedChild } : {}), privateKey: target.keys.secretKey }),
                } });
            };
            const refused = await resolve();
            expect(refused.statusCode, refused.body).toBe(409);
            expect(refused.json()).toEqual({ code: 'credential_unavailable' });
            const setup = { scripts: [{ body: 'echo configured' }], secretRefs: { v: 1 as const,
                bindings: { TOKEN: { ref: 'happier:shared-secret:v1:exact-resource', revision: 1 } } } };
            await db.managedMachinePreset.update({ where: { id: presetId }, data: { setup } });
            input.sources = input.sources.map(source => source.kind === 'accountPreset' ? { ...source, setup } : source);
            const sharedIssued = await mint();
            expect(sharedIssued.statusCode, sharedIssued.body).toBe(200);
            authority = ExternalActionExecutionAuthorizationV1Schema.parse(sharedIssued.json());
            const shared = await resolve();
            expect(shared.statusCode, shared.body).toBe(200);
            expect(shared.json()).toEqual({ sources: input.sources });
            if (reviewed) expect((await resolve(true)).statusCode).toBe(401);
        } finally { await instance.close(); }
    });

    it('requires controller authority before a guest-only manager reads or reports retained setup', async () => {
        const owner = await fixture(true);
        const actor = await fixture(true);
        const guestKeys = tweetnacl.sign.keyPair();
        const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.account.id,
            active: true, metadata: encodePlainMachineStoredContent({ host: 'guest', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(guestKeys.publicKey),
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: capabilities } });
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.account.id, machineId: guest.id,
            principal: { kind: 'account', accountId: actor.account.id }, level: 'admin' }));
        const presetId = crypto.randomUUID();
        const setup = { scripts: [{ body: 'echo private admitted snapshot' }] };
        await db.managedMachinePreset.create({ data: { id: presetId, homeId, custodianAccountId: owner.account.id,
            name: 'Edited archived preset', launch: owner.input.selection.launch, controllerMachineId: owner.controller.machineId,
            controllerInstallationId: owner.controller.installationId, revision: 2,
            archivedAt: new Date(), setup: { setupScript: 'echo changed' } } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: owner.account.id,
            controllerMachineId: owner.controller.machineId, controllerInstallationId: owner.controller.installationId,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, presetId, presetRevision: 1,
            launch: owner.input.selection.launch, retention: owner.input.selection.retention, wakeOnAcceptedMessage: false,
            allocation: 'bound', enrolledMachineId: guest.id, machineSetup: { setup, state: 'pending' },
            resource: { contributionRef: owner.input.selection.launch.provider, schemaVersion: 1, value: { id: 'same-resource' } } } });
        await expect(getManagedMachine({ actorAccountId: actor.account.id, input: { homeId, managedId: row.id } }))
            .rejects.toMatchObject({ code: 'permission_denied' });
        const instance = await app(async () => { throw new Error('Resolving and reporting cannot execute setup'); });
        try {
            const creation = { homeId, machineId: guest.id, presetId, presetRevision: 1 };
            const input = { homeId, machineId: guest.id, sources: [
                { kind: 'accountPreset', presetId, presetRevision: 1, setup },
                { kind: 'direct', setup: {} },
            ] };
            const envelope = { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: guest.id },
                input: { homeId, machineId: guest.id, targets: [{ ...input, desiredRevision: 0, recipePlans: [] }] } };
            const issued = await instance.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.setup.apply'),
                headers: { authorization: `Bearer ${actor.token}` }, payload: { v: 1, machineId: guest.id, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authority = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const post = (path: string, body: InjectOptions['payload']) => instance.inject({ method: 'POST', url: path, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authority.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.setup.apply',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authority.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authority.token,
                    effectActionId: 'machines.setup.apply', target: authority.binding.target, installationId: authority.binding.installationId,
                    requestId: authority.binding.requestId, method: 'POST', path, body, privateKey: guestKeys.secretKey }),
            } });
            const resolved = await post('/v1/machines/setup/resolve', input);
            const reported = await post('/v1/machines/setup/report', { ...creation, managedId: row.id,
                state: 'running', operation: { operationId: 'unauthorized-retry' } });
            expect(resolved.statusCode, resolved.body).toBe(403);
            expect(resolved.json()).toEqual({ code: 'permission_denied' });
            expect(reported.statusCode, reported.body).toBe(403);
            expect(reported.json()).toEqual({ code: 'permission_denied' });
            expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).machineSetup)
                .toEqual({ setup, state: 'pending' });
            await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.account.id,
                machineId: owner.controller.machineId, principal: { kind: 'account', accountId: actor.account.id }, level: 'view' }));
            const readable = await post('/v1/machines/setup/resolve', input);
            expect(readable.statusCode, readable.body).toBe(200);
            expect(readable.json()).toEqual({ sources: input.sources, creation: { managedId: row.id,
                preset: { id: presetId, revision: 1 } } });
            const readOnlyReport = await post('/v1/machines/setup/report', { ...creation, managedId: row.id,
                state: 'running', operation: { operationId: 'read-only-retry' } });
            expect(readOnlyReport.statusCode, readOnlyReport.body).toBe(403);
            expect(readOnlyReport.json()).toEqual({ code: 'permission_denied' });
            expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).machineSetup)
                .toEqual({ setup, state: 'pending' });
        } finally { await instance.close(); }
    });

    it.each(['ui', 'voice', 'session'] as const)('retains the captured %s authority through managed setup proof issuance and guest dispatch', async originKind => {
        const selected = await fixture(true);
        const source = originKind === 'session' ? await sourceFixture(selected) : undefined;
        const origin = source ? SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: source.session.id, starterDepth: 0, turnDepth: 0 },
            sourceTurnId: 'admitted-turn', callerPermissionMode: 'default', workspaceWrites: 'allow',
            requestId: selected.requestId }) : undefined;
        const authority = originKind === 'ui' ? 'present_user' : 'account_automation';
        const guestKeys = tweetnacl.sign.keyPair();
        const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: selected.account.id,
            active: true, operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: capabilities,
            metadata: encodePlainMachineStoredContent({ host: 'guest', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(guestKeys.publicKey) } });
        let delivered: ReturnType<typeof ExternalActionDaemonDispatchRequestSchema.parse> | undefined;
        const instance = await app(async request => {
            delivered = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            return { ok: true, result: { kind: 'invalid_request', errorCode: 'invalid_envelope' } };
        }, undefined, source);
        try {
            const rootEnvelope = { v: 1 as const, requestId: selected.requestId,
                target: { kind: 'machine' as const, machineId: selected.controller.machineId }, input: selected.input };
            const installationProof = origin ? signMachineInstallationProof({ privateKey: selected.keys.secretKey,
                payload: { version: 1, accountId: selected.account.id, ...selected.controller,
                    externalActionOrigin: { homeId, actionId: 'machines.managed.acquire', requestId: selected.requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(rootEnvelope), origin } } }) : undefined;
            const issued = await instance.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                headers: { authorization: `Bearer ${selected.token}`,
                    ...(authority === 'account_automation' ? { [AUTHORITY_CEILING_HEADER_V1]: authority } : {}) },
                payload: { v: 1, machineId: selected.controller.machineId, envelope: rootEnvelope,
                    ...(origin ? { sessionActionOrigin: origin, sessionActionSource: selected.controller, installationProof } : {}) } });
            expect(issued.statusCode, issued.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const presetId = crypto.randomUUID();
            await db.managedMachinePreset.create({ data: { id: presetId, homeId, custodianAccountId: selected.account.id, name: 'Setup',
                launch: selected.input.selection.launch, controllerMachineId: selected.controller.machineId,
                controllerInstallationId: selected.controller.installationId, setup: { scripts: [{ body: 'echo configured' }] } } });
            // The retained paid resource is the real Home owner boundary after
            // the parent acquire's approved replay, without invoking native IO.
            const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: selected.account.id,
                controllerMachineId: selected.controller.machineId, controllerInstallationId: selected.controller.installationId,
                admittedActionRequestId: selected.requestId, admittedInput: { computeInput: selected.input, continuation: null,
                    machineSetup: { requestEnvelopeDigest: root.binding.requestEnvelopeDigest } },
                presetId, presetRevision: 1, machineSetup: { setup: { scripts: [{ body: 'echo configured' }] }, state: 'pending' },
                launch: selected.input.selection.launch, allocation: 'bound', resource: { contributionRef: selected.input.selection.launch.provider,
                    schemaVersion: 1, value: { id: 'approved-paid-resource' } }, enrolledMachineId: guest.id,
                retention: selected.input.selection.retention, wakeOnAcceptedMessage: false } });
            const body = { v: 1, machineId: guest.id,
                envelope: { v: 1 as const, requestId: selected.requestId, target: { kind: 'machine' as const, machineId: guest.id },
                    input: { homeId, machineId: guest.id, targets: [{ homeId, machineId: guest.id, desiredRevision: 0, recipePlans: [], sources: [
                        { kind: 'accountPreset', presetId, presetRevision: 1, setup: { scripts: [{ body: 'echo configured' }] } },
                        { kind: 'direct', setup: {} },
                    ] }] } },
                managedContinuation: { managedId: row.id, creationRequestId: selected.requestId, expectedIntentRevision: 0 } };
            const headersFor = (path: string) => ({
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.managed.acquire',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [AUTHORITY_CEILING_HEADER_V1]: authority,
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: 'machines.managed.acquire', target: root.binding.target, installationId: root.binding.installationId,
                    requestId: root.binding.requestId, method: 'POST', path, body, privateKey: selected.keys.secretKey }),
            });
            const mintPath = bindExternalActionExecutionAuthorizationHttpPathV1('machines.setup.apply');
            const minted = await instance.inject({ method: 'POST', url: mintPath, payload: body, headers: headersFor(mintPath) });
            expect(minted.statusCode, minted.body).toBe(200);
            const child = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const current = await verifyCurrentExternalActionPrincipal(child.binding);
            expect(current).not.toBeNull();
            expect(projectExternalActionBoundPrincipal(child.binding, current!, authority)?.authority).toBe(authority);
            const dispatchPath = '/v1/actions/machines.setup.apply';
            await instance.inject({ method: 'POST', url: dispatchPath, payload: body, headers: headersFor(dispatchPath) });
            expect(delivered?.principal).toMatchObject({ accountId: selected.account.id, authority });
            if (origin) expect(delivered?.principal).toHaveProperty('sessionActionOrigin', origin);
            if (originKind === 'voice') {
                // A new present-user claim must never raise an already narrowed principal.
                expect(projectExternalActionBoundPrincipal(root.binding,
                    { accountId: selected.account.id, authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch },
                        authority: 'account_automation' }, 'present_user')?.authority).toBe('account_automation');
            }
        } finally { await instance.close(); }
    });

    it.each(['plain', 'e2ee'] as const)('delegates setup to the exact enrolled guest under the admitted %s creation authority', async mode => {
        const selected = await fixture(true, mode);
        const guestKeys = tweetnacl.sign.keyPair();
        const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: selected.account.id,
            active: true, metadata: mode === 'e2ee' ? 'guest-ciphertext' : encodePlainMachineStoredContent({ host: 'guest', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
            dataEncryptionKey: mode === 'e2ee' ? null : decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(guestKeys.publicKey),
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: capabilities } });
        const instance = await app(async () => { throw new Error('Authority minting cannot execute setup'); });
        try {
            const rootInput = ManagedAcquireInputV1Schema.parse({ ...selected.input, agentStart: {
                directory: { kind: 'path', path: '/repo' }, creationKey: 'setup-waiting-session',
                agentTarget: { kind: 'agent', identity: { pluginId: 'native.agent', localId: 'agent' } },
            } });
            const rootEnvelope = mode === 'plain' ? { v: 1 as const, requestId: selected.requestId,
                target: { kind: 'machine' as const, machineId: selected.controller.machineId }, input: rootInput }
                : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId, accountId: selected.account.id,
                    authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch }, actionId: 'machines.managed.acquire',
                    requestId: selected.requestId, target: { kind: 'machine', machineId: selected.controller.machineId } },
                    input: rootInput, material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
                    randomBytes: length => new Uint8Array(length).fill(2) });
            const rootResponse = await instance.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1, machineId: selected.controller.machineId, envelope: rootEnvelope } });
            expect(rootResponse.statusCode, rootResponse.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(rootResponse.json());
            const setup = { scripts: [{ body: 'echo snapshot' }] };
            const presetId = crypto.randomUUID();
            await db.managedMachinePreset.create({ data: { id: presetId, homeId, custodianAccountId: selected.account.id, name: 'Setup',
                launch: selected.input.selection.launch, controllerMachineId: selected.controller.machineId,
                controllerInstallationId: selected.controller.installationId, setup: { scripts: [{ body: 'echo edited' }] }, revision: 2 } });
            const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: selected.account.id,
                controllerMachineId: selected.controller.machineId, controllerInstallationId: selected.controller.installationId,
                admittedActionRequestId: selected.requestId, admittedInput: { computeInput: selected.input, continuation: null,
                    machineSetup: { requestEnvelopeDigest: root.binding.requestEnvelopeDigest } },
                presetId, presetRevision: 1, machineSetup: { setup, state: 'pending' },
                launch: selected.input.selection.launch, allocation: 'bound', resource: { contributionRef: selected.input.selection.launch.provider,
                    schemaVersion: 1, value: { id: 'setup-paid-resource' } }, enrolledMachineId: guest.id,
                retention: selected.input.selection.retention, wakeOnAcceptedMessage: false } });
            // Session continuation has independent admitted custody. Setup must
            // hold even an otherwise valid original Session start at this owner.
            await db.managedMachine.update({ where: { id: row.id }, data: { admittedInput: {
                computeInput: selected.input, continuation: { requestEnvelopeDigest: root.binding.requestEnvelopeDigest },
                machineSetup: { requestEnvelopeDigest: root.binding.requestEnvelopeDigest },
            } } });
            const spawnInput = { executionTarget: { serverId: homeId, machineId: guest.id },
                directory: { kind: 'path' as const, path: '/repo' }, creationKey: 'setup-waiting-session',
                agentTarget: { kind: 'agent' as const, identity: { pluginId: 'native.agent', localId: 'agent' } } };
            const spawnPath = bindExternalActionExecutionAuthorizationHttpPathV1('session.spawn_new');
            const spawnEnvelope = mode === 'plain' ? { v: 1 as const, requestId: 'setup-waiting-session',
                target: { kind: 'machine' as const, machineId: guest.id }, input: spawnInput }
                : { ...sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId, accountId: selected.account.id,
                    authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch }, actionId: 'session.spawn_new',
                    requestId: 'setup-waiting-session', target: { kind: 'machine', machineId: guest.id } }, input: spawnInput,
                    material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: length => new Uint8Array(length).fill(4) }),
                    sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(spawnInput) };
            const spawnBody = { v: 1, machineId: guest.id, envelope: spawnEnvelope,
                managedContinuation: { managedId: row.id, creationRequestId: selected.requestId, expectedIntentRevision: 0 } };
            const mintSession = () => instance.inject({ method: 'POST', url: spawnPath, payload: spawnBody, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token, [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.managed.acquire',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: 'machines.managed.acquire', target: root.binding.target, installationId: root.binding.installationId,
                    requestId: root.binding.requestId, method: 'POST', path: spawnPath, body: spawnBody, privateKey: selected.keys.secretKey }),
            } });
            expect((await mintSession()).statusCode).not.toBe(200);
            const target = { homeId, machineId: guest.id, sources: [
                { kind: 'accountPreset' as const, presetId, presetRevision: 1, setup },
                { kind: 'direct' as const, setup: {} },
            ] };
            type SetupChildAction = 'machines.setup.apply' | 'machines.setup.plan';
            const makeBody = (input: { homeId: string; machineId: string; sources?: typeof target.sources; mode?: 'effects' } = target,
                actionId: SetupChildAction = 'machines.setup.apply') => {
                const actionInput = actionId === 'machines.setup.apply'
                    ? { homeId: input.homeId, machineId: input.machineId, targets: [{ homeId: input.homeId,
                        machineId: input.machineId, sources: input.sources ?? [], desiredRevision: 0, recipePlans: [] }] }
                    : input;
                return { v: 1, machineId: input.machineId,
                envelope: mode === 'plain' ? { v: 1 as const, requestId: 'creation-setup', target: { kind: 'machine' as const, machineId: input.machineId }, input: actionInput }
                    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId, accountId: selected.account.id,
                        authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch }, actionId,
                        requestId: 'creation-setup', target: { kind: 'machine', machineId: input.machineId } }, input: actionInput,
                        material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(8) },
                        randomBytes: length => new Uint8Array(length).fill(3) }),
                managedContinuation: { managedId: row.id, creationRequestId: selected.requestId, expectedIntentRevision: 0 } };
            };
            const mint = (body: Omit<ReturnType<typeof makeBody>, 'managedContinuation'>
                & Partial<Pick<ReturnType<typeof makeBody>, 'managedContinuation'>>, actionId: SetupChildAction = 'machines.setup.apply') => {
                const path = bindExternalActionExecutionAuthorizationHttpPathV1(actionId);
                return instance.inject({ method: 'POST', url: path, payload: body,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.managed.acquire',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: 'machines.managed.acquire', target: root.binding.target, installationId: root.binding.installationId,
                        requestId: root.binding.requestId, method: 'POST', path, body, privateKey: selected.keys.secretKey }) } });
            };
            const planInput = { homeId, machineId: guest.id };
            const planned = await mint(makeBody(planInput, 'machines.setup.plan'), 'machines.setup.plan');
            expect(planned.statusCode, planned.body).toBe(200);
            const planChild = ExternalActionExecutionAuthorizationV1Schema.parse(planned.json());
            const verifyHostRoster = (authorization: typeof planChild, method = 'GET', path = '/v1/machines', body?: unknown) =>
                verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
                    effectActionId: authorization.binding.actionId,
                    encodedTarget: encodeExternalActionResolvedTargetV1(authorization.binding.target), method, path, body,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: authorization.binding.actionId, target: authorization.binding.target,
                        installationId: authorization.binding.installationId, requestId: authorization.binding.requestId,
                        method, path, body, privateKey: authorization.binding.machineId === guest.id
                            ? guestKeys.secretKey : selected.keys.secretKey }) });
            expect(await verifyHostRoster(planChild)).not.toBeNull();
            expect(await verifyHostRoster(planChild, 'POST', '/v1/machines', {})).toBeNull();
            expect(await verifyHostRoster(planChild, 'GET', '/v1/machines', {})).toBeNull();
            expect(await verifyHostRoster(root)).toBeNull();
            expect(planChild.binding).toMatchObject({ actionId: 'machines.setup.plan', machineId: guest.id,
                installationId: guest.installationId, managedContinuation: { managedId: row.id } });
            expect(await verifyCurrentExternalActionPrincipal(planChild.binding)).not.toBeNull();
            const { managedContinuation: omittedContinuation, ...unprovedPlan } = makeBody(planInput, 'machines.setup.plan');
            expect(omittedContinuation.managedId).toBe(row.id);
            expect((await mint(unprovedPlan, 'machines.setup.plan')).statusCode).not.toBe(200);
            expect((await mint(makeBody({ ...planInput, machineId: selected.controller.machineId }, 'machines.setup.plan'), 'machines.setup.plan')).statusCode).not.toBe(200);
            if (mode === 'plain') expect((await mint(makeBody(target, 'machines.setup.plan'), 'machines.setup.plan')).statusCode).not.toBe(200);
            const effectsInput = { ...target, mode: 'effects' as const };
            const effectsResponse = await mint(makeBody(effectsInput, 'machines.setup.plan'), 'machines.setup.plan');
            expect(effectsResponse.statusCode, effectsResponse.body).toBe(200);
            const effectsChild = ExternalActionExecutionAuthorizationV1Schema.parse(effectsResponse.json());
            const resolveForPlan = (input: object = target, path = '/v1/machines/setup/resolve') => instance.inject({
                method: 'POST', url: path, payload: input, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: effectsChild.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.setup.plan',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(effectsChild.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: effectsChild.token,
                        effectActionId: 'machines.setup.plan', target: effectsChild.binding.target, installationId: effectsChild.binding.installationId,
                        requestId: effectsChild.binding.requestId, method: 'POST', path, body: input, privateKey: guestKeys.secretKey }),
                },
            });
            const effectsResolved = await resolveForPlan();
            expect(effectsResolved.statusCode, effectsResolved.body).toBe(200);
            expect(effectsResolved.json()).toEqual({ sources: target.sources,
                creation: { managedId: row.id, preset: { id: presetId, revision: 1 } } });
            const changedEffects = { ...target, sources: target.sources.map(source => source.kind === 'accountPreset'
                ? { ...source, setup: { scripts: [{ body: 'unreviewed plan effect' }] } } : source) };
            expect((await resolveForPlan(changedEffects)).statusCode).toBe(409);
            if (mode === 'plain') expect((await mint(makeBody({ ...changedEffects, mode: 'effects' }, 'machines.setup.plan'), 'machines.setup.plan')).statusCode).not.toBe(200);
            expect((await resolveForPlan({ homeId, machineId: guest.id, presetId, presetRevision: 1,
                managedId: row.id, state: 'running', operation: { operationId: 'plan-is-not-apply' } }, '/v1/machines/setup/report')).statusCode).not.toBe(200);
            expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).machineSetup).toEqual({ setup, state: 'pending' });
            const childResponse = await mint(makeBody());
            expect(childResponse.statusCode, childResponse.body).toBe(200);
            const child = ExternalActionExecutionAuthorizationV1Schema.parse(childResponse.json());
            expect(await verifyHostRoster(child)).not.toBeNull();
            expect(child.binding).toMatchObject({ machineId: guest.id, installationId: guest.installationId,
                actionId: 'machines.setup.apply', managedContinuation: { managedId: row.id,
                    acquireRequestEnvelopeDigest: root.binding.requestEnvelopeDigest } });
            expect(await verifyCurrentExternalActionPrincipal(child.binding)).not.toBeNull();
            const resolvePath = '/v1/machines/setup/resolve';
            const resolve = (input: object = target) => instance.inject({ method: 'POST', url: resolvePath, payload: input,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: child.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.setup.apply',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(child.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: child.token,
                        effectActionId: 'machines.setup.apply', target: child.binding.target, installationId: child.binding.installationId,
                        requestId: child.binding.requestId, method: 'POST', path: resolvePath, body: input, privateKey: guestKeys.secretKey }) } });
            const resolved = await resolve();
            expect(resolved.statusCode, resolved.body).toBe(200);
            expect(resolved.json()).toEqual({ sources: target.sources, creation: { managedId: row.id, preset: { id: presetId, revision: 1 } } });
            const candidates = target.sources.filter(source => source.kind === 'accountPreset');
            const originInput = { homeId, machineId: guest.id, purpose: 'creationOrigin', candidates };
            const origin = await resolve(originInput);
            expect(origin.statusCode, origin.body).toBe(200);
            expect(origin.json()).toEqual({ purpose: 'creationOrigin', creation: { managedId: row.id,
                preset: { id: presetId, revision: 1 } } });
            for (const changed of [[], candidates.map(source => ({ ...source, setup: { scripts: [{ body: 'not admitted' }] } }))]) {
                expect((await resolve({ ...originInput, candidates: changed })).statusCode).toBe(409);
            }
            const changedRevision = { ...target, sources: target.sources.map(source => source.kind === 'accountPreset'
                ? { ...source, presetRevision: 2 } : source) };
            expect((await resolve(changedRevision)).statusCode).toBe(409);
            expect((await mint(makeBody({ ...target, machineId: selected.controller.machineId }))).statusCode).not.toBe(200);
            if (mode === 'plain') expect((await mint(makeBody(changedRevision))).statusCode).not.toBe(200);
            const changedDirect = { ...target, sources: target.sources.map(source => source.kind === 'direct'
                ? { ...source, setup: { scripts: [{ body: 'unreviewed extra effect' }] } } : source) };
            expect((await resolve(changedDirect)).statusCode).toBe(409);
            if (mode === 'plain') expect((await mint(makeBody(changedDirect))).statusCode).not.toBe(200);
            await db.managedMachine.update({ where: { id: row.id }, data: { machineSetup: { setup, state: 'succeeded' } } });
            expect(await verifyCurrentExternalActionPrincipal(planChild.binding)).toBeNull();
            expect((await mint(makeBody(planInput, 'machines.setup.plan'), 'machines.setup.plan')).statusCode).not.toBe(200);
            const released = await mintSession();
            expect(released.statusCode, released.body).toBe(200);
            await db.managedMachine.update({ where: { id: row.id }, data: { desired: 'delete', intentRevision: 1 } });
            expect(await verifyCurrentExternalActionPrincipal(child.binding)).toBeNull();
            expect(await verifyCurrentExternalActionPrincipal(planChild.binding)).toBeNull();
            expect((await mint(makeBody(planInput, 'machines.setup.plan'), 'machines.setup.plan')).statusCode).not.toBe(200);
            expect((await mint(makeBody())).statusCode).not.toBe(200);
        } finally { await instance.close(); }
    });

    it.each((['plain', 'e2ee'] as const).flatMap(mode =>
        (['adminAccess', 'isolationPreview', 'isolationSet'] as const).map(policyKind => ({ mode, policyKind }))))('delegates reviewed $policyKind only to its enrolled $mode creation target', async ({ mode, policyKind }) => {
        const selected = await fixture(true, mode);
        const identity = { kind: 'dedicatedDaemonUser' as const, username: 'happier' as const, serviceMode: 'user' as const,
            role: 'deployTarget' as const, adminAccessAtCreation: 'ask' as const, administrator: { username: 'operator' } };
        const acquire = ManagedAcquireInputV1Schema.parse({ ...selected.input, enrollmentIdentity: identity });
        const guestKeys = tweetnacl.sign.keyPair();
        const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: selected.account.id, active: true,
            metadata: mode === 'e2ee' ? 'guest-ciphertext' : encodePlainMachineStoredContent({ host: 'guest', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier' }),
            dataEncryptionKey: mode === 'e2ee' ? null : decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(guestKeys.publicKey),
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: capabilities } });
        const deliveries: unknown[] = [];
        const instance = await app(async request => {
            const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            deliveries.push(admitted);
            // Only daemon transport is replaced; token issuance, enrollment,
            // HTTP framing, authentication and dispatch admission stay real.
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId: admitted.actionId, requestId: admitted.envelope.requestId,
                execution: { ok: true, result: { status: 'applied', metadataVersion: 1,
                    policy: { version: 1, mode: 'ask', administratorUsername: 'operator' } } },
            })) };
        });
        try {
            const seal = (actionId: string, machineId: string, input: unknown, requestId: string = selected.requestId) =>
                mode === 'plain' ? { v: 1 as const, requestId, target: { kind: 'machine' as const, machineId }, input }
                    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId, accountId: selected.account.id,
                        authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch }, actionId,
                        requestId, target: { kind: 'machine', machineId } }, input,
                        material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) }, randomBytes: length => new Uint8Array(length).fill(3) });
            const rootResponse = await instance.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1, machineId: selected.controller.machineId,
                    envelope: seal('machines.managed.acquire', selected.controller.machineId, acquire) } });
            expect(rootResponse.statusCode, rootResponse.body).toBe(200);
            let root = ExternalActionExecutionAuthorizationV1Schema.parse(rootResponse.json());
            const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: selected.account.id,
                controllerMachineId: selected.controller.machineId, controllerInstallationId: selected.controller.installationId,
                admittedActionRequestId: selected.requestId, admittedInput: { computeInput: acquire, continuation: null },
                launch: selected.input.selection.launch, allocation: 'bound', resource: { contributionRef: selected.input.selection.launch.provider,
                    schemaVersion: 1, value: { id: 'same-reviewed-target' } },
                retention: selected.input.selection.retention, wakeOnAcceptedMessage: false } });
            await inTx(tx => linkManagedEnrollmentInTx(tx, ManagedEnrollmentCorrelationV1Schema.parse({ homeId, managedId: row.id, controller: selected.controller,
                requestId: selected.requestId, expectedIntentRevision: 0, resource: row.resource }), selected.account.id, guest.id));
            expect(await verifyCurrentExternalActionPrincipal(root.binding)).not.toBeNull();
            const actionId = policyKind === 'adminAccess' ? 'machines.setup.adminAccess.set'
                : policyKind === 'isolationPreview' ? 'machines.agentIsolation.preview' : 'machines.agentIsolation.set';
            const path = bindExternalActionExecutionAuthorizationHttpPathV1(actionId);
            const policy = { version: 1 as const, mode: 'ask' as const, administratorUsername: 'operator' };
            const input = { serverId: homeId, machineId: guest.id,
                ...(policyKind === 'adminAccess' ? { expectedMetadataVersion: 0,
                    expectedAdminAccess: { version: 1 as const, mode: 'none' as const }, adminAccess: policy, comparison: 'field' as const }
                    : { enabled: true, memberProvisioning: 'linuxUsersV1' as const, ...(policyKind === 'isolationSet' ? { expectedMetadataVersion: 0,
                        expectedPolicy: { enabled: false }, expectedPlanDigest: 'reviewed-current-effects' } : {}) }) };
            const mint = (value = input) => {
                const body = { v: 1, machineId: value.machineId, envelope: seal(actionId, value.machineId, value, root.binding.requestId),
                    managedContinuation: { managedId: row.id, creationRequestId: selected.requestId, expectedIntentRevision: 0 } };
                return instance.inject({ method: 'POST', url: path, payload: body, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: root.binding.actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: root.binding.actionId, target: root.binding.target, installationId: root.binding.installationId,
                        requestId: root.binding.requestId, method: 'POST', path, body, privateKey: selected.keys.secretKey }) } });
            };
            const response = await mint();
            expect(response.statusCode, response.body).toBe(200);
            const child = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(child.binding).toMatchObject({ actionId, requestId: selected.requestId,
                machineId: guest.id, managedContinuation: { managedId: row.id, controller: selected.controller } });
            expect(await verifyCurrentExternalActionPrincipal(child.binding)).not.toBeNull();
            if (policyKind === 'adminAccess' && mode === 'plain') {
                const dispatchPath = `/v1/actions/${actionId}`;
                const envelope = seal(actionId, guest.id, input, root.binding.requestId);
                const body = { v: 1, machineId: guest.id, envelope,
                    managedContinuation: { managedId: row.id, creationRequestId: selected.requestId, expectedIntentRevision: 0 } };
                const frame = encodeExternalActionHttpBodyV1({
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: root.binding.actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: root.binding.actionId, target: root.binding.target, installationId: selected.controller.installationId,
                        requestId: root.binding.requestId, method: 'POST', path: dispatchPath, body, privateKey: selected.keys.secretKey }),
                }, body);
                expect(frame).not.toBeNull();
                const headers = { [EXTERNAL_ACTION_HTTP_BODY_HEADER_V1]: 'v1' };
                // The production credentialAxios carrier has no proof headers.
                const dispatched = await instance.inject({ method: 'POST', url: dispatchPath, headers, payload: frame! });
                expect(dispatched.statusCode, dispatched.body).toBe(200);
                expect(dispatched.json()).toMatchObject({ execution: { ok: true, result: { status: 'applied' } } });
                expect(deliveries).toHaveLength(1);
                expect(deliveries[0]).toMatchObject({ actionId, envelope,
                    executionAuthorization: { binding: { managedContinuation: { managedId: row.id } } } });
                const forged = await instance.inject({ method: 'POST', url: dispatchPath, headers,
                    payload: { ...frame!, authorization: { ...frame!.authorization, machineSignature: 'forged' } } });
                expect(forged.statusCode).toBe(401);
                const missing = await instance.inject({ method: 'POST', url: dispatchPath, headers,
                    payload: { v: 1, authorization: {}, body } });
                expect(missing.statusCode).toBe(400);
                expect(deliveries).toHaveLength(1);
            }
            if (policyKind === 'isolationSet' && mode === 'plain') {
                const method = `${guest.id}:${actionId}`;
                let forwarded: unknown;
                const receiver = createFakeSocket({ id: 'isolation-guest-receiver', data: { clientType: 'machine-scoped', machineId: guest.id,
                    verifiedMachineInstallationId: guest.installationId }, timeout: () => ({ emitWithAck: async (_event, packet) => {
                        forwarded = packet;
                        return { kind: 'conflict', policy: { enabled: false }, metadataVersion: 2 };
                    } }) });
                qualifyCurrentAccountStoredContentSocket(receiver);
                const io = createSocketRoomDiscoveryHarness(async room => room === `rpc:${selected.account.id}:${method}`
                    || room === receiver.id || room === `machine:${guest.id}:${selected.account.id}` ? [receiver] : []);
                const sender = { ...createAuthenticatedFakeSocket({ id: 'isolation-guest-sender', data: { clientType: 'user-scoped',
                    authTokenKind: 'account', authTokenEpoch: selected.account.tokenEpoch, authTokenLegacy: false } }),
                    handshake: { auth: { token: selected.token } } };
                qualifyCurrentAccountStoredContentSocket(sender);
                // Socket.IO is the network boundary; credential, retained row,
                // child principal and installation signatures are all real.
                registerSocketRpcHandlers({ userId: selected.account.id, socket: sender as unknown as Socket, io });
                let reply: unknown;
                await triggerSocketHandler(sender, SOCKET_RPC_EVENTS.CALL, { method, params: input, requestId: 'isolation-child-rpc',
                    externalActionExecution: { v: 1, authorization: child, effectActionId: actionId, target: child.binding.target,
                        installationId: guest.installationId, machineSignature: signExternalActionMachineRpcRequestV1({
                            authorizationToken: child.token, effectActionId: actionId, target: child.binding.target,
                            installationId: guest.installationId!, method, requestId: 'isolation-child-rpc', params: input,
                            privateKey: guestKeys.secretKey }) } }, (value: unknown) => { reply = value; });
                expect(reply).toMatchObject({ ok: true, result: { kind: 'conflict' } });
                expect(forwarded).toMatchObject({ callerAuthority: 'present_user', callerInputAuthorization: {
                    token: child.token, binding: { managedContinuation: child.binding.managedContinuation },
                } });
            }
            expect((await mint({ ...input, machineId: selected.controller.machineId })).statusCode).not.toBe(200);
            if (mode === 'plain') {
                expect((await mint({ ...input, ...(policyKind === 'adminAccess'
                    ? { adminAccess: { ...policy, administratorUsername: 'different' } } : { enabled: false }) })).statusCode).not.toBe(200);
                expect((await mint({ ...input, serverId: 'srv_other' })).statusCode).not.toBe(200);
            }
            if (policyKind !== 'adminAccess') {
                const localBody = { v: 1, machineId: guest.id, envelope: seal(actionId, guest.id, input),
                    managedContinuation: { managedId: row.id, creationRequestId: selected.requestId, expectedIntentRevision: 0 } };
                const local = await instance.inject({ method: 'POST', url: path,
                    headers: { authorization: `Bearer ${selected.token}` }, payload: localBody });
                expect(local.statusCode, local.body).toBe(200);
                const localChild = ExternalActionExecutionAuthorizationV1Schema.parse(local.json());
                expect(localChild.binding.managedContinuation).toMatchObject({ managedId: row.id, controller: selected.controller });
                expect(await verifyCurrentExternalActionPrincipal(localChild.binding)).not.toBeNull();
                const wrongCreation = await instance.inject({ method: 'POST', url: path,
                    headers: { authorization: `Bearer ${selected.token}` }, payload: { ...localBody,
                        managedContinuation: { ...localBody.managedContinuation, creationRequestId: 'other-creation' } } });
                expect(wrongCreation.statusCode).not.toBe(200);
                if (policyKind === 'isolationSet') {
                    const retry = await instance.inject({ method: 'POST',
                        url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.bootstrap.retry'),
                        headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1, machineId: selected.controller.machineId,
                            envelope: seal('machines.managed.bootstrap.retry', selected.controller.machineId,
                                { homeId, managedId: row.id, expectedIntentRevision: 0 }, `${selected.requestId}-retry`) } });
                    expect(retry.statusCode, retry.body).toBe(200);
                    root = ExternalActionExecutionAuthorizationV1Schema.parse(retry.json());
                    const retried = await mint();
                    expect(retried.statusCode, retried.body).toBe(200);
                    const retriedChild = ExternalActionExecutionAuthorizationV1Schema.parse(retried.json());
                    expect(retriedChild.binding).toMatchObject({ requestId: `${selected.requestId}-retry`,
                        managedContinuation: { creationRequestId: selected.requestId, managedId: row.id } });
                    expect(await verifyCurrentExternalActionPrincipal(retriedChild.binding)).not.toBeNull();
                }
                const inspected = await instance.inject({ method: 'POST',
                    url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.inspect'),
                    headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1, machineId: selected.controller.machineId,
                        envelope: seal('machines.managed.inspect', selected.controller.machineId,
                            { homeId, managedId: row.id }, `${selected.requestId}-inspect`) } });
                expect(inspected.statusCode, inspected.body).toBe(200);
                root = ExternalActionExecutionAuthorizationV1Schema.parse(inspected.json());
                const completed = await mint();
                expect(completed.statusCode, completed.body).toBe(200);
                const completedChild = ExternalActionExecutionAuthorizationV1Schema.parse(completed.json());
                expect(completedChild.binding).toMatchObject({ requestId: `${selected.requestId}-inspect`,
                    managedContinuation: { creationRequestId: selected.requestId, managedId: row.id } });
                expect(await verifyCurrentExternalActionPrincipal(completedChild.binding)).not.toBeNull();
                expect((await mint({ ...input, machineId: selected.controller.machineId })).statusCode).not.toBe(200);
                if (mode === 'plain') expect((await mint({ ...input, enabled: false })).statusCode).not.toBe(200);
                await db.managedMachine.update({ where: { id: row.id }, data: { admittedInput: {
                    computeInput: { ...acquire, enrollmentIdentity: { kind: 'existingUser', role: 'adopted' } }, continuation: null,
                } } });
                expect(await verifyCurrentExternalActionPrincipal(child.binding)).toBeNull();
                expect((await mint()).statusCode).not.toBe(200);
            }
            if (policyKind === 'adminAccess') {
                const retry = await instance.inject({ method: 'POST',
                    url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.bootstrap.retry'),
                    headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1, machineId: selected.controller.machineId,
                        envelope: seal('machines.managed.bootstrap.retry', selected.controller.machineId,
                            { homeId, managedId: row.id, expectedIntentRevision: 0 }, `${selected.requestId}-retry`) } });
                expect(retry.statusCode, retry.body).toBe(200);
                root = ExternalActionExecutionAuthorizationV1Schema.parse(retry.json());
                const retried = await mint();
                expect(retried.statusCode, retried.body).toBe(200);
                const retriedChild = ExternalActionExecutionAuthorizationV1Schema.parse(retried.json());
                expect(retriedChild.binding).toMatchObject({ requestId: `${selected.requestId}-retry`,
                    managedContinuation: { creationRequestId: selected.requestId, managedId: row.id } });
                expect(await verifyCurrentExternalActionPrincipal(retriedChild.binding)).not.toBeNull();
                const inspected = await instance.inject({ method: 'POST',
                    url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.inspect'),
                    headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1, machineId: selected.controller.machineId,
                        envelope: seal('machines.managed.inspect', selected.controller.machineId,
                            { homeId, managedId: row.id }, `${selected.requestId}-inspect`) } });
                expect(inspected.statusCode, inspected.body).toBe(200);
                root = ExternalActionExecutionAuthorizationV1Schema.parse(inspected.json());
                expect((await mint()).statusCode).not.toBe(200);
            }
            await db.managedMachine.update({ where: { id: row.id }, data: { desired: 'delete', intentRevision: 1 } });
            expect(await verifyCurrentExternalActionPrincipal(child.binding)).toBeNull();
            expect((await mint()).statusCode).not.toBe(200);
        } finally { await instance.close(); }
    });

    it.each(['ui', 'session', 'requester', 'retained-requester'] as const)('mints a sealed guest continuation only from the exact current %s controller creation proof', async originKind => {
        const custodian = await fixture(true);
        const retainedRequester = originKind === 'retained-requester';
        const requester = originKind === 'requester' || retainedRequester ? await fixture(true, retainedRequester ? 'e2ee' : 'plain') : custodian;
        const selected = { ...custodian, account: requester.account, token: requester.token };
        if (retainedRequester) await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.account.id,
            machineId: custodian.controller.machineId, principal: { kind: 'account', accountId: requester.account.id }, level: 'admin' }));
        let creationInput = ManagedAcquireInputV1Schema.parse(selected.input);
        if (requester.account.id !== custodian.account.id) {
            const team = await db.team.create({ data: { name: 'Delegated continuation' } });
            await db.teamMembership.createMany({ data: [
                { teamId: team.id, accountId: custodian.account.id, role: 'owner' },
                { teamId: team.id, accountId: requester.account.id, role: 'member' },
            ] });
            const presetId = crypto.randomUUID();
            expect(await createMachinePreset({ accountId: custodian.account.id,
                authentication: { authenticationAuthority: 'present_user' }, input: { id: presetId, homeId,
                    name: 'Guest continuation', owner: { kind: 'team', teamId: team.id }, controller: custodian.controller,
                    launch: custodian.input.selection.launch, teamAcquireDelegated: true,
                    retention: custodian.input.selection.retention, wakeOnAcceptedMessage: false } })).toMatchObject({ kind: 'saved' });
            creationInput = ManagedAcquireInputV1Schema.parse({ enrollmentIdentity: custodian.input.enrollmentIdentity,
                selection: { kind: 'preset', homeId, id: presetId, revision: 0 }, controller: custodian.controller,
                retention: custodian.input.selection.retention, wakeOnAcceptedMessage: false });
            const access = await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: custodian.controller.machineId });
            if (retainedRequester) expect(access).toMatchObject({ role: 'manage' });
            else expect(access).toBeNull();
        }
        const source = originKind === 'session' ? await sourceFixture(selected) : undefined;
        const origin = source ? SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: source.session.id, starterDepth: 2, turnDepth: 3 },
            sourceTurnId: 'original-admitted-turn', callerPermissionMode: 'default', workspaceWrites: 'deny',
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
            requestId: selected.requestId }) : undefined;
        const childRequestId = origin || retainedRequester ? selected.requestId : 'guest-start';
        const guestKeys = tweetnacl.sign.keyPair();
        const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: selected.account.id,
            active: true, operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: capabilities,
            metadata: retainedRequester ? 'retained-guest-ciphertext' : encodePlainMachineStoredContent({ host: 'guest', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
            dataEncryptionKey: retainedRequester ? null : decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(guestKeys.publicKey) } });
        if (retainedRequester) expect(await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: guest.id }))
            .toMatchObject({ owned: true, role: 'manage', encryptionMode: 'e2ee', accessState: 'ready' });
        let deliveredChild: ReturnType<typeof ExternalActionDaemonDispatchRequestSchema.parse> | undefined;
        let retireBeforeSessionTransaction: (() => Promise<void>) | undefined;
        const requestErrors: Error[] = [];
        const instance = await app(async params => {
            deliveredChild = ExternalActionDaemonDispatchRequestSchema.parse(params.callParams);
            return { ok: true, result: { kind: 'invalid_request', errorCode: 'invalid_envelope', requestId: childRequestId } };
        }, async () => { await retireBeforeSessionTransaction?.(); }, source, error => { requestErrors.push(error); });
        try {
            const agentStart = { directory: { kind: 'path' as const, path: '/repo' },
                agentTarget: { kind: 'agent' as const, identity: { pluginId: 'native.agent', localId: 'agent' } },
                creationKey: 'guest-start', initialInput: { text: 'Original retained Agent continuation' } };
            const rootInput = ManagedAcquireInputV1Schema.parse({ ...creationInput, agentStart });
            const rootMaterial = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
            const rootEnvelope = retainedRequester ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId,
                accountId: requester.account.id, authentication: { kind: 'account', tokenEpoch: requester.account.tokenEpoch },
                actionId: 'machines.managed.acquire', requestId: selected.requestId,
                target: { kind: 'machine', machineId: selected.controller.machineId } }, input: rootInput,
                material: rootMaterial, randomBytes: tweetnacl.randomBytes }) : ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: selected.requestId,
                target: { kind: 'machine' as const, machineId: selected.controller.machineId },
                input: rootInput });
            const installationProof = origin ? signMachineInstallationProof({ privateKey: selected.keys.secretKey,
                payload: { version: 1, accountId: selected.account.id, ...selected.controller,
                    externalActionOrigin: { homeId, actionId: 'machines.managed.acquire', requestId: selected.requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(rootEnvelope), origin } } }) : undefined;
            const rootResponse = await instance.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1,
                    machineId: selected.controller.machineId, envelope: rootEnvelope,
                    ...(origin ? { sessionActionOrigin: origin, sessionActionSource: selected.controller, installationProof } : {}) } });
            expect(rootResponse.statusCode, rootResponse.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(rootResponse.json());
            const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.account.id,
                controllerMachineId: selected.controller.machineId, controllerInstallationId: selected.controller.installationId,
                admittedActionRequestId: selected.requestId,
                admittedInput: { computeInput: creationInput, enrollmentAccountId: selected.account.id,
                    continuation: { requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(rootEnvelope) } },
                launch: selected.input.selection.launch, allocation: 'bound', resource: { contributionRef: selected.input.selection.launch.provider,
                    schemaVersion: 1, value: { id: 'same-paid-resource' } }, enrolledMachineId: guest.id,
                retention: selected.input.selection.retention, wakeOnAcceptedMessage: false } });
            let recipient: ReturnType<typeof ManagedControllerContextOutputV1Schema.parse>['enrollmentInstallation'];
            if (retainedRequester) {
                await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.account.id,
                    machineId: custodian.controller.machineId, principal: { kind: 'account', accountId: requester.account.id } }));
                expect(await resolveMachineAccess({ actorAccountId: requester.account.id, machineId: custodian.controller.machineId })).toBeNull();
                const path = '/v1/machines/managed/controller/context';
                const body = { homeId, managedId: row.id, expectedIntentRevision: 0, controller: custodian.controller,
                    includeEnrollmentInstallation: true };
                const context = await instance.inject({ method: 'POST', url: path, payload: body, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.managed.acquire',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: 'machines.managed.acquire', target: root.binding.target,
                        installationId: root.binding.installationId, requestId: root.binding.requestId,
                        method: 'POST', path, body, privateKey: selected.keys.secretKey }) } });
                expect(context.statusCode, context.body).toBe(200);
                recipient = ManagedControllerContextOutputV1Schema.parse(context.json()).enrollmentInstallation;
                expect(recipient).toEqual({ machineId: guest.id, installationId: guest.installationId,
                    installationPublicKey: Buffer.from(guestKeys.publicKey).toString('base64url') });
            }
            const privateText = 'Only the exact guest opens this original continuation';
            const spawnInput = { executionTarget: { serverId: homeId, machineId: guest.id },
                directory: { kind: 'path' as const, path: '/repo' },
                agentTarget: { kind: 'agent' as const, identity: { pluginId: 'native.agent', localId: 'agent' } },
                creationKey: 'guest-start', initialInput: { text: privateText } };
            const childMaterial = { type: 'dataKey' as const, machineKey: retainedRequester ? tweetnacl.randomBytes(32) : new Uint8Array(32).fill(7) };
            const baseEnvelope = { ...sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId,
                accountId: selected.account.id, authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch },
                actionId: 'session.spawn_new', requestId: childRequestId, target: { kind: 'machine', machineId: guest.id } },
                input: spawnInput, material: childMaterial,
                randomBytes: length => new Uint8Array(length).fill(3) }),
                sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(spawnInput) };
            const envelope = recipient ? sealManagedCreationActionCodecV1({ authorization: root, actionId: 'session.spawn_new',
                continuation: { managedId: row.id, creationRequestId: selected.requestId, expectedIntentRevision: 0 },
                envelope: baseEnvelope, recipient, material: childMaterial, randomBytes: tweetnacl.randomBytes,
                invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' } }) : baseEnvelope;
            const path = bindExternalActionExecutionAuthorizationHttpPathV1('session.spawn_new');
            const body = { v: 1, machineId: guest.id, envelope,
                managedContinuation: { managedId: row.id, creationRequestId: selected.requestId, expectedIntentRevision: 0 } };
            const headers = {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.managed.acquire',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: 'machines.managed.acquire', target: root.binding.target,
                    installationId: root.binding.installationId, requestId: root.binding.requestId,
                    method: 'POST', path, body, privateKey: selected.keys.secretKey }),
            };
            expect(JSON.stringify(body)).not.toContain(privateText);
            const { sessionSpawnAdmission: _spawnFacts, ...setupEnvelope } = envelope;
            const missingSpawnFactsBody = { ...body, envelope: setupEnvelope };
            const sessionCountBeforeMissingFacts = await db.session.count({ where: { accountId: selected.account.id } });
            const missingSpawnFacts = await instance.inject({ method: 'POST', url: path,
                payload: missingSpawnFactsBody, headers: { ...headers,
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: root.token, effectActionId: 'machines.managed.acquire', target: root.binding.target,
                        installationId: root.binding.installationId, requestId: root.binding.requestId,
                        method: 'POST', path, body: missingSpawnFactsBody, privateKey: selected.keys.secretKey }) } });
            expect(missingSpawnFacts.statusCode, missingSpawnFacts.body).toBe(403);
            expect(missingSpawnFacts.json()).toMatchObject({ error: 'credential_scope_denied' });
            expect(deliveredChild).toBeUndefined();
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
            expect(await db.session.count({ where: { accountId: selected.account.id } })).toBe(sessionCountBeforeMissingFacts);
            // SOURCE authors this envelope and may be another person's daemon, so
            // it cannot pick the plugin surface for the guest Account's policy.
            const pluginBody = { ...body, envelope: { ...envelope, pluginInvocation: mountedPluginInvocation(guest.id) } };
            for (const pluginPath of [path, '/v1/actions/session.spawn_new']) {
                const pluginChild = await instance.inject({ method: 'POST', url: pluginPath, payload: pluginBody,
                    headers: { ...headers, [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: root.token, effectActionId: 'machines.managed.acquire', target: root.binding.target,
                        installationId: root.binding.installationId, requestId: root.binding.requestId,
                        method: 'POST', path: pluginPath, body: pluginBody, privateKey: selected.keys.secretKey }) } });
                expect(pluginChild.statusCode, pluginChild.body).toBe(403);
                expect(pluginChild.json()).toMatchObject({ error: 'credential_scope_denied' });
            }
            expect(deliveredChild).toBeUndefined();
            const mintChild = () => instance.inject({ method: 'POST', url: path, payload: body, headers });
            if (retainedRequester) expect(await verifyCurrentExternalActionPrincipal(root.binding)).not.toBeNull();
            const childResponse = await mintChild();
            expect(childResponse.statusCode, childResponse.body).toBe(200);
            const child = ExternalActionExecutionAuthorizationV1Schema.parse(childResponse.json());
            expect(child.binding).toMatchObject({ machineId: guest.id, installationId: guest.installationId,
                actionId: 'session.spawn_new', requestId: childRequestId, accountId: selected.account.id });
            if (origin) {
                expect(child.binding).toMatchObject({ sessionActionOrigin: origin, sessionActionSource: selected.controller });
                expect(await verifyCurrentExternalActionPrincipal(child.binding))
                    .toMatchObject({ authority: 'account_automation', sessionActionOrigin: origin });
                const mismatchedBody = { ...body, envelope: { ...envelope, requestId: 'rewritten-child-request' } };
                const refused = await instance.inject({ method: 'POST', url: path, payload: mismatchedBody,
                    headers: { ...headers, [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: root.token, effectActionId: 'machines.managed.acquire', target: root.binding.target,
                        installationId: root.binding.installationId, requestId: root.binding.requestId,
                        method: 'POST', path, body: mismatchedBody, privateKey: selected.keys.secretKey }) } });
                expect(refused.statusCode, refused.body).toBe(403);
                const rewrittenOrigin = { ...origin, sourceTurnId: 'different-admitted-turn',
                    caller: { ...origin.caller, starterDepth: 0, turnDepth: 0 } };
                const rewrittenSourceBody = { ...body, sessionActionOrigin: rewrittenOrigin,
                    sessionActionSource: selected.controller, installationProof: signMachineInstallationProof({
                        privateKey: selected.keys.secretKey, payload: { version: 1, accountId: selected.account.id,
                            ...selected.controller, externalActionOrigin: { homeId, actionId: 'session.spawn_new',
                                requestId: childRequestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                                origin: rewrittenOrigin } } }) };
                const rewritten = await instance.inject({ method: 'POST', url: path, payload: rewrittenSourceBody,
                    headers: { ...headers, [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: root.token, effectActionId: 'machines.managed.acquire', target: root.binding.target,
                        installationId: root.binding.installationId, requestId: root.binding.requestId,
                        method: 'POST', path, body: rewrittenSourceBody, privateKey: selected.keys.secretKey }) } });
                expect(rewritten.statusCode, rewritten.body).toBe(401);
            } else {
                expect(child.binding).not.toHaveProperty('sessionActionOrigin');
            }
            expect(child.binding.machineId).not.toBe(root.binding.machineId);
            expect(child.binding.managedContinuation).toMatchObject({ managedId: row.id,
                creationRequestId: selected.requestId, expectedIntentRevision: 0,
                controller: selected.controller, acquireRequestEnvelopeDigest: root.binding.requestEnvelopeDigest });
            const verifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1('session.spawn_new');
            const verifyBody = { v: 1 as const,
                ...(child.binding.admittedMachineRole ? { admittedMachineRole: child.binding.admittedMachineRole } : {}) };
            const verifyChild = () => instance.inject({ method: 'POST', url: verifyPath, payload: verifyBody,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: child.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.spawn_new',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(child.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: child.token,
                        effectActionId: 'session.spawn_new', target: child.binding.target, installationId: child.binding.installationId,
                        requestId: child.binding.requestId, method: 'POST', path: verifyPath,
                        body: verifyBody, privateKey: guestKeys.secretKey }) } });
            const currentChildProof = await verifyChild();
            expect(currentChildProof.statusCode, currentChildProof.body).toBe(200);
            const forwardPath = '/v1/actions/session.spawn_new';
            const forwardHeaders = { ...headers,
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: 'machines.managed.acquire', target: root.binding.target,
                    installationId: root.binding.installationId, requestId: root.binding.requestId,
                    method: 'POST', path: forwardPath, body, privateKey: selected.keys.secretKey }) };
            const forwardChild = () => instance.inject({ method: 'POST', url: forwardPath, payload: body, headers: forwardHeaders });
            const forwarded = await forwardChild();
            expect(forwarded.statusCode, forwarded.body).toBe(400);
            expect(deliveredChild?.executionAuthorization?.binding).toMatchObject({ machineId: guest.id,
                installationId: guest.installationId, actionId: 'session.spawn_new', requestId: childRequestId,
                ...(origin ? { sessionActionOrigin: origin, sessionActionSource: selected.controller } : {}) });
            if (origin) expect(deliveredChild?.principal)
                .toMatchObject({ authority: 'account_automation', sessionActionOrigin: origin });
            expect(deliveredChild?.envelope).toEqual(envelope);
            expect(JSON.stringify(deliveredChild)).not.toContain(privateText);
            if (retainedRequester) {
                if (!deliveredChild) throw new Error('Missing actual Home child dispatch');
                const dispatched = deliveredChild;
                if (!dispatched?.executionAuthorization || dispatched.envelope.v !== 2) throw new Error('Missing actual Home-issued child');
                const childAuthorization = dispatched.executionAuthorization;
                const childEnvelope = dispatched.envelope;
                expect(childAuthorization.binding.requestEnvelopeDigest).toBe(computeExternalActionRequestEnvelopeDigestV1(envelope));
                const open = (candidate = childEnvelope) => openManagedCreationActionCodecV1({
                    authorization: childAuthorization, envelope: candidate, machineId: guest.id,
                    installationId: guest.installationId!, serverIdentityId: homeId, installationPrivateKey: guestKeys.secretKey });
                expect(open()).toEqual(childMaterial);
                expect(childMaterial.machineKey).not.toEqual(rootMaterial.machineKey);
                expect(open({ ...childEnvelope, payload: { t: 'encrypted', c: `${childEnvelope.payload.c}changed` } })).toBeNull();
                if (!childEnvelope.managedCreationCodec) throw new Error('Missing installed child codec');
                expect(open({ ...childEnvelope, managedCreationCodec: { ...childEnvelope.managedCreationCodec,
                    installationId: crypto.randomUUID() } })).toBeNull();
                await db.machine.update({ where: { id: guest.id }, data: { installationId: crypto.randomUUID() } });
                expect((await verifyChild()).statusCode).not.toBe(200);
                expect((await forwardChild()).statusCode).not.toBe(200);
                return;
            }
            // The requesting Account owns its resulting guest and may also
            // originate ordinary Sessions there without the creation root.
            deliveredChild = undefined;
            const ownerOrigination = await instance.inject({ method: 'POST', url: forwardPath,
                headers: { authorization: `Bearer ${selected.token}` }, payload: envelope });
            // The daemon boundary deliberately returns invalid_envelope; its
            // receipt proves ordinary owner admission reached the guest.
            expect(ownerOrigination.statusCode, ownerOrigination.body).toBe(400);
            expect(ownerOrigination.json()).toMatchObject({ code: 'invalid_envelope' });
            const ownerDispatch = ExternalActionDaemonDispatchRequestSchema.parse(deliveredChild);
            expect(ownerDispatch.principal).toMatchObject({ accountId: selected.account.id, authority: 'present_user' });
            expect(ownerDispatch.envelope).toEqual(envelope);
            expect(ownerDispatch.executionAuthorization?.binding).not.toHaveProperty('managedContinuation');

            const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
            const strangerToken = await auth.createToken(stranger.id, undefined, { kind: 'account', authority: 'present_user' });
            expect(await resolveMachineAccess({ actorAccountId: stranger.id, machineId: guest.id })).toBeNull();
            const strangerEnvelope = { ...sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId,
                accountId: stranger.id, authentication: { kind: 'account', tokenEpoch: stranger.tokenEpoch },
                actionId: 'session.spawn_new', requestId: 'stranger-guest-start', target: { kind: 'machine', machineId: guest.id } },
                input: spawnInput, material: childMaterial, randomBytes: tweetnacl.randomBytes }),
                sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(spawnInput) };
            deliveredChild = undefined;
            const sessionCountBeforeStranger = await db.session.count();
            const strangerOrigination = await instance.inject({ method: 'POST', url: forwardPath,
                headers: { authorization: `Bearer ${strangerToken}` }, payload: strangerEnvelope });
            expect(strangerOrigination.statusCode, strangerOrigination.body).toBe(409);
            expect(strangerOrigination.json()).toMatchObject({ code: 'target_not_local' });
            expect(deliveredChild).toBeUndefined();
            expect(await db.session.count()).toBe(sessionCountBeforeStranger);

            const sessionBody = (tag: string) => ({ tag, metadataLayoutVersion: 1,
                sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }) }, ownerMetadata: { t: 'plain', v: { v: 1 } }, encryptionMode: 'plain' });
            const sessionHeaders = (body: unknown) => ({ ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: child.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.spawn_new',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(child.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: child.token,
                    effectActionId: 'session.spawn_new', target: child.binding.target, installationId: child.binding.installationId,
                    requestId: child.binding.requestId, method: 'POST', path: '/v1/sessions', body, privateKey: guestKeys.secretKey }) });
            const admittedSession = sessionBody(crypto.randomUUID());
            const createdSession = await instance.inject({ method: 'POST', url: '/v1/sessions', payload: admittedSession,
                headers: sessionHeaders(admittedSession) });
            expect(createdSession.statusCode, `${createdSession.body}\n${requestErrors.map(error => error.stack ?? error.message).join('\n')}`).toBe(200);
            if (!('authentication' in child.binding)) throw new Error('Expected genuine ordinary child');
            const differentChild = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: homeId,
                accountId: selected.account.id, authentication: child.binding.authentication, machineId: guest.id,
                actionId: 'session.spawn_new', requestId: 'different-child', requestEnvelopeDigest: child.binding.requestEnvelopeDigest,
                target: child.binding.target, managedContinuation: child.binding.managedContinuation });
            const substitutedSession = sessionBody(crypto.randomUUID());
            const substitutedCreation = await instance.inject({ method: 'POST', url: '/v1/sessions', payload: substitutedSession,
                headers: { ...sessionHeaders(substitutedSession), [SESSION_CREATION_AUTHORIZATION_HEADER_V1]: differentChild.token } });
            const archivedAt = new Date();
            const retainedSession = await db.session.findUniqueOrThrow({ where: {
                accountId_tag: { accountId: selected.account.id, tag: admittedSession.tag },
            } });
            await db.session.update({ where: { id: retainedSession.id }, data: { active: false, archivedAt } });
            if (!origin) {
                let missedWinner = false;
                let uniqueLossObserved = false;
                let retireOnUniqueLoss = false;
                let retiredAfterUniqueFailure = false;
                const actualTransaction = db.$transaction.bind(db);
                // Database-boundary interleaving: the create lookup precedes
                // the winner's visibility, but the real unique insert loses.
                // Retire the child only after that transaction rolls back.
                const interleave = async <T>(callback: (tx: Tx) => Promise<T>, options?: Parameters<typeof db.$transaction>[1]) => {
                    try {
                        return await actualTransaction(async tx => {
                            // Only the losing create lookup is interleaved. The
                            // owner's recovery transaction consumes Prisma's
                            // original client/delegates without another wrapper.
                            if (missedWinner) return await callback(tx);
                            const session = tx.session;
                            const interceptedSession = new Proxy(session, { get(delegate, property) {
                                if (property === 'findUnique') return (args: Parameters<typeof session.findUnique>[0]) => {
                                    const tuple = args.where.accountId_tag;
                                    if (!missedWinner && tuple?.accountId === selected.account.id && tuple.tag === retainedSession.tag) {
                                        missedWinner = true;
                                        return Promise.resolve(null);
                                    }
                                    return delegate.findUnique(args);
                                };
                                return Reflect.get(delegate, property, delegate);
                            } });
                            const intercepted = new Proxy(tx, { get(client, property) {
                                if (property === 'session') return interceptedSession;
                                return Reflect.get(client, property, client);
                            } });
                            return await callback(intercepted);
                        }, options);
                    } catch (error) {
                        if (missedWinner && !uniqueLossObserved && isPrismaErrorCode(error, 'P2002')) {
                            uniqueLossObserved = true;
                            if (retireOnUniqueLoss) {
                                retiredAfterUniqueFailure = true;
                                await db.managedMachine.update({ where: { id: row.id }, data: { creationState: 'canceled', intentRevision: 1 } });
                            }
                        }
                        throw error;
                    }
                };
                // Preserve Prisma's overloaded delegate at this boundary;
                // the route and inTx use its interactive callback contract.
                // db forwards methods through its get/set proxy rather than
                // own properties; its existing setter reaches the real client.
                db.$transaction = interleave as typeof db.$transaction;
                try {
                    const currentUniqueLoser = await instance.inject({ method: 'POST', url: '/v1/sessions', payload: admittedSession,
                        headers: sessionHeaders(admittedSession) });
                    expect(uniqueLossObserved, currentUniqueLoser.body).toBe(true);
                    expect(currentUniqueLoser.statusCode, `${currentUniqueLoser.body}\n${requestErrors.map(error => error.stack ?? error.message).join('\n')}`).toBe(200);
                    expect(await db.session.findUniqueOrThrow({ where: { id: retainedSession.id } }))
                        .toMatchObject({ archivedAt: null, metadata: retainedSession.metadata, ownerMetadata: retainedSession.ownerMetadata });
                    await db.session.update({ where: { id: retainedSession.id }, data: { active: false, archivedAt } });
                    missedWinner = false;
                    uniqueLossObserved = false;
                    retireOnUniqueLoss = true;
                    const uniqueLoserRejoin = await instance.inject({ method: 'POST', url: '/v1/sessions', payload: admittedSession,
                        headers: sessionHeaders(admittedSession) });
                    expect(retiredAfterUniqueFailure, uniqueLoserRejoin.body).toBe(true);
                    expect(uniqueLoserRejoin.statusCode, uniqueLoserRejoin.body).toBe(401);
                    expect(await db.session.findUniqueOrThrow({ where: { id: retainedSession.id } }))
                        .toMatchObject({ active: false, archivedAt, metadata: retainedSession.metadata, ownerMetadata: retainedSession.ownerMetadata });
                } finally { db.$transaction = actualTransaction; }
                await db.managedMachine.update({ where: { id: row.id }, data: { creationState: row.creationState, intentRevision: row.intentRevision } });
            }
            retireBeforeSessionTransaction = async () => { await db.managedMachine.update({ where: { id: row.id },
                data: { creationState: 'canceled', intentRevision: 1 } }); };
            const retiredSession = sessionBody(crypto.randomUUID());
            const retiredCreation = await instance.inject({ method: 'POST', url: '/v1/sessions', payload: retiredSession,
                headers: sessionHeaders(retiredSession) });
            // Re-arm the disposable fixture so authentication is genuinely
            // current again; the same HTTP hook retires it before tag rejoin.
            await db.managedMachine.update({ where: { id: row.id },
                data: { creationState: row.creationState, intentRevision: row.intentRevision } });
            const retiredRejoin = await instance.inject({ method: 'POST', url: '/v1/sessions', payload: admittedSession,
                headers: sessionHeaders(admittedSession) });
            expect(substitutedCreation.statusCode, substitutedCreation.body).toBe(401);
            expect(await db.session.count({ where: { accountId: selected.account.id, tag: substitutedSession.tag } })).toBe(0);
            expect(retiredCreation.statusCode, retiredCreation.body).toBe(401);
            expect(await db.session.count({ where: { accountId: selected.account.id, tag: retiredSession.tag } })).toBe(0);
            expect(retiredRejoin.statusCode, retiredRejoin.body).toBe(401);
            expect(await db.session.findUniqueOrThrow({ where: { id: retainedSession.id } }))
                .toMatchObject({ active: false, archivedAt });
            expect((await mintChild()).statusCode).toBe(409);
            expect((await verifyChild()).statusCode).toBe(401);
            deliveredChild = undefined;
            expect((await forwardChild()).statusCode).toBe(409);
            expect(deliveredChild).toBeUndefined();
        } finally { await instance.close(); }
    });
});
