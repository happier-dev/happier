import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodeBase64, encodePlainMachineStoredContent,
    API_TOKEN_FULL_GRANT_V1,
    PluginManifestV2Schema, ManagedPolicyAdmissionInputV1Schema, ManagedControllerMachineOutputV1Schema,
    ManagedResourceV1Schema, createManagedPolicyProofV1, encodeManagedPolicyProofV1, MANAGED_POLICY_PROOF_HEADER,
    ExternalActionExecutionAuthorizationV1Schema,
    type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { setMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { assertManagedWakeOriginCurrentInTx, prepareManagedFiniteActionWake } from './managedWake';
import { createExternalActionDaemonDispatcher, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    resolveCurrentSessionMachineFromServer, resolveCurrentSessionPublisherFromServer } from '@/app/api/socket/externalActionDispatcher';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { createExternalActionDaemonDispatchResponseV1, prepareExternalActionResponseEnvelopeV1,
    computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import { signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { MANAGED_FINITE_WAKE_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { SOCKET_RPC_EVENTS, SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { getAccountSessionSocketRoom } from '@/app/api/socketRooms';
import { applyEnvValues, restoreEnv, snapshotEnv } from '@/testkit/env';
import { encryptString } from '@/modules/encrypt';
import { registerManagedMachineRoutes } from './managedRoutes';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { defineProtocolObject } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema,
    MachineProvisionerPowerResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { createFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { qualifyCurrentAccountStoredContentSocket } from '@/app/api/testkit/accountStoredContentCompatibility';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import type { Fastify as ServerFastify } from '@/app/api/types';
import { projectExternalActionBoundPrincipal, verifyCurrentExternalActionPrincipal } from '@/app/auth/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions';
import { bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions';

describe('finite managed wake original Action authority (real SQLite)', () => {
    let harness: LightSqliteHarness;
    const homeId = `srv_${'f'.repeat(32)}`;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-finite-wake-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function setup() {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controllerKeys = tweetnacl.sign.keyPair();
        const guestKeys = tweetnacl.sign.keyPair();
        const machine = (active: boolean) => db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, installationId: randomUUID(), active,
            installationPublicKey: active ? controllerKeys.publicKey : guestKeys.publicKey,
            metadata: encodePlainMachineStoredContent({ host: 'finite-wake', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/wake', happyHomeDir: '/home/wake/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] }, projectFiniteExecution: { protocolVersions: [1] } },
        } });
        const controller = await machine(true);
        const guest = await machine(false);
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId!,
            admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Retained', choices: {} },
            resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            enrolledMachineId: guest.id, desired: 'stop', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
            observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
        } });
        const requestId = randomUUID();
        const actionOrigin = await auth.mintExternalActionExecutionAuthorization({ accountId: account.id,
            authentication: { kind: 'account', tokenEpoch: account.tokenEpoch }, serverIdentityId: homeId,
            machineId: guest.id, actionId: 'projects.script.run', requestId,
            requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: guest.id } });
        const target = { homeId, managedId: row.id, enrolledMachineId: guest.id, expectedIntentRevision: row.intentRevision,
            controller: { machineId: controller.id, installationId: controller.installationId! },
            origin: { kind: 'finite-command' as const, actionRequestId: requestId }, reason: 'admitted-work' as const };
        const check = (origin?: ExternalActionExecutionAuthorizationV1) => inTx(tx =>
            assertManagedWakeOriginCurrentInTx(tx, { row, target, ...{ actionOrigin: origin } }));
        return { account, controller, controllerKeys, guest, guestKeys, row, target, actionOrigin, check, requestId };
    }

    async function publishWakeDeclaration(test: Awaited<ReturnType<typeof setup>>) {
        const native = defineProtocolObject({}, { policy: 'closed' });
        const roles = defineMachineProvisionerSchemas({ launch: native, resource: native });
        const actions = [
            { id: 'check', inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
            { id: 'acquire', inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
            { id: 'bootstrap', inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
            { id: 'inspect', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
            { id: 'power', inputSchema: roles.powerInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
            { id: 'destroy', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        ];
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'fixture.compute', version: '1.0.0',
            displayName: 'Compute', description: 'Finite policy preparation fixture', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {
                machineProvisioners: [{ id: 'vm', title: 'Compute', icon: 'machine', resourceKind: 'VM', schemaVersion: 1,
                    launchSchema: native.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
                    billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'resume', 'delete'] },
                    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } }],
                actions: actions.map(action => ({ ...action, title: action.id, execution: { target: 'daemon' },
                    surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' })),
            } });
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.machine.update({ where: { id: test.controller.id }, data: { pluginMaterializationRevision: BigInt(1) } });
        await db.accountPluginIntent.create({ data: { accountId: test.account.id, pluginId: manifest.id, enabled: true,
            writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: test.account.id, serverIdentityId: homeId,
            machineId: test.controller.id, materializationId: test.controller.installationId!, pluginId: manifest.id,
            version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false,
            archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true,
            trustState: 'trusted', observedAt: new Date() } });
    }

    it('prepares the Home-selected native wake policy without admitting intent before requester Ask, then revalidates admission', async () => {
        const test = await setup();
        await publishWakeDeclaration(test);
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        for (const machine of [test.controller, test.guest]) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: test.account.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'admin' }));
        const actionOrigin = await auth.mintExternalActionExecutionAuthorization({ accountId: requester.id,
            authentication: { kind: 'account', tokenEpoch: requester.tokenEpoch }, serverIdentityId: homeId,
            machineId: test.guest.id, actionId: 'projects.script.run', requestId: test.requestId,
            requestEnvelopeDigest: 'c'.repeat(43), target: { kind: 'machine', machineId: test.guest.id } });
        await db.managedMachine.update({ where: { id: test.row.id }, data: { observation: {
            observedAt: 2, availability: 'present', power: 'suspended', storage: 'retained' } } });
        const original = await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } });
        const input = ManagedPolicyAdmissionInputV1Schema.parse({ homeId, managedId: test.row.id,
            controller: test.target.controller, expectedIntentRevision: test.row.intentRevision,
            requestId: randomUUID(), purpose: { kind: 'accepted-input-start', target: test.target } });
        const token = await auth.createToken(test.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); registerManagedMachineRoutes(app); await app.ready();
        const invoke = (path: string, root = actionOrigin, proofPath = path, body = input) => app.inject({ method: 'POST', url: path,
            headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}`,
                [MANAGED_POLICY_PROOF_HEADER]: encodeManagedPolicyProofV1(createManagedPolicyProofV1({ correlation: {
                    homeId: body.homeId, managedId: body.managedId, controller: body.controller,
                    expectedIntentRevision: body.expectedIntentRevision, requestId: body.requestId },
                    purpose: body.purpose, resource: ManagedResourceV1Schema.parse(test.row.resource),
                    custodianAccountId: test.account.id, path: proofPath, body,
                    privateKey: test.controllerKeys.secretKey, actionOrigin: root })) }, payload: body });
        const preparePath = '/v1/machines/managed/controller/prepare-policy';
        const admitPath = '/v1/machines/managed/controller/admit-policy';
        try {
            const preview = await invoke(preparePath);
            expect(preview.statusCode, preview.body).toBe(200);
            const prospective = ManagedControllerMachineOutputV1Schema.parse(preview.json()).machine;
            expect(prospective).toMatchObject({ id: test.row.id, desired: 'resume', intentRevision: original.intentRevision,
                controller: test.target.controller, resource: test.row.resource });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).toEqual(original);
            const repeated = await invoke(preparePath);
            expect(repeated.statusCode, repeated.body).toBe(200);
            expect(repeated.json()).toEqual(preview.json());
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).toEqual(original);
            const wrongPhase = await invoke(preparePath, actionOrigin, admitPath);
            expect(wrongPhase.statusCode).toBe(403);
            const alteredRoot = await invoke(preparePath, { ...actionOrigin,
                binding: { ...actionOrigin.binding, requestId: randomUUID() } });
            expect(alteredRoot.statusCode).not.toBe(200);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.account.id, machineId: test.controller.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'view' }));
            const retired = await invoke(preparePath);
            expect(retired.statusCode).not.toBe(200);
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).toEqual(original);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.account.id, machineId: test.controller.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'admin' }));
            const admitted = await invoke(admitPath);
            expect(admitted.statusCode, admitted.body).toBe(200);
            const afterAdmission = await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } });
            expect(afterAdmission).toMatchObject({ desired: 'resume', intentRevision: original.intentRevision + 1 });
            // The pre-admission installation proof cannot spend the newer tuple.
            const stalePreview = await invoke(preparePath);
            expect(stalePreview.statusCode, stalePreview.body).toBe(403);
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).toEqual(afterAdmission);
            await db.account.update({ where: { id: requester.id }, data: { tokenEpoch: { increment: 1 } } });
            const currentInput = { ...input, requestId: randomUUID(), expectedIntentRevision: afterAdmission.intentRevision };
            const retiredReplay = await invoke(preparePath, actionOrigin, preparePath, currentInput);
            expect(retiredReplay.statusCode).not.toBe(200);
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).toEqual(afterAdmission);
            await db.account.update({ where: { id: requester.id }, data: { tokenEpoch: requester.tokenEpoch } });
            await db.managedMachine.update({ where: { id: test.row.id }, data: { intentRevision: { increment: 1 } } });
            const beforeAdmission = await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } });
            const staleInput = { ...input, requestId: randomUUID(), expectedIntentRevision: afterAdmission.intentRevision };
            const staleAdmission = await invoke(admitPath, actionOrigin, admitPath, staleInput);
            expect(staleAdmission.statusCode).toBe(403);
            expect(staleAdmission.json()).toMatchObject({ code: 'permission_denied' });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).toEqual(beforeAdmission);
        } finally { await app.close(); }
    });

    it('admits a stopped guest only under its actual signed original finite Action request', async () => {
        const test = await setup();
        await expect(test.check()).rejects.toMatchObject({ code: 'admission_unavailable' });
        await expect(test.check({ ...test.actionOrigin, binding: { ...test.actionOrigin.binding, requestId: 'forged' } }))
            .rejects.toMatchObject({ code: 'admission_unavailable' });
        await expect(test.check(test.actionOrigin)).resolves.toBeUndefined();
        expect((await db.machine.findUniqueOrThrow({ where: { id: test.guest.id } })).active).toBe(false);
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).desired).toBe('stop');
    });

    it('rechecks original credential and guest installation instead of borrowing controller authority', async () => {
        const test = await setup();
        await expect(test.check(test.actionOrigin)).resolves.toBeUndefined();
        await db.account.update({ where: { id: test.account.id }, data: { tokenEpoch: { increment: 1 } } });
        await expect(test.check(test.actionOrigin)).rejects.toMatchObject({ code: 'admission_unavailable' });
        const fresh = await setup();
        await db.machine.update({ where: { id: fresh.guest.id }, data: { installationId: randomUUID() } });
        await expect(fresh.check(fresh.actionOrigin)).rejects.toMatchObject({ code: 'admission_unavailable' });
    });

    it('does not wake an owned guest when its original Session publisher retires during provider eligibility', async () => {
        const test = await setup();
        const envBefore = snapshotEnv();
        applyEnvValues({ AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' });
        const session = await db.session.create({ data: { accountId: test.account.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true, lastActiveAt: new Date() } });
        await db.accessKey.create({ data: { accountId: test.account.id, machineId: test.controller.id,
            sessionId: session.id, data: 'opaque-original-source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: test.account.id, machineId: test.controller.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        let publisherVisible = true;
        // Only Socket discovery is replaced; publisher and Session authority remain real.
        const io = { in: (room: string) => ({ fetchSockets: async () => publisherVisible
            && room === getAccountSessionSocketRoom(test.account.id, session.id) ? [publisher] : [] }) } as unknown as Server;
        const resolveSource = (input: Readonly<{ accountId: string; sessionId: string }>) =>
            resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
            sourceTurnId: 'original-finite-turn', callerPermissionMode: 'yolo', causalPermissionAuthority: null,
            requestId: test.requestId });
        const envelope = { v: 1 as const, requestId: test.requestId,
            target: { kind: 'machine' as const, machineId: test.guest.id }, input: { retained: 'original Session finite request' } };
        const source = { machineId: test.controller.id, installationId: test.controller.installationId! };
        const installationProof = signMachineInstallationProof({ privateKey: test.controllerKeys.secretKey,
            payload: { version: 1, accountId: test.account.id, ...source, externalActionOrigin: { homeId,
                actionId: 'projects.script.run', requestId: test.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        app.decorate('resolveCurrentSessionPublisher', (input: Readonly<{ accountId: string; sessionId: string }>) =>
            resolveCurrentSessionPublisherFromServer({ io, presence, ...input }));
        app.decorate('resolveCurrentSessionMachine', resolveSource);
        registerExternalActionRoutes(app, { dispatch: async () => { throw new Error('Mint must not execute'); } });
        await app.ready();
        let restoreFetch: (() => void) | undefined;
        try {
            const token = await auth.createToken(test.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const minted = await app.inject({ method: 'POST', url: '/v1/actions/projects.script.run/execution-authorization',
                headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}` },
                payload: { v: 1, machineId: test.guest.id, envelope, sessionActionOrigin: origin,
                    sessionActionSource: source, installationProof } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const current = await verifyCurrentExternalActionPrincipal(authorization.binding);
            const principal = current && projectExternalActionBoundPrincipal(authorization.binding, current);
            if (!principal) throw new Error('Real original Session principal was not admitted');
            expect(principal).toMatchObject({ accountId: test.account.id, authority: 'account_automation', sessionActionOrigin: origin });
            expect(await resolveSource({ accountId: test.account.id, sessionId: session.id })).toBe(test.controller.id);
            await db.accountIdentity.create({ data: { accountId: test.account.id, provider: 'github',
                providerUserId: 'finite-requester', providerLogin: 'finite-requester', profile: {},
                token: encryptString(['user', test.account.id, 'github', 'token'], 'github-oauth-boundary-token') } });
            applyEnvValues({ AUTH_REQUIRED_LOGIN_PROVIDERS: 'github', AUTH_GITHUB_ALLOWED_USERS: '',
                AUTH_GITHUB_ALLOWED_ORGS: 'finite-requesters', AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: 'oauth_user_token',
                AUTH_OFFBOARDING_ENABLED: 'false' });
            let eligibilityRead = false;
            // Real provider eligibility still succeeds; only its HTTP await retires the live source.
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
                expect(String(url)).toBe('https://api.github.com/orgs/finite-requesters/members/finite-requester');
                eligibilityRead = true;
                publisherVisible = false;
                return new Response(null, { status: 204 });
            });
            restoreFetch = () => fetchSpy.mockRestore();
            const methods: string[] = [];
            const dispatch = createExternalActionDaemonDispatcher({ io, sessionPublisherPresence: presence,
                forwardRpc: async request => {
                    methods.push(request.method);
                    if (request.method === `${test.controller.id}:${MANAGED_FINITE_WAKE_RPC_METHOD}`) {
                        await db.machine.update({ where: { id: test.guest.id }, data: { active: true } });
                        return { ok: true, result: { ok: true, result: { kind: 'accepted', managedId: test.row.id,
                            intentRevision: 1, operation: { operationId: 'native-policy' } } } };
                    }
                    return { ok: false, error: 'Retired Session must not reach the guest' };
                } });
            // The actual authenticated Home dispatcher receives the original root, so the
            // provider await is inside finite wake rather than an earlier Bearer-auth hook.
            const result = await dispatch({ actionId: 'projects.script.run', envelope, principal,
                executionAuthorization: authorization });
            expect(eligibilityRead).toBe(true);
            expect(await resolveSource({ accountId: test.account.id, sessionId: session.id })).toBeNull();
            expect(result).toEqual({ kind: 'placement_error', code: 'target_unavailable' });
            expect(methods).toEqual([]);
            expect((await db.machine.findUniqueOrThrow({ where: { id: test.guest.id } })).active).toBe(false);
            expect((await db.account.findUniqueOrThrow({ where: { id: test.account.id } })).tokenEpoch).toBe(test.account.tokenEpoch);
            expect(await db.accessKey.findUnique({ where: { accountId_machineId_sessionId: {
                accountId: test.account.id, machineId: test.controller.id, sessionId: session.id } } })).not.toBeNull();
            expect((await db.machine.findUniqueOrThrow({ where: { id: test.controller.id } })).installationId).toBe(test.controller.installationId);
            expect((await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).desired).toBe('stop');
        } finally { restoreFetch?.(); restoreEnv(envBefore); await app.close(); }
    });

    it('rechecks original source retirement at the final guarded wake transport boundary', async () => {
        const test = await setup();
        let sourceCurrent = true;
        const nativeEffect = vi.fn(async () => ({ ok: true as const }));
        const io = {} as Server;
        const prepared = await prepareManagedFiniteActionWake({ io, actionOrigin: test.actionOrigin,
            signal: new AbortController().signal, isOriginalSourceCurrent: async () => sourceCurrent,
            forwardRpc: async request => {
                const candidate = { id: 'controller-socket', data: { clientType: 'machine-scoped', userId: test.account.id,
                    machineId: test.controller.id, verifiedMachineInstallationId: test.controller.installationId },
                    timeout: () => ({ emitWithAck: nativeEffect }) };
                const guard = request.targetGuard;
                if (!guard) throw new Error('Finite wake requires a guarded native transport.');
                expect(await guard.filterTargets([candidate])).toEqual([candidate]);
                sourceCurrent = false;
                expect(await guard.runOperation({ target: candidate, readLatestTarget: async () => candidate,
                    operation: nativeEffect })).toEqual({ status: 'unavailable' });
                expect(await guard.filterTargets([candidate])).toEqual([]);
                return { ok: false, error: 'retired-original-source' };
            } });
        expect(prepared).toEqual({ kind: 'unavailable' });
        expect(nativeEffect).not.toHaveBeenCalled();
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).desired).toBe('stop');
    });

    it('retains the exact original finite PAT grant and mode instead of requiring a native power grant', async () => {
        const test = await setup();
        const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['projects.script.run' as const] },
            targets: { sessions: [], machines: [test.guest.id] } };
        const pat = await auth.createApiToken({ accountId: test.account.id, tokenId: randomUUID(), label: 'original finite', grant });
        const origin = await auth.mintExternalActionExecutionAuthorization({ accountId: test.account.id,
            principalId: test.account.id, credentialId: pat.tokenId, grant, serverIdentityId: homeId, machineId: test.guest.id,
            actionId: 'projects.script.run', requestId: test.requestId, requestEnvelopeDigest: 'b'.repeat(43),
            target: { kind: 'machine', machineId: test.guest.id } });
        await expect(test.check(origin)).resolves.toBeUndefined();
        await auth.updateApiToken({ accountId: test.account.id, tokenId: pat.tokenId,
            grant: { ...grant, actions: { families: [], ids: ['projects.prepare'] } } });
        await expect(test.check(origin)).rejects.toMatchObject({ code: 'admission_unavailable' });
    });

    it('issues and dispatches the real terminal finite request without promoting its authority, then closes it on epoch retirement', async () => {
        const test = await setup();
        const token = await auth.createToken(test.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const envelope = { v: 1 as const, requestId: test.requestId,
            target: { kind: 'machine' as const, machineId: test.guest.id }, input: { retained: 'original terminal request' } };
        const methods: string[] = [];
        const dispatch = createExternalActionDaemonDispatcher({ io: new Server(), forwardRpc: async request => {
            methods.push(request.method);
            if (request.method.startsWith(`${test.controller.id}:`)) {
                const wake = request.callParams as { actionOrigin: ExternalActionExecutionAuthorizationV1 };
                expect(wake.actionOrigin.binding).toMatchObject({ authentication: { kind: 'terminal' } });
                await test.check(wake.actionOrigin);
                await db.machine.update({ where: { id: test.guest.id }, data: { active: true } });
                return { ok: true, result: { ok: true, result: { kind: 'accepted', managedId: test.row.id,
                    intentRevision: 1, operation: { operationId: 'native-policy' } } } };
            }
            expect(request.callParams).toMatchObject({ principal: { authority: 'account_automation', authentication: { kind: 'terminal' } } });
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId: 'projects.script.run', requestId: test.requestId, execution: { ok: true, result: { terminal: true } },
            })) };
        } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); registerExternalActionRoutes(app, { dispatch });
        await app.ready();
        try {
            const headers = { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}` };
            const minted = await app.inject({ method: 'POST', url: '/v1/actions/projects.script.run/execution-authorization',
                headers, payload: { v: 1, machineId: test.guest.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding).toMatchObject({ authentication: { kind: 'terminal', tokenEpoch: test.account.tokenEpoch } });
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({ authority: 'account_automation' });
            const relay = { v: 1 as const, machineId: test.guest.id, envelope, executionAuthorization: authorization };
            const relayHeaders = { ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'projects.script.run',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(envelope.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'projects.script.run', target: envelope.target, method: 'POST',
                    installationId: test.guest.installationId!, requestId: test.requestId,
                    path: '/v1/actions/projects.script.run', body: relay, privateKey: test.guestKeys.secretKey }) };
            const delivered = await app.inject({ method: 'POST', url: '/v1/actions/projects.script.run', headers: relayHeaders, payload: relay });
            expect(delivered.statusCode, delivered.body).toBe(200);
            expect(methods).toHaveLength(2);
            await db.account.update({ where: { id: test.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toBeNull();
            const retired = await app.inject({ method: 'POST', url: '/v1/actions/projects.script.run', headers: relayHeaders, payload: relay });
            expect(retired.statusCode).toBe(401); expect(methods).toHaveLength(2);
        } finally { await app.close(); }
    });

    it.each(['shared', 'owned'] as const)('returns only the current Home-proved finite controller custody recipient on the unchanged original %s guest root', async guestOwnership => {
        const test = await setup();
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        if (guestOwnership === 'owned') await db.machine.update({ where: { id: test.guest.id }, data: { accountId: requester.id } });
        for (const machine of guestOwnership === 'shared' ? [test.controller, test.guest] : [test.controller]) {
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.account.id, machineId: machine.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'admin' }));
        }
        const token = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        const envelope = { v: 1 as const, requestId: test.requestId,
            target: { kind: 'machine' as const, machineId: test.guest.id }, input: { retained: 'Bob original finite request' } };
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerExternalActionRoutes(app, { dispatch: async () => { throw new Error('Issuance must not run a native effect'); } });
        await app.ready();
        const issue = () => app.inject({ method: 'POST', url: '/v1/actions/projects.script.run/execution-authorization',
            headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}` },
            payload: { v: 1, machineId: test.guest.id, envelope } });
        try {
            const issued = await issue();
            expect(issued.statusCode, issued.body).toBe(200);
            expect(issued.json()).toMatchObject({ managedFiniteWake: {
                target: test.target,
                installationPublicKey: encodeBase64(test.controller.installationPublicKey!, 'base64url'),
            } });
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(await auth.verifyExternalActionExecutionAuthorization(root.token)).toEqual(root.binding);
            expect(root.binding).toMatchObject({ accountId: requester.id,
                custodianAccountId: guestOwnership === 'owned' ? requester.id : test.account.id,
                machineId: test.guest.id, installationId: test.guest.installationId,
                target: envelope.target, actionId: 'projects.script.run', requestId: test.requestId });
            expect(root.binding).not.toHaveProperty('sessionActionOrigin');
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.account.id, machineId: test.controller.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'view' }));
            const withdrawn = await issue();
            expect(withdrawn.statusCode, withdrawn.body).toBe(200);
            expect(withdrawn.json()).not.toHaveProperty('managedFiniteWake');
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.account.id, machineId: test.controller.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'admin' }));
            await db.machine.update({ where: { id: test.controller.id }, data: { installationId: randomUUID() } });
            const replaced = await issue();
            expect(replaced.statusCode, replaced.body).toBe(200);
            expect(replaced.json()).not.toHaveProperty('managedFiniteWake');
            expect((await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).desired).toBe('stop');
        } finally { await app.close(); }
    });

    it('verifies finite requester custody only at its current Home-proved controller without retargeting the guest root', async () => {
        const test = await setup();
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        for (const machine of [test.controller, test.guest]) {
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.account.id, machineId: machine.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'admin' }));
        }
        const root = await auth.mintExternalActionExecutionAuthorization({ accountId: requester.id,
            authentication: { kind: 'account', tokenEpoch: requester.tokenEpoch }, serverIdentityId: homeId,
            machineId: test.guest.id, actionId: 'projects.script.run', requestId: test.requestId,
            requestEnvelopeDigest: 'd'.repeat(43), target: { kind: 'machine', machineId: test.guest.id } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerExternalActionRoutes(app, { dispatch: async () => { throw new Error('Custody verification must not execute'); } });
        await app.ready();
        const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1('projects.script.run');
        const verify = (target: unknown = test.target, privateKey: Uint8Array = test.controllerKeys.secretKey) => {
            const body = { v: 1, managedFiniteWakeTarget: target };
            return app.inject({ method: 'POST', url: path, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: root.binding.actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: root.token, effectActionId: root.binding.actionId, target: root.binding.target,
                    installationId: root.binding.installationId, requestId: root.binding.requestId,
                    method: 'POST', path, body, privateKey,
                }),
            } });
        };
        try {
            const admitted = await verify();
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(await auth.verifyExternalActionExecutionAuthorization(root.token)).toEqual(root.binding);
            expect(root.binding.machineId).toBe(test.guest.id);
            expect((await verify({ ...test.target, managedId: randomUUID() })).statusCode).toBe(401);
            expect((await verify({ ...test.target, controller: { ...test.target.controller, installationId: randomUUID() } })).statusCode).toBe(401);
            expect((await verify({ ...test.target, origin: { kind: 'finite-command', actionRequestId: randomUUID() } })).statusCode).toBe(401);
            expect((await verify(test.target, test.guestKeys.secretKey)).statusCode).toBe(401);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.account.id, machineId: test.controller.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'view' }));
            expect((await verify()).statusCode).toBe(401);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.account.id, machineId: test.controller.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'admin' }));
            await db.machine.update({ where: { id: test.controller.id }, data: { installationId: randomUUID() } });
            expect((await verify()).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it('preserves both installed custody boxes and the original root through actual finite wake and guest relay', async () => {
        const test = await setup();
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        for (const machine of [test.controller, test.guest]) {
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.account.id, machineId: machine.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'admin' }));
        }
        const token = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        const envelope = { v: 1 as const, requestId: test.requestId,
            target: { kind: 'machine' as const, machineId: test.guest.id }, input: { retained: 'original private finite request' } };
        let carrier: ExternalActionExecutionAuthorizationV1 | undefined;
        const methods: string[] = [];
        const boundaryErrors: unknown[] = [];
        const dispatch = createExternalActionDaemonDispatcher({ io: new Server(), forwardRpc: async request => {
            try {
                methods.push(request.method);
                if (request.method === `${test.controller.id}:${MANAGED_FINITE_WAKE_RPC_METHOD}`) {
                    expect(request.callParams).toMatchObject({ target: test.target, actionOrigin: carrier });
                    await test.check(carrier);
                    await db.machine.update({ where: { id: test.guest.id }, data: { active: true } });
                    return { ok: true, result: { ok: true, result: { kind: 'accepted', managedId: test.row.id,
                        intentRevision: 1, operation: { operationId: 'native-policy' } } } };
                }
                expect(request.method).toBe(`${test.guest.id}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`);
                expect(request.callParams).toMatchObject({ envelope, executionAuthorization: carrier,
                    principal: { accountId: requester.id, authority: 'present_user' } });
                return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                    v: 1, actionId: 'projects.script.run', requestId: test.requestId, execution: { ok: true, result: { ran: true } },
                })) };
            } catch (error) { boundaryErrors.push(error); throw error; }
        } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); registerExternalActionRoutes(app, { dispatch });
        await app.ready();
        try {
            const headers = { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}` };
            const minted = await app.inject({ method: 'POST', url: '/v1/actions/projects.script.run/execution-authorization',
                headers, payload: { v: 1, machineId: test.guest.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            if (!root.managedFiniteWake) throw new Error('Actual Home must supply the controller custody recipient');
            carrier = { ...root,
                requesterAccountContext: { kind: 'installation_sealed_v1', installationId: root.binding.installationId, ciphertext: 'guest_box' },
                managedFiniteWake: { ...root.managedFiniteWake, requesterAccountContext: {
                    kind: 'installation_sealed_v1', installationId: root.managedFiniteWake.target.controller.installationId, ciphertext: 'controller_box',
                } } };
            const result = await app.inject({ method: 'POST', url: '/v1/actions/projects.script.run', headers,
                payload: { v: 1, machineId: test.guest.id, envelope, executionAuthorization: carrier } });
            if (boundaryErrors.length > 0) throw boundaryErrors[0];
            expect(result.statusCode, result.body).toBe(200);
            expect(result.json()).toMatchObject({ execution: { ok: true, result: { ran: true } } });
            expect(methods).toEqual([`${test.controller.id}:${MANAGED_FINITE_WAKE_RPC_METHOD}`,
                `${test.guest.id}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`]);
        } finally { await app.close(); }
    });

    it('checks requester Account mode independently of the shared custodian Machine resource mode', async () => {
        const test = await setup();
        const keys = tweetnacl.box.keyPair();
        const requester = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
        await db.machineAccountGrant.createMany({ data: [test.controller, test.guest].map(machine => ({
            machineId: machine.id, accountId: requester.id, accessLevel: 'admin' as const, createdByAccountId: test.account.id,
        })) });
        const origin = await auth.mintExternalActionExecutionAuthorization({ accountId: requester.id,
            authentication: { kind: 'account', tokenEpoch: requester.tokenEpoch }, serverIdentityId: homeId,
            machineId: test.guest.id, actionId: 'projects.script.run', requestId: test.requestId,
            requestEnvelopeDigest: 'c'.repeat(43), target: { kind: 'machine', machineId: test.guest.id } });
        expect(origin.binding.accountEncryptionMode).toBe('e2ee');
        await expect(test.check(origin)).resolves.toBeUndefined();
        await db.account.update({ where: { id: requester.id }, data: { encryptionMode: 'plain' } });
        await expect(test.check(origin)).rejects.toMatchObject({ code: 'admission_unavailable' });
    });

    it('retains the original HTTP Action across exact-controller wake and freshly admits the guest once', async () => {
        const test = await setup();
        const envelope = { v: 1 as const, requestId: test.requestId,
            target: { kind: 'machine' as const, machineId: test.guest.id }, input: { preserved: 'opaque original input' } };
        const methods: string[] = [];
        const dispatch = createExternalActionDaemonDispatcher({ io: new Server(), forwardRpc: async request => {
            methods.push(request.method);
            if (request.method.startsWith(`${test.controller.id}:`)) {
                const wake = request.callParams as { target: typeof test.target; actionOrigin: ExternalActionExecutionAuthorizationV1 };
                expect(wake.target.origin).toEqual(test.target.origin);
                expect(wake.actionOrigin.binding.machineId).toBe(test.guest.id);
                await test.check(wake.actionOrigin);
                await db.machine.update({ where: { id: test.guest.id }, data: { active: true } });
                return { ok: true, result: { ok: true, result: { kind: 'accepted', managedId: test.row.id, intentRevision: 1, operation: { operationId: 'native-policy' } } } };
            }
            expect(request.method).toBe(`${test.guest.id}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`);
            expect((request.callParams as { envelope: unknown }).envelope).toBe(envelope);
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId: 'projects.script.run', requestId: test.requestId, execution: { ok: true, result: { ran: true } },
            })) };
        } });
        await expect(dispatch({ actionId: 'projects.script.run', envelope,
            principal: { accountId: test.account.id, authority: 'present_user', authentication: { kind: 'account', tokenEpoch: test.account.tokenEpoch } },
        })).resolves.toMatchObject({ kind: 'response' });
        expect(methods).toHaveLength(2);
    });

    it.each(['cancel', 'unknown', 'credential-retired'] as const)('dispatches no guest work when wake is %s', async disposition => {
        const test = await setup();
        const cancel = new AbortController();
        const methods: string[] = [];
        const dispatch = createExternalActionDaemonDispatcher({ io: new Server(), forwardRpc: async request => {
            methods.push(request.method);
            expect(request.method.startsWith(`${test.controller.id}:`)).toBe(true);
            if (disposition === 'cancel') cancel.abort();
            if (disposition === 'credential-retired') {
                await db.account.update({ where: { id: test.account.id }, data: { tokenEpoch: { increment: 1 } } });
                await db.machine.update({ where: { id: test.guest.id }, data: { active: true } });
            }
            if (disposition === 'unknown') { request.onSubmittedUnknown?.(); return { ok: false, error: 'transport lost' }; }
            return { ok: true, result: { ok: true, result: { kind: 'accepted', managedId: test.row.id, intentRevision: 1, operation: { operationId: 'native-policy' } } } };
        } });
        const result = await dispatch({ actionId: 'projects.script.run', envelope: { v: 1, requestId: test.requestId,
            target: { kind: 'machine', machineId: test.guest.id }, input: {} },
            principal: { accountId: test.account.id, authority: 'present_user', authentication: { kind: 'account', tokenEpoch: test.account.tokenEpoch } },
        }, { signal: cancel.signal });
        expect(result.kind).toBe(disposition === 'unknown' ? 'submitted_unknown' : 'placement_error');
        expect(methods).toHaveLength(1);
    });

    it.each(['current', 'publisher-during-eligibility'] as const)('preserves the original signed Socket finite custody carrier and refuses retired Session authority (%s)', async disposition => {
        const test = await setup();
        const envBefore = snapshotEnv();
        applyEnvValues({ AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' });
        const methods: string[] = [];
        const boundaryErrors: unknown[] = [];
        const original = { opaque: 'same caller-owned Project input' };
        const guestMethod = `${test.guest.id}:${RPC_METHODS.DAEMON_PROJECTS_SCRIPT_RUN}`;
        const wakeMethod = `${test.controller.id}:${MANAGED_FINITE_WAKE_RPC_METHOD}`;
        const session = await db.session.create({ data: { accountId: test.account.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true, lastActiveAt: new Date() } });
        await db.accessKey.create({ data: { accountId: test.account.id, machineId: test.controller.id,
            sessionId: session.id, data: 'opaque-original-source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: test.account.id, machineId: test.controller.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        let publisherVisible = true;
        let carrier: ExternalActionExecutionAuthorizationV1 | undefined;
        let initialEligibilityReached = false;
        let wakeEligibilityDue = false;
        let wakeEligibilityReached = false;
        const controllerSocket = { id: 'finite-controller', data: { clientType: 'machine-scoped', userId: test.account.id,
            machineId: test.controller.id, verifiedMachineInstallationId: test.controller.installationId }, timeout: () => ({
            emitWithAck: async (_event: string, request: { method: string; params: { actionOrigin: ExternalActionExecutionAuthorizationV1 } }) => {
                methods.push(request.method);
                try {
                    if (disposition === 'current') expect(request.params.actionOrigin).toEqual(carrier);
                    await test.check(request.params.actionOrigin);
                    await db.machine.update({ where: { id: test.guest.id }, data: { active: true } });
                    return { ok: true, result: { kind: 'accepted', managedId: test.row.id, intentRevision: 1, operation: { operationId: 'native-policy' } } };
                } catch (error) { boundaryErrors.push(error); throw error; }
            },
        }) };
        const guestSocket = { id: 'finite-guest', data: { clientType: 'machine-scoped', userId: test.account.id,
            machineId: test.guest.id, verifiedMachineInstallationId: test.guest.installationId }, timeout: () => ({
            emitWithAck: async (_event: string, request: { method: string; params: unknown }) => {
                methods.push(request.method); expect(request.params).toBe(original); return { completed: true };
            },
        }) };
        qualifyCurrentAccountStoredContentSocket(controllerSocket); qualifyCurrentAccountStoredContentSocket(guestSocket);
        const io = createSocketRoomDiscoveryHarness(async room => {
            if (room === getAccountSessionSocketRoom(test.account.id, session.id)) {
                if (initialEligibilityReached && !wakeEligibilityDue) {
                    // The original RPC verifier has completed real eligibility
                    // before its final source read. Make the persisted offboarding
                    // check due before wake's separate eligibility await.
                    await db.accountIdentity.updateMany({ where: { accountId: test.account.id, provider: 'github' },
                        data: { eligibilityNextCheckAt: new Date(0) } });
                    wakeEligibilityDue = true;
                }
                return publisherVisible ? [publisher] : [];
            }
            return room === `rpc:${test.account.id}:${wakeMethod}` || room === controllerSocket.id ? [controllerSocket]
                : room === `rpc:${test.account.id}:${guestMethod}` || room === guestSocket.id ? [guestSocket] : [];
        });
        const caller = createFakeSocket({ id: 'finite-original-caller', data: { authAuthority: 'present_user' } });
        qualifyCurrentAccountStoredContentSocket(caller);
        registerSocketRpcHandlers({ userId: test.account.id, socket: caller as unknown as Socket, io, sessionPublisherPresence: presence });
        const resolveSource = (input: Readonly<{ accountId: string; sessionId: string }>) =>
            resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler); enableAuthentication(app);
        app.decorate('resolveCurrentSessionPublisher', (input: Readonly<{ accountId: string; sessionId: string }>) =>
            resolveCurrentSessionPublisherFromServer({ io, presence, ...input }));
        app.decorate('resolveCurrentSessionMachine', resolveSource);
        registerExternalActionRoutes(app, { dispatch: async () => { throw new Error('Mint must not execute'); } });
        await app.ready();
        let restoreFetch: (() => void) | undefined;
        try {
            const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
                caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 }, sourceTurnId: 'original-socket-turn',
                callerPermissionMode: 'yolo', causalPermissionAuthority: null, requestId: test.requestId });
            const envelope = { v: 1 as const, requestId: test.requestId,
                target: { kind: 'machine' as const, machineId: test.guest.id }, input: original };
            const source = { machineId: test.controller.id, installationId: test.controller.installationId! };
            const installationProof = signMachineInstallationProof({ privateKey: test.controllerKeys.secretKey,
                payload: { version: 1, accountId: test.account.id, ...source, externalActionOrigin: { homeId,
                    actionId: 'projects.script.run', requestId: test.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
            const token = await auth.createToken(test.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const minted = await app.inject({ method: 'POST', url: '/v1/actions/projects.script.run/execution-authorization',
                headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}` },
                payload: { v: 1, machineId: test.guest.id, envelope, sessionActionOrigin: origin,
                    sessionActionSource: source, installationProof } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            if (!root.managedFiniteWake) throw new Error('Real Home must prove the current controller custody recipient');
            carrier = ExternalActionExecutionAuthorizationV1Schema.parse({ ...root,
                requesterAccountContext: { kind: 'installation_sealed_v1', installationId: root.binding.installationId, ciphertext: 'guest_box' },
                managedFiniteWake: { ...root.managedFiniteWake, requesterAccountContext: {
                    kind: 'installation_sealed_v1', installationId: root.managedFiniteWake.target.controller.installationId,
                    ciphertext: 'controller_box' } } });
            expect(await auth.verifyExternalActionExecutionAuthorization(carrier.token)).toEqual(root.binding);
            const providerLogin = `finite-socket-${disposition === 'current' ? 'steady' : 'retired'}`;
            await db.accountIdentity.create({ data: { accountId: test.account.id, provider: 'github',
                providerUserId: test.account.id, providerLogin, profile: {},
                token: encryptString(['user', test.account.id, 'github', 'token'], 'github-oauth-boundary-token') } });
            applyEnvValues({ AUTH_REQUIRED_LOGIN_PROVIDERS: 'github', AUTH_GITHUB_ALLOWED_USERS: '',
                AUTH_GITHUB_ALLOWED_ORGS: 'finite-requesters', AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: 'oauth_user_token',
                AUTH_OFFBOARDING_ENABLED: 'true' });
            // Retire only at the demonstrably due wake eligibility boundary,
            // after the real original RPC/source verification has succeeded.
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
                expect(String(url)).toBe(`https://api.github.com/orgs/finite-requesters/members/${providerLogin}`);
                if (!initialEligibilityReached) initialEligibilityReached = true;
                else {
                    expect(wakeEligibilityDue).toBe(true);
                    wakeEligibilityReached = true;
                    if (disposition === 'publisher-during-eligibility') publisherVisible = false;
                }
                return new Response(null, { status: 204 });
            });
            restoreFetch = () => fetchSpy.mockRestore();
            const execution = { v: 1 as const, authorization: carrier, effectActionId: 'projects.script.run',
                target: carrier.binding.target, installationId: test.guest.installationId!,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: carrier.token,
                    effectActionId: 'projects.script.run', target: carrier.binding.target,
                    installationId: test.guest.installationId!, requestId: test.requestId, method: guestMethod,
                    params: original, privateKey: test.controllerKeys.secretKey }),
            };
            let response: unknown;
            await getSocketHandler(caller, SOCKET_RPC_EVENTS.CALL)({ method: guestMethod, requestId: test.requestId,
                params: original, externalActionExecution: execution }, (value: unknown) => { response = value; });
            if (boundaryErrors.length > 0) throw boundaryErrors[0];
            expect(wakeEligibilityDue).toBe(true);
            expect(wakeEligibilityReached).toBe(true);
            if (disposition === 'current') {
                expect(response).toEqual({ ok: true, result: { completed: true } });
                expect(methods).toEqual([wakeMethod, guestMethod]);
                expect(carrier.binding).toEqual(root.binding);
            } else {
                expect(await resolveSource({ accountId: test.account.id, sessionId: session.id })).toBeNull();
                expect(response).toMatchObject({ ok: false });
                expect(methods).toEqual([]);
                expect((await db.machine.findUniqueOrThrow({ where: { id: test.guest.id } })).active).toBe(false);
                expect((await db.account.findUniqueOrThrow({ where: { id: test.account.id } })).tokenEpoch).toBe(test.account.tokenEpoch);
                expect(await db.accessKey.findUnique({ where: { accountId_machineId_sessionId: {
                    accountId: test.account.id, machineId: test.controller.id, sessionId: session.id } } })).not.toBeNull();
                expect((await db.machine.findUniqueOrThrow({ where: { id: test.controller.id } })).installationId).toBe(test.controller.installationId);
            }
        } finally { restoreFetch?.(); restoreEnv(envBefore); await app.close(); }
    });
});
