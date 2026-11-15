import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { decodeBase64, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { resolveSessionScopedSocketBinding } from '@/app/api/socket/sessionScopedBinding';
import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import { eventRouter, type ClientConnection } from '@/app/events/eventRouter';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { readSessionAccessAuthenticationFromSocket } from '@/app/session/access/sessionAccessAuthentication';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSessionFollowSourceRoutes, setSessionFollowSource } from './sessionFollowEdgeService';

/** Socket.IO is the only substituted boundary; publisher, write, access and Follow owners are real. */
describe('[p03redesign.T4] terminal-write ack follow facts', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-follow-terminal-ack-', initAuth: true,
            initEncrypt: false, initFiles: false, env: { HAPPIER_SERVER_IDENTITY_ID: 'srv_follow-terminal-ack',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'true' } });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it('returns the route read answer to the Session own publisher, and nothing without a request or to a runtime principal', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'terminal-ack', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: randomUUID() } });
        // The shipped default rule follows assigned Sessions; this one is assigned to its owner.
        const session = await db.session.create({ data: { accountId: owner.id, responsibleAccountId: owner.id,
            tag: randomUUID(), encryptionMode: 'plain', metadata: '{}', active: false } });
        const follower = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}', active: false } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'owner-binding' } });
        const binding = { accountId: owner.id, machineId: machine.id, sessionId: session.id };
        const admitted = await resolveSessionScopedSocketBinding({ userId: owner.id, ...binding });
        if (!admitted.ok) throw new Error('Publisher admission failed');
        const socket = createAuthenticatedFakeSocket({ data: { clientType: 'session-scoped', authTokenKind: 'account',
            sessionScopedBinding: admitted.binding } });
        const connection: ClientConnection = { connectionType: 'session-scoped', userId: owner.id,
            machineId: machine.id, sessionId: session.id, socket: socket as unknown as Socket };
        sessionUpdateHandler(owner.id, connection.socket, connection, { presence: createSessionPublisherPresence(), binding });
        eventRouter.clearIo();
        eventRouter.addConnection(owner.id, connection);
        const emit = async (event: string, payload: unknown) => {
            const acks: unknown[] = [];
            await getSocketHandler(socket, event)(payload, (ack: unknown) => acks.push(ack));
            return acks[0] as Record<string, unknown>;
        };
        const terminal = (localId: string, followFacts: boolean) => emit(SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1, { v: 1,
            sessionId: session.id, localId, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'done' } } },
            createdAt: 1_000, updatedAt: 1_000, provenance: { kind: 'non_dependent', source: 'external' },
            ...(followFacts ? { followFacts: true } : {}) });
        const routeRead = async (localId: string, seq: number) => {
            const row = await db.session.findUniqueOrThrow({ where: { id: session.id },
                select: { publisherGeneration: true, lastActiveAt: true } });
            const route = await observeSessionFollowSourceRoutes({ accountId: owner.id, sourceSessionId: session.id,
                authentication: readSessionAccessAuthenticationFromSocket(connection.socket),
                request: { v: 1, sourcePublisher: { machineId: machine.id, publisherGeneration: row.publisherGeneration.toString(),
                    committedFenceMs: row.lastActiveAt.getTime() }, sourceMessage: { localId, seq } } });
            if (!route.ok) throw new Error(`route read refused: ${route.error}`);
            return route;
        };
        try {
            expect(await emit('session-runtime-activity-snapshot', { sessionId: session.id, mutationId: randomUUID(),
                snapshot: { state: 'active', activeCount: 1 } })).toMatchObject({ status: 'applied' });

            // No request: the ack is unchanged.
            expect(await terminal('plain-row', false)).not.toHaveProperty('followRoutes');

            // 0 edges: the ack carries exactly the route read's facts for this original.
            const first = await terminal('terminal-1', true);
            const firstRoute = await routeRead('terminal-1', first.seq as number);
            expect(firstRoute.routes).toEqual([]);
            expect(first.followRoutes).toEqual({ edges: 'none', originalCreatedAt: firstRoute.originalCreatedAt,
                currentAccountFacts: firstRoute.currentAccountFacts });
            expect(firstRoute.currentAccountFacts?.defaultRelationships.assigned).toBe(true);

            // A follower added before the next terminal write is seen in its ack.
            expect(await setSessionFollowSource({ accountId: owner.id, sourceSessionId: session.id,
                destinationSessionId: follower.id, policy: { preset: 'important' },
                authentication: readSessionAccessAuthenticationFromSocket(connection.socket) })).toMatchObject({ ok: true });
            const second = await terminal('terminal-2', true);
            expect(second.followRoutes).toMatchObject({ edges: 'present' });
            expect((await routeRead('terminal-2', second.seq as number)).routes).toHaveLength(1);

            // A runtime principal cannot read the route, so it gets no facts either.
            connection.socket.data.authTokenKind = 'ephemeral_session_runner';
            expect(await terminal('terminal-3', true)).not.toHaveProperty('followRoutes');
        } finally {
            eventRouter.removeConnection(owner.id, connection);
        }
    });
});
