import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, FeaturesResponseSchema, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { deriveDiscussionFollowInputLocalIdV1, type SessionFollowDiscussionPendingObservationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SessionPendingEnqueueByMachineRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { writeSessionExplicitStopV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { SessionInputAdmissionReceiptV1Schema, readSessionInputRequest, readSessionMessageProvenance, settleSessionInputRequestV1, withSessionInputAuthorityV1,
    settleSessionMessageProvenanceV1, SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { auth } from '@/app/auth/auth';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { registerSessionLookupByTagsRoute } from '@/app/api/routes/session/registerSessionLookupByTagsRoute';
import { registerSessionFollowRoutes } from '@/app/api/routes/session/registerSessionFollowRoutes';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { createDiscussion, postDiscussionMessage } from '@/app/discussions/mutations';
import { inviteDiscussionParticipant } from '@/app/discussions/accessService';
import { enqueuePendingMessageByAuthenticatedMachine, materializeNextPendingMessage, settlePendingInputAdmission } from '@/app/session/pending/pendingMessageService';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { acknowledgeDiscussionFollowInputInTx, observePendingSessionFollowForDestinationInTx } from './sessionFollowEdgeService';
import { changeDeliveryMute } from './sessionDeliveryMuteService';

const authentication = createPresentUserSessionAccessAuthentication();

describe('Discussion Follow suppression custody (SQLite composition)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-discussion-suppression-', initAuth: true,
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_SESSIONS__ENABLED: '1',
            HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'true' } }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture() {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const receiver = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const other = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Discussion' }] };
        const created = await createDiscussion({ actorAccountId: account.id, authentication, request: buildDiscussionMutationRequestBodyV1({
            kind: 'create', creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Suppression' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [] },
        }) });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        for (const session of [receiver, other]) expect(await inviteDiscussionParticipant({ actorAccountId: account.id, authentication, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'when_addressed' } })).toMatchObject({ ok: true });
        const observe = async (sessionId = receiver.id) => {
            const result = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal: { kind: 'destination_runtime', destinationRuntimeAccountId: account.id, authentication }, destinationSessionId: sessionId,
            }));
            return result.observations.filter((row): row is SessionFollowDiscussionPendingObservationV1 => 'source' in row && row.source.kind === 'discussion');
        };
        const post = async () => {
            const authoredContent = { v: 1 as const, parts: [receiver, other].map(session => ({
                t: 'mention' as const, participant: { kind: 'session' as const, sessionId: session.id },
            })) };
            const result = await postDiscussionMessage({ actorAccountId: account.id, authentication, discussionId,
                request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: randomUUID(), content: { t: 'plain', v: authoredContent },
                    authoredContent, mentionedAccountIds: [], mentionedSessionIds: [receiver.id, other.id] }) });
            if (!result.ok) throw new Error(result.error);
            return result.value.message;
        };
        const mute = (operation: 'set' | 'remove') => changeDeliveryMute({ accountId: account.id, authentication, operation,
            receiver: { kind: 'session', sessionId: receiver.id }, scope: { kind: 'source', source: { kind: 'discussion', discussionId } } });
        return { account, receiver, other, discussionId, observe, post, mute };
    }

    it('keeps unavailable mute state and inactive or explicitly stopped receiver work retryable', async () => {
        const f = await fixture();
        const original = await f.post();
        await db.session.update({ where: { id: f.receiver.id }, data: { deliveryMutes: 'malformed' } });
        expect(await f.observe()).toEqual([]);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.receiver.id } })).toBe(0);
        await db.session.update({ where: { id: f.receiver.id }, data: { deliveryMutes: null, active: false } });
        expect((await f.observe()).map(row => row.addressing.messageId)).toEqual([original.id]);
        await db.session.update({ where: { id: f.receiver.id }, data: { metadata: JSON.stringify(writeSessionExplicitStopV1ToMetadata({}, {
            v: 1, cause: 'explicit_stop', requestId: randomUUID(), requestedAtMs: 1,
        })) } });
        expect((await f.observe()).map(row => row.addressing.messageId)).toEqual([original.id]);
        expect(await db.sessionFollowEdge.findFirstOrThrow({ where: { destinationSessionId: f.receiver.id, sourceDiscussionId: f.discussionId } }))
            .toMatchObject({ deliveredTranscriptSeq: original.seq - 1 });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.receiver.id } })).toBe(0);
    });

    it('settles muted originals without replay after remove and accepts only a fresh original once', async () => {
        const f = await fixture();
        const machine = await db.machine.create({ data: { id: randomUUID(), installationId: randomUUID(), accountId: f.account.id,
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] }, sessionMessageReply: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        await db.accessKey.create({ data: { accountId: f.account.id, machineId: machine.id, sessionId: f.receiver.id, data: 'encrypted' } });
        const socket = createAuthenticatedFakeSocket();
        const presence = createSessionPublisherPresence();
        sessionUpdateHandler(f.account.id, socket as never, { connectionType: 'session-scoped', socket, userId: f.account.id, sessionId: f.receiver.id } as never,
            { presence, binding: { accountId: f.account.id, machineId: machine.id, sessionId: f.receiver.id } });
        let snapshot: unknown;
        await getSocketHandler(socket, 'session-runtime-activity-snapshot')({ sessionId: f.receiver.id, mutationId: randomUUID(), snapshot: { state: 'idle', activeCount: 0 } },
            (value: unknown) => { snapshot = value; });
        expect(snapshot).toMatchObject({ status: expect.stringMatching(/^(applied|unchanged)$/) });
        await db.session.update({ where: { id: f.receiver.id }, data: { active: true,
            metadata: JSON.stringify({ machineId: machine.id, path: '/repo', claudeSessionId: 'discussion-suppression' }) } });
        const serverId = await getOrCreateServerIdentityId();
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        registerDiscussionRoutes(app); registerAccountEncryptionRoutes(app); registerSessionListingRoutes(app);
        registerSessionLookupByTagsRoute(app); registerSessionFollowRoutes(app); registerSessionMessageRoutes(app);
        sessionPendingRoutes(app);
        const origin = 'http://discussion-suppression.test';
        const { installAxiosFastifyAdapter } = await vi.importActual<{
            installAxiosFastifyAdapter(input: { app: typeof app; origin: string }): () => void;
        }>('../../../../../cli/src/testkit/http/axiosAdapter');
        const restoreHttp = installAxiosFastifyAdapter({ app, origin });
        const { runWithServerHttpBaseUrl } = await vi.importActual<{
            runWithServerHttpBaseUrl<T>(origin: string, run: () => Promise<T>): Promise<T>;
        }>('../../../../../cli/src/api/client/serverHttpBaseUrl');
        const admissions: string[] = [];
        const session = { sessionId: f.receiver.id, getServerBinding: () => ({ serverId, serverUrl: origin }),
            getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
                sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } },
                capabilities: { serverIdentity: { serverIdentityId: serverId } } }) }),
            runSessionFollowSourceRequest: <T>({ request }: { request: () => Promise<T> }) => runWithServerHttpBaseUrl(origin, request),
            getMachineAdmissionTransport: () => async (payload: unknown) => {
                const result = await enqueuePendingMessageByAuthenticatedMachine({ ...SessionPendingEnqueueByMachineRequestV1Schema.parse(payload),
                    accountId: f.account.id, sourceMachineId: machine.id });
                admissions.push(result.status === 'rejected' ? result.code : result.status);
                return result;
            } };
        // Dynamic runtime import keeps the CLI's private aliases out of server compilation.
        const { createDiscussionFollowInputIntake } = await vi.importActual<{
            createDiscussionFollowInputIntake(input: { session: typeof session; credentials: { token: string; encryption: null } }):
                (input: { observation: SessionFollowDiscussionPendingObservationV1; signal: AbortSignal }) => Promise<boolean>;
        }>('../../../../../cli/src/agent/runtime/session/follow/discussionFollowInput');
        const intake = createDiscussionFollowInputIntake({ session, credentials: { token: await auth.createToken(f.account.id, undefined,
            { kind: 'account', authority: 'present_user' }), encryption: null } });
        try {
            expect(await f.mute('set')).toMatchObject({ ok: true });
            const old = await f.post();
            const oldObservations = await f.observe();
            for (const observation of oldObservations) await intake({ observation, signal: new AbortController().signal });
            expect((await f.observe(f.other.id)).map(row => row.addressing.messageId)).toEqual([old.id]);
            expect(await f.mute('remove')).toMatchObject({ ok: true });
            expect(await f.observe()).toEqual([]);
            expect(await f.observe()).toEqual([]);
            for (const observation of oldObservations) expect(await intake({ observation, signal: new AbortController().signal })).toBe(false);
            const oldLocalId = deriveDiscussionFollowInputLocalIdV1({ discussionId: f.discussionId, messageId: old.id,
                throughSeq: old.seq, participantSessionId: f.receiver.id });
            expect(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: f.receiver.id, localId: oldLocalId } } }))
                .toMatchObject({ status: 'discarded', discardedReason: 'session_input_muted', inputAdmissionReceipt: { discussionAddressing: { messageId: old.id } } });
            expect(admissions[0]).toBe('session_input_muted');
            expect(admissions).not.toContain('accepted');
            expect(admissions).not.toContain('alreadyAccepted');
            expect(await db.sessionMessage.count({ where: { sessionId: f.receiver.id } })).toBe(0);
            expect(await db.session.findUniqueOrThrow({ where: { id: f.receiver.id } })).toMatchObject({ pendingCount: 0 });
            await expect(inTx(tx => acknowledgeDiscussionFollowInputInTx(tx, { addressing: {
                discussionId: f.discussionId, messageId: old.id, throughSeq: old.seq, participantSessionId: f.receiver.id,
            }, localInputId: oldLocalId }))).rejects.toThrow();
            expect(await db.sessionFollowEdge.findFirstOrThrow({ where: { destinationSessionId: f.receiver.id, sourceDiscussionId: f.discussionId } }))
                .toMatchObject({ deliveredTranscriptSeq: old.seq - 1 });
            const fresh = await f.post();
            const [observation] = await f.observe();
            expect(observation?.addressing.messageId).toBe(fresh.id);
            if (!observation) throw new Error('Fresh original missing');
            expect(await intake({ observation, signal: new AbortController().signal }), JSON.stringify(admissions)).toBe(true);
            expect(await intake({ observation, signal: new AbortController().signal })).toBe(true);
            expect(admissions.slice(-2)).toEqual(['accepted', 'alreadyAccepted']);
            const localId = deriveDiscussionFollowInputLocalIdV1(observation.addressing);
            const current = await db.session.findUniqueOrThrow({ where: { id: f.receiver.id } });
            const publisherAuthority = { accountId: f.account.id, sessionId: f.receiver.id, machineId: machine.id, committedFence: current.lastActiveAt };
            expect(await materializeNextPendingMessage({ actorUserId: f.account.id, sessionId: f.receiver.id, publisherAuthority,
                deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' }))
                .toMatchObject({ ok: true, didMaterialize: true, message: { localId } });
            const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: f.receiver.id, localId } } });
            if (pending.content.t !== 'plain') throw new Error('Expected plain fixture');
            const body = pending.content.v as Record<string, unknown>;
            const request = readSessionInputRequest(body.meta, 'stored');
            if (!request) throw new Error('Protected input missing');
            const receipt = SessionInputAdmissionReceiptV1Schema.parse(pending.inputAdmissionReceipt);
            const finalContent = { t: 'plain' as const, v: { ...body, meta: {
                ...withSessionInputAuthorityV1(body.meta, settleSessionInputRequestV1({ request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt })),
                [SESSION_MESSAGE_PROVENANCE_META_KEY]: settleSessionMessageProvenanceV1({ request,
                    requestedProvenance: readSessionMessageProvenance(body.meta, 'stored'), inputAdmissionReceipt: receipt }),
            } } };
            expect(await settlePendingInputAdmission({ actorUserId: f.account.id, sessionId: f.receiver.id, localId, publisherAuthority,
                decision: { kind: 'admit', finalContent, validation: { reply: { mode: 'return', discussion: observation.addressing,
                    ...(request.actionRequestAttributionV1 ? { actionRequestAttributionV1: request.actionRequestAttributionV1 } : {}) },
                    autonomousCheckIn: { afterTurns: 5 } } } }))
                .toMatchObject({ ok: true, result: { status: 'accepted', localId } });
            expect(await db.sessionMessage.findMany({ where: { sessionId: f.receiver.id }, select: { localId: true } })).toEqual([{ localId }]);
            expect(await f.observe()).toEqual([]);
        } finally {
            restoreHttp();
            await app.close();
            await presence.forgetDisconnectedPublisher({ socket });
        }
    });
});
