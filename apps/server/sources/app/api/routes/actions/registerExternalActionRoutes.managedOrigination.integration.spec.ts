import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Server } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    MACHINE_PLAIN_DATA_KEY_MARKER, PluginManifestV2Schema, encodePlainMachineStoredContent, ManagedAcquireInputV1Schema,
    SESSION_CREATION_AUTHORIZATION_HEADER_V1,
    MachineOperationProtocolCapabilitiesV1Schema,
    signMachineInstallationProof, signAccountContentKeyBindingV1,
} from '@happier-dev/protocol';
import {
    ExternalActionDaemonDispatchRequestSchema, createExternalActionDaemonDispatchResponseV1,
    prepareExternalActionResponseEnvelopeV1, sealExternalActionRequestV2, ExternalActionExecutionAuthorizationV1Schema,
    bindExternalActionExecutionAuthorizationHttpPathV1, computeExternalActionRequestEnvelopeDigestV1,
    bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    signExternalActionMachineRequestV1, encodeExternalActionResolvedTargetV1,
} from '@happier-dev/protocol/actions';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
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
import { verifyCurrentExternalActionPrincipal } from '@/app/auth/externalActionExecutionAuthorization';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { resolveMachineAccess, setMachineAccessGrantInTx, removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { db, isPrismaErrorCode } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { registerSessionCreateOrLoadRoute } from '@/app/api/routes/session/registerSessionCreateOrLoadRoute';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import * as externalActionDispatcher from '@/app/api/socket/externalActionDispatcher';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { getAccountSessionSocketRoom } from '@/app/api/socketRooms';
import { inTx, type Tx } from '@/storage/inTx';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { deriveAccountEncryptionCurrentnessFromRow } from '@/app/encryption/accountContentKeyAdmission';
import { registerManagedMachineRoutes } from '@/app/machines/managed/managedRoutes';
import { cancelManagedCreation, getManagedMachine } from '@/app/machines/managed/managedRead';

describe('ordinary Account managed Action origination', () => {
    const homeId = `srv_${'a'.repeat(32)}`;
    const capabilities = MachineOperationProtocolCapabilitiesV1Schema.parse({ externalActionExecutionAuthorization: { protocolVersions: [1] } });
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-origination-', initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
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
        const input = { selection: { kind: 'one-off' as const, homeId, controller,
            launch: { provider: { pluginId: manifest.id, localId: 'compute' }, schemaVersion: 1, name: 'Reviewed', choices: { image: 'linux' } },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
        return { account, controller, keys, token, input, requestId: crypto.randomUUID() };
    }

    async function sourceFixture(selected: Awaited<ReturnType<typeof fixture>>) {
        const session = await db.session.create({ data: { accountId: selected.account.id,
            tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await expect(inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: selected.account.id,
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
        return { session, presence, io, discovery };
    }

    async function app(forwardRpc: ExternalActionForwardRpcCall, afterSessionAuthentication?: () => Promise<void>,
        source?: Readonly<{ io: Server; presence: ReturnType<typeof createSessionPublisherPresence>;
            afterResolution?: () => Promise<void> }>, onRequestError?: (error: Error) => void) {
        const instance = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        instance.setValidatorCompiler(validatorCompiler);
        instance.setSerializerCompiler(serializerCompiler);
        if (onRequestError) instance.addHook('onError', async (_request, _reply, error) => { onRequestError(error); });
        enableAuthentication(instance);
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
        registerManagedMachineRoutes(instance);
        await instance.ready();
        return instance;
    }

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
        const envelope = { v: 1, requestId: selected.requestId,
            target: { kind: 'machine', machineId: selected.controller.machineId }, input: selected.input };
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
            expect(forged.statusCode, forged.body).toBe(401);
            replaceAfterResolution = true;
            const superseded = await mint();
            expect(superseded.statusCode, superseded.body).toBe(401);
            expect(superseded.json()).toMatchObject({ error: 'invalid_token' });
            replaceAfterResolution = false;
            discovery.visible = false;
            const unavailable = await mint();
            expect(unavailable.statusCode, unavailable.body).toBe(401);
            expect(unavailable.json()).toMatchObject({ error: 'invalid_token' });
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
            const post = (payload: unknown = body, bearer = false) => instance.inject({ method: 'POST', url: path, payload,
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
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: destination.account.id,
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
            const relay = (payload: unknown = body) => instance.inject({ method: 'POST', url: '/v1/actions/approval.request.decide',
                headers: { authorization: `Bearer ${reviewer.token}` }, payload });
            const result = await relay();
            if (transportErrors.length > 0) throw transportErrors[0];
            expect(result.statusCode, result.body).toBe(200);
            expect(result.json(), result.body).toMatchObject({ execution: { ok: true, result: { replayed: true } } });
            expect(delivered).toHaveLength(1);
            const substituted = await relay({ ...body, envelope: { ...envelope,
                input: { ...envelope.input, artifactId: crypto.randomUUID() } } });
            expect(substituted.statusCode, substituted.body).toBe(401);
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: destination.account.id,
                machineId: destination.controller.machineId,
                principal: { kind: 'account', accountId: reviewer.account.id } }));
            const retired = await relay();
            expect(retired.statusCode, retired.body).toBe(401);
            expect(delivered).toHaveLength(1);
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
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: destination.account.id,
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
            expect(refused.statusCode, refused.body).toBe(401);
            expect(await db.managedMachine.count({ where: { homeId, admittedActionRequestId: forged.envelope.requestId } })).toBe(0);

            source.discovery.visible = false;
            const withdrawn = makePayload(crypto.randomUUID());
            const stale = await post(withdrawn);
            expect(stale.statusCode, stale.body).toBe(401);
            expect(await db.managedMachine.count({ where: { homeId, admittedActionRequestId: withdrawn.envelope.requestId } })).toBe(0);
            expect(deliveredRequests).toEqual([payload.envelope.requestId]);
        } finally { await instance.close(); }
    });

    it.each(['machines.managed.acquire', 'machines.managed.bootstrap.retry'] as const)('retains only an issued Acquire bound fact from %s after its Session publisher retires and creation is canceled', async actionId => {
        const selected = await fixture(true);
        const source = await sourceFixture(selected);
        const instance = await app(async () => { throw new Error('Fact reporting must not dispatch another Action'); }, undefined, source);
        const envelope = { v: 1, requestId: selected.requestId,
            target: { kind: 'machine' as const, machineId: selected.controller.machineId }, input: selected.input };
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
            const post = (path: string, body: unknown) => instance.inject({ method: 'POST', url: path, payload: body,
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
            const correlation = { homeId, managedId: row.id, requestId: selected.requestId,
                expectedIntentRevision: row.intentRevision, controller: selected.controller };
            if (actionId === 'machines.managed.bootstrap.retry') {
                const retryEnvelope = { ...envelope, requestId: crypto.randomUUID(),
                    input: { homeId, managedId: row.id, expectedIntentRevision: row.intentRevision } };
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
                    homeId, managedId: row.id, expectedIntentRevision: row.intentRevision, controller: selected.controller,
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
            await db.account.update({ where: { id: selected.account.id }, data: { encryptionMode: 'e2ee' } });
            expect((await post(report, body)).statusCode).toBe(401);
            await db.account.update({ where: { id: selected.account.id }, data: { encryptionMode: 'plain', tokenEpoch: { increment: 1 } } });
            expect((await post(report, body)).statusCode).toBe(401);
            await db.account.update({ where: { id: selected.account.id }, data: { tokenEpoch: selected.account.tokenEpoch } });
            await db.machine.update({ where: { id: selected.controller.machineId }, data: { revokedAt: new Date() } });
            expect((await post(report, body)).statusCode).toBe(401);
            await db.machine.update({ where: { id: selected.controller.machineId }, data: { revokedAt: null } });
            expect((await post(report, body)).statusCode).toBe(200);
            expect((await post(report, { ...body, result: { kind: 'bound', resource: { ...resource, value: { id: 'another-paid-resource' } } } })).statusCode).toBe(409);
            expect(await db.savedSecretResource.count({ where: { ownerAccountId: selected.account.id } })).toBe(0);
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
        const sealed = sealExternalActionRequestV2({ binding: { serverIdentityId: homeId, accountId: selected.account.id,
            actionId: 'machines.managed.acquire', requestId: selected.requestId,
            target: { kind: 'machine', machineId: selected.controller.machineId },
            authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch } },
            input: ManagedAcquireInputV1Schema.parse({ ...selected.input, agentStart }), material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) },
            randomBytes: length => new Uint8Array(length).fill(2) });
        const instance = await app(async () => { throw new Error('Offline admission must not deliver to a daemon'); });
        try {
            const response = await instance.inject({ method: 'POST', url: '/v1/actions/machines.managed.acquire',
                headers: { authorization: `Bearer ${selected.token}` }, payload: { ...sealed,
                    managedAdmission: { actionId: 'machines.managed.acquire', input: selected.input, continuationPresent: true } } });
            expect(response.statusCode).toBe(409);
            const row = await db.managedMachine.findUniqueOrThrow({ where: { homeId_admittedActionRequestId: {
                homeId, admittedActionRequestId: selected.requestId } } });
            expect(response.json()).toEqual({ error: 'invalid_request', code: 'target_unavailable',
                requestId: selected.requestId, managedAdmission: { managedId: row.id } });
            expect(row.allocation).toBe('unsubmitted');
            expect(JSON.stringify(row)).not.toContain(prompt);
            expect(JSON.stringify(row)).not.toContain(sealed.payload.c);
            expect(JSON.stringify(response.json())).not.toContain(prompt);
            expect(response.json()).not.toHaveProperty('payload');
            expect(response.json()).not.toHaveProperty('execution');
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
        const rootEnvelope = sealExternalActionRequestV2({ binding: { serverIdentityId: homeId,
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
            const envelope = { ...sealExternalActionRequestV2({ binding: { serverIdentityId: homeId,
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
            // Prisma's generic delegate return is retained by this boundary cast.
            const readThenRetire = ((args: Parameters<typeof db.session.findUnique>[0]) => {
                if (interleavedRead) return actualRead(args);
                interleavedRead = true;
                return actualRead(args).then(async result => {
                    if (result?.id === retained.id) {
                        retiredAfterUniqueFailure = true;
                        await db.managedMachine.update({ where: { id: row.id }, data: { creationState: 'canceled', intentRevision: 1 } });
                    }
                    return result;
                });
            }) as typeof db.session.findUnique;
            // Prisma's delegate is a lazy proxy, not an own method descriptor.
            // Restore the actual method value rather than a spy descriptor.
            db.session.findUnique = readThenRetire;
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

    it('refuses personal setup references on another custodian while preserving shared-reference authority', async () => {
        const source = await fixture(true);
        const target = await fixture(true);
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: target.account.id, machineId: target.controller.machineId,
            principal: { kind: 'account', accountId: source.account.id }, level: 'admin' }));
        const presetId = crypto.randomUUID();
        await db.managedMachinePreset.create({ data: { id: presetId, homeId, custodianAccountId: source.account.id, name: 'Personal tools',
            launch: source.input.selection.launch, controllerMachineId: source.controller.machineId,
            controllerInstallationId: source.controller.installationId,
            environment: { setupScript: 'echo configured', secretRefs: { v: 1, bindings: { TOKEN: { ref: 'same-personal-id' } } } } } });
        const input = { homeId, machineId: target.controller.machineId, presetId, presetRevision: 0 };
        const instance = await app(async () => { throw new Error('Resolving references cannot execute setup'); });
        try {
            const envelope = { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: input.machineId }, input };
            const issued = await instance.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.environment.apply'),
                headers: { authorization: `Bearer ${source.token}` }, payload: { v: 1, machineId: input.machineId, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authority = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const path = '/v1/machines/environment/resolve';
            const resolve = () => instance.inject({ method: 'POST', url: path, payload: input, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authority.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.environment.apply',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authority.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authority.token,
                    effectActionId: 'machines.environment.apply', target: authority.binding.target, installationId: authority.binding.installationId,
                    requestId: authority.binding.requestId, method: 'POST', path, body: input, privateKey: target.keys.secretKey }),
            } });
            const refused = await resolve();
            expect(refused.statusCode, refused.body).toBe(409);
            expect(refused.json()).toEqual({ code: 'credential_unavailable' });
            const environment = { setupScript: 'echo configured', secretRefs: { v: 1,
                bindings: { TOKEN: { ref: 'happier:shared-secret:v1:exact-resource', revision: 1 } } } };
            await db.managedMachinePreset.update({ where: { id: presetId }, data: { environment } });
            const shared = await resolve();
            expect(shared.statusCode, shared.body).toBe(200);
            expect(shared.json()).toEqual({ environment });
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
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: owner.account.id, machineId: guest.id,
            principal: { kind: 'account', accountId: actor.account.id }, level: 'admin' }));
        const presetId = crypto.randomUUID();
        const environment = { setupScript: 'echo private admitted snapshot' };
        await db.managedMachinePreset.create({ data: { id: presetId, homeId, custodianAccountId: owner.account.id,
            name: 'Edited archived preset', launch: owner.input.selection.launch, controllerMachineId: owner.controller.machineId,
            controllerInstallationId: owner.controller.installationId, revision: 2,
            archivedAt: new Date(), environment: { setupScript: 'echo changed' } } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: owner.account.id,
            controllerMachineId: owner.controller.machineId, controllerInstallationId: owner.controller.installationId,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, presetId, presetRevision: 1,
            launch: owner.input.selection.launch, retention: owner.input.selection.retention, wakeOnAcceptedMessage: false,
            allocation: 'bound', enrolledMachineId: guest.id, environmentSetup: { environment, state: 'pending' },
            resource: { contributionRef: owner.input.selection.launch.provider, schemaVersion: 1, value: { id: 'same-resource' } } } });
        await expect(getManagedMachine({ actorAccountId: actor.account.id, input: { homeId, managedId: row.id } }))
            .rejects.toMatchObject({ code: 'permission_denied' });
        const instance = await app(async () => { throw new Error('Resolving and reporting cannot execute setup'); });
        try {
            const input = { homeId, machineId: guest.id, presetId, presetRevision: 1 };
            const envelope = { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: guest.id }, input };
            const issued = await instance.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.environment.apply'),
                headers: { authorization: `Bearer ${actor.token}` }, payload: { v: 1, machineId: guest.id, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authority = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const post = (path: string, body: unknown) => instance.inject({ method: 'POST', url: path, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authority.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.environment.apply',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authority.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authority.token,
                    effectActionId: 'machines.environment.apply', target: authority.binding.target, installationId: authority.binding.installationId,
                    requestId: authority.binding.requestId, method: 'POST', path, body, privateKey: guestKeys.secretKey }),
            } });
            const resolved = await post('/v1/machines/environment/resolve', input);
            const reported = await post('/v1/machines/environment/report', { ...input, managedId: row.id,
                state: 'running', operation: { operationId: 'unauthorized-retry' } });
            expect(resolved.statusCode, resolved.body).toBe(403);
            expect(resolved.json()).toEqual({ code: 'permission_denied' });
            expect(reported.statusCode, reported.body).toBe(403);
            expect(reported.json()).toEqual({ code: 'permission_denied' });
            expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).environmentSetup)
                .toEqual({ environment, state: 'pending' });
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: owner.account.id,
                machineId: owner.controller.machineId, principal: { kind: 'account', accountId: actor.account.id }, level: 'view' }));
            const readable = await post('/v1/machines/environment/resolve', input);
            expect(readable.statusCode, readable.body).toBe(200);
            expect(readable.json()).toEqual({ environment, managedId: row.id });
            const readOnlyReport = await post('/v1/machines/environment/report', { ...input, managedId: row.id,
                state: 'running', operation: { operationId: 'read-only-retry' } });
            expect(readOnlyReport.statusCode, readOnlyReport.body).toBe(403);
            expect(readOnlyReport.json()).toEqual({ code: 'permission_denied' });
            expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).environmentSetup)
                .toEqual({ environment, state: 'pending' });
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
                : sealExternalActionRequestV2({ binding: { serverIdentityId: homeId, accountId: selected.account.id,
                    authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch }, actionId: 'machines.managed.acquire',
                    requestId: selected.requestId, target: { kind: 'machine', machineId: selected.controller.machineId } },
                    input: rootInput, material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
                    randomBytes: length => new Uint8Array(length).fill(2) });
            const rootResponse = await instance.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                headers: { authorization: `Bearer ${selected.token}` }, payload: { v: 1, machineId: selected.controller.machineId, envelope: rootEnvelope } });
            expect(rootResponse.statusCode, rootResponse.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(rootResponse.json());
            const environment = { setupScript: 'echo snapshot' };
            const presetId = crypto.randomUUID();
            await db.managedMachinePreset.create({ data: { id: presetId, homeId, custodianAccountId: selected.account.id, name: 'Setup',
                launch: selected.input.selection.launch, controllerMachineId: selected.controller.machineId,
                controllerInstallationId: selected.controller.installationId, environment: { setupScript: 'echo edited' }, revision: 2 } });
            const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: selected.account.id,
                controllerMachineId: selected.controller.machineId, controllerInstallationId: selected.controller.installationId,
                admittedActionRequestId: selected.requestId, admittedInput: { computeInput: selected.input, continuation: null,
                    environmentSetup: { requestEnvelopeDigest: root.binding.requestEnvelopeDigest } },
                presetId, presetRevision: 1, environmentSetup: { environment, state: 'pending' },
                launch: selected.input.selection.launch, allocation: 'bound', resource: { contributionRef: selected.input.selection.launch.provider,
                    schemaVersion: 1, value: { id: 'setup-paid-resource' } }, enrolledMachineId: guest.id,
                retention: selected.input.selection.retention, wakeOnAcceptedMessage: false } });
            // Session continuation has independent admitted custody. Setup must
            // hold even an otherwise valid original Session start at this owner.
            await db.managedMachine.update({ where: { id: row.id }, data: { admittedInput: {
                computeInput: selected.input, continuation: { requestEnvelopeDigest: root.binding.requestEnvelopeDigest },
                environmentSetup: { requestEnvelopeDigest: root.binding.requestEnvelopeDigest },
            } } });
            const spawnInput = { executionTarget: { serverId: homeId, machineId: guest.id },
                directory: { kind: 'path' as const, path: '/repo' }, creationKey: 'setup-waiting-session',
                agentTarget: { kind: 'agent' as const, identity: { pluginId: 'native.agent', localId: 'agent' } } };
            const spawnPath = bindExternalActionExecutionAuthorizationHttpPathV1('session.spawn_new');
            const spawnEnvelope = mode === 'plain' ? { v: 1 as const, requestId: 'setup-waiting-session',
                target: { kind: 'machine' as const, machineId: guest.id }, input: spawnInput }
                : { ...sealExternalActionRequestV2({ binding: { serverIdentityId: homeId, accountId: selected.account.id,
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
            const path = bindExternalActionExecutionAuthorizationHttpPathV1('machines.environment.apply');
            const target = { homeId, machineId: guest.id, presetId, presetRevision: 1 };
            const makeBody = (input = target) => ({ v: 1, machineId: input.machineId,
                envelope: mode === 'plain' ? { v: 1 as const, requestId: 'creation-setup', target: { kind: 'machine' as const, machineId: input.machineId }, input }
                    : sealExternalActionRequestV2({ binding: { serverIdentityId: homeId, accountId: selected.account.id,
                        authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch }, actionId: 'machines.environment.apply',
                        requestId: 'creation-setup', target: { kind: 'machine', machineId: input.machineId } }, input,
                        material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(8) },
                        randomBytes: length => new Uint8Array(length).fill(3) }),
                managedContinuation: { managedId: row.id, creationRequestId: selected.requestId, expectedIntentRevision: 0 } });
            const mint = (body: ReturnType<typeof makeBody>) => instance.inject({ method: 'POST', url: path, payload: body,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.managed.acquire',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: 'machines.managed.acquire', target: root.binding.target, installationId: root.binding.installationId,
                        requestId: root.binding.requestId, method: 'POST', path, body, privateKey: selected.keys.secretKey }) } });
            const childResponse = await mint(makeBody());
            expect(childResponse.statusCode, childResponse.body).toBe(200);
            const child = ExternalActionExecutionAuthorizationV1Schema.parse(childResponse.json());
            expect(child.binding).toMatchObject({ machineId: guest.id, installationId: guest.installationId,
                actionId: 'machines.environment.apply', managedContinuation: { managedId: row.id,
                    acquireRequestEnvelopeDigest: root.binding.requestEnvelopeDigest } });
            expect(await verifyCurrentExternalActionPrincipal(child.binding)).not.toBeNull();
            const resolvePath = '/v1/machines/environment/resolve';
            const resolve = (input = target) => instance.inject({ method: 'POST', url: resolvePath, payload: input,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: child.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.environment.apply',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(child.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: child.token,
                        effectActionId: 'machines.environment.apply', target: child.binding.target, installationId: child.binding.installationId,
                        requestId: child.binding.requestId, method: 'POST', path: resolvePath, body: input, privateKey: guestKeys.secretKey }) } });
            const resolved = await resolve();
            expect(resolved.statusCode, resolved.body).toBe(200);
            expect(resolved.json()).toEqual({ environment, managedId: row.id });
            expect((await resolve({ ...target, presetRevision: 2 })).statusCode).toBe(409);
            expect((await mint(makeBody({ ...target, machineId: selected.controller.machineId }))).statusCode).not.toBe(200);
            if (mode === 'plain') expect((await mint(makeBody({ ...target, presetRevision: 2 }))).statusCode).not.toBe(200);
            await db.managedMachine.update({ where: { id: row.id }, data: { environmentSetup: { environment, state: 'succeeded' } } });
            const released = await mintSession();
            expect(released.statusCode, released.body).toBe(200);
            await db.managedMachine.update({ where: { id: row.id }, data: { desired: 'delete', intentRevision: 1 } });
            expect(await verifyCurrentExternalActionPrincipal(child.binding)).toBeNull();
            expect((await mint(makeBody())).statusCode).not.toBe(200);
        } finally { await instance.close(); }
    });

    it.each(['ui', 'session'] as const)('mints a sealed guest continuation only from the exact current %s controller creation proof', async originKind => {
        const selected = await fixture(true);
        const source = originKind === 'session' ? await sourceFixture(selected) : undefined;
        const origin = source ? SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: source.session.id, starterDepth: 2, turnDepth: 3 },
            sourceTurnId: 'original-admitted-turn', callerPermissionMode: 'default', workspaceWrites: 'deny',
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
            requestId: selected.requestId }) : undefined;
        const childRequestId = origin ? selected.requestId : 'guest-start';
        const guestKeys = tweetnacl.sign.keyPair();
        const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: selected.account.id,
            active: true, operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: capabilities,
            metadata: encodePlainMachineStoredContent({ host: 'guest', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(guestKeys.publicKey) } });
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
            const rootEnvelope = { v: 1, requestId: selected.requestId,
                target: { kind: 'machine', machineId: selected.controller.machineId },
                input: ManagedAcquireInputV1Schema.parse({ ...selected.input, agentStart }) };
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
            const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: selected.account.id,
                controllerMachineId: selected.controller.machineId, controllerInstallationId: selected.controller.installationId,
                admittedActionRequestId: selected.requestId,
                admittedInput: { computeInput: selected.input, continuation: { requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(rootEnvelope) } },
                launch: selected.input.selection.launch, allocation: 'bound', resource: { contributionRef: selected.input.selection.launch.provider,
                    schemaVersion: 1, value: { id: 'same-paid-resource' } }, enrolledMachineId: guest.id,
                retention: selected.input.selection.retention, wakeOnAcceptedMessage: false } });
            const privateText = 'Only the exact guest opens this original continuation';
            const spawnInput = { executionTarget: { serverId: homeId, machineId: guest.id },
                directory: { kind: 'path' as const, path: '/repo' },
                agentTarget: { kind: 'agent' as const, identity: { pluginId: 'native.agent', localId: 'agent' } },
                creationKey: 'guest-start', initialInput: { text: privateText } };
            const envelope = { ...sealExternalActionRequestV2({ binding: { serverIdentityId: homeId,
                accountId: selected.account.id, authentication: { kind: 'account', tokenEpoch: selected.account.tokenEpoch },
                actionId: 'session.spawn_new', requestId: childRequestId, target: { kind: 'machine', machineId: guest.id } },
                input: spawnInput, material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
                randomBytes: length => new Uint8Array(length).fill(3) }),
                sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(spawnInput) };
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
            const mintChild = () => instance.inject({ method: 'POST', url: path, payload: body, headers });
            const childResponse = await mintChild();
            expect(childResponse.statusCode).toBe(200);
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
                expect(refused.statusCode, refused.body).toBe(401);
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
            const verifyBody = { v: 1 };
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
            const arbitraryBearer = await instance.inject({ method: 'POST', url: forwardPath,
                headers: { authorization: `Bearer ${selected.token}` }, payload: envelope });
            expect(arbitraryBearer.statusCode).toBe(401);
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
