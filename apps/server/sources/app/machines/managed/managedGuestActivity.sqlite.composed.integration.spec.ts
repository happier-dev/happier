import { readManagedAdmissionState } from '@/app/machines/managed/managedRows';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import type { Socket, Server } from 'socket.io';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { API_TOKEN_FULL_GRANT_V1, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent,
    sealEncryptedDataKeyEnvelopeV1, openEncryptedDataKeyEnvelopeV1, computeContentPublicKeyFingerprint } from '@happier-dev/protocol';
import { signExternalActionMachineRpcRequestV1, signExternalActionMachineRequestV1,
    computeExternalActionRequestEnvelopeDigestV1,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    encodeExternalActionResolvedTargetV1 } from '@happier-dev/protocol/actions';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionDaemonDispatchRequestSchema, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { auth } from '@/app/auth/auth';
import { verifyExternalActionMachineRpcExecution } from '@/app/auth/externalActionExecutionAuthorization';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { setMachineAccessGrantInTx, readMachineRecipientCensusInTx, commitMachineRecipientKeyEnvelopesInTx } from '@/app/machines/machineAccess';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '@/app/api/testkit/socketHarness';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { currentAccountStoredContentCompatibilityHeaders, qualifyCurrentAccountStoredContentSocket } from '@/app/api/testkit/accountStoredContentCompatibility';
import type { Fastify as ServerFastify } from '@/app/api/types';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { encrypt, decrypt } from '../../../../../cli/src/api/encryption';

