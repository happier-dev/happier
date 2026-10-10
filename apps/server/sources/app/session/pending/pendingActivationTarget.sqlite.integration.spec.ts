import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { setMachineAccessGrantInTx, removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { createFakeSocket } from '@/app/api/testkit/socketHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { eventRouter, type ClientConnection } from '@/app/events/eventRouter';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { enqueuePendingMessage, materializeNextPendingMessage, resolveAcceptedPendingDelivery } from './pendingMessageService';
import { armPendingActivationAuthorizationInTx } from './pendingActivationAuthorization';
import { emitPendingActivationHint, loadPendingActivationPublication } from './publishPendingMutation';

describe('exact requester pending activation target (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-requester-pending-target-', initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_SERVER_IDENTITY_ID: 'srv_01234567890123456789012345678901' } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });
    afterEach(() => { harness.resetEnv(); });

    async function fixture() {
        const custodian = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', active: false } });
        async function machine() {
            const row = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id, installationId: randomUUID(),
                metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
                dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1 } });
            expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: row.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'view' }))).toMatchObject({ kind: 'saved', readiness: 'ready' });
            expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: requester.id, sessionId: session.id, machineId: row.id, data: 'private-key-ciphertext' }))).toMatchObject({ ok: true });
            return row;
        }
        const otherMachine = await machine();
        const selectedMachine = await machine();
        const input = { actorUserId: requester.id, authentication: createPresentUserSessionAccessAuthentication(), sessionId: session.id,
            localId: randomUUID(), targetMachineId: selectedMachine.id, requestedAction: { v: 1, kind: 'send_now' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private-prompt-never-in-hint' } } } } as const;
        const target = { homeId: process.env.HAPPIER_SERVER_IDENTITY_ID, accountId: requester.id, sessionId: session.id,
            machineId: selectedMachine.id, installationId: selectedMachine.installationId };
        return { custodian, requester, session, selectedMachine, otherMachine, input, target };
    }

    it('retains the selected second tuple and emits only a content-free exact custodian Machine hint without an Account cursor', async () => {
        const f = await fixture();
        const result = await enqueuePendingMessage(f.input);
        expect(result).toMatchObject({ ok: true, didWrite: true });
        if (!result.ok || !('activationTarget' in result) || !result.activationTarget) throw new Error('Missing accepted activation');
        const receipt = (await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: f.session.id, localId: f.input.localId } } })).inputAdmissionReceipt;
        expect(receipt).toMatchObject({ issuer: 'authenticatedAccount', actorAccountId: f.requester.id, admittedTarget: f.target });
        expect(await loadPendingActivationPublication(f.session.id)).toMatchObject({ status: 'waiting', admittedTarget: f.target });
        await withAuthenticatedTestApp(registerSessionListingRoutes, async app => {
            const response = await app.inject({ method: 'GET', url: `/v2/sessions/${f.session.id}`, headers: { 'x-test-user-id': f.requester.id } });
            expect(response.statusCode).toBe(200);
            expect(response.json().session.pendingActivationAuthorization).toMatchObject({ admittedTarget: f.target });
            expect((await app.inject({ method: 'GET', url: `/v2/sessions/${f.session.id}`, headers: { 'x-test-user-id': f.custodian.id } })).statusCode).toBe(404);
        });
        const selectedSocket = createFakeSocket();
        const otherSocket = createFakeSocket();
        const browserSocket = createFakeSocket();
        const requesterSocket = createFakeSocket();
        // Socket.IO is the only replaced boundary; receipt/currentness/routing owners remain real.
        const connections: ClientConnection[] = [
            { connectionType: 'machine-scoped', userId: f.custodian.id, machineId: f.selectedMachine.id, socket: selectedSocket as unknown as Socket },
            { connectionType: 'machine-scoped', userId: f.custodian.id, machineId: f.otherMachine.id, socket: otherSocket as unknown as Socket },
            { connectionType: 'user-scoped', userId: f.custodian.id, socket: browserSocket as unknown as Socket },
            { connectionType: 'machine-scoped', userId: f.requester.id, machineId: f.selectedMachine.id, socket: requesterSocket as unknown as Socket },
        ];
        const custodianChanges = await db.accountChange.count({ where: { accountId: f.custodian.id } });
        try {
            for (const connection of connections) eventRouter.addConnection(connection.userId, connection);
            await emitPendingActivationHint({ sessionId: f.session.id, changedByAccountId: f.requester.id,
                pendingCount: result.pendingCount, pendingVersion: result.pendingVersion, recipientCursors: result.recipientCursors,
                activationTarget: result.activationTarget });
            expect(selectedSocket.emit).toHaveBeenCalledWith('ephemeral', {
                type: 'pending-activation-requested', target: f.target, requestId: f.input.localId,
                requestedAt: expect.any(Number), pendingVersion: result.pendingVersion,
            });
            expect(otherSocket.emit).not.toHaveBeenCalled();
            expect(browserSocket.emit).not.toHaveBeenCalled();
            expect(requesterSocket.emit).not.toHaveBeenCalled();
            expect(await db.accountChange.count({ where: { accountId: f.custodian.id } })).toBe(custodianChanges);
        } finally { for (const connection of connections) eventRouter.removeConnection(connection.userId, connection); }
    });

    it('preserves explicit same-owner uninstalled predecessor placement without manufacturing an admitted target', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', active: false } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: account.id, sessionId: session.id, machineId: machine.id, data: 'legacy-own-key' } });
        const input = { actorUserId: account.id, authentication: createPresentUserSessionAccessAuthentication(), sessionId: session.id,
            localId: randomUUID(), targetMachineId: machine.id, requestedAction: { v: 1, kind: 'send_now' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'predecessor-owned-input' } } } } as const;
        expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
        const row = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: input.localId } } });
        expect(row.inputAdmissionReceipt).not.toHaveProperty('admittedTarget');
        expect(await loadPendingActivationPublication(session.id)).not.toHaveProperty('admittedTarget');
        await db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        expect(await enqueuePendingMessage({ ...input, localId: randomUUID() })).toMatchObject({ ok: false,
            admissionRejectionCode: 'session_input_target_update_required' });
    });

    it.each(['grant', 'installation', 'requester', 'home'] as const)('never retargets retained input after %s currentness loss', async loss => {
        const f = await fixture();
        const accepted = await enqueuePendingMessage(f.input);
        expect(accepted).toMatchObject({ ok: true });
        if (!accepted.ok || !('activationTarget' in accepted) || !accepted.activationTarget) throw new Error('Missing accepted target');
        if (loss === 'grant') await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: f.custodian.id,
            machineId: f.selectedMachine.id, principal: { kind: 'account', accountId: f.requester.id } }));
        if (loss === 'installation') await db.machine.update({ where: { id: f.selectedMachine.id }, data: { installationId: randomUUID() } });
        if (loss === 'requester') await db.account.update({ where: { id: f.requester.id }, data: { status: 'suspended' } });
        if (loss === 'home') process.env.HAPPIER_SERVER_IDENTITY_ID = 'srv_11234567890123456789012345678901';
        expect(await inTx(tx => armPendingActivationAuthorizationInTx({ tx, sessionId: f.session.id, requestId: f.input.localId,
            currentAccess: { accountId: f.requester.id, sessionId: f.session.id, level: 'owner' } }))).toBeUndefined();
        expect(await loadPendingActivationPublication(f.session.id)).not.toHaveProperty('admittedTarget');
        const row = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: f.session.id, localId: f.input.localId } } });
        expect(row.inputAdmissionReceipt).toMatchObject({ admittedTarget: f.target });
        expect(row.status).toBe('queued');
        expect(await db.session.findUnique({ where: { id: f.session.id } })).not.toBeNull();
        const socket = createFakeSocket();
        const connection: ClientConnection = { connectionType: 'machine-scoped', userId: f.custodian.id,
            machineId: f.selectedMachine.id, socket: socket as unknown as Socket };
        eventRouter.addConnection(connection.userId, connection);
        try {
            await emitPendingActivationHint({ sessionId: f.session.id, changedByAccountId: f.requester.id,
                pendingCount: accepted.pendingCount, pendingVersion: accepted.pendingVersion,
                recipientCursors: accepted.recipientCursors, activationTarget: accepted.activationTarget });
            expect(socket.emit).not.toHaveBeenCalled();
        } finally { eventRouter.removeConnection(connection.userId, connection); }
    });

    it('does not let another usable requester tuple materialize the selected input', async () => {
        const f = await fixture();
        expect(await enqueuePendingMessage(f.input)).toMatchObject({ ok: true });
        const socket = createFakeSocket() as unknown as Socket;
        const presence = createSessionPublisherPresence();
        const binding = { accountId: f.requester.id, sessionId: f.session.id, machineId: f.otherMachine.id };
        const registration = await presence.registerPublisher({ socket, binding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (registration.status !== 'registered') throw new Error('Missing real publisher');
        expect(await materializeNextPendingMessage({ actorUserId: f.requester.id, sessionId: f.session.id,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready',
            publisherAuthority: { ...binding, committedFence: registration.committedFence } })).toMatchObject({ ok: false, error: 'forbidden' });
        expect((await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: f.session.id, localId: f.input.localId } } })).deliveryState).toBeNull();
        const selectedBinding = { ...binding, machineId: f.selectedMachine.id };
        const selected = await presence.registerPublisher({ socket: createFakeSocket() as unknown as Socket,
            binding: selectedBinding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (selected.status !== 'registered') throw new Error('Missing selected publisher');
        expect(await materializeNextPendingMessage({ actorUserId: f.requester.id, sessionId: f.session.id,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready',
            publisherAuthority: { ...selectedBinding, committedFence: selected.committedFence } })).toMatchObject({ ok: true, didMaterialize: true });
        const otherCurrent = await presence.registerPublisher({ socket: createFakeSocket() as unknown as Socket,
            binding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (otherCurrent.status !== 'registered') throw new Error('Missing other current publisher');
        expect(await resolveAcceptedPendingDelivery({ actorUserId: f.requester.id, sessionId: f.session.id,
            localId: f.input.localId, publisherAuthority: { ...binding, committedFence: otherCurrent.committedFence } }))
            .toMatchObject({ ok: false, error: 'forbidden' });
    });

    it('keeps target-less predecessor input from becoming foreign publisher authority', async () => {
        const f = await fixture();
        const { targetMachineId: _selectedTarget, ...legacyInput } = f.input;
        expect(await enqueuePendingMessage(legacyInput)).toMatchObject({ ok: true });
        const presence = createSessionPublisherPresence();
        const binding = { accountId: f.requester.id, sessionId: f.session.id, machineId: f.selectedMachine.id };
        const registered = await presence.registerPublisher({ socket: createFakeSocket() as unknown as Socket,
            binding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (registered.status !== 'registered') throw new Error('Missing real publisher');
        expect(await materializeNextPendingMessage({ actorUserId: f.requester.id, sessionId: f.session.id,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready',
            publisherAuthority: { ...binding, committedFence: registered.committedFence } }))
            .toMatchObject({ ok: false, error: 'forbidden' });
        expect((await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
            sessionId: f.session.id, localId: f.input.localId } } })).deliveryState).toBeNull();
        const ownedSession = await db.session.create({ data: { accountId: f.custodian.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: false } });
        const ownBinding = { accountId: f.custodian.id, sessionId: ownedSession.id, machineId: f.selectedMachine.id };
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { ...ownBinding, data: 'owned-current-key' }))).toMatchObject({ ok: true });
        expect(await enqueuePendingMessage({ ...legacyInput, actorUserId: f.custodian.id, sessionId: ownedSession.id,
            localId: randomUUID() })).toMatchObject({ ok: true });
        const ownerPublisher = await presence.registerPublisher({ socket: createFakeSocket() as unknown as Socket,
            binding: ownBinding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (ownerPublisher.status !== 'registered') throw new Error('Missing released owner publisher');
        expect(await materializeNextPendingMessage({ actorUserId: f.custodian.id, sessionId: ownedSession.id,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready',
            publisherAuthority: { ...ownBinding, committedFence: ownerPublisher.committedFence } }))
            .toMatchObject({ ok: true, didMaterialize: true });
    });
});
