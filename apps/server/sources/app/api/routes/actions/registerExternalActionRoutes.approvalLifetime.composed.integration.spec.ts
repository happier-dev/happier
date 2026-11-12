import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import nacl from 'tweetnacl';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createExternalActionDaemonDispatchResponse, ExternalActionDaemonDispatchRequestSchema,
    prepareExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { auth } from '@/app/auth/auth';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(accept => { resolve = accept; });
    return { promise, resolve };
}

describe('approval decision HTTP observation lifetime', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-approval-lifetime-', initAuth: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['approval.request.decide', 'session.spawn_new'] as const)(
        'preserves the decision but retains ordinary Action cancellation after an HTTP disconnect (%s)', async actionId => {
            const account = await db.account.create({ data: { encryptionMode: 'plain' } });
            const keys = nacl.sign.keyPair();
            const machineId = randomUUID();
            await db.machine.create({ data: { id: machineId, accountId: account.id,
                metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
                installationId: randomUUID(), installationPublicKey: keys.publicKey, active: true,
                operationProtocolCapabilitiesRevision: 1,
                operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
            const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
            const homeId = await getOrCreateServerIdentityId();
            const draftInput = { discussionId: 'discussion', localId: 'answer',
                content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Private answer' }] },
                replyTarget: { kind: 'message' as const, messageId: 'question' } };
            let stored = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                createdBy: { surface: 'agent', sessionId: 'participant' }, discussionDraftReview: true,
                actionId: 'discussion.reply', actionArgs: draftInput, summary: 'Post answer',
                approval: { flow: 'deferred', result: 'required' }, executionOriginV1: { v: 1,
                    authority: 'account_automation', surface: 'agent', serverId: 'daemon-home', serverIdentityId: homeId,
                    accountId: account.id, machineId, sessionId: 'participant', actionId: 'discussion.reply', requestId: 'answer',
                    caller: { kind: 'host' }, discussionReplyReturn: { serverId: homeId,
                        requestLocalId: 'original', acceptedTurnId: 'original-turn' } } });
            let publicationCount = 0;
            // Only persistence, external current-Home/installation observation and
            // Discussion HTTP transport are boundaries. Domain admission,
            // decision/CAS/claim/replay use the real Protocol owner.
            const executor = createActionExecutor({
                approvalsGet: async () => stored,
                approvalsUpdate: async ({ request }) => {
                    const transition = decideApprovalRequestTransition(stored, request);
                    if (!transition.ok) return transition;
                    stored = ApprovalRequestV2Schema.parse(request);
                    return { ok: true };
                },
                isApprovalExecutionOriginCurrent: async ({ signal }) => !signal?.aborted,
                discussionAction: async ({ actionId: discussionActionId }) => {
                    if (discussionActionId === 'discussion.participants.list') return {
                        discussionId: 'discussion', ownerAccountId: account.id, access: 'owner', grants: [],
                        participants: [{ participant: { kind: 'session', sessionId: 'participant' },
                            answerPolicy: 'drafts_for_approval', createdAt: 1 }],
                    };
                    publicationCount += 1;
                    return { v: 1, serverId: 'daemon-home', messageSeq: 2, message: {
                        id: 'answer-message', discussionId: 'discussion', localId: 'answer', seq: 2,
                        authorAccountId: null, accountActor: null, producerV1: null, content: draftInput.content,
                        mentionedAccountIds: [], createdAt: 2, messageRef: { kind: 'discussion',
                            discussion: { serverId: 'daemon-home', discussionId: 'discussion' }, messageId: 'answer-message' } } };
                },
            } satisfies Partial<ActionExecutorDeps> as ActionExecutorDeps);
            const reachedDaemon = deferred<void>();
            const releaseDaemon = deferred<void>();
            const responseClosed = deferred<void>();
            const settled = deferred<void>();
            let daemonSignal: AbortSignal | undefined;
            let execution: Awaited<ReturnType<typeof executor.execute>> | undefined;
            const io = new Server();
            const dispatch = createExternalActionDaemonDispatcher({ io,
                // The network boundary parks after real Home auth/placement, just
                // before the receiving daemon begins its actual decision owner.
                forwardRpc: async call => {
                    const request = ExternalActionDaemonDispatchRequestSchema.parse(call.callParams);
                    daemonSignal = call.cancellation?.signal;
                    reachedDaemon.resolve();
                    await releaseDaemon.promise;
                    execution = actionId === 'approval.request.decide'
                        ? await executor.execute('approval.request.decide', request.envelope.v === 1 ? request.envelope.input : {}, {
                            surface: 'ui', authority: request.principal.authority, serverId: 'daemon-home',
                            serverIdentityId: homeId, runtimeAccountId: account.id,
                            ...(daemonSignal ? { signal: daemonSignal } : {}),
                        })
                        : { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
                    settled.resolve();
                    return { ok: true, result: createExternalActionDaemonDispatchResponse(prepareExternalActionResponseEnvelopeV1({
                        v: 1, actionId, requestId: request.envelope.requestId, execution })) };
                },
            });
            const app = createAuthenticatedTestApp({ authentication: 'real' });
            app.addHook('onRequest', async (_request, reply) => { reply.raw.once('close', () => responseClosed.resolve()); });
            registerExternalActionRoutes(app, { dispatch });
            const origin = await app.listen({ host: '127.0.0.1', port: 0 });
            const client = httpRequest(`${origin}/v1/actions/${actionId}`, { method: 'POST', headers: {
                authorization: `Bearer ${token}`, 'content-type': 'application/json',
            } });
            client.on('error', () => { /* A destroyed reviewing browser has no response observer. */ });
            try {
                // Canonical public spawn operands admitted since 6324db8cb34a.
                client.end(JSON.stringify({ v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId },
                    input: actionId === 'approval.request.decide' ? { artifactId: 'private-draft', decision: 'approve' } : { directory: { kind: 'path', path: '/workspace' },
                        agentTarget: { kind: 'agent', identity: { pluginId: 'native.agent', localId: 'agent' } } } }));
                await reachedDaemon.promise;
                client.destroy();
                await responseClosed.promise;
                releaseDaemon.resolve();
                await settled.promise;
                if (actionId === 'approval.request.decide') {
                    expect(daemonSignal?.aborted ?? false).toBe(false);
                    expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true, result: { status: 'executed' } });
                    expect(stored).toMatchObject({ status: 'executed', execution: { ok: true } });
                    expect(publicationCount).toBe(1);
                } else {
                    expect(daemonSignal?.aborted).toBe(true);
                    expect(stored.status).toBe('open');
                    expect(publicationCount).toBe(0);
                }
            } finally {
                releaseDaemon.resolve();
                client.destroy();
                await app.close();
            }
        });
});
