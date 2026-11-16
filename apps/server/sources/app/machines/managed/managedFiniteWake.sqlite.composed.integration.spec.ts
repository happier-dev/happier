import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodeBase64, encodePlainMachineStoredContent,
    API_TOKEN_FULL_GRANT_V1,
    PluginManifestV2Schema, ManagedPolicyAdmissionInputV1Schema, ManagedPolicyAdmissionOutputV1Schema,
    ManagedResourceV1Schema, createManagedPolicyProofV1, createManagedPolicyCensusProofV1, encodeManagedPolicyProofV1, MANAGED_POLICY_PROOF_HEADER,
    ExternalActionExecutionAuthorizationV1Schema,
    ActionIdSchema, createActionExecutor, getActionSpec, normalizeActionsSettingsV1,
    type ActionExecutorDeps,
    type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol';
import { auth } from '@/app/auth/auth';
import { db, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { setEligibleMachineAccessGrantInTx as setMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { assertManagedWakeOriginCurrentInTx, prepareManagedFiniteActionWake, readCurrentManagedFiniteWakeCustodyInTx, readManagedWakeTargets, resolveManagedWakeTargetInTx } from './managedWake';
import { projectManagedMachine } from './managedRows';
import { createExternalActionDaemonDispatcher, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    resolveCurrentSessionMachineFromServer, resolveCurrentSessionPublisherFromServer } from '@/app/api/socket/externalActionDispatcher';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { createExternalActionDaemonDispatchResponseV1, prepareExternalActionResponseEnvelopeV1,
    computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import { ExternalActionDaemonDispatchRequestSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { MANAGED_FINITE_WAKE_RPC_METHOD, ManagedFiniteWakeRequestV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { SOCKET_RPC_EVENTS, SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { getAccountSessionSocketRoom } from '@/app/api/socketRooms';
import { applyEnvValues, restoreEnv, snapshotEnv } from '@/testkit/env';
import { encryptString, initEncrypt } from '@/modules/encrypt';
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
import { projectExternalActionBoundPrincipal, verifyCurrentExternalActionPrincipal, resolveExternalActionExecutionMachineAdmissionInTx } from '@/app/auth/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions';
import { bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions';
import { enqueuePendingMessage, listPendingMessages, updatePendingRequestedAction } from '@/app/session/pending/pendingMessageService';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createAuthenticatedTestApp, withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { PendingActivationHoldReasonV1Schema, ManagedPendingActivationFailureRequestV1Schema,
    PendingActivationAuthorizationV1Schema } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import { markPendingActivationAuthorizationFailedInTx, mapPendingActivationAuthorization } from '@/app/session/pending/pendingActivationAuthorization';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { measure } from './managedProjectionVolume.testkit';
import { eventRouter } from '@/app/events/eventRouter';
import { emitPendingChanged } from '@/app/session/pending/publishPendingMutation';
import { SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { preparePlainAccountApiTokenLabel, prepareE2eeAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

describe('finite managed wake original Action authority (real storage)', () => {
    let harness: LightSqliteHarness | undefined;
    const homeId = `srv_${'f'.repeat(32)}`;
    const initialEnv = snapshotEnv();
    beforeAll(async () => {
        if (process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            if (process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error('Use only the disposable PostgreSQL DB-contract harness');
            }
            Object.assign(process.env, { HAPPIER_SERVER_IDENTITY_ID: homeId, HANDY_MASTER_SECRET: randomUUID() });
            initDbPostgres();
            await db.$connect();
            await auth.init();
            await initEncrypt();
        } else {
            harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-finite-wake-', initAuth: true, initEncrypt: true,
                env: { HAPPIER_SERVER_IDENTITY_ID: homeId } });
        }
    }, 120_000);
    afterAll(async () => {
        try { if (harness) await harness.close(); else await db.$disconnect(); }
        finally { restoreEnv(initialEnv); }
    });

    async function setup() {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controllerKeys = tweetnacl.sign.keyPair();
        const guestKeys = tweetnacl.sign.keyPair();
        const machine = (active: boolean) => db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, installationId: randomUUID(), active,
            installationPublicKey: new Uint8Array(active ? controllerKeys.publicKey : guestKeys.publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'finite-wake', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/wake', happyHomeDir: '/home/wake/.happier' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
                projectFiniteExecution: { protocolVersions: [1] }, requesterExecutionIsolation: { protocolVersions: [1] } },
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

    it.each([false, true])('retains controller-free explicit Send independently of unattended wake choice (%s)', async wakeOnAcceptedMessage => {
        const test = await setup();
        await db.managedMachine.update({ where: { id: test.row.id }, data: {
            controllerMachineId: null, controllerInstallationId: null, wakeOnAcceptedMessage,
        } });
        await db.machine.update({ where: { id: test.guest.id }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
        } });
        const session = await db.session.create({ data: { accountId: test.account.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: false } });
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: test.account.id,
            sessionId: session.id, machineId: test.guest.id, data: 'private-key-ciphertext' }))).toMatchObject({ ok: true });
        const localId = randomUUID();
        const input = { actorUserId: test.account.id, authentication: createPresentUserSessionAccessAuthentication(),
            sessionId: session.id, localId, targetMachineId: test.guest.id,
            requestedAction: { v: 1, kind: 'send_now' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'kept on the original Session' } } } } as const;
        const envBefore = snapshotEnv();
        applyEnvValues({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
        try {
            expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
            const retained = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(mapPendingActivationAuthorization(retained)?.managedWakeTargetV1).toMatchObject({
                managedId: test.row.id, enrolledMachineId: test.guest.id,
                origin: { kind: 'session-input', session: { sessionId: session.id }, pendingRequestId: localId },
            });
            const request = { homeId, controller: { machineId: test.controller.id, installationId: test.controller.installationId! } };
            expect((await readManagedWakeTargets({ actorAccountId: test.account.id, request })).targets).toHaveLength(wakeOnAcceptedMessage ? 1 : 0);
            // A classified managed-row wake must discover accepted input through
            // the same exact census that supplies its current scheduling row.
            await withAuthenticatedTestApp(registerManagedMachineRoutes, async app => {
                const exact = await measure('exact-managed-wake', () => app.inject({ method: 'POST',
                    url: '/v1/machines/managed/controller/policies', headers: { 'x-test-user-id': test.account.id },
                    payload: { ...request, managedId: test.row.id,
                        proof: createManagedPolicyCensusProofV1({ ...request, custodianAccountId: test.account.id,
                            privateKey: test.controllerKeys.secretKey }) } }));
                expect(exact.value.statusCode, exact.value.body).toBe(200);
                expect(exact.value.json().machines.map((machine: { id: string }) => machine.id)).toEqual([test.row.id]);
                expect(exact.value.json().targets).toHaveLength(wakeOnAcceptedMessage ? 1 : 0);
                if (wakeOnAcceptedMessage) expect(exact.value.json().targets[0]).toMatchObject({
                    managedId: test.row.id, origin: { kind: 'session-input', pendingRequestId: localId },
                });
                expect(exact.queries.filter(query => query.model === 'managedMachine' && query.method === 'findMany')
                    .every(query => query.rows <= 1)).toBe(true);
            });
            expect(await listPendingMessages(input)).toMatchObject({ ok: true, pending: [{ localId,
                status: 'queued', deliveryState: null, content: input.content }] });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } }))
                .toMatchObject({ desired: 'stop', intentRevision: test.row.intentRevision });
            await db.managedMachine.update({ where: { id: test.row.id }, data: { wakeOnAcceptedMessage: false } });
            expect((await readManagedWakeTargets({ actorAccountId: test.account.id, request })).targets).toEqual([]);
            expect(await listPendingMessages(input)).toMatchObject({ ok: true, pending: [{ localId,
                status: 'queued', deliveryState: null, content: input.content }] });
        } finally { restoreEnv(envBefore); }
    });

    it('publishes accepted input to the installed controller after unused retention stops its guest', async () => {
        const test = await setup();
        await db.managedMachine.update({ where: { id: test.row.id }, data: {
            intentRevision: 7, retention: { kind: 'unused', afterMs: 60_000, effect: 'stop' },
        } });
        await db.machine.update({ where: { id: test.guest.id }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
        } });
        const session = await db.session.create({ data: { accountId: test.account.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: false } });
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: test.account.id,
            sessionId: session.id, machineId: test.guest.id, data: 'private-key-ciphertext' }))).toMatchObject({ ok: true });
        const input = { actorUserId: test.account.id, authentication: createPresentUserSessionAccessAuthentication(),
            sessionId: session.id, localId: randomUUID(), targetMachineId: test.guest.id,
            requestedAction: { v: 1, kind: 'enqueue' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'retained input' } } } } as const;
        const env = snapshotEnv();
        applyEnvValues({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
        // Outbound Socket.IO delivery is the boundary; admission and publication remain real.
        const emitted = vi.spyOn(eventRouter, 'emitUpdate').mockImplementation(() => {});
        try {
            expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
            const result = await updatePendingRequestedAction({ ...input, resumeWhenAvailable: true });
            expect(result).toMatchObject({ ok: true, didUpdate: true });
            if (!result.ok || !result.activationTarget) throw new Error('Expected armed activation');
            expect(await db.accountChange.findFirst({ where: { accountId: test.account.id,
                kind: 'account', entityId: test.row.id } })).toMatchObject({
                hint: { managedMachinePolicy: true, machineId: test.controller.id },
            });
            await emitPendingChanged({ sessionId: session.id, changedByAccountId: test.account.id,
                pendingCount: result.pendingCount, pendingVersion: result.pendingVersion,
                recipientCursors: result.recipientCursors, activationTarget: result.activationTarget });
            expect(emitted).toHaveBeenCalledWith(expect.objectContaining({
                recipientFilter: { type: 'machine-only', machineId: test.controller.id },
                payload: expect.objectContaining({ body: expect.objectContaining({ managedWakeTargetV1:
                    expect.objectContaining({ managedId: test.row.id, expectedIntentRevision: 7 }) }) }),
            }));
        } finally { emitted.mockRestore(); restoreEnv(env); }
    });

    it.each([false, true])('reads one current resource without fleet wake discovery (controller-free: %s)', async controllerFree => {
        const test = await setup();
        const controller = { machineId: test.controller.id, installationId: test.controller.installationId! };
        const ids = [test.row.id];
        for (let index = 0; index < 3; index += 1) {
            const other = await setup();
            await db.managedMachine.update({ where: { id: other.row.id }, data: { custodianAccountId: test.account.id,
                controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId } });
            ids.push(other.row.id);
        }
        if (controllerFree) await db.managedMachine.update({ where: { id: test.row.id }, data: {
            controllerMachineId: null, controllerInstallationId: null,
        } });
        await withAuthenticatedTestApp(registerManagedMachineRoutes, async app => {
            const read = (managedId?: string, accountId = test.account.id) => app.inject({ method: 'POST',
                url: '/v1/machines/managed/controller/policies', headers: { 'x-test-user-id': accountId },
                payload: { homeId, controller, ...(managedId ? { managedId } : {}),
                    proof: createManagedPolicyCensusProofV1({ homeId, controller, custodianAccountId: test.account.id,
                        privateKey: test.controllerKeys.secretKey }) } });
            const exact = await measure('exact-managed-currentness', () => read(test.row.id));
            expect(exact.value.statusCode, exact.value.body).toBe(200);
            expect(exact.value.json().machines.map((machine: { id: string }) => machine.id)).toEqual([test.row.id]);
            expect(exact.value.json().targets).toEqual([]);
            expect(exact.queries.filter(query => query.model === 'managedMachine' && query.method === 'findMany')
                .reduce((sum, query) => sum + query.rows, 0)).toBeLessThanOrEqual(2);
            if (!controllerFree) {
                const fleet = await measure('scheduler-managed-census', () => read());
                expect(fleet.value.statusCode, fleet.value.body).toBe(200);
                expect(fleet.value.json().machines.map((machine: { id: string }) => machine.id).sort()).toEqual(ids.sort());
                expect(fleet.queries.some(query => query.model === 'session')).toBe(true);
                expect(fleet.queries.some(query => query.model === 'automationRun')).toBe(true);
            }
            const stranger = await setup();
            expect((await read(test.row.id, stranger.account.id)).statusCode).toBe(403);
            for (const invalid of [
                { homeId: `srv_${'e'.repeat(32)}`, controller, privateKey: test.controllerKeys.secretKey, status: 403 },
                { homeId, controller: { ...controller, installationId: randomUUID() }, privateKey: test.controllerKeys.secretKey, status: 409 },
                { homeId, controller, privateKey: test.guestKeys.secretKey, status: 403 },
            ]) {
                const denied = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/policies',
                    headers: { 'x-test-user-id': test.account.id }, payload: { homeId: invalid.homeId,
                        controller: invalid.controller, managedId: test.row.id,
                        proof: createManagedPolicyCensusProofV1({ ...invalid, custodianAccountId: test.account.id }) } });
                expect(denied.statusCode, denied.body).toBe(invalid.status);
            }
            if (controllerFree) {
                await db.managedMachine.update({ where: { id: ids[1] }, data: {
                    controllerMachineId: null, controllerInstallationId: null,
                } });
                // A different retained guest is not the Account's private daemon
                // and cannot inspect this resource as its executor.
                const guestController = { machineId: test.guest.id, installationId: test.guest.installationId! };
                const wrongGuest = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/policies',
                    headers: { 'x-test-user-id': test.account.id }, payload: { homeId, controller: guestController, managedId: ids[1],
                        proof: createManagedPolicyCensusProofV1({ homeId, controller: guestController,
                            custodianAccountId: test.account.id, privateKey: test.guestKeys.secretKey }) } });
                expect(wrongGuest.statusCode, wrongGuest.body).toBe(200);
                expect(wrongGuest.json().machines).toEqual([]);
            }
        });
    });

    it.each([false, true])('lets the enrolled guest census read its controller-free Stop policy without acquiring another resource (exact: %s)', async exact => {
        const test = await setup();
        await db.managedMachine.update({ where: { id: test.row.id }, data: { controllerMachineId: null,
            controllerInstallationId: null, desired: 'start', retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' } } });
        const other = await setup();
        await db.managedMachine.update({ where: { id: other.row.id }, data: { custodianAccountId: test.account.id,
            controllerMachineId: null, controllerInstallationId: null } });
        await withAuthenticatedTestApp(registerManagedMachineRoutes, async app => {
            const controller = { machineId: test.guest.id, installationId: test.guest.installationId! };
            const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/policies',
                headers: { 'x-test-user-id': test.account.id }, payload: { homeId, controller,
                    ...(exact ? { managedId: test.row.id } : {}),
                    proof: createManagedPolicyCensusProofV1({ homeId, controller, custodianAccountId: test.account.id,
                        privateKey: test.guestKeys.secretKey }) } });
            expect(response.statusCode).toBe(200);
            expect(response.json().machines.map((machine: { id: string }) => machine.id)).toEqual([test.row.id]);
            expect(response.json().targets).toEqual([]);
        });
    });

    it.each([
        { power: 'stopped', reachable: false, wakeOnAcceptedMessage: true, arms: true },
        { power: 'running', reachable: true, wakeOnAcceptedMessage: true, arms: false },
        { power: 'running', reachable: false, wakeOnAcceptedMessage: true, arms: true },
        { power: 'stopped', reachable: false, wakeOnAcceptedMessage: false, arms: false },
    ] as const)('keeps collaborator input queued unless managed wake applies ($power, reachable=$reachable, wake=$wakeOnAcceptedMessage)', async ({ power, reachable, wakeOnAcceptedMessage, arms }) => {
        const test = await setup();
        await db.managedMachine.update({ where: { id: test.row.id }, data: { wakeOnAcceptedMessage,
            observation: { observedAt: 1, availability: 'present', power, storage: 'retained' },
        } });
        const managed = await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } });
        expect(managed.observation).toMatchObject({ availability: 'present', power });
        expect(projectManagedMachine(managed).submittedNativeEffect).toBeUndefined();
        const collaborator = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.machine.update({ where: { id: test.guest.id }, data: {
            active: reachable,
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
        } });
        const session = await db.session.create({ data: { accountId: test.account.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: false } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: test.account.id,
            accountId: collaborator.id, accessLevel: 'edit', canApprovePermissions: false } });
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: test.account.id,
            sessionId: session.id, machineId: test.guest.id, data: 'private-key-ciphertext' }))).toMatchObject({ ok: true });
        const localId = randomUUID();
        const input = { actorUserId: collaborator.id, authentication: createPresentUserSessionAccessAuthentication(),
            sessionId: session.id, localId, targetMachineId: test.guest.id,
            requestedAction: { v: 1, kind: 'send_now' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'collaborator accepted input' } } } } as const;
        const envBefore = snapshotEnv();
        applyEnvValues({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
        try {
            expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
            const retained = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(retained.pendingActivationRequestId).toBe(arms ? localId : null);
            if (arms) {
                expect(mapPendingActivationAuthorization(retained)?.managedWakeTargetV1).toMatchObject({
                    managedId: test.row.id, enrolledMachineId: test.guest.id,
                    origin: { kind: 'session-input', session: { sessionId: session.id }, pendingRequestId: localId },
                });
            }
            expect(await listPendingMessages(input)).toMatchObject({ ok: true, pending: [{ localId,
                status: 'queued', deliveryState: null, content: input.content }] });
            expect((await readManagedWakeTargets({ actorAccountId: test.account.id, request: { homeId,
                controller: { machineId: test.controller.id, installationId: test.controller.installationId! } } })).targets).toHaveLength(arms ? 1 : 0);
            if (arms) {
                await db.managedMachine.update({ where: { id: test.row.id }, data: {
                    observation: { observedAt: 2, availability: 'present', power: 'running', storage: 'retained' },
                } });
                await db.machine.update({ where: { id: test.guest.id }, data: { active: true } });
                expect((await readManagedWakeTargets({ actorAccountId: test.account.id, request: { homeId,
                    controller: { machineId: test.controller.id, installationId: test.controller.installationId! } } })).targets).toEqual([]);
                await db.managedMachine.update({ where: { id: test.row.id }, data: {
                    observation: { observedAt: 3, availability: 'present', power, storage: 'retained' },
                } });
                await db.machine.update({ where: { id: test.guest.id }, data: { active: reachable } });
            }
            expect(await updatePendingRequestedAction({ ...input, requestedAction: { v: 1, kind: 'enqueue' },
                resumeWhenAvailable: true })).toMatchObject({ ok: true });
            expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).pendingActivationRequestId)
                .toBe(arms ? localId : null);
            await expect(readManagedWakeTargets({ actorAccountId: collaborator.id, request: { homeId,
                controller: { machineId: test.controller.id, installationId: test.controller.installationId! } } }))
                .rejects.toMatchObject({ code: 'permission_denied' });
            const authored = await db.sessionPendingMessage.findUniqueOrThrow({ where: {
                sessionId_localId: { sessionId: session.id, localId },
            } });
            expect(authored.authorAccountId).toBe(collaborator.id);
            expect(authored.inputAdmissionReceipt).toMatchObject({ actorAccountId: collaborator.id,
                sessionRelationship: 'sharedEditor', admittedTarget: { accountId: test.account.id,
                    sessionId: session.id, machineId: test.guest.id } });

            const ordinaryGuest = await db.machine.create({ data: { id: randomUUID(), accountId: test.account.id,
                installationId: randomUUID(), metadata: test.guest.metadata, dataEncryptionKey: test.guest.dataEncryptionKey,
                operationProtocolCapabilitiesRevision: 1,
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } } } });
            const ordinarySession = await db.session.create({ data: { accountId: test.account.id,
                tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', active: false } });
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: ordinarySession.id, createdByAccountId: test.account.id,
                accountId: collaborator.id, accessLevel: 'edit', canApprovePermissions: false } });
            expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: test.account.id,
                sessionId: ordinarySession.id, machineId: ordinaryGuest.id, data: 'private-key-ciphertext' }))).toMatchObject({ ok: true });
            expect(await enqueuePendingMessage({ ...input, sessionId: ordinarySession.id,
                targetMachineId: ordinaryGuest.id, localId: randomUUID() })).toMatchObject({ ok: true });
            expect((await db.session.findUniqueOrThrow({ where: { id: ordinarySession.id } })).pendingActivationRequestId).toBeNull();
        } finally { restoreEnv(envBefore); }
    });

    it.each(['manage', 'use'] as const)('publishes accepted requester Pending activation to its foreign managed controller Account (guest %s)', async role => {
        const test = await setup();
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        // Use-only requesters can submit work to the guest without access to its controller.
        for (const machine of role === 'manage' ? [test.controller, test.guest] : [test.guest]) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: test.account.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id }, level: role === 'manage' ? 'admin' : 'view',
        }));
        await db.machine.update({ where: { id: test.guest.id }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
        } });
        const session = await db.session.create({ data: {
            accountId: requester.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', active: false,
        } });
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, {
            accountId: requester.id, sessionId: session.id, machineId: test.guest.id, data: 'private-key-ciphertext',
        }))).toMatchObject({ ok: true });
        const localId = randomUUID();
        const authentication = createPresentUserSessionAccessAuthentication();
        const input = { actorUserId: requester.id, authentication, sessionId: session.id, localId,
            targetMachineId: test.guest.id, requestedAction: { v: 1, kind: 'send_now' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'accepted wake' } } } } as const;
        const envBefore = snapshotEnv();
        applyEnvValues({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
        try {
            const enqueue = await enqueuePendingMessage(input);
            expect(enqueue, JSON.stringify(enqueue)).toMatchObject({ ok: true, activationTarget: {
                accountId: requester.id, managedControllerPublication: { accountId: test.account.id, cursor: expect.any(Number) },
            } });
            const reconnect = () => readManagedWakeTargets({ actorAccountId: test.account.id, request: { homeId,
                controller: { machineId: test.controller.id, installationId: test.controller.installationId! } } });
            expect((await reconnect()).targets).toMatchObject([{ managedId: test.row.id,
                origin: { kind: 'session-input', session: { sessionId: session.id } } }]);
            const target = (await reconnect()).targets[0]!;
            await expect(inTx(tx => assertManagedWakeOriginCurrentInTx(tx, { row: test.row, target })))
                .resolves.toBeUndefined();
            if (role === 'use') {
                expect(await inTx(tx => resolveManagedWakeTargetInTx(tx, { actorAccountId: requester.id,
                    machineId: test.guest.id, origin: test.target.origin }))).toBeUndefined();
            }
            expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
                accountId: test.account.id, kind: 'account', entityId: test.row.id,
            } } })).toMatchObject({ hint: { managedMachinePolicy: true, machineId: test.controller.id },
                cursor: enqueue.ok && 'activationTarget' in enqueue
                ? enqueue.activationTarget?.managedControllerPublication?.cursor : undefined });
            const replaced = await updatePendingRequestedAction({ actorUserId: requester.id, authentication,
                sessionId: session.id, localId, requestedAction: { v: 1, kind: 'enqueue' }, resumeWhenAvailable: true });
            expect(replaced).toMatchObject({ ok: true, didUpdate: true, activationTarget: {
                managedControllerPublication: { accountId: test.account.id, cursor: expect.any(Number) },
            } });
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.account.id, machineId: test.controller.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'view' }));
            // Owner withdrawal of automatic wake takes effect at the next admission.
            await db.managedMachine.update({ where: { id: test.row.id }, data: { wakeOnAcceptedMessage: false } });
            expect(await updatePendingRequestedAction({ actorUserId: requester.id, authentication,
                sessionId: session.id, localId, requestedAction: { v: 1, kind: 'send_now' } }))
                .toMatchObject({ ok: true, activationTarget: { accountId: requester.id } });
            const sessionAfter = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(sessionAfter.pendingActivationManagedTarget).toBeNull();
            expect((await reconnect()).targets).toEqual([]);
        } finally { restoreEnv(envBefore); }
    });

    it('retains a managed wake against ordinary runtime failure until compute is observed running', async () => {
        const test = await setup();
        await db.machine.update({ where: { id: test.guest.id }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
        } });
        const session = await db.session.create({ data: { accountId: test.account.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: false } });
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: test.account.id,
            sessionId: session.id, machineId: test.guest.id, data: 'private-key-ciphertext' }))).toMatchObject({ ok: true });
        const input = { actorUserId: test.account.id, authentication: createPresentUserSessionAccessAuthentication(),
            sessionId: session.id, localId: randomUUID(), targetMachineId: test.guest.id,
            requestedAction: { v: 1, kind: 'enqueue' }, content: { t: 'plain', v: {
                role: 'user', content: { type: 'text', text: 'retained original input' } } } } as const;
        const envBefore = snapshotEnv();
        applyEnvValues({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        sessionPendingRoutes(app); await app.ready();
        try {
            expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
            expect(await updatePendingRequestedAction({ ...input, resumeWhenAvailable: true })).toMatchObject({ ok: true });
            const armed = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            const queued = await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } });
            const token = await auth.createToken(test.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const report = () => app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/pending/activation/fail`,
                headers: { authorization: `Bearer ${token}` }, payload: { requestId: input.localId,
                    requestedAt: armed.pendingActivationRequestedAt!.getTime(), failureCode: 'runtime_start_failed' } });
            const waiting = await report();
            expect(waiting.statusCode, waiting.body).toBe(200);
            expect(waiting.json()).toEqual({ ok: true, didFail: false });
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toEqual(armed);
            // Once compute runs, the ordinary runtime owner can report its
            // genuine Agent startup refusal against this same authorization.
            await db.managedMachine.update({ where: { id: test.row.id }, data: { observation: {
                observedAt: 2, availability: 'present', power: 'running', storage: 'retained' } } });
            const failed = await report();
            expect(failed.statusCode, failed.body).toBe(200);
            expect(failed.json()).toEqual({ ok: true, didFail: true });
            expect(mapPendingActivationAuthorization(await db.session.findUniqueOrThrow({ where: { id: session.id } })))
                .toMatchObject({ status: 'failed', failureCode: 'runtime_start_failed' });
            expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } })).toEqual(queued);
        } finally { await app.close(); restoreEnv(envBefore); }
    });

    it.each(['managed_start_refused', 'managed_start_denied', 'managed_start_expired', 'managed_start_failed'] as const)(
        'settles an exact signed pre-admission wake failure and permits same-input rearm (%s)', async failureCode => {
        const test = await setup();
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        for (const machine of [test.controller, test.guest]) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: test.account.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'admin',
        }));
        await db.machine.update({ where: { id: test.guest.id }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
        } });
        const session = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: false } });
        await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: requester.id,
            sessionId: session.id, machineId: test.guest.id, data: 'private-key-ciphertext' }));
        const input = { actorUserId: requester.id, authentication: createPresentUserSessionAccessAuthentication(),
            sessionId: session.id, localId: randomUUID(), targetMachineId: test.guest.id,
            requestedAction: { v: 1, kind: 'enqueue' }, content: { t: 'plain', v: {
                role: 'user', content: { type: 'text', text: 'original queued input' } } } } as const;
        const envBefore = snapshotEnv();
        applyEnvValues({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); registerManagedMachineRoutes(app); await app.ready();
        try {
            expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
            expect(await updatePendingRequestedAction({ ...input, resumeWhenAvailable: true })).toMatchObject({ ok: true });
            const original = await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } });
            const first = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            const authorization = mapPendingActivationAuthorization(first);
            const target = authorization?.managedWakeTargetV1;
            if (!authorization || !target) throw new Error('Missing admitted managed target');
            const body = ManagedPendingActivationFailureRequestV1Schema.parse({ target, failureCode });
            const path = '/v1/machines/managed/controller/activation-failed';
            const token = await auth.createToken(test.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const invoke = (proofPath = path) => app.inject({ method: 'POST', url: path, payload: body, headers: {
                ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}`,
                [MANAGED_POLICY_PROOF_HEADER]: encodeManagedPolicyProofV1(createManagedPolicyProofV1({
                    correlation: { homeId, managedId: test.row.id, controller: target.controller,
                        expectedIntentRevision: target.expectedIntentRevision, requestId: randomUUID() },
                    purpose: { kind: 'accepted-input-start', target }, resource: ManagedResourceV1Schema.parse(test.row.resource),
                    custodianAccountId: test.account.id, path: proofPath, body, privateKey: test.controllerKeys.secretKey,
                })),
            } });
            // Mis-bound proof cannot settle an authorization even with the same signer.
            expect((await invoke('/v1/machines/managed/controller/admit-policy')).statusCode).toBe(403);
            expect(mapPendingActivationAuthorization(await db.session.findUniqueOrThrow({ where: { id: session.id } })))
                .toMatchObject({ status: 'waiting' });
            const failed = await invoke();
            expect(failed.statusCode, failed.body).toBe(200);
            expect(failed.json()).toEqual({ ok: true, didFail: true });
            const projected = mapPendingActivationAuthorization(await db.session.findUniqueOrThrow({ where: { id: session.id } }));
            expect(PendingActivationAuthorizationV1Schema.parse(projected)).toMatchObject({ requestId: input.localId,
                requestedAt: authorization.requestedAt, status: 'failed', failureCode, managedWakeTargetV1: target });
            expect(await listPendingMessages(input)).toMatchObject({ ok: true, pending: [{ localId: input.localId,
                status: 'queued', activationHoldReason: 'resume_not_requested' }] });
            expect(await updatePendingRequestedAction({ ...input, resumeWhenAvailable: true })).toMatchObject({ ok: true, didUpdate: true });
            const retried = mapPendingActivationAuthorization(await db.session.findUniqueOrThrow({ where: { id: session.id } }));
            expect(retried).toMatchObject({ requestId: input.localId, status: 'waiting' });
            expect(retried!.requestedAt).toBeGreaterThan(authorization.requestedAt);
            expect((await invoke()).json()).toEqual({ ok: true, didFail: false });
            expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } })).toEqual(original);
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).toMatchObject({ desired: 'stop', intentRevision: test.row.intentRevision });
        } finally { await app.close(); restoreEnv(envBefore); }
    });

    it.each(['view', 'admin'] as const)('explains stopped managed enqueue custody without inventing activation (%s)', async level => {
        const test = await setup();
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        for (const machine of [test.controller, test.guest]) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: test.account.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id }, level,
        }));
        await db.machine.update({ where: { id: test.guest.id }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
        } });
        const session = await db.session.create({ data: {
            accountId: requester.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', active: false,
        } });
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, {
            accountId: requester.id, sessionId: session.id, machineId: test.guest.id, data: 'private-key-ciphertext',
        }))).toMatchObject({ ok: true });
        const authentication = createPresentUserSessionAccessAuthentication();
        const input = { actorUserId: requester.id, authentication, sessionId: session.id, localId: randomUUID(),
            targetMachineId: test.guest.id, requestedAction: { v: 1, kind: 'enqueue' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'accepted while stopped' } } } } as const;
        const envBefore = snapshotEnv();
        applyEnvValues({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
        try {
            expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
            const expected = 'resume_not_requested';
            expect(await listPendingMessages(input)).toMatchObject({ ok: true, pending: [{
                localId: input.localId, status: 'queued', deliveryState: null, activationHoldReason: expected,
            }] });
            await withAuthenticatedTestApp(sessionPendingRoutes, async app => {
                const response = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/pending`,
                    headers: { 'x-test-user-id': requester.id } });
                expect(response.statusCode).toBe(200);
                const pending = response.json().pending[0];
                expect(pending.localId).toBe(input.localId);
                expect(PendingActivationHoldReasonV1Schema.parse(pending.activationHoldReason)).toBe(expected);
            });
            const before = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(before.pendingActivationRequestId).toBeNull();
            expect(before.pendingActivationManagedTarget).toBeNull();
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } }))
                .toMatchObject({ desired: 'stop', intentRevision: test.row.intentRevision });
            // The ordinary Process-when-online owner, not inspection, changes authorization.
            expect(await updatePendingRequestedAction({ ...input, requestedAction: { v: 1, kind: 'enqueue' }, resumeWhenAvailable: true }))
                .toMatchObject({ ok: true });
            const authorized = await listPendingMessages(input);
            if (!authorized.ok) throw new Error('Accepted queue disappeared');
            expect(authorized.pending[0]).not.toHaveProperty('activationHoldReason');
            const first = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(await inTx(tx => markPendingActivationAuthorizationFailedInTx({ tx, sessionId: session.id,
                requestId: input.localId, requestedAt: first.pendingActivationRequestedAt!, failureCode: 'managed_start_failed' }))).toBe(true);
            // A terminal wake is history, not an outstanding resume request. Keep
            // the original input and expose its current authorization prerequisite.
            expect(await listPendingMessages(input)).toMatchObject({ ok: true, pending: [{
                localId: input.localId, status: 'queued', deliveryState: null, content: input.content, activationHoldReason: expected,
            }] });
            expect(await updatePendingRequestedAction({ ...input, resumeWhenAvailable: true })).toMatchObject({ ok: true, didUpdate: true });
            const retried = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(retried.pendingActivationRequestedAt!.getTime()).toBeGreaterThan(first.pendingActivationRequestedAt!.getTime());
            expect(mapPendingActivationAuthorization(retried)).toMatchObject({ requestId: input.localId, status: 'waiting' });
            expect(mapPendingActivationAuthorization(retried)?.managedWakeTargetV1).toMatchObject({
                managedId: test.row.id, enrolledMachineId: test.guest.id, controller: {
                    machineId: test.controller.id, installationId: test.controller.installationId,
                }, origin: { kind: 'session-input', pendingRequestId: input.localId,
                    requestedAt: retried.pendingActivationRequestedAt!.getTime() },
            });
            expect(await inTx(tx => markPendingActivationAuthorizationFailedInTx({ tx, sessionId: session.id,
                requestId: input.localId, requestedAt: first.pendingActivationRequestedAt!, failureCode: 'runtime_start_failed' }))).toBe(false);
            await db.managedMachine.update({ where: { id: test.row.id }, data: { observation: {
                observedAt: 20, availability: 'present', power: 'running', storage: 'retained',
            } } });
            await db.machine.update({ where: { id: test.guest.id }, data: { active: true } });
            const running = await listPendingMessages(input);
            if (!running.ok) throw new Error('Accepted queue disappeared');
            expect(running.pending[0]).not.toHaveProperty('activationHoldReason');
        } finally { restoreEnv(envBefore); }
    });

    it.each(['view', 'admin'] as const)('rearms the same failed input through registered pending Action and HTTP (%s)', async level => {
        const test = await setup();
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        for (const machine of [test.controller, test.guest]) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: test.account.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id }, level,
        }));
        await db.machine.update({ where: { id: test.guest.id }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
        } });
        const session = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: false } });
        const sourceSession = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true, lastActiveAt: new Date() } });
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: requester.id,
            sessionId: sourceSession.id, machineId: test.controller.id, data: 'source-private-key-ciphertext' }))).toMatchObject({ ok: true });
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: requester.id,
            sessionId: session.id, machineId: test.guest.id, data: 'private-key-ciphertext' }))).toMatchObject({ ok: true });
        const input = { actorUserId: requester.id, authentication: createPresentUserSessionAccessAuthentication(),
            sessionId: session.id, localId: randomUUID(), targetMachineId: test.guest.id,
            requestedAction: { v: 1, kind: 'enqueue' }, resumeWhenAvailable: true,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'retain this input' } } } } as const;
        const envBefore = snapshotEnv();
        applyEnvValues({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: requester.id, machineId: test.controller.id, sessionId: sourceSession.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(requester.id, sourceSession.id) ? [publisher] : []);
        const resolveSource = (params: Readonly<{ accountId: string; sessionId: string }>) =>
            resolveCurrentSessionMachineFromServer({ io, presence, ...params });
        app.decorate('resolveCurrentSessionMachine', resolveSource);
        sessionPendingRoutes(app);
        registerSessionListingRoutes(app);
        registerAccountEncryptionRoutes(app);
        machinesRoutes(app);
        try {
            expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
            const first = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(await inTx(tx => markPendingActivationAuthorizationFailedInTx({ tx, sessionId: session.id,
                requestId: input.localId, requestedAt: first.pendingActivationRequestedAt!, failureCode: 'managed_start_failed' }))).toBe(true);
            const before = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            const original = await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } });
            // Import the real CLI composition without widening the server's compiler root.
            const importCli = async <T,>(path: string) => await import(path) as T;
            const { createCliActionDeps } = await importCli<{ createCliActionDeps: (options: unknown) => ActionExecutorDeps }>(
                '../../../../../cli/src/session/actions/createCliActionDeps');
            const { runWithServerHttpBaseUrl } = await importCli<{ runWithServerHttpBaseUrl: <T>(url: string, run: () => T) => T }>(
                '../../../../../cli/src/api/client/serverHttpBaseUrl');
            const origin = await app.listen({ host: '127.0.0.1', port: 0 });
            const token = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
            const actionId = ActionIdSchema.parse('session.pending.action.set');
            const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, mode: 'plain', ctx: null,
                sessionId: session.id, serverId: origin, serverHttpBaseUrl: origin, serverIdentityId: homeId,
                externalActionMachineInstallationId: test.guest.installationId,
                externalActionMachineRequestPrivateKey: test.controllerKeys.secretKey });
            const actionInput = { sessionId: session.id, localId: input.localId,
                requestedAction: input.requestedAction, resumeWhenAvailable: true, serverId: origin };
            const target = { kind: 'session' as const, sessionId: session.id };
            const requestId = randomUUID();
            const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1, requestId,
                caller: { kind: 'session', sessionId: sourceSession.id, starterDepth: 0, turnDepth: 0 },
                sourceInputId: 'original-agent-input', sourceTurnId: 'original-agent-turn',
                callerPermissionMode: 'yolo', causalPermissionAuthority: null });
            const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId: requester.id,
                authentication: { kind: 'account', tokenEpoch: requester.tokenEpoch }, serverIdentityId: homeId,
                machineId: test.guest.id, actionId, requestId, target,
                sessionActionOrigin, sessionActionSource: { machineId: test.controller.id, installationId: test.controller.installationId! },
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input: actionInput }) },
                { resolveCurrentSessionMachine: resolveSource });
            const context = { surface: 'agent' as const, authority: 'account_automation' as const,
                defaultSessionId: sourceSession.id,
                externalActionTarget: target, externalActionExecutionAuthorization: authorization,
                actionCaller: sessionActionOrigin.caller, actionsSettings: normalizeActionsSettingsV1({ v: 1,
                    approvalWaivedSurfaces: { [actionId]: ['agent'] } }) };
            const missing = createActionExecutor({ ...deps, sessionPendingActionSet: undefined });
            expect(await runWithServerHttpBaseUrl(origin, () => missing.execute(actionId, actionInput, context)))
                .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toEqual(before);
            const executor = createActionExecutor(deps);
            expect(await runWithServerHttpBaseUrl(origin, () => executor.execute(actionId, actionInput, { ...context, actionsSettings: normalizeActionsSettingsV1({ v: 1,
                actions: { [actionId]: { enabled: false } } }) }))).toMatchObject({ ok: false, errorCode: 'action_disabled' });
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toEqual(before);
            const result = await runWithServerHttpBaseUrl(origin, () => executor.execute(actionId, actionInput, context));
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { didUpdate: true, requestedAction: input.requestedAction } });
            if (!result.ok) throw new Error('Expected same-input rearm');
            getActionSpec(actionId).outputSchema!.parse(result.result);
            const retried = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(retried.pendingActivationRequestedAt!.getTime()).toBeGreaterThan(first.pendingActivationRequestedAt!.getTime());
            expect(mapPendingActivationAuthorization(retried)).toMatchObject({ requestId: input.localId, status: 'waiting' });
            expect(mapPendingActivationAuthorization(retried)?.managedWakeTargetV1).toMatchObject({ managedId: test.row.id });
            expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } })).toEqual(original);
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } }))
                .toMatchObject({ desired: 'stop', intentRevision: test.row.intentRevision });
            // A retained signed root cannot outlive its installed signer.
            await db.machine.update({ where: { id: test.guest.id }, data: { installationId: randomUUID() } });
            expect(await runWithServerHttpBaseUrl(origin, () => executor.execute(actionId, actionInput, context)))
                .toMatchObject({ ok: false, errorCode: 'ERR_BAD_REQUEST' });
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toEqual(retried);
        } finally { await app.close(); restoreEnv(envBefore); }
    });

    it('retains native admission for Actions whose input may select a Machine effect', async () => {
        const test = await setup();
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.account.id, machineId: test.controller.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'admin' }));
        expect(await inTx(tx => resolveExternalActionExecutionMachineAdmissionInTx(tx, { actorAccountId: requester.id,
            machineId: test.controller.id, actionId: 'providers.connections.secrets.bind' }))).toMatchObject({ kind: 'denied', code: 'custodian_only' });
    });

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

    it.each([false, true])('prepares explicit finite wake independently of unattended choice (%s), without admitting intent before requester Ask', async wakeOnAcceptedMessage => {
        const test = await setup();
        await db.managedMachine.update({ where: { id: test.row.id }, data: { wakeOnAcceptedMessage } });
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
            const prepared = ManagedPolicyAdmissionOutputV1Schema.parse(preview.json());
            expect(prepared).toMatchObject({ requestId: input.requestId, replayed: false });
            expect(ManagedPolicyAdmissionOutputV1Schema.safeParse({ ...prepared, unreviewed: true }).success).toBe(false);
            const prospective = prepared.machine;
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

    it('admits one finite wake once and uses local cancellation at each transport step', async () => {
        const test = await setup();
        let sourceCurrent = true;
        let sourceReads = 0;
        const tokenAdmission = vi.spyOn(auth, 'verifyExternalActionExecutionAuthorization');
        const cancel = new AbortController();
        const nativeEffect = vi.fn(async () => ({ ok: true as const }));
        const io = {} as Server;
        let admittedReads: { source: number; token: number } | undefined;
        const guarded: unknown[] = [];
        try {
            const prepared = await prepareManagedFiniteActionWake({ io, actionOrigin: test.actionOrigin,
                signal: cancel.signal, isOriginalSourceCurrent: async () => { sourceReads++; return sourceCurrent; },
                forwardRpc: async request => {
                    const candidate = { id: 'controller-socket', data: { clientType: 'machine-scoped', userId: test.account.id,
                        machineId: test.controller.id, verifiedMachineInstallationId: test.controller.installationId },
                        timeout: () => ({ emitWithAck: nativeEffect }) };
                    const guard = request.targetGuard;
                    if (!guard) throw new Error('Finite wake requires a guarded native transport.');
                    const replaced = { ...candidate, id: 'replaced-controller-socket', data: {
                        ...candidate.data, verifiedMachineInstallationId: randomUUID(),
                    } };
                    guarded.push((await guard.filterTargets([replaced, candidate])).map(target => target.id));
                    admittedReads = { source: sourceReads, token: tokenAdmission.mock.calls.length };
                    guarded.push(await guard.runOperation({ target: replaced, readLatestTarget: async () => replaced,
                        operation: nativeEffect }));
                    sourceCurrent = false;
                    guarded.push((await guard.filterTargets([candidate])).map(target => target.id));
                    guarded.push(await guard.runOperation({ target: candidate, readLatestTarget: async () => candidate,
                        operation: nativeEffect }));
                    cancel.abort();
                    guarded.push(await guard.runOperation({ target: candidate, readLatestTarget: async () => candidate,
                        operation: nativeEffect }));
                    guarded.push((await guard.filterTargets([candidate])).map(target => target.id));
                    return { ok: false, error: 'retired-original-source' };
                } });
            expect(prepared).toEqual({ kind: 'unavailable' });
            expect(admittedReads).toEqual({ source: 1, token: 1 });
            expect(guarded).toEqual([['controller-socket'], { status: 'unavailable' }, ['controller-socket'],
                { status: 'current', value: { ok: true } }, { status: 'unavailable' }, []]);
            expect(sourceReads).toBe(1);
            expect(tokenAdmission).toHaveBeenCalledTimes(1);
            expect(nativeEffect).toHaveBeenCalledTimes(1);
            expect((await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).desired).toBe('stop');
        } finally { tokenAdmission.mockRestore(); }
    });

    it.each(['owner', 'wrong-requester', 'wrong-root', 'no-manage', 'session-input-use', 'session-input-opted-out'] as const)('admits the real requester and exact root at the finite wake boundary (%s)', async disposition => {
        const test = await setup();
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sessionInput = disposition.startsWith('session-input-');
        for (const machine of sessionInput ? [test.guest] : [test.controller, test.guest]) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: test.account.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id }, level: sessionInput ? 'view' : 'admin',
        }));
        if (disposition === 'session-input-opted-out') await db.managedMachine.update({
            where: { id: test.row.id }, data: { wakeOnAcceptedMessage: false },
        });
        const root = await auth.mintExternalActionExecutionAuthorization({ accountId: requester.id,
            authentication: { kind: 'account', tokenEpoch: requester.tokenEpoch }, serverIdentityId: homeId,
            machineId: test.guest.id, actionId: sessionInput ? SESSION_SPAWN_NEW_ACTION_ID_V1 : 'projects.script.run', requestId: test.requestId,
            ...(sessionInput ? { machineRuntimeDemand: 'required' as const } : {}),
            requestEnvelopeDigest: 'd'.repeat(43), target: { kind: 'machine', machineId: test.guest.id } });
        if (disposition === 'wrong-requester') await db.machineGrant.deleteMany({ where: { principalKind: 'account',
            machineId: { in: [test.guest.id, test.controller.id] }, accountId: requester.id,
        } });
        if (disposition === 'no-manage') await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: test.account.id, machineId: test.controller.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'view',
        }));
        const forwardRpc = vi.fn(async (request: { callParams: unknown }) => {
            const wake = ManagedFiniteWakeRequestV1Schema.parse(request.callParams);
            expect(wake.actionOrigin.binding.accountId).toBe(requester.id);
            await test.check(wake.actionOrigin);
            expect(await inTx(tx => readCurrentManagedFiniteWakeCustodyInTx(tx, wake))).not.toBeNull();
            return { ok: true as const, result: { ok: true, result: {
                kind: 'accepted', managedId: test.row.id, intentRevision: 1, operation: { operationId: 'native-policy' },
            } } };
        });
        const result = await prepareManagedFiniteActionWake({ io: new Server(), signal: new AbortController().signal,
            actionOrigin: disposition === 'wrong-root' ? { ...root, binding: { ...root.binding, requestId: randomUUID() } } : root,
            forwardRpc });
        const allowed = disposition === 'owner' || disposition === 'session-input-use';
        expect(result.kind).toBe(allowed ? 'ready' : 'unavailable');
        expect(forwardRpc).toHaveBeenCalledTimes(allowed ? 1 : 0);
    });

    it('retains the exact original finite PAT grant and mode instead of requiring a native power grant', async () => {
        const test = await setup();
        const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['projects.script.run' as const] },
            targets: { sessions: [], machines: [test.guest.id] } };
        const pat = await auth.createApiToken({ accountId: test.account.id, tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(test.account.id, 'original finite'), grant });
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
            expect(issued.json().managedFiniteWake.requesterCredentialDisclosure).toEqual(guestOwnership === 'owned'
                ? { accountId: test.account.id, displayName: '' } : undefined);
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

    it('leaves passive file discovery asleep through the real Home route', async () => {
        const test = await setup();
        const methods: string[] = [];
        const dispatch = createExternalActionDaemonDispatcher({ io: new Server(), forwardRpc: async request => {
            methods.push(request.method);
            throw new Error('Passive discovery must not contact the stopped guest or its controller');
        } });
        const token = await auth.createToken(test.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); registerExternalActionRoutes(app, { dispatch });
        await app.ready();
        try {
            const result = await app.inject({ method: 'POST', url: '/v1/actions/daemon.filesystem.listDirectory',
                headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}` },
                payload: { v: 1, requestId: test.requestId, target: { kind: 'machine', machineId: test.guest.id },
                    input: { rootPath: '/work', path: '.' } } });
            expect(result.json()).toMatchObject({ execution: { ok: false, errorCode: 'target_unavailable' } });
            expect(methods).toEqual([]);
            expect((await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).desired).toBe('stop');
        } finally { await app.close(); }
    });

    it('leaves a restricted passive PAT read asleep when its sealed envelope forges runtime demand', async () => {
        const test = await setup();
        const keys = tweetnacl.box.keyPair();
        const requester = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
        for (const machine of [test.controller, test.guest]) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: test.account.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'admin',
        }));
        const actionId = 'daemon.filesystem.listDirectory' as const;
        const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] },
            targets: { sessions: [], machines: [test.guest.id] } };
        const tokenId = randomUUID();
        const pat = await auth.createApiToken({ accountId: requester.id, tokenId, label: await prepareE2eeAccountApiTokenLabel(requester.id, tokenId, 'passive only'), grant });
        const envelope = { ...sealExternalActionRequestV2({
            binding: { serverIdentityId: homeId, accountId: requester.id, credentialId: pat.tokenId,
                actionId, requestId: test.requestId, target: { kind: 'machine', machineId: test.guest.id } },
            input: { rootPath: '/work', path: '.' },
            material: { type: 'dataKey', machineKey: tweetnacl.randomBytes(32) }, randomBytes: tweetnacl.randomBytes,
            projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
        }), machineRuntimeDemand: 'required' as const };
        const methods: string[] = [];
        const admittedRoots: ExternalActionExecutionAuthorizationV1[] = [];
        const dispatch = createExternalActionDaemonDispatcher({ io: new Server(), forwardRpc: async request => {
            methods.push(request.method);
            if (request.method === `${test.controller.id}:${MANAGED_FINITE_WAKE_RPC_METHOD}`) {
                const root = ExternalActionExecutionAuthorizationV1Schema.parse(
                    (request.callParams as { actionOrigin: unknown }).actionOrigin);
                await test.check(root);
                admittedRoots.push(root);
            }
            return { ok: false, error: 'passive_guest_unavailable' };
        } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); registerExternalActionRoutes(app, { dispatch });
        await app.ready();
        try {
            const response = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${pat.token}` },
                payload: envelope });
            expect(response.json()).toMatchObject({ code: 'target_unavailable' });
            expect(admittedRoots.map(root => ({ actionId: root.binding.actionId, credentialId: root.binding.credentialId })))
                .toEqual([]);
            expect(methods).toEqual([]);
            expect((await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).desired).toBe('stop');
        } finally { await app.close(); }
    });

    it.each(['projects.script.run', 'daemon.filesystem.readFile', 'session.open', SESSION_SPAWN_NEW_ACTION_ID_V1] as const)('preserves both installed custody boxes and the original root through actual %s wake and guest relay', async actionId => {
        const test = await setup();
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sessionInput = actionId === SESSION_SPAWN_NEW_ACTION_ID_V1;
        for (const machine of sessionInput ? [test.guest] : [test.controller, test.guest]) {
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: test.account.id, machineId: machine.id,
                principal: { kind: 'account', accountId: requester.id }, level: sessionInput ? 'view' : 'admin' }));
        }
        const token = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        const session = actionId === 'session.open' ? await db.session.create({ data: {
            accountId: requester.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', active: false,
        } }) : undefined;
        if (session) {
            expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: requester.id,
                sessionId: session.id, machineId: test.guest.id, data: 'opaque-session-key' }))).toMatchObject({ ok: true });
            await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: {
                homeId, accountId: requester.id, sessionId: session.id,
                machineId: test.guest.id, installationId: test.guest.installationId!,
            } } });
        }
        const envelope = { v: 1 as const, requestId: test.requestId,
            target: session ? { kind: 'session' as const, sessionId: session.id } : { kind: 'machine' as const, machineId: test.guest.id },
            input: session ? { sessionId: session.id, intent: 'resume' } : sessionInput ? {
                executionTarget: { serverId: homeId, machineId: test.guest.id },
                creationKey: test.requestId, directory: { kind: 'path', path: '/work' },
                organizationPlacement: { sectionId: null, tagIds: [] },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                initialInput: { text: 'Start this Session' },
            } : { rootPath: '/work', path: 'original-private-file' } };
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
                    v: 1, actionId, requestId: test.requestId, execution: { ok: true, result: { ran: true } },
                })) };
            } catch (error) { boundaryErrors.push(error); throw error; }
        } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as ServerFastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app); registerExternalActionRoutes(app, { dispatch });
        await app.ready();
        try {
            const headers = { ...currentAccountStoredContentCompatibilityHeaders, authorization: `Bearer ${token}` };
            const minted = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}/execution-authorization`,
                headers, payload: { v: 1, machineId: test.guest.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            if (!root.managedFiniteWake) throw new Error('Actual Home must supply the controller custody recipient');
            carrier = { ...root,
                requesterAccountContext: { kind: 'installation_sealed_v1', installationId: root.binding.installationId, ciphertext: 'guest_box' },
                managedFiniteWake: { ...root.managedFiniteWake, requesterAccountContext: {
                    kind: 'installation_sealed_v1', installationId: root.managedFiniteWake.target.controller.installationId, ciphertext: 'controller_box',
                } } };
            const result = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`, headers,
                payload: { v: 1, machineId: test.guest.id, envelope, executionAuthorization: carrier } });
            if (boundaryErrors.length > 0) throw boundaryErrors[0];
            expect(result.statusCode, result.body).toBe(200);
            expect(result.json()).toMatchObject({ execution: { ok: true, result: { ran: true } } });
            expect(methods).toEqual([`${test.controller.id}:${MANAGED_FINITE_WAKE_RPC_METHOD}`,
                `${test.guest.id}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`]);
        } finally { await app.close(); }
    });

    it.each(['no_controller', 'controller_unavailable'] as const)('refuses an asleep Session spawn with its Protocol wake-blocked reason (%s)', async reason => {
        const test = await setup();
        if (reason === 'no_controller') {
            await db.managedMachine.update({ where: { id: test.row.id }, data: {
                controllerMachineId: null, controllerInstallationId: null,
            } });
        } else await db.machine.update({ where: { id: test.controller.id }, data: { active: false } });
        const methods: string[] = [];
        const dispatch = createExternalActionDaemonDispatcher({ io: new Server(), forwardRpc: async request => {
            methods.push(request.method);
            throw new Error('A wake-blocked Machine must not receive native wake or Session spawn');
        } });
        const result = await dispatch({ actionId: SESSION_SPAWN_NEW_ACTION_ID_V1,
            principal: { accountId: test.account.id, authority: 'present_user',
                authentication: { kind: 'account', tokenEpoch: test.account.tokenEpoch } },
            envelope: { v: 1, requestId: test.requestId, target: { kind: 'machine', machineId: test.guest.id }, input: {
                creationKey: test.requestId, executionTarget: { serverId: homeId, machineId: test.guest.id },
                directory: { kind: 'path', path: '/work' }, organizationPlacement: { sectionId: null, tagIds: [] },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                initialInput: { text: 'Start this Session' }, agentInstallConsent: { vendorRecipe: true },
            } },
        });
        expect(result).toMatchObject({ kind: 'placement_error', code: 'target_unavailable', failureCause: {
            phase: 'machines.managed.wake', errorCode: 'target_unavailable', nativeErrorReason: reason,
        } });
        expect(methods).toEqual([]);
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: test.row.id } })).desired).toBe('stop');
    });

    it('checks requester Account mode independently of the shared custodian Machine resource mode', async () => {
        const test = await setup();
        const keys = tweetnacl.box.keyPair();
        const requester = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
        await db.machineGrant.createMany({ data: [test.controller, test.guest].map(machine => ({ principalKind: 'account' as const,
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

    it.each(['cancel', 'unknown', 'credential-retired'] as const)('preserves local wake cancellation and next-destination admission (%s)', async disposition => {
        const test = await setup();
        const cancel = new AbortController();
        const methods: string[] = [];
        const dispatch = createExternalActionDaemonDispatcher({ io: new Server(), forwardRpc: async request => {
            methods.push(request.method);
            if (request.method === `${test.guest.id}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`) {
                // This is a new destination admission. Keep its actual strict
                // request/principal owners beneath the substituted RPC transport.
                expect(disposition).toBe('credential-retired');
                const guest = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
                if (!guest.executionAuthorization) throw new Error('Missing guest execution authorization');
                expect(await verifyCurrentExternalActionPrincipal(guest.executionAuthorization.binding)).toBe(false);
                return { ok: false, error: 'authorization_refused' };
            }
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
        expect(methods).toHaveLength(disposition === 'credential-retired' ? 2 : 1);
    });

    it.each([
        { actionId: 'projects.script.run', disposition: 'current' },
        { actionId: 'projects.script.run', disposition: 'publisher-before-wake' },
        { actionId: 'projects.script.run', disposition: 'controller-unavailable' },
        { actionId: 'daemon.filesystem.readFile', disposition: 'current' },
    ] as const)('preserves the original signed Socket finite custody carrier and refuses retired Session authority ($actionId/$disposition)', async ({ actionId, disposition }) => {
        const test = await setup();
        const envBefore = snapshotEnv();
        applyEnvValues({ AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' });
        const methods: string[] = [];
        const boundaryErrors: unknown[] = [];
        const original = actionId === 'daemon.filesystem.readFile' ? { rootPath: '/workspace', path: 'retained.txt' }
            : { opaque: 'same caller-owned Project input' };
        const guestMethod = `${test.guest.id}:${actionId === 'daemon.filesystem.readFile'
            ? RPC_METHODS.DAEMON_FILESYSTEM_READ_FILE : RPC_METHODS.DAEMON_PROJECTS_SCRIPT_RUN}`;
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
                    // The original RPC verifier has admitted the principal. Its
                    // source boundary still observes a retired publisher before
                    // any controller effect, without re-admitting the principal.
                    await db.accountIdentity.updateMany({ where: { accountId: test.account.id, provider: 'github' },
                        data: { eligibilityNextCheckAt: new Date(0) } });
                    wakeEligibilityDue = true;
                    if (disposition === 'publisher-before-wake') publisherVisible = false;
                    if (disposition === 'controller-unavailable') {
                        await db.machine.update({ where: { id: test.controller.id }, data: { active: false } });
                    }
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
                    actionId, requestId: test.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
            const token = await auth.createToken(test.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const minted = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}/execution-authorization`,
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
            // Eligibility is evaluated once at original Socket admission.
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
                expect(String(url)).toBe(`https://api.github.com/orgs/finite-requesters/members/${providerLogin}`);
                expect(initialEligibilityReached).toBe(false);
                initialEligibilityReached = true;
                return new Response(null, { status: 204 });
            });
            restoreFetch = () => fetchSpy.mockRestore();
            const execution = { v: 1 as const, authorization: carrier, effectActionId: actionId,
                target: carrier.binding.target, installationId: test.guest.installationId!,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: carrier.token,
                    requesterAccountContext: carrier.requesterAccountContext,
                    effectActionId: actionId, target: carrier.binding.target,
                    installationId: test.guest.installationId!, requestId: test.requestId, method: guestMethod,
                    params: original, privateKey: test.controllerKeys.secretKey }),
            };
            let response: unknown;
            await getSocketHandler(caller, SOCKET_RPC_EVENTS.CALL)({ method: guestMethod, requestId: test.requestId,
                params: original, externalActionExecution: execution }, (value: unknown) => { response = value; });
            if (boundaryErrors.length > 0) throw boundaryErrors[0];
            expect(wakeEligibilityDue, JSON.stringify({ initialEligibilityReached, response, methods })).toBe(true);
            expect(initialEligibilityReached).toBe(true);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            if (disposition === 'current') {
                expect(response).toEqual({ ok: true, result: { completed: true } });
                expect(methods).toEqual([wakeMethod, guestMethod]);
                expect(carrier.binding).toEqual(root.binding);
            } else if (disposition === 'controller-unavailable') {
                expect(response).toMatchObject({ ok: false, failureCause: {
                    phase: 'machines.managed.wake', errorCode: 'target_unavailable',
                    nativeErrorReason: 'controller_unavailable',
                } });
                expect(methods).toEqual([]);
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