describe('external after-idle retained guest authority (real SQLite)', () => {
    let harness: LightSqliteHarness;
    const homeId = `srv_${'d'.repeat(32)}`;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-guest-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function setup(kind: 'account' | 'pat', actionId: 'machines.managed.power.set' | 'machines.managed.delete', mode: 'plain' | 'e2ee' = 'plain', grantGuest = true, requesterGuest = false,
        accountExecutor?: 'guest' | 'daemon') {
        const ownerContent = tweetnacl.box.keyPair();
        const requesterContent = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(ownerContent.publicKey) : {}) } });
        const requester = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(requesterContent.publicKey) : {}) } });
        const dataKey = tweetnacl.randomBytes(32);
        const ownerEnvelope = sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: ownerContent.publicKey, randomBytes: tweetnacl.randomBytes });
        const keys = tweetnacl.sign.keyPair();
        const guestKeys = tweetnacl.sign.keyPair();
        const createMachine = (publicKey: Uint8Array, guest = false) => db.machine.create({ data: {
            id: randomUUID(), accountId: guest && requesterGuest ? requester.id : owner.id, installationId: randomUUID(), active: true,
            installationPublicKey: publicKey,
            metadata: mode === 'plain' ? encodePlainMachineStoredContent({ host: 'managed', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }) : 'encrypted-metadata',
            dataEncryptionKey: mode === 'plain' ? new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'))
                : new Uint8Array(guest && requesterGuest ? sealEncryptedDataKeyEnvelopeV1({ dataKey,
                    recipientPublicKey: requesterContent.publicKey, randomBytes: tweetnacl.randomBytes }) : ownerEnvelope),
        } });
        const controller = await createMachine(keys.publicKey);
        const guest = await createMachine(guestKeys.publicKey, true);
        for (const machine of accountExecutor ? [] : grantGuest ? [controller, guest] : [controller]) {
            await inTx(tx => setMachineAccessGrantInTx(tx, {
                actorAccountId: owner.id, machineId: machine.id, principal: { kind: 'account', accountId: requester.id }, level: 'admin' }));
            if (mode === 'e2ee') {
                const census = await inTx(tx => readMachineRecipientCensusInTx(tx, { actorAccountId: owner.id, machineId: machine.id }));
                if ('kind' in census) throw new Error(census.code);
                await inTx(tx => commitMachineRecipientKeyEnvelopesInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
                    expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!, expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!,
                    expectedMetadataVersion: census.content.metadataVersion, expectedDaemonStateVersion: census.content.daemonStateVersion,
                    recipientKeyEnvelopes: [{ recipientAccountId: requester.id,
                        encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: requesterContent.publicKey, randomBytes: tweetnacl.randomBytes })).toString('base64'),
                        recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(requesterContent.publicKey) }] }));
            }
        }
        const requestId = randomUUID();
        const intent = actionId === 'machines.managed.delete' ? 'delete' as const : 'stop' as const;
        const row = await db.managedMachine.create({ data: {
            homeId, custodianAccountId: owner.id, controllerMachineId: accountExecutor ? null : controller.id,
            controllerInstallationId: accountExecutor ? null : controller.installationId!,
            enrolledMachineId: guest.id, admittedActionRequestId: randomUUID(), allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            desired: intent, desiredWhen: 'after-idle', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            admittedInput: {},
        } });
        const controlInput = { homeId, managedId: row.id, when: 'after-idle', intent,
            ...(actionId === 'machines.managed.delete' ? { reviewedDependencies: true } : {}) };
        await db.managedMachine.update({ where: { id: row.id }, data: { admittedInput: { currentAdmission: { kind: 'control',
            request: { action: actionId, requestId, input: controlInput } } } } });
        const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] },
            targets: { sessions: [], machines: [controller.id] } };
        const pat = kind === 'pat' ? await auth.createApiToken({ accountId: requester.id, tokenId: randomUUID(), label: 'Managed effect', grant }) : null;
        const actor = accountExecutor ? owner : requester;
        const signer = accountExecutor === 'guest' ? guest : controller;
        const signerKeys = accountExecutor === 'guest' ? guestKeys : keys;
        const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId: actor.id,
            ...(pat ? { principalId: requester.id, credentialId: pat.tokenId, grant }
                : { authentication: { kind: 'account' as const, tokenEpoch: actor.tokenEpoch } }),
            serverIdentityId: homeId, machineId: signer.id, actionId, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId,
                target: { kind: 'machine', machineId: signer.id }, input: controlInput }),
            target: { kind: 'machine', machineId: signer.id } }, { input: controlInput });
        const managedTarget = { homeId, managedId: row.id, expectedRevision: row.intentRevision,
            ...(!accountExecutor ? { controller: { machineId: controller.id, installationId: controller.installationId! } } : {}) };
        const rpc = (rpcMethod: string, params: unknown = managedTarget, destination = guest.id) => {
            const method = `${destination}:${rpcMethod}`;
            const requestId = randomUUID();
            const execution = { v: 1 as const, authorization, effectActionId: actionId, target: authorization.binding.target,
                installationId: signer.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({
                    authorizationToken: authorization.token, effectActionId: actionId, target: authorization.binding.target,
                    installationId: signer.installationId!, method, requestId, params, event: SOCKET_RPC_EVENTS.CALL, privateKey: signerKeys.secretKey }) };
            return { method, requestId, params, execution };
        };
        return { owner, requester, controller, guest, row, keys, guestKeys, authorization, managedTarget, rpc, pat, grant, actionId,
            ownerContent, requesterContent, dataKey };
    }

    it.each([
        ['guest', 'machines.managed.power.set'], ['daemon', 'machines.managed.power.set'],
        ['guest', 'machines.managed.delete'], ['daemon', 'machines.managed.delete'],
    ] as const)('uses the actual admitted Account %s signer for exact %s after-idle activity and drain', async (executor, actionId) => {
        const test = await setup('account', actionId, 'plain', false, false, executor);
        expect(test.authorization.binding).toMatchObject({
            managedAdmission: { actionId, input: { homeId, managedId: test.row.id, when: 'after-idle' } },
            managedAccountExecutor: { enrolledMachineId: test.guest.id },
        });
        const verify = async (method: string, params: unknown = test.managedTarget) => {
            const request = test.rpc(method, params);
            return verifyExternalActionMachineRpcExecution(request.execution, {
                method: request.method, requestId: request.requestId, params: request.params, event: SOCKET_RPC_EVENTS.CALL,
            });
        };
        expect(await verify(MANAGED_ACTIVITY_READ_RPC_METHOD)).toMatchObject({ managedGuestActivity: {
            machineId: test.guest.id, installationId: test.guest.installationId, encryptionMode: 'plain' } });
        expect(await verify(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...test.managedTarget, action: 'begin' }))
            .toMatchObject({ managedGuestActivity: { machineId: test.guest.id } });
        expect(await verify(MANAGED_ACTIVITY_READ_RPC_METHOD, { ...test.managedTarget, expectedRevision: 0 })).toBeNull();
        expect(await verify(MANAGED_ACTIVITY_READ_RPC_METHOD, { ...test.managedTarget,
            controller: { machineId: test.controller.id, installationId: test.controller.installationId } })).toBeNull();
        await db.managedMachine.update({ where: { id: test.row.id }, data: { intentRevision: 2 } });
        expect(await verify(MANAGED_ACTIVITY_READ_RPC_METHOD)).toBeNull();
    });

    it('refuses an Account root on a foreign null row or a replaced control intent/request', async () => {
        const test = await setup('account', 'machines.managed.power.set', 'plain', false, false, 'daemon');
        const foreign = await setup('account', 'machines.managed.power.set', 'plain', false, false, 'guest');
        // Same custodian and request correlation isolate the exact signed row/guest binding.
        const foreignStored = await db.managedMachine.findUniqueOrThrow({ where: { id: foreign.row.id } });
        const foreignState = readManagedAdmissionState(foreignStored.admittedInput);
        if (foreignState.currentAdmission?.kind !== 'control') throw new Error('Missing foreign control fixture');
        await db.machine.update({ where: { id: foreign.guest.id }, data: { accountId: test.owner.id } });
        await db.managedMachine.update({ where: { id: foreign.row.id }, data: { custodianAccountId: test.owner.id,
            admittedInput: { ...foreignState, currentAdmission: { ...foreignState.currentAdmission,
                request: { ...foreignState.currentAdmission.request, requestId: test.authorization.binding.requestId } } } } });
        const verify = async (method: string, target = test.managedTarget, destination = test.guest.id) => {
            const request = test.rpc(method, method === MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD ? { ...target, action: 'begin' } : target, destination);
            return verifyExternalActionMachineRpcExecution(request.execution, {
                method: request.method, requestId: request.requestId, params: request.params, event: SOCKET_RPC_EVENTS.CALL,
            });
        };
        const methods = [MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD];
        for (const method of methods) expect(await verify(method, foreign.managedTarget, foreign.guest.id)).toBeNull();
        const stored = await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } });
        const state = readManagedAdmissionState(stored.admittedInput);
        if (state.currentAdmission?.kind !== 'control' || state.currentAdmission.request.action !== 'machines.managed.power.set') {
            throw new Error('Missing power control fixture');
        }
        const admission = state.currentAdmission;
        for (const request of [
            { ...admission.request, input: { ...admission.request.input, intent: 'suspend' } },
            { ...admission.request, requestId: randomUUID() },
        ]) {
            await db.managedMachine.update({ where: { id: test.row.id }, data: {
                admittedInput: { ...state, currentAdmission: { ...admission, request } } } });
            for (const method of methods) expect(await verify(method)).toBeNull();
        }
        await db.managedMachine.update({ where: { id: test.row.id }, data: { admittedInput: state } });
        for (const method of methods) expect(await verify(method)).toMatchObject({ managedGuestActivity: { machineId: test.guest.id } });
    });

    it.each([1, 2] as const)('issues the same admitted Account executor through the V%s HTTP root', async version => {
        const test = await setup('account', 'machines.managed.power.set', version === 1 ? 'plain' : 'e2ee', false, false, 'daemon');
        const row = await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } });
        const admission = readManagedAdmissionState(row.admittedInput).currentAdmission;
        if (admission?.kind !== 'control') throw new Error('Missing control fixture');
        await db.machine.update({ where: { id: test.controller.id }, data: { lastActiveAt: new Date() } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); registerExternalActionRoutes(app); await app.ready();
        try {
            const token = await auth.createToken(test.owner.id, undefined, { kind: 'account', authority: 'present_user' });
            const envelope = { v: version, requestId: test.authorization.binding.requestId, target: test.authorization.binding.target,
                ...(version === 1 ? { input: admission.request.input } : { payload: { t: 'encrypted', c: 'opaque-fixture-content' },
                    managedAdmission: { actionId: test.actionId, input: admission.request.input } }) };
            const response = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(test.actionId),
                headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}` },
                payload: { v: 1, machineId: test.controller.id, envelope } });
            expect(response.statusCode, response.body).toBe(200);
            expect(ExternalActionExecutionAuthorizationV1Schema.parse(response.json()).binding).toMatchObject({
                managedAdmission: { actionId: test.actionId, input: admission.request.input },
                managedAccountExecutor: { enrolledMachineId: test.guest.id },
            });
        } finally { await app.close(); }
    });

    it.each([1, 2] as const)('retains the Account control proof through unsigned V%s direct HTTP dispatch', async version => {
        const test = await setup('account', 'machines.managed.power.set', version === 1 ? 'plain' : 'e2ee', false, false, 'daemon');
        const row = await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } });
        const admission = readManagedAdmissionState(row.admittedInput).currentAdmission;
        if (admission?.kind !== 'control') throw new Error('Missing control fixture');
        await db.machine.update({ where: { id: test.controller.id }, data: { lastActiveAt: new Date(),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        const delivery: { authorization?: ExternalActionExecutionAuthorizationV1 } = {};
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler); enableAuthentication(app);
        registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io: {} as Server,
            // Only socket delivery is substituted; HTTP, custody, placement and mint stay real.
            forwardRpc: async ({ callParams }) => {
                delivery.authorization = ExternalActionDaemonDispatchRequestSchema.parse(callParams).executionAuthorization;
                return { ok: false, error: 'fixture_transport_unavailable' };
            } }) });
        await app.ready();
        try {
            const token = await auth.createToken(test.owner.id, undefined, { kind: 'account', authority: 'present_user' });
            await app.inject({ method: 'POST', url: `/v1/actions/${test.actionId}`,
                headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}` },
                payload: { v: version, requestId: test.authorization.binding.requestId, target: test.authorization.binding.target,
                    ...(version === 1 ? { input: admission.request.input } : { payload: { t: 'encrypted', c: 'opaque-fixture-content' },
                        managedAdmission: { actionId: test.actionId, input: admission.request.input } }) } });
            expect(delivery.authorization?.binding).toMatchObject({
                managedAdmission: { actionId: test.actionId, input: admission.request.input },
                managedAccountExecutor: { enrolledMachineId: test.guest.id },
            });
        } finally { await app.close(); }
    });

    it('refuses to qualify a shared Account daemon as the private managed executor', async () => {
        const test = await setup('account', 'machines.managed.power.set', 'plain', false, false, 'daemon');
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.owner.id, machineId: test.controller.id,
            principal: { kind: 'account', accountId: test.requester.id }, level: 'admin' }));
        const row = await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } });
        const admission = readManagedAdmissionState(row.admittedInput).currentAdmission;
        if (admission?.kind !== 'control') throw new Error('Missing control fixture');
        const result = await auth.mintExternalActionExecutionAuthorization(test.authorization.binding,
            { input: admission.request.input }).then(() => 'minted', error => error.code);
        expect(result).toBe('credential_scope_denied');
    });

    it.each(['plain', 'e2ee'] as const)('observes and drains a retained %s guest with controller Manage alone', async mode => {
        const test = await setup('account', 'machines.managed.power.set', mode, false);
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); machinesRoutes(app); await app.ready();
        try {
            const path = `/v1/machines/${test.guest.id}`;
            const headers = {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: test.authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: test.actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(test.authorization.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: test.authorization.token, effectActionId: test.actionId, target: test.authorization.binding.target,
                    installationId: test.controller.installationId!, requestId: test.authorization.binding.requestId,
                    method: 'GET', path, privateKey: test.keys.secretKey }),
            };
            const response = await app.inject({ method: 'GET', url: path, headers });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().machine).toMatchObject({ id: test.guest.id, installationId: test.guest.installationId });
            for (const method of [MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD]) {
                const request = test.rpc(method, { ...test.managedTarget, ...(method === MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD ? { action: 'begin' } : {}) });
                expect(await verifyExternalActionMachineRpcExecution(request.execution, request)).toMatchObject({
                    principal: { accountId: test.requester.id },
                    managedGuestActivity: { machineId: test.guest.id, installationId: test.guest.installationId },
                });
            }
            // The bridge is scoped to the retained control, not ordinary guest access.
            const requesterToken = await auth.createToken(test.requester.id, undefined, { kind: 'account', authority: 'present_user' });
            expect((await app.inject({ method: 'GET', url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${requesterToken}`,
            } })).statusCode).not.toBe(200);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.owner.id, machineId: test.controller.id,
                principal: { kind: 'account', accountId: test.requester.id }, level: 'view' }));
            expect((await app.inject({ method: 'GET', url: path, headers })).statusCode).not.toBe(200);
            const request = test.rpc(MANAGED_ACTIVITY_READ_RPC_METHOD);
            expect(await verifyExternalActionMachineRpcExecution(request.execution, request)).toBeNull();
        } finally { await app.close(); }
    });

    it('publishes the custodian encrypted guest envelope only to the proved controller, retaining requester admission', async () => {
        const test = await setup('account', 'machines.managed.power.set', 'e2ee');
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); machinesRoutes(app); await app.ready();
        try {
            const path = `/v1/machines/${test.guest.id}`;
            const headers = {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: test.authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: test.actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(test.authorization.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: test.authorization.token, effectActionId: test.actionId, target: test.authorization.binding.target,
                    installationId: test.controller.installationId!, requestId: test.authorization.binding.requestId,
                    method: 'GET', path, privateKey: test.keys.secretKey }),
            };
            const response = await app.inject({ method: 'GET', url: path, headers });
            expect(response.statusCode, response.body).toBe(200);
            const published = response.json().machine;
            const envelope = new Uint8Array(Buffer.from(published.dataEncryptionKey, 'base64'));
            expect(openEncryptedDataKeyEnvelopeV1({ envelope, recipientSecretKeyOrSeed: test.ownerContent.secretKey })).toEqual(test.dataKey);
            expect(openEncryptedDataKeyEnvelopeV1({ envelope, recipientSecretKeyOrSeed: test.requesterContent.secretKey })).toBeNull();
            const ciphertext = await socketRpcCodec.encodeParams({ mode: 'e2ee', cipher: {
                encryptRaw: async value => Buffer.from(encrypt(test.dataKey, 'dataKey', value)).toString('base64'),
                decryptRaw: async value => decrypt(test.dataKey, 'dataKey', new Uint8Array(Buffer.from(value, 'base64'))),
            } }, test.managedTarget, { method: `${test.guest.id}:${MANAGED_ACTIVITY_READ_RPC_METHOD}`, callId: 'a'.repeat(32) });
            const encryptedRead = test.rpc(MANAGED_ACTIVITY_READ_RPC_METHOD, ciphertext);
            expect(await verifyExternalActionMachineRpcExecution(encryptedRead.execution, encryptedRead)).toMatchObject({
                principal: { accountId: test.requester.id },
                managedGuestActivity: { machineId: test.guest.id, installationId: test.guest.installationId },
            });
            const forged = await app.inject({ method: 'GET', url: path, headers: { ...headers,
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: test.authorization.token, effectActionId: test.actionId, target: test.authorization.binding.target,
                    installationId: test.controller.installationId!, requestId: test.authorization.binding.requestId,
                    method: 'GET', path, privateKey: test.guestKeys.secretKey }) } });
            expect(forged.statusCode).not.toBe(200);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.owner.id, machineId: test.guest.id,
                principal: { kind: 'account', accountId: test.requester.id }, level: 'view' }));
            expect((await app.inject({ method: 'GET', url: path, headers })).statusCode).toBe(200);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.owner.id, machineId: test.controller.id,
                principal: { kind: 'account', accountId: test.requester.id }, level: 'view' }));
            expect((await app.inject({ method: 'GET', url: path, headers })).statusCode).not.toBe(200);
            expect(await verifyExternalActionMachineRpcExecution(encryptedRead.execution, encryptedRead)).toBeNull();
        } finally { await app.close(); }
    });

    it.each(['account', 'pat'] as const)('uses only the original %s control for signed retained guest metadata/read/drain', async kind => {
        const test = await setup(kind, kind === 'pat' ? 'machines.managed.delete' : 'machines.managed.power.set', 'plain', false);
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); machinesRoutes(app); await app.ready();
        try {
            const path = `/v1/machines/${test.guest.id}`;
            const response = await app.inject({ method: 'GET', url: path, headers: {
                ...currentAccountStoredContentCompatibilityHeaders,
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: test.authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: test.actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(test.authorization.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: test.authorization.token, effectActionId: test.actionId, target: test.authorization.binding.target,
                    installationId: test.controller.installationId!, requestId: test.authorization.binding.requestId,
                    method: 'GET', path, privateKey: test.keys.secretKey }),
            } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().machine).toMatchObject({ id: test.guest.id, installationId: test.guest.installationId });
        } finally { await app.close(); }
        for (const method of [MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD]) {
            const request = test.rpc(method, { ...test.managedTarget, ...(method === MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD ? { action: 'begin' } : {}) });
            expect(await verifyExternalActionMachineRpcExecution(request.execution, request)).toMatchObject({
                binding: test.authorization.binding, principal: { accountId: test.requester.id } });
        }
        for (const params of [{ ...test.managedTarget, expectedRevision: 0 },
            { ...test.managedTarget, managedId: randomUUID() },
            { ...test.managedTarget, controller: { ...test.managedTarget.controller, installationId: randomUUID() } }]) {
            const request = test.rpc(MANAGED_ACTIVITY_READ_RPC_METHOD, params);
            expect(await verifyExternalActionMachineRpcExecution(request.execution, request)).toBeNull();
        }
        const unrelated = test.rpc(MANAGED_ACTIVITY_READ_RPC_METHOD, test.managedTarget, test.controller.id);
        expect(await verifyExternalActionMachineRpcExecution(unrelated.execution, unrelated)).toBeNull();
        const wrongEffect = test.rpc('machines.managed.get');
        expect(await verifyExternalActionMachineRpcExecution(wrongEffect.execution, wrongEffect)).toBeNull();
        const wrongRoot = test.rpc(MANAGED_ACTIVITY_READ_RPC_METHOD);
        expect(await verifyExternalActionMachineRpcExecution({ ...wrongRoot.execution, authorization: { ...test.authorization,
            binding: { ...test.authorization.binding, requestId: randomUUID() } } }, wrongRoot)).toBeNull();
        expect(await verifyExternalActionMachineRpcExecution({ ...wrongRoot.execution,
            machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: test.authorization.token,
                effectActionId: test.actionId, target: test.authorization.binding.target, installationId: test.controller.installationId!,
                method: wrongRoot.method, requestId: wrongRoot.requestId, params: wrongRoot.params, event: SOCKET_RPC_EVENTS.CALL,
                privateKey: test.guestKeys.secretKey }) }, wrongRoot)).toBeNull();
        if (test.pat) await auth.updateApiToken({ accountId: test.requester.id, tokenId: test.pat.tokenId,
            grant: { ...test.grant, actions: { families: [], ids: ['machines.managed.get'] } } });
        else await db.account.update({ where: { id: test.requester.id }, data: { tokenEpoch: { increment: 1 } } });
        expect(await verifyExternalActionMachineRpcExecution(wrongRoot.execution, wrongRoot)).toBeNull();
    });

    it('forwards busy then idle and reversible drain from the signed controller, retiring before guest IO on access loss', async () => {
        const test = await setup('account', 'machines.managed.power.set');
        let idle = false;
        const effect = vi.fn(async (_event: string, payload: { machineAdmission: unknown; params: { action?: string } }) => {
            expect(payload.machineAdmission).toMatchObject({ actorAccountId: test.requester.id, machineId: test.guest.id,
                installationId: test.guest.installationId, role: 'manage' });
            return idle ? { kind: 'idle', since: 1 } : { kind: 'busy', reasons: ['finite'] };
        });
        const target = { id: randomUUID(), data: { clientType: 'machine-scoped', userId: test.owner.id,
            machineId: test.guest.id, verifiedMachineInstallationId: test.guest.installationId }, timeout: () => ({ emitWithAck: effect }) };
        qualifyCurrentAccountStoredContentSocket(target);
        let retire = false;
        const io = createSocketRoomDiscoveryHarness(async room => {
            if (retire) { retire = false; await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.owner.id,
                machineId: test.controller.id, principal: { kind: 'account', accountId: test.requester.id }, level: 'view' })); }
            return room === target.id || room.startsWith(`rpc:${test.owner.id}:${test.guest.id}:`) ? [target] : [];
        });
        const caller = createAuthenticatedFakeSocket({ data: { clientType: 'user-scoped' } });
        qualifyCurrentAccountStoredContentSocket(caller);
        registerSocketRpcHandlers({ userId: test.owner.id, socket: caller as unknown as Socket, io });
        const call = async (method: string, action?: 'begin' | 'resume') => {
            const request = test.rpc(method, { ...test.managedTarget, ...(action ? { action } : {}) });
            const callback = vi.fn();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { ...request, externalActionExecution: request.execution }, callback);
            return callback.mock.calls[0]?.[0];
        };
        const busy = await call(MANAGED_ACTIVITY_READ_RPC_METHOD);
        expect(busy, JSON.stringify(busy)).toMatchObject({ ok: true, result: { kind: 'busy' } });
        idle = true;
        expect(await call(MANAGED_ACTIVITY_READ_RPC_METHOD)).toMatchObject({ ok: true, result: { kind: 'idle' } });
        expect(await call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, 'begin')).toMatchObject({ ok: true });
        expect(await call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, 'resume')).toMatchObject({ ok: true });
        effect.mockClear(); retire = true;
        expect(await call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, 'begin')).toMatchObject({ ok: false });
        expect(effect).not.toHaveBeenCalled();
    });
});
