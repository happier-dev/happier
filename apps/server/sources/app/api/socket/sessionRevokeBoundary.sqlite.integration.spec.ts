import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1, SESSION_MESSAGE_REPLY_RELEASE_SOURCE_TURN_EVENT_V1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { eventRouter, type ClientConnection } from '@/app/events/eventRouter';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { enqueuePendingMessage, materializeNextPendingMessage, resolveAcceptedPendingDelivery } from '@/app/session/pending/pendingMessageService';
import { applySessionTurnMutation } from '@/app/session/sessionWriteService';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { resolveSessionScopedSocketBinding } from './sessionScopedBinding';
import { sessionUpdateHandler } from './sessionUpdateHandler';

describe('Machine withdrawal at the admitted reply boundary', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-revoke-turn-', initAuth: true,
            initEncrypt: false, initFiles: false, env: { HAPPIER_SERVER_IDENTITY_ID: 'srv_revoke-boundary-home',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it('finishes the admitted reply after removal, keeps its publisher alive, and refuses the next Send and reconnect', async () => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            metadata: encodePlainMachineStoredContent({ host: 'revoke-boundary', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/requester', happyHomeDir: '/home/requester/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }), dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            installationId: randomUUID(), operationProtocolCapabilities: {
                requesterExecutionIsolation: { protocolVersions: [1] },
                sessionInputAdmission: { protocolVersions: [1, 2, 3] },
            }, operationProtocolCapabilitiesRevision: 1 } });
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
            machineId: machine.id, principal: { kind: 'account', accountId: requester.id }, level: 'view' })))
            .toMatchObject({ kind: 'saved' });
        const session = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}', active: false } });
        await db.accessKey.create({ data: { accountId: requester.id, machineId: machine.id,
            sessionId: session.id, data: 'requester-binding' } });
        const binding = { accountId: requester.id, machineId: machine.id, sessionId: session.id };
        const admitted = await resolveSessionScopedSocketBinding({ userId: requester.id, ...binding });
        expect(admitted.ok).toBe(true);
        if (!admitted.ok) throw new Error('Publisher admission failed');
        // Socket.IO is the transport boundary; all access, publisher, input and transcript owners stay real.
        const socket = Object.assign(createAuthenticatedFakeSocket({ data: { clientType: 'session-scoped',
            sessionScopedBinding: admitted.binding } }), { disconnect: () => { socket.connected = false; } });
        const connection: ClientConnection = { connectionType: 'session-scoped', userId: requester.id,
            machineId: machine.id, sessionId: session.id, socket: socket as unknown as Socket };
        const presence = createSessionPublisherPresence();
        sessionUpdateHandler(requester.id, connection.socket, connection, { presence, binding });
        eventRouter.clearIo();
        eventRouter.addConnection(requester.id, connection);
        try {
            const activity = async (state: 'active' | 'idle') => {
                const acks: unknown[] = [];
                await getSocketHandler(socket, 'session-runtime-activity-snapshot')({ sessionId: session.id,
                    mutationId: randomUUID(), snapshot: { state, activeCount: state === 'active' ? 1 : 0 } },
                (ack: unknown) => acks.push(ack));
                return acks;
            };
            expect(await activity('active')).toEqual([expect.objectContaining({ status: 'applied' })]);
            const authentication = createPresentUserSessionAccessAuthentication();
            const send = (localId: string) => enqueuePendingMessage({ actorUserId: requester.id, sessionId: session.id,
                targetMachineId: machine.id, localId, authentication, requestedAction: { v: 1, kind: 'enqueue' }, reply: { mode: 'wait' },
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Reply with 1 through 300' } } } });
            const input = await send('admitted-input');
            expect(input, JSON.stringify(input)).toMatchObject({ ok: true });
            expect(await presence.runAsCurrentPublisher({ socket, operation: publisherAuthority => materializeNextPendingMessage({
                actorUserId: requester.id, sessionId: session.id, publisherAuthority,
                deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready',
            }) })).toMatchObject({ ok: true, didMaterialize: true });
            const turnId = randomUUID();
            expect(await applySessionTurnMutation({ actorUserId: requester.id, authentication,
                mutation: { v: 1, sessionId: session.id, mutationId: randomUUID(), action: 'begin', turnId,
                    observedAt: Date.now() } })).toMatchObject({ ok: true });
            const accepted = await presence.runAsCurrentPublisher({ socket, operation: publisherAuthority => resolveAcceptedPendingDelivery({
                actorUserId: requester.id, sessionId: session.id, localId: 'admitted-input', publisherAuthority,
                acceptedTurn: { kind: 'newTurn', turnId },
                acceptedDelivery: { t: 'plain', v: { v: 1, acceptedAtMs: Date.now(), delivery: { kind: 'newTurn', turnId } } },
            }) });
            expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true });
            // Native Run terminal evidence crosses the same admitted publisher boundary.
            const nativeInputId = randomUUID();
            await db.sessionMessage.create({ data: { sessionId: session.id, seq: 100, localId: nativeInputId,
                targetExecutionRunId: randomUUID(), acceptedTurnId: turnId, messageRole: 'user', content: { t: 'plain', v: {} } } });
            const reply = async (through: number, localId = 'admitted-reply') => {
                const acks: unknown[] = [];
                await getSocketHandler(socket, SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1)({ v: 1,
                    sessionId: session.id, localId, messageRole: 'agent',
                    content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text:
                        Array.from({ length: through }, (_, index) => String(index + 1)).join('\n') } } },
                    createdAt: 1, updatedAt: through, provenance: { kind: 'non_dependent', source: 'external' },
                }, (ack: unknown) => acks.push(ack));
                return acks;
            };
            expect(await reply(33)).toEqual([expect.objectContaining({ ok: true })]);
            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                machineId: machine.id, principal: { kind: 'account', accountId: requester.id } })))
                .toMatchObject({ kind: 'removed' });
            expect.soft(socket.connected).toBe(true);
            expect.soft(await presence.touchPublisher({ socket })).toMatchObject({ status: 'touched' });
            expect.soft(await presence.readCurrentPublisherPrecondition({ socket })).not.toBeNull();
            expect.soft(await activity('active')).toEqual([expect.objectContaining({ status: 'unchanged' })]);
            expect.soft(await reply(300)).toEqual([expect.objectContaining({ ok: true })]);
            expect.soft(await reply(300, 'admitted-completion')).toEqual([expect.objectContaining({ ok: true })]);
            for (const [event, request] of [
                [SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1, { v: 1, sessionId: session.id, requestSessionId: session.id,
                    requestLocalId: 'admitted-input', operation: { kind: 'fulfill', turnId, outcome: { kind: 'pass' } } }],
                [SESSION_MESSAGE_REPLY_RELEASE_SOURCE_TURN_EVENT_V1, { v: 1, sessionId: session.id,
                    sourceTurnId: turnId, sourceInputId: nativeInputId }],
            ] as const) {
                const acks: unknown[] = [];
                await getSocketHandler(socket, event)(request, (ack: unknown) => acks.push(ack));
                expect.soft(acks).toEqual([expect.objectContaining({ ok: true })]);
            }
            await activity('idle');
            const stored = await db.sessionMessage.findUniqueOrThrow({
                where: { sessionId_localId: { sessionId: session.id, localId: 'admitted-reply' } }, select: { content: true } });
            expect.soft(stored.content).toMatchObject({ t: 'plain', v: { content: { text:
                Array.from({ length: 300 }, (_, index) => String(index + 1)).join('\n') } } });
            expect.soft(await db.session.findUniqueOrThrow({ where: { id: session.id },
                select: { runtimeActivityState: true } })).toEqual({ runtimeActivityState: 'idle' });
            expect(await send('next-input')).toMatchObject({ ok: false, admissionRejectionCode: 'session_input_target_unavailable' });
            expect(await resolveSessionScopedSocketBinding({ userId: requester.id, ...binding })).toMatchObject({ ok: false });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId: 'next-input' } })).toBe(0);
            expect.soft(await presence.closePublisher({ socket })).toMatchObject({ status: 'closed' });
        } finally { eventRouter.removeConnection(requester.id, connection); }
    });
});
