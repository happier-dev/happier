import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { setEligibleMachineAccessGrantInTx as setMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { createFakeSocket } from '@/app/api/testkit/socketHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { eventRouter, type ClientConnection } from '@/app/events/eventRouter';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { removeSessionFollowSource, setSessionFollowSource } from '@/app/session/follow/sessionFollowEdgeService';
import { SessionFollowInputV1Schema, deriveSessionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { clearSessionExplicitStopV1FromMetadata, writeSessionExplicitStopV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { buildTrustedHostSessionInputAdmissionV1, SessionInputRequestV1Schema, withSessionInputRequestV1,
    withSessionInputAuthority, settleSessionInputRequestV1, settleSessionMessageProvenanceV1,
    SESSION_MESSAGE_PROVENANCE_META_KEY, type SessionInputRequestV1, type SessionInputAdmissionReceiptV1,
} from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { readStoredSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';
import { enqueuePendingMessage, materializeNextPendingMessage, resolveAcceptedPendingDelivery, settlePendingInputAdmission } from './pendingMessageService';
import { armPendingActivationAuthorizationInTx } from './pendingActivationAuthorization';
import { emitPendingActivationHint, emitPendingChanged, loadPendingActivationPublication } from './publishPendingMutation';

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

    function protectedContent(options: Pick<SessionInputRequestV1, 'replyIntent' | 'followDeliveryV1'> = {}) {
        const host = buildTrustedHostSessionInputAdmissionV1(options.followDeliveryV1 ? 'agent' : 'ui');
        const request = SessionInputRequestV1Schema.parse({ ...host.request, ...options });
        const meta = withSessionInputRequestV1({ [SESSION_MESSAGE_PROVENANCE_META_KEY]: host.provenance }, request);
        const content = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'admitted original' }, meta } };
        const finalContent = (receipt: SessionInputAdmissionReceiptV1) => ({ ...content, v: { ...content.v, meta: {
            ...withSessionInputAuthority(meta, settleSessionInputRequestV1({ request, inputAdmissionReceipt: receipt,
                currentSessionPermissionCeiling: 'default' })),
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: settleSessionMessageProvenanceV1({ request,
                requestedProvenance: host.provenance, inputAdmissionReceipt: receipt }),
        } } });
        return { content, finalContent };
    }

    async function admittedReceipt(sessionId: string, localId: string) {
        const original = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId, localId } } });
        const receipt = readStoredSessionInputAdmissionReceipt(original.inputAdmissionReceipt);
        if (!receipt) throw new Error('Expected the input admission owner to retain its receipt');
        return receipt;
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

    it('publishes an accepted activation from one decision of its current target', async () => {
        const f = await fixture();
        const result = await enqueuePendingMessage(f.input);
        if (!result.ok || !('activationTarget' in result) || !result.activationTarget) throw new Error('Missing accepted activation');
        // Prisma's tracing helper is the client's own instrumentation boundary: every client operation passes it.
        const operations: string[] = [];
        const instrumented = globalThis as { PRISMA_INSTRUMENTATION?: unknown };
        const previous = instrumented.PRISMA_INSTRUMENTATION;
        const selectedSocket = createFakeSocket();
        const connection: ClientConnection = { connectionType: 'machine-scoped', userId: f.custodian.id,
            machineId: f.selectedMachine.id, socket: selectedSocket as unknown as Socket };
        eventRouter.addConnection(connection.userId, connection);
        instrumented.PRISMA_INSTRUMENTATION = { helper: {
            isEnabled: () => false, getTraceParent: () => '00-10-10-00', dispatchEngineSpans: () => undefined, getActiveContext: () => undefined,
            runInChildSpan: (options: { name?: string; attributes?: { name?: string } } | string, callback: () => unknown) => {
                if (typeof options === 'object' && options.name === 'operation') operations.push(options.attributes?.name ?? '?');
                return callback();
            },
        } };
        try {
            await emitPendingChanged({ sessionId: f.session.id, changedByAccountId: f.requester.id,
                pendingCount: result.pendingCount, pendingVersion: result.pendingVersion,
                recipientCursors: result.recipientCursors, activationTarget: result.activationTarget });
        } finally {
            instrumented.PRISMA_INSTRUMENTATION = previous;
            eventRouter.removeConnection(connection.userId, connection);
        }
        expect(selectedSocket.emit).toHaveBeenCalledWith('ephemeral', expect.objectContaining({
            type: 'pending-activation-requested', target: f.target, requestId: f.input.localId }));
        // Each decision of the target reads its exact AccessKey binding once (the Machine grant currentness).
        expect(operations.filter(name => name === 'AccessKey.findMany')).toHaveLength(1);
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

    it.each(['before materialization', 'after materialization'] as const)(
        'settles materialized input after Machine grant withdrawal without resending and refuses a fresh input (%s)', async withdrawal => {
        const f = await fixture();
        const protectedInput = protectedContent();
        const input = { ...f.input, content: protectedInput.content };
        expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
        const finalContent = protectedInput.finalContent(await admittedReceipt(f.session.id, input.localId));
        const binding = { accountId: f.requester.id, sessionId: f.session.id, machineId: f.selectedMachine.id };
        const presence = createSessionPublisherPresence();
        const registered = await presence.registerPublisher({ socket: createFakeSocket() as unknown as Socket,
            binding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (registered.status !== 'registered') throw new Error('Expected the selected publisher to be admitted');
        const publisherAuthority = { ...binding, committedFence: registered.committedFence };
        const withdraw = async () => {
            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: f.custodian.id,
                machineId: f.selectedMachine.id, principal: { kind: 'account', accountId: f.requester.id } })))
                .toMatchObject({ kind: 'removed' });
            await db.machine.update({ where: { id: f.selectedMachine.id }, data: {
                operationProtocolCapabilities: {}, operationProtocolCapabilitiesRevision: null,
            } });
        };
        if (withdrawal === 'before materialization') await withdraw();
        expect(await materializeNextPendingMessage({ actorUserId: f.requester.id, sessionId: f.session.id,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready', publisherAuthority }))
            .toMatchObject({ ok: true, didMaterialize: true });
        if (withdrawal === 'after materialization') await withdraw();
        expect(await settlePendingInputAdmission({ actorUserId: f.requester.id, sessionId: f.session.id,
            localId: input.localId, publisherAuthority, decision: { kind: 'admit', finalContent } }))
            .toMatchObject({ ok: true, result: { status: 'accepted', localId: input.localId } });
        const settle = () => resolveAcceptedPendingDelivery({ actorUserId: f.requester.id, sessionId: f.session.id,
            localId: f.input.localId, publisherAuthority });
        expect(await settle()).toMatchObject({ ok: true, didResolve: true });
        expect(await settle()).toMatchObject({ ok: true, didResolve: false });
        expect(await db.sessionMessage.count({ where: { sessionId: f.session.id, localId: f.input.localId } })).toBe(1);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.session.id, localId: f.input.localId } })).toBe(0);
        expect(await enqueuePendingMessage({ ...f.input, localId: randomUUID() })).toMatchObject({ ok: false });
    });

    it('refuses settlement by a replacement installation of the admitted publisher', async () => {
        const f = await fixture();
        expect(await enqueuePendingMessage(f.input)).toMatchObject({ ok: true });
        const binding = { accountId: f.requester.id, sessionId: f.session.id, machineId: f.selectedMachine.id };
        const registered = await createSessionPublisherPresence().registerPublisher({ socket: createFakeSocket() as unknown as Socket,
            binding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (registered.status !== 'registered') throw new Error('Expected the selected publisher to be admitted');
        const publisherAuthority = { ...binding, committedFence: registered.committedFence };
        expect(await materializeNextPendingMessage({ actorUserId: f.requester.id, sessionId: f.session.id,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready', publisherAuthority }))
            .toMatchObject({ ok: true, didMaterialize: true });
        await db.machine.update({ where: { id: f.selectedMachine.id }, data: { installationId: randomUUID() } });
        expect(await resolveAcceptedPendingDelivery({ actorUserId: f.requester.id, sessionId: f.session.id,
            localId: f.input.localId, publisherAuthority })).toMatchObject({ ok: false, error: 'forbidden' });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.session.id, localId: f.input.localId } })).toBe(1);
    });

    it('settles an admitted human ask after its target share is withdrawn and refuses a new ask', async () => {
        const f = await fixture();
        const human = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: human.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: f.session.id, createdByAccountId: f.requester.id,
            accountId: human.id, accessLevel: 'edit' } });
        const reply = { mode: 'return', humanOrigin: { sessionId: source.id } } as const;
        await db.machine.update({ where: { id: f.selectedMachine.id }, data: { operationProtocolCapabilities: {
            sessionInputAdmission: { protocolVersions: [1, 2] }, sessionMessageReply: { protocolVersions: [1] },
        } } });
        const protectedInput = protectedContent({ replyIntent: reply });
        const input = { ...f.input, actorUserId: human.id, reply, content: protectedInput.content };
        expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
        const finalContent = protectedInput.finalContent(await admittedReceipt(f.session.id, input.localId));
        const binding = { accountId: f.requester.id, sessionId: f.session.id, machineId: f.selectedMachine.id };
        const registered = await createSessionPublisherPresence().registerPublisher({ socket: createFakeSocket() as unknown as Socket,
            binding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (registered.status !== 'registered') throw new Error('Expected the selected publisher to be admitted');
        const publisherAuthority = { ...binding, committedFence: registered.committedFence };
        expect(await materializeNextPendingMessage({ actorUserId: f.requester.id, sessionId: f.session.id,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready', publisherAuthority }))
            .toMatchObject({ ok: true, didMaterialize: true });
        await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: f.session.id, accountId: human.id } });
        expect(await settlePendingInputAdmission({ actorUserId: f.requester.id, sessionId: f.session.id,
            localId: input.localId, publisherAuthority,
            decision: { kind: 'admit', finalContent, validation: { reply } } }))
            .toMatchObject({ ok: true, result: { status: 'accepted', localId: input.localId } });
        expect(await enqueuePendingMessage({ ...input, localId: randomUUID() })).toMatchObject({ ok: false });
    });

    it.each(['kept', 'removed'] as const)('reconciles a stopped receiver’s claimed Follow after its route is %s', async (route) => {
        const f = await fixture();
        const source = await db.session.create({ data: { accountId: f.requester.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const stopped = writeSessionExplicitStopV1ToMetadata({}, {
            v: 1, cause: 'explicit_stop', requestId: 'receiver-stop', requestedAtMs: Date.now(),
        });
        await db.session.update({ where: { id: f.session.id }, data: { metadata: JSON.stringify(stopped) } });
        const follow = { accountId: f.requester.id, sourceSessionId: source.id, destinationSessionId: f.session.id, authentication };
        expect(await setSessionFollowSource({ ...follow, policy: { preset: 'everything' } })).toMatchObject({ ok: true });
        const terminalAt = BigInt(Date.now());
        const sourceTurn = { id: randomUUID(), status: 'completed' } as const;
        await db.sessionTurn.create({ data: { sessionId: source.id, turnId: sourceTurn.id, status: sourceTurn.status,
            startedAt: terminalAt, updatedAt: terminalAt, terminalAt } });
        await db.session.update({ where: { id: source.id }, data: { latestTurnId: sourceTurn.id, latestTurnStatus: sourceTurn.status } });
        const occurrences = [];
        for (const [seq, kind, delivery] of [[1, 'update_posted', 'wake'], [2, 'message', 'next_turn']] as const) {
            const sourceMessage = { seq, localId: randomUUID() };
            await db.sessionMessage.create({ data: { sessionId: source.id, ...sourceMessage, messageRole: 'agent',
                content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'source update' } } } } });
            await db.session.update({ where: { id: source.id }, data: { seq } });
            occurrences.push({ delivery, original: { sourceSessionId: source.id, sourceMessage }, event: { kind } });
        }
        occurrences.push({ delivery: 'wake', original: { sourceSessionId: source.id, sourceTurn }, event: { kind: 'finished' } });
        const originals = [];
        for (const occurrence of occurrences) {
            const followDeliveryV1 = SessionFollowInputV1Schema.parse({ v: 1, ...occurrence });
            const protectedInput = protectedContent({ followDeliveryV1 });
            const localId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: f.session.id, original: followDeliveryV1.original });
            expect(await enqueuePendingMessage({ ...f.input, localId, followDeliveryV1,
                requestedAction: { v: 1, kind: 'enqueue' }, followRelations: [{ relation: 'follower' }],
                content: protectedInput.content })).toMatchObject({ ok: true });
            originals.push({ localId, delivery: followDeliveryV1.delivery,
                finalContent: protectedInput.finalContent(await admittedReceipt(f.session.id, localId)) });
        }
        const laterInput = { ...f.input, localId: randomUUID(), requestedAction: { v: 1, kind: 'enqueue' } as const };
        expect(await enqueuePendingMessage(laterInput)).toMatchObject({ ok: true });
        if (route === 'removed') expect(await removeSessionFollowSource(follow)).toEqual({ ok: true, value: { changed: true } });
        await db.session.update({ where: { id: f.session.id }, data: {
            metadata: JSON.stringify(clearSessionExplicitStopV1FromMetadata(stopped, 'receiver-stop')),
        } });
        const binding = { accountId: f.requester.id, sessionId: f.session.id, machineId: f.selectedMachine.id };
        const registered = await createSessionPublisherPresence().registerPublisher({ socket: createFakeSocket() as unknown as Socket,
            binding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (registered.status !== 'registered') throw new Error('Expected the selected publisher to be admitted');
        const publisherAuthority = { ...binding, committedFence: registered.committedFence };
        const materialize = () => materializeNextPendingMessage({ actorUserId: f.requester.id, sessionId: f.session.id,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready', publisherAuthority });
        const reconcile = (input: { localId: string; finalContent: (typeof originals)[number]['finalContent'] }) =>
            settlePendingInputAdmission({ actorUserId: f.requester.id, sessionId: f.session.id,
                localId: input.localId, publisherAuthority, decision: { kind: 'admit', finalContent: input.finalContent } });
        const accepted = (localId: string) => resolveAcceptedPendingDelivery({ actorUserId: f.requester.id,
            sessionId: f.session.id, localId, publisherAuthority });
        const cancellation = { ok: true, result: { status: 'rejected', code: 'session_input_cancelled' } };
        for (const [index, original] of originals.entries()) {
            expect(await materialize()).toMatchObject({ ok: true, didMaterialize: true, message: { localId: original.localId } });
            const admitted = await reconcile(original);
            if (route === 'kept' || original.delivery === 'wake') {
                expect(admitted).toMatchObject({ ok: true, result: { status: 'accepted', localId: original.localId } });
            } else {
                expect(admitted).toMatchObject(cancellation);
            }
            if (route === 'kept') {
                expect(await reconcile(original)).toMatchObject({ ok: true, result: { status: 'alreadyAccepted', localId: original.localId } });
                return;
            }
            expect(await reconcile(original)).toMatchObject({ ...cancellation, pendingCount: 3 - index });
            const row = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                sessionId: f.session.id, localId: original.localId,
            } } });
            expect(row).toMatchObject({ status: 'discarded', discardedReason: 'session_input_cancelled' });
            expect(await reconcile(original)).toMatchObject({ ...cancellation, pendingCount: 3 - index });
            const replayedRow = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                sessionId: f.session.id, localId: original.localId,
            } } });
            expect(replayedRow.updatedAt).toEqual(row.updatedAt);
        }
        expect(await materialize()).toMatchObject({ ok: true, didMaterialize: true, message: { localId: laterInput.localId } });
        expect(await accepted(laterInput.localId)).toMatchObject({ ok: true, didResolve: true });
        expect(await accepted(laterInput.localId)).toMatchObject({ ok: true, didResolve: false });
        expect(await materialize()).toMatchObject({ ok: true, didMaterialize: false, pendingCount: 0 });
        expect(await db.sessionMessage.count({ where: { sessionId: f.session.id, localId: laterInput.localId } })).toBe(1);
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
