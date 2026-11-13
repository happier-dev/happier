import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { eventRouter } from '@/app/events/eventRouter';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionMessageRoutes } from './registerSessionMessageRoutes';
import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { sessionPendingRoutes } from './pendingRoutes';
import { inTx } from '@/storage/inTx';
import { createSessionMessageFromPending } from '@/app/session/pending/pendingMessageTranscriptCommit';
import { applySessionTurnMutation } from '@/app/session/sessionWriteService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1, SessionMessageReplyMutationResultV1Schema,
    deriveSessionMessageReplyReturnLocalIdV1, SessionMessageReplyProgressV1Schema, SESSION_MESSAGE_REPLY_RELEASE_SOURCE_TURN_EVENT_V1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { enqueuePendingMessageByAuthenticatedMachine, updatePendingMessage, sendPendingDeliveryAsNew, deletePendingMessage, enqueuePendingMessage, discardPendingMessage,
    materializeNextPendingMessage, settlePendingInputAdmission, resolveAcceptedPendingDelivery, blockPendingDelivery } from '@/app/session/pending/pendingMessageService';
import type { SessionInputSettlementValidationV1 } from '@happier-dev/protocol/sessions/messages/sessionPendingAdmissionSettlementV1';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { buildTrustedHostSessionInputAdmissionV1, withSessionInputRequestV1, withSessionInputAuthorityV1, settleSessionInputRequestV1,
    withSessionInputRequest, withSessionInputAuthority, settleSessionInputRequestV2, deriveWorkflowSessionInputLocalIdV2,
    settleSessionMessageProvenanceV1, SESSION_MESSAGE_PROVENANCE_META_KEY,
    type SessionInputRequestV1, SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { machinesRoutes } from '../machines/machinesRoutes';
import { machineUpdateHandler } from '@/app/api/socket/machineUpdateHandler';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { auth } from '@/app/auth/auth';
import { SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1 } from '@happier-dev/protocol/sessions/messages/sessionTranscriptPageLimits';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { bindSessionInputReplyAcceptedTurnInTx, createSessionInputReplyProgressInTx, isSessionInputSourceCurrentInTx, readSessionMessageReplyInTx,
    mutateSessionMessageReplyForMachineInTx, projectSessionInputRepliesFromTurnInTx } from '@/app/session/messages/sessionMessageReply';
import { createDiscussion, postDiscussionMessage } from '@/app/discussions/mutations';
import { inviteDiscussionParticipant } from '@/app/discussions/accessService';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { removeMachineAccessGrantInTx, resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { changeDeliveryMute } from '@/app/session/follow/sessionDeliveryMuteService';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';

const authentication = createPresentUserSessionAccessAuthentication();

describe('original Session input reply custody', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-n1-s3-reply-', initAuth: true, env: {
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_SHARING_SESSION__ENABLED: '1',
        } });
        await getOrCreateServerIdentityId();
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('reads the existing exact recovery refusal without accepting input or exposing a foreign Session', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const localId = 'unavailable-run-recovery';
        const pending = await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId, position: 1,
            targetExecutionRunId: 'unavailable-run', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Recover' } } },
            requestedAction: { v: 2, kind: 'recover_execution_run' }, status: 'queued', deliveryState: 'blocked',
            deliveryBlockedReason: 'session_input_target_unavailable', providerAction: null } });
        await withAuthenticatedTestApp(app => registerSessionMessageRoutes(app), async app => {
            const read = (accountId: string) => app.inject({ method: 'GET',
                url: `/v2/sessions/${session.id}/messages/by-local-id/${localId}`, headers: { 'x-test-user-id': accountId } });
            const result = await read(account.id);
            expect(result.statusCode).toBe(404);
            expect(result.json()).toEqual({ error: 'Message not found', inputDisposition: { localId,
                result: { status: 'rejected', code: 'session_input_target_unavailable' } } });
            expect((await read(foreign.id)).json()).not.toHaveProperty('inputDisposition');
            // Neither queued recovery nor an ordinary blocked input proves this refusal.
            await db.sessionPendingMessage.update({ where: { id: pending.id }, data: { deliveryState: null, deliveryBlockedReason: null } });
            expect((await read(account.id)).json()).not.toHaveProperty('inputDisposition');
            await db.sessionPendingMessage.update({ where: { id: pending.id }, data: { deliveryState: 'blocked',
                deliveryBlockedReason: 'session_input_target_unavailable', requestedAction: { v: 1, kind: 'enqueue' } } });
            expect((await read(account.id)).json()).not.toHaveProperty('inputDisposition');
        });
        expect(await db.sessionMessage.count({ where: { sessionId: session.id, localId } })).toBe(0);
        expect(await db.sessionPendingMessage.findUnique({ where: { id: pending.id } })).not.toBeNull();
    });

    it('reads the exact external input native-start witness and canonical waiting state without C2 counting', async () => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, localId: 'external-input', messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'External work' } } },
            acceptedTurnId: 'external-turn', acceptedTurnKind: 'newTurn', autonomousExchangeCause: 'person',
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' } } });
        const begin = await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: {
            v: 1, sessionId: session.id, mutationId: 'external-begin', action: 'begin', turnId: 'external-turn',
            startingInputId: 'external-input', initiator: 'user', workDepth: 0, observedAt: 10,
        } });
        expect(begin).toMatchObject({ ok: true, didApply: true });
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: {
            v: 1, sessionId: session.id, mutationId: 'external-wait', action: 'wait', turnId: 'external-turn', observedAt: 20,
        } })).toMatchObject({ ok: true, didApply: true });
        await withAuthenticatedTestApp(app => registerSessionMessageRoutes(app), async app => {
            const result = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/messages/by-local-id/external-input`,
                headers: { 'x-test-user-id': account.id } });
            expect(result.statusCode).toBe(200);
            expect(result.json()).toMatchObject({ message: { localId: 'external-input', acceptedTurnId: 'external-turn',
                turnStartWitnessId: 'external-turn', turn: { turnId: 'external-turn', status: 'waiting', initiator: 'user' } } });
        });
        expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: 'external-input' } } }))
            .toMatchObject({ acceptedTurnCounted: false, autonomousExchangeState: null, autonomousExchangeRootSessionId: null, autonomousExchangeRootLocalId: null });
    });

    it('reads one exact demand batch without substituting an unrelated original or disclosing a foreign Session', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const makeSession = (accountId: string) => db.session.create({ data: { accountId, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const target = await makeSession(account.id);
        const hidden = await makeSession(foreign.id);
        for (const session of [target, hidden]) await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1,
            localId: 'original', messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Question' } } },
            replyProgress: { v: 1, mode: 'wait', disposition: 'inline', outcome: { kind: 'pass' } } } });
        await withAuthenticatedTestApp(app => registerSessionMessageRoutes(app), async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/sessions/messages/replies/read-batch',
                headers: { 'x-test-user-id': account.id }, payload: { requests: [
                    { sessionId: target.id, localId: 'original' }, { sessionId: target.id, localId: 'not-admitted' },
                    { sessionId: hidden.id, localId: 'original' },
                ] } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ results: [
                { sessionId: target.id, localId: 'original', reply: { status: 'available', progress: { outcome: { kind: 'pass' } } } },
                { sessionId: target.id, localId: 'not-admitted', reply: { status: 'unavailable' } },
                { sessionId: hidden.id, localId: 'original', reply: { status: 'unavailable' } },
            ] });
            const restricted = await app.inject({ method: 'POST', url: '/v2/sessions/messages/replies/read-batch',
                headers: { 'x-test-user-id': account.id, 'x-test-auth-token-kind': 'api_token' },
                payload: { requests: [{ sessionId: target.id, localId: 'original' }] } });
            expect(restricted.statusCode).toBe(403);
        });
    });

    it('acquires a thousand demanded reply originals as sets across Sessions', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sessions = await Promise.all(Array.from({ length: 3 }, () => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
        } })));
        const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionMessage.create({ data: { sessionId: source.id, seq: 1, localId: 'source-input', messageRole: 'user',
            acceptedTurnId: 'source-turn', content: { t: 'plain', v: { text: 'Ask the workers' } } } });
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: {
            v: 1, sessionId: source.id, mutationId: 'source-begin', action: 'begin', turnId: 'source-turn',
            startingInputId: 'source-input', initiator: 'user', workDepth: 0, observedAt: 10,
        } })).toMatchObject({ ok: true });
        const sourceSession = { sourceSessionId: source.id, sourceTurnId: 'source-turn', sourceInputId: 'source-input', via: 'action' };
        const requests = Array.from({ length: 1000 }, (_, index) => ({ sessionId: sessions[index % sessions.length]!.id, localId: `ask-${index}` }));
        await db.sessionMessage.createMany({ data: requests.map((key, index) => ({ ...key, seq: index + 1, messageRole: 'user',
            content: { t: 'plain', v: { text: 'Question' } }, replyProgress: { v: 1, mode: 'wait', sourceSession, disposition: 'inline', outcome: { kind: 'pass' } },
        })) });
        const pending = await db.sessionPendingMessage.create({ data: { ...requests[0]!, position: 1,
            content: { t: 'plain', v: { text: 'Question' } }, requestedAction: { v: 1, kind: 'enqueue' },
            replyProgress: { v: 1, mode: 'wait', sourceSession, disposition: 'inline', outcome: { kind: 'failed' } },
        } });
        await withAuthenticatedTestApp(app => registerSessionMessageRoutes(app), async app => {
            const reads: string[] = [];
            const accessReads: string[] = [];
            const sourceReads: string[] = [];
            const restore = observeSqliteRequests({ before: request => {
                if (['SessionPendingMessage', 'SessionMessage'].includes(request.model ?? '') && request.action.startsWith('find'))
                    reads.push(`${request.model}.${request.action}`);
                if (request.model === 'Session' && request.action.startsWith('find')) accessReads.push(request.action);
                if (['SessionMessage', 'SessionTurn'].includes(request.model ?? '') && request.action === 'findUnique')
                    sourceReads.push(`${request.model}.${request.action}`);
            } });
            try {
                const response = await app.inject({ method: 'POST', url: '/v2/sessions/messages/replies/read-batch',
                    headers: { 'x-test-user-id': account.id }, payload: { requests } });
                expect(response.statusCode).toBe(200);
                expect(response.json().results).toHaveLength(requests.length);
                expect(response.json().results.every((row: { reply: { status: string } }) => row.reply.status === 'available')).toBe(true);
                expect(response.json().results[0].reply.progress.outcome).toEqual({ kind: 'failed' });
                // Physical persistent acquisitions, observed without replacing database IO.
                // Six original-set reads plus the shared exact-source witness/recipient reads.
                expect(reads.length).toBeLessThanOrEqual(9);
                expect(accessReads.length).toBeLessThanOrEqual(1);
                expect(sourceReads.length).toBeLessThanOrEqual(3);
            } finally { restore(); }
            await db.sessionPendingMessage.delete({ where: { id: pending.id } });
            const retired = await app.inject({ method: 'POST', url: '/v2/sessions/messages/replies/read-batch',
                headers: { 'x-test-user-id': account.id }, payload: { requests: [requests[0]!] } });
            expect(retired.json().results[0].reply.progress.outcome).toEqual({ kind: 'pass' });
            await db.session.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
            const revoked = await app.inject({ method: 'POST', url: '/v2/sessions/messages/replies/read-batch',
                headers: { 'x-test-user-id': account.id }, payload: { requests: [requests[0]!] } });
            expect(revoked.json().results[0].reply.status).toBe('unavailable');
        });
    });

    it('keeps an idempotent composer source entry out of user input and turn admission even when targeting itself', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const { projectSessionMessageInvocationV1, deriveSessionMessageInvocationLocalIdV1 } = await import('@happier-dev/protocol/sessions/messages/sessionMessageInvocationV1');
        const invocation = projectSessionMessageInvocationV1({ serverId: 'home', localId: 'self-input', requestLocalId: 'self-input',
            target: source.id, reply: 'return', result: { ok: true, result: { status: 'accepted', localId: 'self-input' } } });
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: 'self-input', seq: 1, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Original admitted input' } } } } });
        await db.session.update({ where: { id: source.id }, data: { seq: 1 } });
        const body = { localId: deriveSessionMessageInvocationLocalIdV1(invocation.localId), messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: 'entry', data: {
                type: 'message', message: 'Question', sessionMessageInvocationV1: invocation,
            } } } } };
        await withAuthenticatedTestApp(app => registerSessionMessageRoutes(app), async app => {
            const write = () => app.inject({ method: 'POST', url: `/v2/sessions/${source.id}/messages`,
                headers: { 'x-test-user-id': account.id }, payload: body });
            expect((await write()).statusCode).toBe(200);
            expect((await write()).statusCode).toBe(200);
            invocation.targets[0]!.immediate.status = 'alreadyAccepted';
            const retryUpdate = await write();
            expect(retryUpdate.statusCode).toBe(200);
            expect(retryUpdate.json()).toMatchObject({ didWrite: false, didUpdate: true });
            const read = await app.inject({ method: 'GET', url: `/v2/sessions/${source.id}/messages/by-local-id/${encodeURIComponent(body.localId)}`,
                headers: { 'x-test-user-id': account.id } });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toMatchObject({ message: { messageRole: 'event', content: body.content } });
            const editor = await db.account.create({ data: { encryptionMode: 'plain' } });
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: source.id, createdByAccountId: account.id,
                accountId: editor.id, accessLevel: 'edit', canApprovePermissions: false } });
            invocation.targets[0]!.target.sessionId = 'different-receiver';
            invocation.targets[0]!.immediate.status = 'rejected';
            const replaced = await app.inject({ method: 'POST', url: `/v2/sessions/${source.id}/messages`,
                headers: { 'x-test-user-id': editor.id }, payload: body });
            // This is ordinary editable presentation, not protected replay
            // custody. Editing it still cannot admit input or start a turn.
            expect(replaced.statusCode).toBe(200);
        });
        expect(await db.sessionMessage.count({ where: { sessionId: source.id } })).toBe(2);
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: source.id, localId: 'self-input' } } })).messageRole).toBe('user');
        expect(await db.sessionPendingMessage.count({ where: { sessionId: source.id } })).toBe(0);
        expect(await db.sessionTurn.count({ where: { sessionId: source.id } })).toBe(0);
    });

    it.each(['pass', 'answer', 'cancelled'] as const)('retains a Workflow V2 %s at the original input through retirement and final replay', async outcomeKind => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), installationId: randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] }, sessionMessageReply: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const workflow = { purpose: 'invocation', runId: 'workflow-run', invocationRecordId: randomUUID() } as const;
        const request = { v: 2, producer: 'workflow', caller: { kind: 'host' }, workflow, permission: {}, replyIntent: { mode: 'wait' } } as const;
        const localId = deriveWorkflowSessionInputLocalIdV2(workflow);
        const content = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'Review the proposal' },
            meta: withSessionInputRequest({}, request) } };
        const admission = { accountId: account.id, sourceMachineId: machine.id, targetMachineId: machine.id, sessionId: session.id,
            localId, content, reply: { mode: 'wait' as const }, requestedAction: { v: 1 as const, kind: 'enqueue' as const } };
        if (outcomeKind === 'pass') {
            await db.machine.update({ where: { id: machine.id }, data: {
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
            } });
            expect(await enqueuePendingMessageByAuthenticatedMachine(admission)).toMatchObject({
                status: 'rejected', code: 'session_input_target_update_required',
            });
            expect(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId } } })).toBeNull();
            // Recover through the actual authenticated publication handler;
            // admission below must read its acknowledged durable projection.
            const machineSocket = Object.assign(createAuthenticatedFakeSocket({ data: { clientType: 'machine-scoped',
                machineId: machine.id, verifiedMachineInstallationId: machine.installationId } }), {
                handshake: { auth: { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }) } },
            });
            machineUpdateHandler(account.id, machineSocket as never, {
                operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524288 } },
            });
            let publication: unknown;
            await getSocketHandler(machineSocket, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1)({
                machineId: machine.id, capabilities: machine.operationProtocolCapabilities,
            }, (value: unknown) => { publication = value; });
            expect(publication).toMatchObject({ v: 1, result: 'success', revision: 2 });
        }
        expect(await enqueuePendingMessageByAuthenticatedMachine(admission)).toEqual({ status: 'accepted', localId });
        const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } });
        const authority = settleSessionInputRequestV2({ request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: pending.inputAdmissionReceipt });
        const input = await inTx(async tx => {
            const committed = await createSessionMessageFromPending(tx, { sessionId: session.id, sessionEncryptionMode: 'plain', storagePolicy: 'optional',
                localId, content: { ...content, v: { ...content.v, meta: withSessionInputAuthority({}, authority) } }, messageRole: 'user',
                requestContentForEquality: content, inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.parse(pending.inputAdmissionReceipt),
                pendingRequestedAction: admission.requestedAction });
            if (!committed.ok) throw new Error('Workflow input materialization failed');
            await tx.sessionPendingMessage.delete({ where: { id: pending.id } });
            return committed.message;
        });
        const turnId = randomUUID();
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: { v: 1, sessionId: session.id,
            turnId, mutationId: randomUUID(), action: 'begin', observedAt: Date.now(), transcriptAnchors: { userMessageSeqs: [input.seq] } } })).toMatchObject({ ok: true });
        // Explicit fulfillment uses the Session publisher; the Machine only recovers disposition.
        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(account.id, socket as never, { connectionType: 'session-scoped', socket, userId: account.id, sessionId: session.id } as never,
            { presence: createSessionPublisherPresence(), binding: { accountId: account.id, machineId: machine.id, sessionId: session.id } });
        await getSocketHandler(socket, 'session-runtime-activity-snapshot')({ sessionId: session.id, mutationId: randomUUID(), snapshot: { state: 'idle', activeCount: 0 } }, () => {});
        if (outcomeKind === 'pass') {
            let response: unknown;
            await getSocketHandler(socket, SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1)({ v: 1, sessionId: session.id,
                requestSessionId: session.id, requestLocalId: localId, operation: { kind: 'fulfill', turnId, outcome: { kind: 'pass' } } },
            (value: unknown) => { response = value; });
            expect(response).toMatchObject({ ok: true, progress: { outcome: { kind: 'pass' } } });
        }
        const final = await db.sessionMessage.create({ data: { sessionId: session.id, seq: input.seq + 1, messageRole: 'agent',
            content: { t: 'plain', v: { text: 'Exact final answer' } } } });
        const terminal = { v: 1 as const, sessionId: session.id, turnId, mutationId: randomUUID(),
            action: outcomeKind === 'cancelled' ? 'cancel' as const : 'complete' as const, observedAt: Date.now() + 1,
            ...(outcomeKind === 'cancelled' ? {} : { transcriptAnchors: {
                startSeqInclusive: input.seq, endSeqInclusive: final.seq, finalAssistantMessageSeq: final.seq } }) };
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: terminal })).toMatchObject({ ok: true });
        // Cancel has no transcript payload; the durable final arrives through
        // the canonical late-anchor operation and enriches the same outcome.
        if (outcomeKind === 'cancelled') expect(await applySessionTurnMutation({ actorUserId: account.id, authentication,
            mutation: { v: 1, sessionId: session.id, turnId, mutationId: randomUUID(), action: 'append_transcript_anchors',
                observedAt: Date.now() + 2, transcriptAnchors: { startSeqInclusive: input.seq, endSeqInclusive: final.seq,
                    finalAssistantMessageSeq: final.seq } } })).toMatchObject({ ok: true });
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            const url = `/v2/sessions/${session.id}/messages/by-local-id/${localId}/reply`;
            const headers = { 'x-test-user-id': account.id };
            const expected = outcomeKind === 'pass' ? { kind: 'pass' } : { kind: outcomeKind, result: { sessionId: session.id, messageId: final.id } };
            expect((await app.inject({ method: 'GET', url, headers })).json()).toMatchObject({ status: 'available', progress: { mode: 'wait', workflow, acceptedTurnId: turnId, outcome: expected } });
            expect((await app.inject({ method: 'POST', url, headers, payload: { kind: 'inline' } })).json()).toMatchObject({ ok: true, progress: { disposition: 'inline', outcome: expected } });
            expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: terminal })).toMatchObject({ ok: true });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toMatchObject({ progress: { disposition: 'inline', outcome: expected } });
        });
    });

    it.each([
        { reason: 'provider_rejected_before_acceptance', previouslyBlocked: false },
        { reason: 'provider_unavailable_before_acceptance', previouslyBlocked: false },
        { reason: 'provider_rejected_before_acceptance', previouslyBlocked: true },
    ] as const)('settles only a definitive exact Workflow refusal before provider acceptance ($reason, retained block=$previouslyBlocked)', async ({ reason, previouslyBlocked }) => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), installationId: randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] }, sessionMessageReply: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const workflow = { purpose: 'invocation', runId: 'workflow-run', invocationRecordId: randomUUID() } as const;
        const request = { v: 2, producer: 'workflow', caller: { kind: 'host' }, workflow, permission: {}, replyIntent: { mode: 'wait' } } as const;
        const localId = deriveWorkflowSessionInputLocalIdV2(workflow);
        const content = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'Review the proposal' },
            meta: withSessionInputRequest({}, request) } };
        // The sidecar cannot redirect the protected original to a different invocation.
        expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: account.id,
            sourceMachineId: machine.id, targetMachineId: machine.id, sessionId: session.id, localId, content,
            reply: { mode: 'wait', workflow: { ...workflow, invocationRecordId: randomUUID() } },
            requestedAction: { v: 1, kind: 'enqueue' } })).toMatchObject({ status: 'rejected', code: 'session_input_invalid' });
        expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: account.id,
            sourceMachineId: machine.id, targetMachineId: machine.id, sessionId: session.id, localId,
            content,
            reply: { mode: 'wait' }, requestedAction: { v: 1, kind: 'enqueue' } })).toEqual({ status: 'accepted', localId });
        const unrelated = { actorUserId: account.id, sessionId: session.id, localId: 'unrelated-ask', authentication };
        expect(await enqueuePendingMessage({ ...unrelated, content: { t: 'plain', v: { text: 'Another input' } },
            requestedAction: { v: 1, kind: 'enqueue' }, reply: { mode: 'wait' } })).toMatchObject({ ok: true });
        if (previouslyBlocked) {
            // Retained rows from the missing-settlement producer already carry
            // the exact refusal, but have no C2 outcome to wake their observer.
            await db.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId: session.id, localId } },
                data: { deliveryState: 'blocked', deliveryBlockedReason: reason } });
            await db.session.update({ where: { id: session.id },
                data: { pendingBlockedCount: { increment: 1 }, pendingVersion: { increment: 1 } } });
        }
        const block = () => blockPendingDelivery({ actorUserId: account.id, sessionId: session.id, localId, reason, authentication });
        expect(await block()).toMatchObject({ ok: true, didUpdate: !previouslyBlocked });
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            const read = () => app.inject({ method: 'GET',
                url: `/v2/sessions/${session.id}/messages/by-local-id/${encodeURIComponent(localId)}/reply`,
                headers: { 'x-test-user-id': account.id } });
            const response = await read();
            expect(response.statusCode).toBe(200);
            const progress = SessionMessageReplyProgressV1Schema.parse(response.json().progress);
            expect(progress.workflow).toEqual(workflow);
            expect(progress.acceptedTurnId).toBeUndefined();
            expect(progress.outcome).toEqual(reason === 'provider_rejected_before_acceptance' ? { kind: 'failed' } : undefined);
            expect(await block()).toMatchObject({ ok: true, didUpdate: false });
            expect((await read()).json().progress).toEqual(response.json().progress);
        });
        expect((await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: unrelated.localId } },
        })).replyProgress).not.toHaveProperty('outcome');
        expect(await db.sessionTurn.count({ where: { sessionId: session.id } })).toBe(0);
    });

    it('preserves the human Ask root through a non-counting return and its next autonomous child', async () => {
        const keys = tweetnacl.box.keyPair();
        const account = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
        const [source, target, child] = await Promise.all([0, 1, 2].map(() => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'e2ee', metadata: '{}', active: true, lastActiveAt: new Date() } })));
        const machine = await db.machine.create({ data: { id: randomUUID(), installationId: randomUUID(), accountId: account.id,
            metadata: 'encrypted-metadata', dataEncryptionKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
                recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes })),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] }, sessionMessageReply: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        for (const session of [source, target, child]) await db.accessKey.create({ data: {
            accountId: account.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const publisher = (session: typeof source) => ({ accountId: account.id, sessionId: session.id,
            machineId: machine.id, committedFence: session.lastActiveAt });
        const settle = async (session: typeof source, localId: string, validation: SessionInputSettlementValidationV1) => {
            const input = { actorUserId: account.id, sessionId: session.id, localId, publisherAuthority: publisher(session) };
            expect(await materializeNextPendingMessage({ ...input, deliveryState: 'provider',
                deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' })).toMatchObject({ ok: true, didMaterialize: true });
            expect(await settlePendingInputAdmission({ ...input, decision: { kind: 'admit',
                finalContent: { t: 'encrypted', c: 'settled-authority' }, validation } })).toMatchObject({ ok: true, result: { status: 'accepted' } });
            return db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } });
        };
        const accept = async (session: typeof source, localId: string, turnId: string) => {
            const message = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } });
            expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: {
                v: 1, sessionId: session.id, turnId, mutationId: randomUUID(), action: 'begin', observedAt: Date.now(),
                startingInputId: localId, transcriptAnchors: { userMessageSeqs: [message.seq] } } })).toMatchObject({ ok: true });
            expect(await resolveAcceptedPendingDelivery({ actorUserId: account.id, sessionId: session.id, localId,
                publisherAuthority: publisher(session), acceptedDelivery: { t: 'encrypted', c: 'accepted-native-input' },
                acceptedTurn: { kind: 'newTurn', turnId } })).toMatchObject({ ok: true, didResolve: true });
        };
        const askLocalId = randomUUID();
        const reply = { mode: 'return' as const, humanOrigin: { sessionId: source.id } };
        expect(await enqueuePendingMessage({ actorUserId: account.id, authentication, sessionId: target.id,
            localId: askLocalId, targetMachineId: machine.id, content: { t: 'encrypted', c: 'human-ask' },
            requestedAction: { v: 1, kind: 'enqueue' }, reply })).toMatchObject({ ok: true });
        await settle(target, askLocalId, { reply, autonomousCheckIn: { afterTurns: 5 } });
        const askTurnId = randomUUID();
        await accept(target, askLocalId, askTurnId);
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: { v: 1,
            sessionId: target.id, turnId: askTurnId, mutationId: randomUUID(), action: 'complete', observedAt: Date.now() } })).toMatchObject({ ok: true });
        const returnLocalId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: target.id, localId: askLocalId, acceptedTurnId: askTurnId });
        expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: account.id, sourceMachineId: machine.id,
            targetMachineId: machine.id, sessionId: source.id, localId: returnLocalId,
            content: { t: 'encrypted', c: 'returned-information' }, requestedAction: { v: 1, kind: 'enqueue' } })).toMatchObject({ status: 'accepted' });
        const returned = await settle(source, returnLocalId, { returnedAnswer: { requestSessionId: target.id, requestLocalId: askLocalId,
            senderSessionId: target.id, outcome: 'terminal_no_result', delivery: 'wake' } });
        expect(returned).toMatchObject({ autonomousExchangeRootSessionId: target.id,
            autonomousExchangeRootLocalId: askLocalId, autonomousExchangeCause: 'returned_answer' });
        const returnTurnId = randomUUID();
        await accept(source, returnLocalId, returnTurnId);
        expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: target.id, localId: askLocalId } } }))
            .toMatchObject({ autonomousExchangeState: { observedStarts: 0 } });
        const childLocalId = randomUUID();
        expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: account.id, sourceMachineId: machine.id,
            targetMachineId: machine.id, sessionId: child.id, localId: childLocalId,
            content: { t: 'encrypted', c: 'autonomous-child' }, requestedAction: { v: 1, kind: 'enqueue' } })).toMatchObject({ status: 'accepted' });
        expect(await settle(child, childLocalId, { sourceSession: { sourceSessionId: source.id,
            sourceTurnId: returnTurnId, sourceInputId: returnLocalId, via: 'action' }, autonomousCheckIn: { afterTurns: 5 } }))
            .toMatchObject({ autonomousExchangeRootSessionId: target.id, autonomousExchangeRootLocalId: askLocalId });
        await accept(child, childLocalId, randomUUID());
        expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: target.id, localId: askLocalId } } }))
            .toMatchObject({ autonomousExchangeState: { observedStarts: 1 } });
    });

    it.each(['plain', 'e2ee'] as const)('returns a cross-Account human Ask through requester custody across later access withdrawal (%s)', async encryptionMode => {
        const keys = [tweetnacl.box.keyPair(), tweetnacl.box.keyPair()];
        const [alice, bob] = await Promise.all(keys.map(key => db.account.create({ data: { encryptionMode,
            ...(encryptionMode === 'e2ee' ? createSignedAccountContentBinding(key.publicKey) : {}) } })));
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: bob.id, tag: randomUUID(), encryptionMode, metadata: '{}', active: true, lastActiveAt: new Date() } });
        const target = await db.session.create({ data: { accountId: alice.id, tag: randomUUID(), encryptionMode, metadata: '{}', active: true, lastActiveAt: new Date() } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: target.id, createdByAccountId: alice.id,
            accountId: bob.id, accessLevel: 'edit', canApprovePermissions: false } });
        const machine = await db.machine.create({ data: { id: randomUUID(), installationId: randomUUID(), accountId: alice.id,
            metadata: encryptionMode === 'plain' ? encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }) : 'encrypted-metadata',
            dataEncryptionKey: encryptionMode === 'plain' ? decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)
                : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32), recipientPublicKey: keys[0]!.publicKey, randomBytes: tweetnacl.randomBytes })),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] }, sessionMessageReply: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        await db.accessKey.create({ data: { accountId: alice.id, machineId: machine.id, sessionId: target.id, data: 'encrypted' } });
        const returnMachine = await db.machine.create({ data: { id: randomUUID(), installationId: randomUUID(), accountId: bob.id,
            metadata: machine.metadata, dataEncryptionKey: encryptionMode === 'plain' ? machine.dataEncryptionKey
                : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32), recipientPublicKey: keys[1]!.publicKey, randomBytes: tweetnacl.randomBytes })),
            operationProtocolCapabilities: machine.operationProtocolCapabilities, operationProtocolCapabilitiesRevision: 1 } });
        const sourceHost = await db.machine.create({ data: { id: randomUUID(), installationId: randomUUID(), accountId: bob.id,
            metadata: returnMachine.metadata, dataEncryptionKey: returnMachine.dataEncryptionKey,
            operationProtocolCapabilities: machine.operationProtocolCapabilities, operationProtocolCapabilitiesRevision: 1 } });
        await db.accessKey.create({ data: { accountId: bob.id, machineId: sourceHost.id, sessionId: source.id, data: 'encrypted' } });
        const requesterSocket = createAuthenticatedFakeSocket({ id: randomUUID() });
        const requesterConnection = { connectionType: 'machine-scoped' as const, userId: bob.id, machineId: returnMachine.id,
            socket: requesterSocket as unknown as Socket };
        eventRouter.addConnection(bob.id, requesterConnection);
        onTestFinished(() => eventRouter.removeConnection(bob.id, requesterConnection));
        const sourceSocket = createAuthenticatedFakeSocket({ id: randomUUID() });
        const sourceConnection = { connectionType: 'session-scoped' as const, userId: bob.id, sessionId: source.id,
            socket: sourceSocket as unknown as Socket };
        eventRouter.addConnection(bob.id, sourceConnection);
        onTestFinished(() => eventRouter.removeConnection(bob.id, sourceConnection));
        const humanOrigin = { sessionId: source.id };
        const request: SessionInputRequestV1 = { v: 1, producer: 'happierApp', caller: { kind: 'host' }, permission: {},
            replyIntent: { mode: 'return', humanOrigin } };
        const plainContent = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'human question' },
            meta: withSessionInputRequestV1({}, request) } };
        const content = encryptionMode === 'plain' ? plainContent : { t: 'encrypted' as const, c: 'shared-human-ask' };
        const reply = { mode: 'return' as const, humanOrigin };
        await withAuthenticatedTestApp(app => { sessionPendingRoutes(app); registerSessionMessageRoutes(app); machinesRoutes(app); }, async app => {
            const url = `/v2/sessions/${target.id}/pending`;
            const headers = { 'x-test-user-id': bob.id };
            const localId = randomUUID();
            const sourceShare = { sessionId: source.id, createdByAccountId: bob.id, accountId: outsider.id, accessLevel: 'view' } as const;
            await db.sessionGrant.create({ data: { ...sourceShare, principalKind: 'account' } });
            const undisclosable = await app.inject({ method: 'POST', url, headers, payload: { localId, content,
                targetMachineId: machine.id, reply } });
            expect(undisclosable.statusCode).toBe(400);
            expect(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: target.id, localId } } })).toBeNull();
            await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: source.id } });
            const accepted = await app.inject({ method: 'POST', url, headers, payload: { localId, content,
                targetMachineId: machine.id, reply } });
            expect(accepted.statusCode, accepted.body).toBe(200);
            const original = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: target.id, localId } } });
            expect(original.inputAdmissionReceipt).toMatchObject({ issuer: 'authenticatedAccount', actorAccountId: bob.id });
            const publisherAuthority = { accountId: alice.id, machineId: machine.id, sessionId: target.id, committedFence: target.lastActiveAt };
            const finalContent = encryptionMode === 'plain' ? { ...plainContent, v: { ...plainContent.v,
                meta: { ...withSessionInputAuthorityV1(plainContent.v.meta, settleSessionInputRequestV1({ request,
                    currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: original.inputAdmissionReceipt })),
                    [SESSION_MESSAGE_PROVENANCE_META_KEY]: settleSessionMessageProvenanceV1({ request, requestedProvenance: null,
                        inputAdmissionReceipt: original.inputAdmissionReceipt }) } } } : { t: 'encrypted' as const, c: 'settled-shared-human-ask' };
            expect(await materializeNextPendingMessage({ actorUserId: alice.id, sessionId: target.id, publisherAuthority,
                deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' })).toMatchObject({ ok: true, didMaterialize: true });
            expect(await settlePendingInputAdmission({ actorUserId: alice.id, sessionId: target.id, localId, publisherAuthority,
                decision: { kind: 'admit', finalContent, validation: { reply } } })).toMatchObject({ ok: true, result: { status: 'accepted' } });
            const committed = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: target.id, localId } } });
            const turnId = randomUUID();
            expect(await applySessionTurnMutation({ actorUserId: alice.id, authentication, mutation: { v: 1,
                sessionId: target.id, turnId, mutationId: randomUUID(), action: 'begin', observedAt: Date.now(),
                transcriptAnchors: { userMessageSeqs: [committed.seq] } } })).toMatchObject({ ok: true });
            expect(await resolveAcceptedPendingDelivery({ actorUserId: alice.id, sessionId: target.id, localId,
                publisherAuthority, acceptedDelivery: encryptionMode === 'plain' ? { t: 'plain', v: { v: 1, acceptedAtMs: Date.now(), delivery: { kind: 'newTurn', turnId } } }
                    : { t: 'encrypted', c: 'accepted-human-question' }, acceptedTurn: { kind: 'newTurn', turnId } })).toMatchObject({ ok: true, didResolve: true });
            // A held source row must learn that the original input entered a
            // real turn, even before a terminal answer/pass exists.
            await vi.waitFor(() => expect(sourceSocket.emit).toHaveBeenCalledWith('ephemeral', {
                type: 'session-message-reply-pending-v1', v: 1, sessionId: target.id, requestLocalId: localId,
            }));
            expect(await applySessionTurnMutation({ actorUserId: alice.id, authentication, mutation: { v: 1,
                sessionId: target.id, turnId, mutationId: randomUUID(), action: 'complete', observedAt: Date.now(),
                transcriptAnchors: { userMessageSeqs: [committed.seq] } } })).toMatchObject({ ok: true });
            expect(await db.sessionPendingMessage.findUnique({ where: { id: original.id } })).toBeNull();
            const read = () => app.inject({ method: 'GET', url: `/v2/sessions/${target.id}/messages/by-local-id/${localId}/reply`, headers });
            const inventory = () => app.inject({ method: 'GET', url: `/v2/machines/${returnMachine.id}/session-message-replies/pending`, headers });
            expect((await read()).json()).toMatchObject({ status: 'available', progress: { humanOrigin, outcome: { kind: 'terminal_no_result' } } });
            expect((await inventory()).json()).toMatchObject({ entries: [{ requestSessionId: target.id, requestLocalId: localId }] });
            await vi.waitFor(() => expect(requesterSocket.emit).toHaveBeenCalledWith('ephemeral', { type: 'session-message-reply-pending-v1',
                v: 1, sessionId: target.id, requestLocalId: localId }));
            await db.sessionGrant.create({ data: { ...sourceShare, principalKind: 'account' } });
            expect((await read()).json()).toMatchObject({ status: 'unavailable' });
            expect((await inventory()).json()).toMatchObject({ entries: [] });
            await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: source.id } });
            const returnedInputLocalId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: target.id, localId, acceptedTurnId: turnId });
            const acknowledge = (accountId = bob.id, recoveryMachine = returnMachine) => inTx(tx => mutateSessionMessageReplyForMachineInTx(tx, {
                accountId, installationId: recoveryMachine.installationId!, authentication, mutation: { v: 1, machineId: recoveryMachine.id,
                    requestSessionId: target.id, requestLocalId: localId, operation: { kind: 'returned', returnedInputLocalId } } }));
            expect(await acknowledge()).toMatchObject({ ok: false, error: 'conflict' });
            expect(await acknowledge(alice.id, machine)).toMatchObject({ ok: false });
            const returnedAnswer = { requestSessionId: target.id, requestLocalId: localId,
                senderSessionId: target.id, outcome: 'terminal_no_result' as const, delivery: 'wake' as const };
            const returnedAdmission = buildTrustedHostSessionInputAdmissionV1('agent');
            const returnedRequest: SessionInputRequestV1 = { ...returnedAdmission.request, returnedAnswer };
            const returnedPlain = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'returned information' },
                meta: withSessionInputRequestV1({}, returnedRequest) } };
            expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: bob.id, sourceMachineId: returnMachine.id,
                targetMachineId: sourceHost.id, sessionId: source.id, localId: returnedInputLocalId,
                content: encryptionMode === 'plain' ? returnedPlain
                    : { t: 'encrypted', c: 'returned-information' }, requestedAction: { v: 1, kind: 'enqueue' } })).toMatchObject({ status: 'accepted' });
            const returnedOriginal = await db.sessionPendingMessage.findUniqueOrThrow({ where: {
                sessionId_localId: { sessionId: source.id, localId: returnedInputLocalId } } });
            const returnedFinal = encryptionMode === 'plain' ? { ...returnedPlain, v: { ...returnedPlain.v,
                meta: { ...withSessionInputAuthorityV1(returnedPlain.v.meta, settleSessionInputRequestV1({ request: returnedRequest,
                    currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: returnedOriginal.inputAdmissionReceipt })),
                    [SESSION_MESSAGE_PROVENANCE_META_KEY]: settleSessionMessageProvenanceV1({ request: returnedRequest,
                        requestedProvenance: null, inputAdmissionReceipt: returnedOriginal.inputAdmissionReceipt }) } } }
                : { t: 'encrypted' as const, c: 'settled-returned-information' };
            const sourcePublisher = { accountId: bob.id, sessionId: source.id, machineId: sourceHost.id, committedFence: source.lastActiveAt };
            expect(await materializeNextPendingMessage({ actorUserId: bob.id, sessionId: source.id, publisherAuthority: sourcePublisher,
                deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' })).toMatchObject({ ok: true, didMaterialize: true });
            await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: target.id, accountId: bob.id } });
            expect(await settlePendingInputAdmission({ actorUserId: bob.id, sessionId: source.id, localId: returnedInputLocalId,
                publisherAuthority: sourcePublisher, decision: { kind: 'admit', finalContent: returnedFinal,
                    validation: { returnedAnswer } } })).toMatchObject({ ok: true, result: { status: 'accepted' } });
            expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: source.id, localId: returnedInputLocalId } } }))
                .toMatchObject({ autonomousExchangeRootSessionId: target.id, autonomousExchangeRootLocalId: localId, autonomousExchangeCause: 'returned_answer' });
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: target.id, createdByAccountId: alice.id,
                accountId: bob.id, accessLevel: 'edit', canApprovePermissions: false } });
            expect(await acknowledge()).toMatchObject({ ok: true, progress: { disposition: 'returned', humanOrigin, returnedInputLocalId } });
            expect(await acknowledge()).toMatchObject({ ok: true });
            await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: target.id, accountId: bob.id } });
            expect((await read()).json()).toMatchObject({ status: 'unavailable' });
            expect(await acknowledge()).toMatchObject({ ok: false });
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: target.id, createdByAccountId: alice.id,
                accountId: bob.id, accessLevel: 'edit', canApprovePermissions: false } });
            await db.session.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
            expect((await read()).json()).toMatchObject({ status: 'unavailable' });
            expect(await acknowledge()).toMatchObject({ ok: false });
        });
    });

    it.each(['plain', 'e2ee'] as const)('admits a human composer return only through its authenticated Account and retains exact recovery custody (%s)', async encryptionMode => {
        const keys = tweetnacl.box.keyPair();
        const account = await db.account.create({ data: { encryptionMode,
            ...(encryptionMode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const [source, target, foreign, archived] = await Promise.all([account.id, account.id, other.id, account.id].map(accountId =>
            db.session.create({ data: { accountId, tag: randomUUID(), encryptionMode, metadata: '{}' } })));
        await db.session.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
        const operationProtocolCapabilities = { sessionInputAdmission: { protocolVersions: [1, 2] }, sessionMessageReply: { protocolVersions: [1] } };
        const machine = await db.machine.create({ data: { id: randomUUID(), installationId: randomUUID(), accountId: account.id,
            metadata: encryptionMode === 'plain' ? encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }) : 'encrypted-metadata',
            dataEncryptionKey: encryptionMode === 'plain' ? decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)
                : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32), recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes })),
            operationProtocolCapabilities,
            operationProtocolCapabilitiesRevision: 1 } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: target.id, data: 'encrypted' } });
        const localId = randomUUID();
        const humanOrigin = { sessionId: source.id };
        const request: SessionInputRequestV1 = { v: 1, producer: 'happierApp', caller: { kind: 'host' }, permission: {},
            replyIntent: { mode: 'return', humanOrigin } };
        const plainContent = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'the human question' },
            meta: withSessionInputRequestV1({}, request) } };
        // Encryption is the host boundary: this server never opens the protected envelope.
        const content = encryptionMode === 'plain' ? plainContent : { t: 'encrypted' as const, c: 'encrypted-human-request' };
        await withAuthenticatedTestApp(app => { registerSessionMessageRoutes(app); sessionPendingRoutes(app); machinesRoutes(app); }, async app => {
            const headers = { 'x-test-user-id': account.id };
            const payload = { localId, content, targetMachineId: machine.id, reply: { mode: 'return', humanOrigin } };
            const url = `/v2/sessions/${target.id}/pending`;
            const accepted = await app.inject({ method: 'POST', url, headers, payload });
            expect(accepted.statusCode, accepted.body).toBe(200);
            const original = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: target.id, localId } } });
            expect(original.inputAdmissionReceipt).toMatchObject({ issuer: 'authenticatedAccount', actorAccountId: account.id });
            expect(original.replyProgress).toEqual({ v: 1, mode: 'return', humanOrigin, disposition: 'return_pending' });
            expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(200);
            for (const destination of [foreign.id, archived.id]) {
                expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, localId: randomUUID(),
                    reply: { mode: 'return', humanOrigin: { sessionId: destination } } } })).statusCode).toBe(400);
            }
            expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-test-auth-token-kind': 'terminal' },
                payload: { ...payload, localId: randomUUID() } })).statusCode).toBe(400);
            expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload,
                reply: { mode: 'return', humanOrigin: { sessionId: target.id } } } })).statusCode).toBe(400);
            const unboundLocalId = randomUUID();
            const unbound = await app.inject({ method: 'POST', url, headers, payload: {
                localId: unboundLocalId, content, reply: { mode: 'return', humanOrigin } } });
            expect(unbound.statusCode).toBe(400);
            expect(unbound.json()).toMatchObject({ code: 'session_input_target_unavailable' });
            expect(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: {
                sessionId: target.id, localId: unboundLocalId } } })).toBeNull();
            expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: account.id, sourceMachineId: machine.id,
                targetMachineId: machine.id, sessionId: target.id, localId: randomUUID(), content,
                requestedAction: { v: 1, kind: 'enqueue' }, reply: { mode: 'return', humanOrigin } })).toMatchObject({ status: 'rejected' });
            await db.machine.update({ where: { id: machine.id }, data: {
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } } } });
            const unsupported = await app.inject({ method: 'POST', url, headers, payload: { ...payload, localId: randomUUID() } });
            expect(unsupported.statusCode).toBe(400);
            expect(unsupported.json()).toMatchObject({ code: 'session_input_target_update_required' });
            await db.machine.update({ where: { id: machine.id }, data: { operationProtocolCapabilities } });
            const active = await db.session.update({ where: { id: target.id }, data: { active: true, lastActiveAt: new Date() } });
            const publisherAuthority = { accountId: account.id, machineId: machine.id, sessionId: target.id, committedFence: active.lastActiveAt };
            const claim = await materializeNextPendingMessage({ actorUserId: account.id, sessionId: target.id, publisherAuthority,
                deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' });
            expect(claim).toMatchObject({ ok: true, didMaterialize: true, message: { localId } });
            const finalContent = encryptionMode === 'plain' ? { ...plainContent, v: { ...plainContent.v,
                meta: { ...withSessionInputAuthorityV1(plainContent.v.meta, settleSessionInputRequestV1({ request, currentSessionPermissionCeiling: 'default',
                    inputAdmissionReceipt: original.inputAdmissionReceipt })),
                    [SESSION_MESSAGE_PROVENANCE_META_KEY]: settleSessionMessageProvenanceV1({ request, requestedProvenance: null,
                        inputAdmissionReceipt: original.inputAdmissionReceipt }) } } } : { t: 'encrypted' as const, c: 'settled-human-authority' };
            const settlement = { actorUserId: account.id, sessionId: target.id, localId, publisherAuthority,
                decision: { kind: 'admit' as const, finalContent, validation: { reply: { mode: 'return' as const, humanOrigin } } } };
            expect(await settlePendingInputAdmission({ ...settlement, decision: { ...settlement.decision,
                validation: { reply: { mode: 'return', humanOrigin: { sessionId: target.id } } } } })).toMatchObject({ ok: false, error: 'conflict' });
            expect(await settlePendingInputAdmission(settlement)).toMatchObject({ ok: true, result: { status: 'accepted', localId } });
            const committed = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: target.id, localId } } });
            for (const action of ['begin', 'complete'] as const) expect(await applySessionTurnMutation({ actorUserId: account.id,
                authentication, mutation: { v: 1, sessionId: target.id, turnId: 'human-answer-turn', mutationId: randomUUID(), action,
                    observedAt: Date.now(), transcriptAnchors: { userMessageSeqs: [committed.seq] } } })).toMatchObject({ ok: true });
            await db.sessionPendingMessage.delete({ where: { id: original.id } });
            expect(await settlePendingInputAdmission({ ...settlement, decision: { ...settlement.decision,
                validation: { reply: { mode: 'return', humanOrigin: { sessionId: target.id } } } } })).toMatchObject({ ok: false, error: 'conflict' });
            expect(await db.sessionMessage.count({ where: { sessionId: source.id } })).toBe(0);
            const recovery = await app.inject({ method: 'GET', url: `/v2/machines/${machine.id}/session-message-replies/pending`, headers });
            expect(recovery.json()).toMatchObject({ entries: [{ requestSessionId: target.id, requestLocalId: localId,
                progress: { humanOrigin, outcome: { kind: 'terminal_no_result' } } }] });
            expect((await app.inject({ method: 'POST', url: `/v2/sessions/${target.id}/messages/by-local-id/${localId}/reply`, headers,
                payload: { kind: 'release' } })).json()).toMatchObject({ ok: true, progress: { disposition: 'return_pending' } });
            const returnedInputLocalId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: target.id, localId, acceptedTurnId: 'human-answer-turn' });
            const acknowledge = () => inTx(tx => mutateSessionMessageReplyForMachineInTx(tx, { accountId: account.id,
                installationId: machine.installationId!, authentication, mutation: { v: 1, machineId: machine.id,
                    requestSessionId: target.id, requestLocalId: localId, operation: { kind: 'returned', returnedInputLocalId } } }));
            expect(await acknowledge()).toMatchObject({ ok: false, error: 'conflict' });
            await db.sessionPendingMessage.create({ data: { sessionId: source.id, localId: returnedInputLocalId, position: 0,
                content: encryptionMode === 'plain' ? { t: 'plain', v: {} } : { t: 'encrypted', c: 'returned-information' },
                requestedAction: { v: 1, kind: 'enqueue' },
                inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' } } });
            expect(await acknowledge()).toMatchObject({ ok: true, progress: { disposition: 'returned', humanOrigin, returnedInputLocalId } });
            expect(await acknowledge()).toMatchObject({ ok: true });
            await db.session.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
            expect((await app.inject({ method: 'GET', url: `/v2/sessions/${target.id}/messages/by-local-id/${localId}/reply`, headers })).json())
                .toMatchObject({ status: 'unavailable' });
            expect(await settlePendingInputAdmission(settlement)).toMatchObject({ ok: true,
                result: { status: 'alreadyAccepted', localId } });
        });
    });

    it('binds an asserted primary causal input to its real turn user-message anchors', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        for (const seq of [1, 2, 3]) await db.sessionMessage.create({ data: { sessionId: session.id, localId: `causal-${seq}`, seq,
            messageRole: 'user', content: { t: 'plain', v: {} } } });
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId: 'primary-cause', status: 'in_progress',
            startedAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
            transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 1, userMessageSeqs: [1, 2] }) } });
        const source = { sourceSessionId: session.id, sourceTurnId: 'primary-cause', via: 'action' as const };
        const current = (sourceInputId?: string) => inTx(tx => isSessionInputSourceCurrentInTx(tx, account.id,
            { ...source, ...(sourceInputId ? { sourceInputId } : {}) }));
        expect(await current('causal-1')).toBe(true);
        expect(await current('causal-2')).toBe(true);
        expect(await current('causal-3')).toBe(false);
        expect(await current('missing-input')).toBe(false);
        expect(await current()).toBe(true);
    });

    it.each(['audience', 'mute'] as const)('finishes an admitted Discussion original after its %s policy changes', async change => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const target = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), installationId: randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'discussion-host' }), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] }, sessionMessageReply: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: target.id, data: 'fixture-key' } });
        const binding = { accountId: account.id, machineId: machine.id, sessionId: target.id };
        const registered = await createSessionPublisherPresence().registerPublisher({ socket: {}, binding,
            completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (registered.status !== 'registered') throw new Error('Expected the Discussion receiver publisher to register');
        const publisherAuthority = { ...binding, committedFence: registered.committedFence };
        const document = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Original question' }] };
        const created = await createDiscussion({ authentication, actorAccountId: account.id, request: buildDiscussionMutationRequestBodyV1({
            kind: 'create', creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Admitted Discussion' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: document }, authoredContent: document, mentionedAccountIds: [] },
        }) });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: account.id, discussionId,
            request: { participant: { kind: 'session', sessionId: target.id } } })).toMatchObject({ ok: true });
        const question = async () => {
            const posted = await postDiscussionMessage({ authentication, actorAccountId: account.id, discussionId, request: {
                localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: target.id } }] } },
                mentionedAccountIds: [], mentionedSessionIds: [target.id],
            } });
            if (!posted.ok) throw new Error(posted.error);
            return posted.value.message;
        };
        const inputFor = (message: { id: string; seq: number }) => {
            const discussion = { discussionId, messageId: message.id, throughSeq: message.seq, participantSessionId: target.id };
            const reply = { mode: 'return' as const, discussion };
            const request: SessionInputRequestV1 = { ...buildTrustedHostSessionInputAdmissionV1('agent').request,
                discussionAddressing: discussion, replyIntent: { mode: 'return' } };
            const content = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'Discuss the question' },
                meta: withSessionInputRequestV1({}, request) } };
            return { request, input: { accountId: account.id, sourceMachineId: machine.id, targetMachineId: machine.id,
                sessionId: target.id, localId: deriveDiscussionFollowInputLocalIdV1(discussion),
                requestedAction: { v: 1 as const, kind: 'enqueue' as const }, content, reply } };
        };
        const { request, input } = inputFor(await question());
        expect(await enqueuePendingMessageByAuthenticatedMachine(input)).toMatchObject({ status: 'accepted' });
        const original = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
            sessionId: target.id, localId: input.localId } } });
        const finalContent = { ...input.content, v: { ...input.content.v, meta: {
            ...withSessionInputAuthorityV1(input.content.v.meta, settleSessionInputRequestV1({ request,
                currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: original.inputAdmissionReceipt })),
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: settleSessionMessageProvenanceV1({ request,
                requestedProvenance: null, inputAdmissionReceipt: original.inputAdmissionReceipt }),
        } } };
        expect(await materializeNextPendingMessage({ actorUserId: account.id, sessionId: target.id, publisherAuthority,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' })).toMatchObject({ ok: true, didMaterialize: true });
        const settlement = { actorUserId: account.id, sessionId: target.id, localId: input.localId, publisherAuthority,
            decision: { kind: 'admit' as const, finalContent, validation: { reply: input.reply } } };
        expect(await settlePendingInputAdmission({ ...settlement, decision: { ...settlement.decision,
            validation: { reply: { ...input.reply, discussion: { ...input.reply.discussion, messageId: randomUUID() } } } } }))
            .toMatchObject({ ok: false, error: 'conflict' });
        const next = inputFor(await question());
        if (change === 'audience') {
            const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: target.id, createdByAccountId: account.id,
                accountId: outsider.id, accessLevel: 'view' } });
        } else {
            expect(await changeDeliveryMute({ accountId: account.id, receiver: { kind: 'session', sessionId: target.id },
                scope: { kind: 'source', source: { kind: 'discussion', discussionId } }, operation: 'set', authentication }))
                .toMatchObject({ ok: true });
        }
        expect(await settlePendingInputAdmission(settlement)).toMatchObject({ ok: true, result: { status: 'accepted', localId: input.localId } });
        expect(await db.sessionMessage.count({ where: { sessionId: target.id, localId: input.localId } })).toBe(1);
        expect(await enqueuePendingMessageByAuthenticatedMachine(next.input)).toMatchObject({ status: 'rejected' });
    });

    it('advertises the registered operation and treats an old input as having no reply obligation', async () => {
        const account = await db.account.create({ data: { publicKey: 'reply-route-owner', encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'reply-route-session', encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionMessage.create({ data: { sessionId: session.id, localId: 'old-input', seq: 1,
            messageRole: 'user', content: { t: 'plain', v: { text: 'old input' } } } });
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            const headers = { 'x-test-user-id': account.id };
            const capability = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/messages/reply-capability`, headers });
            expect(capability.statusCode).toBe(200);
            expect(capability.json()).toEqual({ v: 1, protocolVersions: [1] });
            const result = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/messages/by-local-id/old-input/reply`, headers });
            expect(result.statusCode).toBe(200);
            expect(result.json()).toEqual({ v: 1, status: 'none' });
        });
    });

    it('exposes only the owning Machine original-custody recovery page', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), installationId: randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const url = `/v2/machines/${machine.id}/session-message-replies/pending`;
            const result = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': account.id } });
            expect(result.statusCode).toBe(200);
            expect(result.json()).toEqual({ v: 1, entries: [], nextAfter: null });
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': other.id } })).statusCode).toBe(404);
        });
    });

    it('recovers only the requester Account originals on an admitted shared Machine and retains them after grant removal', async () => {
        const [alice, bob] = await Promise.all([0, 1].map(() => db.account.create({ data: { encryptionMode: 'plain' } })));
        const machine = await db.machine.create({ data: { id: randomUUID(), installationId: randomUUID(), accountId: alice.id, kind: 'persistent',
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: alice.id, machineId: machine.id,
            principal: { kind: 'account', accountId: bob.id }, level: 'view' }));
        expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: bob.id, machineId: machine.id })))
            .toMatchObject({ kind: 'admitted', actorAccountId: bob.id, custodianAccountId: alice.id, role: 'use' });
        const session = await db.session.create({ data: { accountId: bob.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const created = await createDiscussion({ authentication, actorAccountId: bob.id, request: buildDiscussionMutationRequestBodyV1({
            kind: 'create', creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Bob question' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Start' }] } },
                authoredContent: { v: 1, parts: [{ t: 'text', text: 'Start' }] }, mentionedAccountIds: [] },
        }) });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: bob.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const question = await postDiscussionMessage({ authentication, actorAccountId: bob.id, discussionId,
            request: { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: session.id } }] } },
                mentionedAccountIds: [], mentionedSessionIds: [session.id] } });
        if (!question.ok) throw new Error(question.error);
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: bob.id, reply: { mode: 'return',
            discussion: { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: session.id } } }));
        if (!progress) throw new Error('Missing original Discussion obligation');
        const localId = randomUUID();
        const receipt = SessionInputAdmissionReceiptV1Schema.parse({ v: 1, issuer: 'authenticatedMachine',
            admittedTarget: { homeId: await getOrCreateServerIdentityId(), accountId: bob.id, sessionId: session.id,
                machineId: machine.id, installationId: machine.installationId! } });
        await db.sessionMessage.create({ data: { sessionId: session.id, localId, seq: 1, messageRole: 'user', content: { t: 'plain', v: {} },
            inputAdmissionReceipt: receipt, replyTargetMachineId: machine.id,
            replyDisposition: 'return_pending', replyProgress: { ...progress, acceptedTurnId: 'bob-turn' } } });
        const machineSocket = createAuthenticatedFakeSocket({ id: randomUUID() });
        // Socket.IO is the network boundary; the real router must select the custodian's room.
        const connection = { connectionType: 'machine-scoped' as const, userId: alice.id, machineId: machine.id,
            socket: machineSocket as unknown as Socket };
        eventRouter.addConnection(alice.id, connection);
        onTestFinished(() => eventRouter.removeConnection(alice.id, connection));
        await inTx(tx => projectSessionInputRepliesFromTurnInTx(tx, { sessionId: session.id, turnId: 'bob-turn', status: 'cancelled',
            transcriptAnchorsJson: JSON.stringify({ userMessageSeqs: [1] }) }));
        await vi.waitFor(() => expect(machineSocket.emit).toHaveBeenCalledWith('ephemeral', { type: 'session-message-reply-pending-v1', v: 1,
            sessionId: session.id, requestLocalId: localId }));
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const url = `/v2/machines/${machine.id}/session-message-replies/pending`;
            const own = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': bob.id } });
            expect(own.statusCode).toBe(200);
            expect(own.json()).toMatchObject({ entries: [{ requestSessionId: session.id, requestLocalId: localId, progress: { outcome: { kind: 'cancelled' } } }] });
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': alice.id } })).json()).toMatchObject({ entries: [] });
            expect(await inTx(tx => mutateSessionMessageReplyForMachineInTx(tx, { accountId: alice.id,
                installationId: machine.installationId!, authentication,
                mutation: { v: 1, machineId: machine.id, requestSessionId: session.id, requestLocalId: localId,
                    operation: { kind: 'returned', returnedInputLocalId: deriveSessionMessageReplyReturnLocalIdV1({ sessionId: session.id, localId, acceptedTurnId: 'bob-turn' }) } } })))
                .toMatchObject({ ok: false, error: 'forbidden' });
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: alice.id, machineId: machine.id,
                principal: { kind: 'account', accountId: bob.id } }));
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': bob.id } })).statusCode).toBe(404);
        });
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } })).replyProgress)
            .toMatchObject({ disposition: 'return_pending', outcome: { kind: 'cancelled' } });
    });

    it('pages opaque original local ids in database order without losing a boundary input', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const target = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionTurn.create({ data: { sessionId: source.id, turnId: 'page-source', status: 'in_progress', startedAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
        const ids = [...Array.from({ length: SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1 - 1 }, (_, index) => `a-${String(index).padStart(4, '0')}`), '\uE000', '\u{10000}'];
        await db.sessionPendingMessage.createMany({ data: ids.map((localId, position) => ({ sessionId: target.id, localId, position,
            content: { t: 'plain', v: {} }, requestedAction: { v: 1, kind: 'enqueue' }, replyDisposition: 'return_pending',
            replyProgress: { v: 1, mode: 'return', disposition: 'return_pending', sourceSession: { sourceSessionId: source.id, sourceTurnId: 'page-source', via: 'action' } } })) });
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            const url = `/v2/sessions/${target.id}/messages/replies/pending`;
            const headers = { 'x-test-user-id': account.id };
            const first = (await app.inject({ method: 'GET', url, headers })).json();
            expect(first.entries).toHaveLength(SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1);
            const second = (await app.inject({ method: 'GET', url: `${url}?afterLocalId=${encodeURIComponent(first.nextAfterLocalId)}`, headers })).json();
            expect([...first.entries, ...second.entries].map((entry: { requestLocalId: string }) => entry.requestLocalId).sort()).toEqual([...ids].sort());
            expect(second.nextAfterLocalId).toBeNull();
        });
    });

    it('retains the admitted original through retirement and source end; explicit pass wins, retries rejoin, revocation refuses', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), installationId: randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] }, sessionMessageReply: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const target = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        for (const session of [source, target]) await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const begin = async (sessionId: string, turnId: string, userMessageSeqs?: number[]) => expect(await applySessionTurnMutation({
            actorUserId: account.id, authentication, mutation: { v: 1, sessionId, turnId, mutationId: randomUUID(), action: 'begin', observedAt: Date.now(),
                ...(userMessageSeqs ? { transcriptAnchors: { userMessageSeqs } } : {}) },
        })).toMatchObject({ ok: true, didApply: true });
        await begin(source.id, 'source-turn');
        const actionRequestAttributionV1 = materializeActionRequestAttributionV1({ requestRef: 'bob-original-input',
            requester: { serverId: 'home', accountId: 'bob' }, persona: { serverId: 'home', sessionId: target.id }, origin: null });
        const reply = { mode: 'return' as const, sourceSession: { sourceSessionId: source.id, sourceTurnId: 'source-turn', via: 'action' as const },
            actionRequestAttributionV1 };
        const protectedRequest: SessionInputRequestV1 = { v: 1, producer: 'sessionAction', caller: { kind: 'host' }, permission: {},
            sourceSession: reply.sourceSession, replyIntent: { mode: 'return' }, actionRequestAttributionV1 };
        const content = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'the assignment' }, meta: withSessionInputRequestV1({}, protectedRequest) } };
        const admission = { accountId: account.id, sourceMachineId: machine.id, targetMachineId: machine.id,
            sessionId: target.id, localId: 'original-ask', content, reply, requestedAction: { v: 1 as const, kind: 'enqueue' as const } };
        expect(await enqueuePendingMessageByAuthenticatedMachine(admission)).toEqual({ status: 'accepted', localId: admission.localId });
        expect(await enqueuePendingMessageByAuthenticatedMachine(admission)).toEqual({ status: 'alreadyAccepted', localId: admission.localId });
        const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: target.id, localId: admission.localId } } });
        expect(pending.replyProgress).toMatchObject({ mode: 'return', disposition: 'observing', sourceSession: reply.sourceSession,
            actionRequestAttributionV1 });
        const settledContent = { ...content, v: { ...content.v, meta: withSessionInputAuthorityV1({}, settleSessionInputRequestV1({
            request: protectedRequest, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: pending.inputAdmissionReceipt,
        })) } };
        const materialized = await inTx(async tx => {
            const result = await createSessionMessageFromPending(tx, { sessionId: target.id, sessionEncryptionMode: 'plain', storagePolicy: 'optional',
                localId: admission.localId, content: settledContent, messageRole: 'user', requestContentForEquality: content,
                inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.parse(pending.inputAdmissionReceipt), pendingRequestedAction: admission.requestedAction });
            expect(result.ok).toBe(true);
            await tx.sessionPendingMessage.delete({ where: { id: pending.id } });
            return result;
        });
        expect(materialized.ok).toBe(true);
        if (!materialized.ok) throw new Error('materialization failed');
        await begin(target.id, 'target-turn', [materialized.message.seq]);
        // This target's committed input is not the original bob-original-input cause.
        expect.soft((await db.sessionMessage.findUniqueOrThrow({ where: { id: materialized.message.id } })).replyProgress)
            .toMatchObject({ actionRequestAttributionV1 });
        expect(materialized.message.id).not.toBe(admission.localId);
        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(account.id, socket as never, { connectionType: 'session-scoped', socket, userId: account.id, sessionId: target.id } as never,
            { presence: createSessionPublisherPresence(), binding: { accountId: account.id, machineId: machine.id, sessionId: target.id } });
        await getSocketHandler(socket, 'session-runtime-activity-snapshot')({ sessionId: target.id, mutationId: randomUUID(), snapshot: { state: 'idle', activeCount: 0 } }, () => {});
        const mutate = async (operation: unknown) => {
            let response: unknown;
            await getSocketHandler(socket, SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1)({ v: 1, sessionId: target.id,
                requestSessionId: target.id, requestLocalId: admission.localId, operation }, (value: unknown) => { response = value; });
            return SessionMessageReplyMutationResultV1Schema.parse(response);
        };
        expect(await mutate({ kind: 'fulfill', turnId: 'unrelated-turn', outcome: { kind: 'pass' } })).toMatchObject({ ok: false, error: 'conflict' });
        const unrelated = await db.sessionMessage.create({ data: { sessionId: target.id, localId: 'unrelated-agent-post', seq: materialized.message.seq + 1,
            messageRole: 'agent', content: { t: 'plain', v: { text: 'a different turn or publication' } } } });
        expect.soft(await mutate({ kind: 'fulfill', turnId: 'target-turn', outcome: { kind: 'answer', result: { sessionId: target.id, messageId: unrelated.id } } }))
            .toMatchObject({ ok: false, error: 'conflict' });
        expect(await mutate({ kind: 'fulfill', turnId: 'target-turn', outcome: { kind: 'pass' } })).toMatchObject({ ok: true, progress: { outcome: { kind: 'pass' } } });
        expect(await mutate({ kind: 'fulfill', turnId: 'target-turn', outcome: { kind: 'pass' } })).toMatchObject({ ok: true });
        const final = await db.sessionMessage.create({ data: { sessionId: target.id, seq: materialized.message.seq + 2, messageRole: 'agent', content: { t: 'plain', v: { text: 'later final' } } } });
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: { v: 1, sessionId: target.id,
            turnId: 'target-turn', mutationId: randomUUID(), action: 'complete', observedAt: Date.now() + 1,
            transcriptAnchors: { startSeqInclusive: materialized.message.seq, endSeqInclusive: final.seq, finalAssistantMessageSeq: final.seq } } })).toMatchObject({ ok: true });
        expect.soft((await db.sessionMessage.findUniqueOrThrow({ where: { id: materialized.message.id } })).replyProgress).toMatchObject({ outcome: { kind: 'pass' }, disposition: 'observing',
            actionRequestAttributionV1 });
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: { v: 1, sessionId: source.id,
            turnId: 'source-turn', mutationId: randomUUID(), action: 'complete', observedAt: Date.now() + 2 } })).toMatchObject({ ok: true });
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { id: materialized.message.id } })).replyProgress).toMatchObject({ disposition: 'return_pending' });
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const page = await app.inject({ method: 'GET', url: `/v2/machines/${machine.id}/session-message-replies/pending`, headers: { 'x-test-user-id': account.id } });
            expect(page.statusCode).toBe(200);
            expect(page.json()).toMatchObject({ entries: [{ requestSessionId: target.id, requestLocalId: admission.localId, progress: { outcome: { kind: 'pass' } } }], nextAfter: null });
        });
        const returnedInputLocalId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: target.id, localId: admission.localId, acceptedTurnId: 'target-turn' });
        expect(await mutate({ kind: 'returned', returnedInputLocalId })).toMatchObject({ ok: false, error: 'conflict' });
        await db.sessionPendingMessage.create({ data: { sessionId: source.id, localId: returnedInputLocalId, content: { t: 'plain', v: { text: 'passed' } },
            requestedAction: { v: 1, kind: 'enqueue' }, position: 0, inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' } } });
        const machineSocket = Object.assign(createAuthenticatedFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
            verifiedMachineInstallationId: 'superseded-installation' } }), { handshake: { auth: { token: await auth.createToken(account.id, undefined,
                { kind: 'account', authority: 'present_user' }) } } });
        machineUpdateHandler(account.id, machineSocket as never, { operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524288 } } });
        const machineMutate = async (operation: unknown, requestLocalId = admission.localId) => {
            let response: unknown;
            await getSocketHandler(machineSocket, SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1)({ v: 1, machineId: machine.id,
                requestSessionId: target.id, requestLocalId, operation }, (value: unknown) => { response = value; });
            return SessionMessageReplyMutationResultV1Schema.parse(response);
        };
        expect(await machineMutate({ kind: 'returned', returnedInputLocalId })).toMatchObject({ ok: false, error: 'forbidden' });
        machineSocket.data!.verifiedMachineInstallationId = machine.installationId;
        expect(await machineMutate({ kind: 'fulfill', turnId: 'target-turn', outcome: { kind: 'pass' } })).toMatchObject({ ok: false, error: 'invalid_request' });
        expect(await machineMutate({ kind: 'returned', returnedInputLocalId })).toMatchObject({ ok: true, progress: { disposition: 'returned' } });
        expect(await machineMutate({ kind: 'returned', returnedInputLocalId })).toMatchObject({ ok: true });
        expect(await mutate({ kind: 'returned', returnedInputLocalId })).toMatchObject({ ok: true, progress: { disposition: 'returned', returnedInputLocalId } });
        expect(await mutate({ kind: 'returned', returnedInputLocalId })).toMatchObject({ ok: true });
        expect.soft((await db.sessionMessage.findUniqueOrThrow({ where: { id: materialized.message.id } })).replyProgress)
            .toMatchObject({ actionRequestAttributionV1 });
        await db.session.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
        expect(await machineMutate({ kind: 'returned', returnedInputLocalId })).toMatchObject({ ok: false, error: 'unavailable' });
        await db.session.update({ where: { id: source.id }, data: { archivedAt: null } });
        // A Run-native source routes back to its admitted Run, never the idle parent Session.
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: 'source-run-input', seq: 1, messageRole: 'user',
            targetExecutionRunId: 'source-run', acceptedTurnId: 'source-run-turn', acceptedTurnKind: 'newTurn', content: { t: 'plain', v: { text: 'native question source' } } } });
        const runReply = { ...reply, sourceSession: { sourceSessionId: source.id, sourceTurnId: 'source-run-turn', sourceInputId: 'source-run-input', via: 'action' as const } };
        const runRequest = { ...protectedRequest, sourceSession: runReply.sourceSession };
        const runAdmission = { ...admission, localId: 'run-source-ask', reply: runReply,
            content: { ...content, v: { ...content.v, meta: withSessionInputRequestV1({}, runRequest) } } };
        expect(await enqueuePendingMessageByAuthenticatedMachine(runAdmission)).toMatchObject({ status: 'accepted' });
        const sourceSocket = createAuthenticatedFakeSocket({ id: 'source-publisher' });
        sessionUpdateHandler(account.id, sourceSocket as never, { connectionType: 'session-scoped', socket: sourceSocket, userId: account.id, sessionId: source.id } as never,
            { presence: createSessionPublisherPresence(), binding: { accountId: account.id, machineId: machine.id, sessionId: source.id } });
        await getSocketHandler(sourceSocket, 'session-runtime-activity-snapshot')({ sessionId: source.id, mutationId: randomUUID(), snapshot: { state: 'idle', activeCount: 0 } }, () => {});
        let released: unknown;
        await getSocketHandler(sourceSocket, SESSION_MESSAGE_REPLY_RELEASE_SOURCE_TURN_EVENT_V1)({ v: 1, sessionId: source.id,
            sourceTurnId: 'source-run-turn', sourceInputId: 'source-run-input' }, (response: unknown) => { released = response; });
        expect(released).toEqual({ v: 1, ok: true });
        expect(await discardPendingMessage({ actorUserId: account.id, sessionId: target.id, localId: runAdmission.localId, authentication })).toMatchObject({ ok: true });
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            const original = await app.inject({ method: 'GET', url: `/v2/sessions/${target.id}/messages/by-local-id/${runAdmission.localId}/reply`, headers: { 'x-test-user-id': account.id } });
            expect(original.json()).toMatchObject({ status: 'available', returnRecipient: { kind: 'execution_run', runId: 'source-run' },
                progress: { outcome: { kind: 'cancelled' }, disposition: 'return_pending' } });
        });
        const cancelledReturnId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: target.id, localId: runAdmission.localId });
        const returnedRunInput = await db.sessionPendingMessage.create({ data: { sessionId: source.id, localId: cancelledReturnId, position: 1,
            content: { t: 'plain', v: { text: 'cancelled before native acceptance' } }, requestedAction: { v: 1, kind: 'enqueue' }, inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' } } });
        expect(await machineMutate({ kind: 'returned', returnedInputLocalId: cancelledReturnId }, runAdmission.localId)).toMatchObject({ ok: false, error: 'conflict' });
        await db.sessionPendingMessage.update({ where: { id: returnedRunInput.id }, data: { targetExecutionRunId: 'source-run' } });
        expect(await machineMutate({ kind: 'returned', returnedInputLocalId: cancelledReturnId }, runAdmission.localId)).toMatchObject({ ok: true, progress: { disposition: 'returned' } });
        await db.accessKey.delete({ where: { accountId_machineId_sessionId: { accountId: account.id, machineId: machine.id, sessionId: target.id } } });
        expect(await mutate({ kind: 'fulfill', turnId: 'target-turn', outcome: { kind: 'pass' } })).toMatchObject({ ok: false });
    });

    it('retains admitted attribution for a no-source wait without inventing an origin', async () => {
        const actionRequestAttributionV1 = materializeActionRequestAttributionV1({ requestRef: 'original-input', requester: null,
            persona: { serverId: 'home', sessionId: 'bot' }, origin: null });
        expect(await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: 'unused-account',
            reply: { mode: 'wait', actionRequestAttributionV1 } }))).toEqual({ v: 1, mode: 'wait', disposition: 'observing',
            actionRequestAttributionV1 });
    });

    it('projects a committed original after Pending-only acceptance without rewriting an existing causal origin', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        for (const existingOrigin of [null, { kind: 'session' as const, session: { serverId: 'source-home', sessionId: 'source-session' }, messageId: 'source-message' }]) {
            const localId = randomUUID();
            const actionRequestAttributionV1 = materializeActionRequestAttributionV1({ requestRef: 'bob-original-input',
                requester: { serverId: 'home', accountId: 'bob' }, persona: { serverId: 'home', sessionId: session.id }, origin: existingOrigin });
            const progress = { v: 1, mode: 'wait', disposition: 'observing', actionRequestAttributionV1 };
            const pending = await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId, position: existingOrigin ? 1 : 0,
                requestedAction: { v: 1, kind: 'enqueue' }, content: { t: 'plain', v: { text: 'original' } }, replyProgress: progress, replyDisposition: 'observing' } });
            expect(await inTx(tx => bindSessionInputReplyAcceptedTurnInTx(tx, { sessionId: session.id, localId, acceptedTurnId: 'run-turn' }))).toBe(true);
            const read = () => inTx(tx => readSessionMessageReplyInTx(tx, { accountId: account.id, sessionId: session.id, localId, authentication }));
            expect(await read()).toMatchObject({ status: 'available', progress: { actionRequestAttributionV1 } });
            const accepted = await db.sessionPendingMessage.findUniqueOrThrow({ where: { id: pending.id } });
            const message = await db.sessionMessage.create({ data: { sessionId: session.id, localId, seq: existingOrigin ? 2 : 1,
                messageRole: 'user', content: pending.content, replyProgress: accepted.replyProgress, replyDisposition: 'observing' } });
            expect(await read()).toMatchObject({ status: 'available', progress: { actionRequestAttributionV1 } });
            expect(await inTx(tx => bindSessionInputReplyAcceptedTurnInTx(tx, { sessionId: session.id, localId, acceptedTurnId: 'run-turn' }))).toBe(true);
            expect((await db.sessionPendingMessage.findUniqueOrThrow({ where: { id: pending.id } })).replyProgress)
                .toMatchObject({ actionRequestAttributionV1 });
            expect((await db.sessionMessage.findUniqueOrThrow({ where: { id: message.id } })).replyProgress)
                .toMatchObject({ actionRequestAttributionV1 });
        }
    });

    it.each([{ decision: 'reject', native: 'answer' }, { decision: 'cancel', native: 'none' },
        { decision: 'reject', native: 'failed' }] as const)('settles a private Discussion review $decision ($native) on the exact original without publication or a late return', async ({ decision, native }) => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: account.id,
            accountId: outsider.id, accessLevel: 'edit' } });
        const body = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Start' }] };
        const created = await createDiscussion({ authentication, actorAccountId: account.id, request: buildDiscussionMutationRequestBodyV1({
            kind: 'create', creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Private review' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: body }, authoredContent: body, mentionedAccountIds: [] },
        }) });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: account.id, discussionId,
            request: { participant: { kind: 'account', accountId: outsider.id } } })).toMatchObject({ ok: true });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: account.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'drafts_for_approval' } })).toMatchObject({ ok: true });
        const question = await postDiscussionMessage({ authentication, actorAccountId: account.id, discussionId, request: {
            localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: session.id } }] } },
            mentionedSessionIds: [session.id], mentionedAccountIds: [],
        } });
        if (!question.ok) throw new Error(question.error);
        const discussion = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: session.id };
        const admitted = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: account.id, reply: { mode: 'return', discussion } }));
        if (!admitted) throw new Error('Missing original Discussion review');
        const localId = randomUUID(), acceptedTurnId = native !== 'none' ? randomUUID() : undefined;
        const finalMessage = await db.sessionMessage.create({ data: { sessionId: session.id, seq: 2, messageRole: 'agent', content: { t: 'plain', v: {} } } });
        const progress = SessionMessageReplyProgressV1Schema.parse({ ...admitted, ...(acceptedTurnId ? { acceptedTurnId,
            outcome: native === 'failed' ? { kind: 'failed' } : { kind: 'answer', result: { sessionId: session.id, messageId: finalMessage.id } } } : {}) });
        await db.sessionMessage.create({ data: { sessionId: session.id, localId, seq: 1, messageRole: 'user', content: { t: 'plain', v: {} },
            replyDisposition: 'return_pending', replyProgress: progress } });
        await db.sessionPendingMessage.create({ data: { sessionId: session.id, localId, position: 0, content: { t: 'plain', v: {} },
            requestedAction: { v: 1, kind: 'enqueue' }, replyDisposition: 'return_pending', replyProgress: progress } });
        const payload = { kind: 'discussion_review', discussionId, messageId: question.value.message.id, ...(acceptedTurnId ? { acceptedTurnId } : {}), decision };
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            const url = `/v2/sessions/${session.id}/messages/by-local-id/${localId}/reply`, headers = { 'x-test-user-id': account.id };
            for (const mismatch of [{ messageId: 'another-question' }, { discussionId: 'another-discussion' }, { acceptedTurnId: 'another-turn' }]) {
                expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, ...mismatch } })).json()).toMatchObject({ ok: false, error: 'conflict' });
            }
            expect((await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': outsider.id }, payload })).json()).toMatchObject({ ok: false, error: 'forbidden' });
            const automated = await app.inject({ method: 'POST', url, headers: { ...headers, 'x-test-auth-token-kind': 'api_token',
                'x-test-api-token-account-id': account.id, 'x-test-api-token-principal-id': 'automation', 'x-test-api-token-credential-id': 'credential' }, payload });
            expect(automated.statusCode === 403 || automated.json().ok === false).toBe(true);
            expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, senderAccountId: account.id } })).statusCode).toBe(400);
            expect((await app.inject({ method: 'POST', url, headers, payload })).json()).toMatchObject({ ok: true,
                progress: { discussion, disposition: 'released', outcome: { kind: 'declined' } } });
            expect((await app.inject({ method: 'POST', url, headers, payload })).json()).toMatchObject({ ok: true,
                progress: { disposition: 'released', outcome: { kind: 'declined' } } });
            if (acceptedTurnId) await inTx(tx => projectSessionInputRepliesFromTurnInTx(tx, { sessionId: session.id, turnId: acceptedTurnId,
                status: 'completed', transcriptAnchorsJson: JSON.stringify({ userMessageSeqs: [1], finalAssistantMessageSeq: 2 }) }));
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } }))
                .toMatchObject({ replyDisposition: 'released', replyProgress: { disposition: 'released', outcome: { kind: 'declined' } } });
            expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } }))
                .toMatchObject({ replyDisposition: 'released', replyProgress: { disposition: 'released', outcome: { kind: 'declined' } } });
            const published = { ...progress, disposition: 'returned' as const, outcome: { kind: 'answer' as const,
                publicationRef: { kind: 'discussion' as const, discussion: { serverId: 'home', discussionId }, messageId: question.value.message.id } } };
            await db.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId: session.id, localId } }, data: { replyProgress: published, replyDisposition: 'returned' } });
            expect((await app.inject({ method: 'POST', url, headers, payload })).json()).toMatchObject({ ok: false, error: 'conflict' });
        });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
        expect(await db.sessionMessage.count({ where: { sessionId: session.id, replyDisposition: 'return_pending' } })).toBe(0);
    });

    it('allows only the original Account to consume a no-source wait and never schedules its late return', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await withAuthenticatedTestApp(app => { registerSessionMessageRoutes(app); sessionPendingRoutes(app); }, async app => {
            const headers = { 'x-test-user-id': account.id };
            const forged = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/pending`, headers,
                payload: { localId: 'forged-wait-input', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'question' } } },
                    reply: { mode: 'wait', actionRequestAttributionV1: { requestRef: 'someone-elses-input',
                        requester: { serverId: 'home', accountId: 'bob' }, persona: { serverId: 'home', sessionId: session.id }, origin: null } } } });
            expect(forged.statusCode).toBe(400);
            expect(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId: 'forged-wait-input' } } })).toBeNull();
            const enqueue = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/pending`, headers,
                payload: { localId: 'wait-input', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'question' } } }, reply: { mode: 'wait' } } });
            expect(enqueue.statusCode).toBe(200);
            const release = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/messages/by-local-id/wait-input/reply`, headers, payload: { kind: 'release' } });
            expect(release.json()).toMatchObject({ ok: true, progress: { mode: 'wait', disposition: 'released' } });
            const inline = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/messages/by-local-id/wait-input/reply`, headers, payload: { kind: 'inline' } });
            expect(inline.json()).toMatchObject({ ok: false, error: 'conflict' });
        });
    });

    it('binds automatic completion to the accepted input and exact final, not an unrelated later post', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const localId = 'automatic-original';
        const content = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'answer exactly this' } } };
        const materialize = async (requestLocalId: string) => {
            expect(await enqueuePendingMessage({ actorUserId: account.id, sessionId: session.id, localId: requestLocalId, content,
                requestedAction: { v: 1, kind: 'enqueue' }, reply: { mode: 'wait' }, authentication })).toMatchObject({ ok: true });
            const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: requestLocalId } } });
            return inTx(async tx => {
                const result = await createSessionMessageFromPending(tx, { sessionId: session.id, sessionEncryptionMode: 'plain', storagePolicy: 'optional',
                    localId: requestLocalId, content, messageRole: 'user', requestContentForEquality: content,
                    inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.parse(pending.inputAdmissionReceipt), pendingRequestedAction: { v: 1, kind: 'enqueue' } });
                if (!result.ok) throw new Error('materialization failed');
                await tx.sessionPendingMessage.delete({ where: { id: pending.id } });
                return result.message;
            });
        };
        const input = await materialize(localId);
        const batched = await materialize('automatic-batched');
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: { v: 1, sessionId: session.id,
            turnId: 'automatic-turn', mutationId: randomUUID(), action: 'begin', observedAt: Date.now(), transcriptAnchors: { userMessageSeqs: [input.seq, batched.seq] } } })).toMatchObject({ ok: true });
        const final = await db.sessionMessage.create({ data: { sessionId: session.id, seq: batched.seq + 1, messageRole: 'agent', content: { t: 'plain', v: { text: 'exact answer' } } } });
        await db.sessionMessage.create({ data: { sessionId: session.id, seq: batched.seq + 2, messageRole: 'agent', content: { t: 'plain', v: { text: 'unrelated latest post' } } } });
        const mutation = { v: 1 as const, sessionId: session.id, turnId: 'automatic-turn', mutationId: randomUUID(), action: 'complete' as const,
            observedAt: Date.now() + 1, transcriptAnchors: { startSeqInclusive: input.seq, endSeqInclusive: batched.seq + 2, finalAssistantMessageSeq: final.seq } };
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            const url = `/v2/sessions/${session.id}/messages/by-local-id/${localId}/reply`;
            const headers = { 'x-test-user-id': account.id };
            const [terminal, release] = await Promise.all([applySessionTurnMutation({ actorUserId: account.id, authentication, mutation }),
                app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/messages/by-local-id/automatic-batched/reply`, headers, payload: { kind: 'release' } })]);
            expect(terminal).toMatchObject({ ok: true });
            expect(release.json()).toMatchObject({ ok: true });
            expect((await db.sessionMessage.findUniqueOrThrow({ where: { id: batched.id } })).replyProgress).toMatchObject({
                acceptedTurnId: 'automatic-turn', disposition: 'released', outcome: { kind: 'answer', result: { messageId: final.id } } });
            expect((await app.inject({ method: 'GET', url, headers })).json()).toMatchObject({ status: 'available', progress: {
                acceptedTurnId: 'automatic-turn', outcome: { kind: 'answer', result: { sessionId: session.id, messageId: final.id } }, disposition: 'observing' } });
            const raced = await Promise.all(['inline', 'release'].map(kind => app.inject({ method: 'POST', url, headers, payload: { kind } })));
            expect(raced.every(result => result.statusCode === 200)).toBe(true);
            const row = await db.sessionMessage.findUniqueOrThrow({ where: { id: input.id } });
            expect(row.replyProgress).toMatchObject({ outcome: { kind: 'answer', result: { messageId: final.id } } });
            expect(SessionMessageReplyProgressV1Schema.parse(row.replyProgress).disposition).toMatch(/^(inline|released)$/);
            expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation })).toMatchObject({ ok: true });
            expect((await db.sessionMessage.findUniqueOrThrow({ where: { id: input.id } })).replyProgress).toEqual(row.replyProgress);
        });
    });

    it('preserves original queued reply custody against replacement and settles explicit pre-provider cancellation', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const request = { actorUserId: account.id, sessionId: session.id, localId: 'queued-ask', requestedAction: { v: 1 as const, kind: 'enqueue' as const }, authentication };
        const content = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'original question' } } };
        expect(await enqueuePendingMessage({ ...request, content, reply: { mode: 'wait' } })).toMatchObject({ ok: true });
        const original = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: request.localId } } });
        expect.soft(await updatePendingMessage({ ...request, content: { t: 'plain', v: { text: 'changed question' } } })).toMatchObject({ ok: false, error: 'delivery-settlement-conflict' });
        expect.soft((await db.sessionPendingMessage.findUniqueOrThrow({ where: { id: original.id } })).content).toEqual(original.content);
        await db.sessionPendingMessage.update({ where: { id: original.id }, data: { deliveryState: 'blocked', deliveryBlockedReason: 'delivery_outcome_uncertain' } });
        expect.soft(await sendPendingDeliveryAsNew(request)).toMatchObject({ ok: false, error: 'delivery-settlement-conflict' });
        await db.sessionPendingMessage.update({ where: { id: original.id }, data: { status: 'queued', deliveryState: null, deliveryBlockedReason: null } });
        expect(await deletePendingMessage({ ...request, withdraw: true })).toMatchObject({ ok: true, outcome: 'removed' });
        expect.soft(await db.sessionPendingMessage.findUnique({ where: { id: original.id } })).toMatchObject({ status: 'discarded', replyProgress: { outcome: { kind: 'cancelled' } } });
        const ordinary = { ...request, localId: 'ordinary-edit' };
        expect(await enqueuePendingMessage({ ...ordinary, content })).toMatchObject({ ok: true });
        expect(await updatePendingMessage({ ...ordinary, content: { t: 'plain', v: { text: 'ordinary change' } } })).toMatchObject({ ok: true });
    });

    it('retains actual failed, cancelled and terminal-no-result outcomes without inventing answers', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        let observedAt = Date.now();
        for (const [action, kind] of [['fail', 'failed'], ['cancel', 'cancelled'], ['complete', 'terminal_no_result']] as const) {
            const localId = `terminal-${action}`;
            const content = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'one exact input' } } };
            expect(await enqueuePendingMessage({ actorUserId: account.id, sessionId: session.id, localId, content,
                requestedAction: { v: 1, kind: 'enqueue' }, reply: { mode: 'wait' }, authentication })).toMatchObject({ ok: true });
            const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } });
            const input = await inTx(async tx => {
                const result = await createSessionMessageFromPending(tx, { sessionId: session.id, sessionEncryptionMode: 'plain', storagePolicy: 'optional',
                    localId, content, messageRole: 'user', requestContentForEquality: content,
                    inputAdmissionReceipt: SessionInputAdmissionReceiptV1Schema.parse(pending.inputAdmissionReceipt), pendingRequestedAction: { v: 1, kind: 'enqueue' } });
                if (!result.ok) throw new Error('materialization failed');
                await tx.sessionPendingMessage.delete({ where: { id: pending.id } });
                return result.message;
            });
            expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: { v: 1, sessionId: session.id,
                turnId: localId, mutationId: randomUUID(), action: 'begin', observedAt: ++observedAt, transcriptAnchors: { userMessageSeqs: [input.seq] } } })).toMatchObject({ ok: true });
            expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: { v: 1, sessionId: session.id,
                turnId: localId, mutationId: randomUUID(), action, observedAt: ++observedAt,
                ...(action === 'fail' ? { issue: { v: 1, scope: 'primary_session', status: 'failed', code: 'native_task_failed',
                    source: 'agent_session_error', occurredAt: observedAt } } : {}) } })).toMatchObject({ ok: true });
            expect((await db.sessionMessage.findUniqueOrThrow({ where: { id: input.id } })).replyProgress).toMatchObject({ acceptedTurnId: localId, outcome: { kind } });
        }
    });

    it('allows the current owner to release a plugin wait without granting shared readers its disposition', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const collaborator = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), installationId: randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] }, sessionMessageReply: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: account.id, accountId: collaborator.id, accessLevel: 'edit' } });
        const request: SessionInputRequestV1 = { v: 1, producer: 'pluginSession', caller: { kind: 'plugin', pluginId: 'acme.agent', contributionLocalId: 'assistant' }, permission: {}, replyIntent: { mode: 'wait' } };
        expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: account.id, sourceMachineId: machine.id, targetMachineId: machine.id,
            sessionId: session.id, localId: 'plugin-wait', requestedAction: { v: 1, kind: 'enqueue' }, reply: { mode: 'wait' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'plugin question' }, meta: withSessionInputRequestV1({}, request) } } })).toMatchObject({ status: 'accepted' });
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            const url = `/v2/sessions/${session.id}/messages/by-local-id/plugin-wait/reply`;
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': collaborator.id } })).json()).toMatchObject({ status: 'available' });
            expect((await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': collaborator.id }, payload: { kind: 'release' } })).json()).toMatchObject({ ok: false });
            expect((await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': account.id }, payload: { kind: 'release' } })).json()).toMatchObject({ ok: true, progress: { mode: 'wait', disposition: 'released' } });
        });
    });
});
