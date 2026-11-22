import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentSessionRuntimeEventV1Schema, deriveAccountMachineKeyFromRecoverySecret, renderSessionInputContextPromptV1, type AgentSessionRuntimeEvent } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import Fastify from 'fastify';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { auth } from '@/app/auth/auth';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { registerAccountProfileRoute } from '@/app/api/routes/account/registerAccountProfileRoute';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { registerSessionFollowRoutes } from '@/app/api/routes/session/registerSessionFollowRoutes';
import { registerSessionFollowSourceRoutes } from '@/app/api/routes/session/registerSessionFollowSourceRoutes';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { featuresRoutes } from '@/app/api/routes/features/featuresRoutes';
import { startSocket } from '@/app/api/socket';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { blockPendingDelivery, deletePendingMessage, enqueuePendingMessage, enqueuePendingMessageByAuthenticatedMachine, markPendingDeliveryHandled } from './pendingMessageService';
import { createPublicAcpSession } from '../../../../../cli/src/agent/acp/runtime/publicSession/createPublicAcpSession';
import { createNativeAgentSessionPublications } from '../../../../../cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createSessionTurnLifecycle } from '../../../../../cli/src/agent/runtime/session/turn/lifecycle';
import { createNativeAgentSessionOperations } from '../../../../../cli/src/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createPluginSessionMediaHostAdapter } from '../../../../../cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionMedia';
import { bindSessionProviderInputOutcome, createSessionProviderInputOutcomeNormalizer, createSessionProviderInputOutcomeBinding } from '../../../../../cli/src/agent/runtime/session/input/providerInputOutcome';
import { ApiSessionClient } from '../../../../../cli/src/api/session/sessionClient';
import { createSessionSocketTransport } from '../../../../../cli/src/api/session/connection/createSessionSocketTransport';
import { createInitialHostRuntimeActivityMutation } from '../../../../../cli/src/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { createTestMetadata } from '../../../../../cli/src/testkit/backends/sessionMetadata';
import { encodeBase64, encrypt } from '../../../../../cli/src/api/encryption';
import type { AgentSessionRuntimeContext, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { writeAcpTestAgentScript } from '../../../../../cli/src/agent/acp/testkit/subprocessHarness';
import { waitForCondition } from '../../../../../cli/src/testkit/async/waitFor';
import { MessageQueue2 } from '../../../../../cli/src/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '../../../../../cli/src/agent/runtime/session/input/sessionProviderInputConsumer';
import { createSessionProviderInputConsumerSessionAdapter } from '../../../../../cli/src/agent/runtime/waitForNextPermissionModeMessage';
import { createWorkflowOriginContextInputPort } from '../../../../../cli/src/agent/runtime/session/contextOnly/workflowOriginInput';
import { publishSessionFollowWakeInvalidation } from '../../../../../cli/src/agent/runtime/session/follow/sessionFollowWakeSignal';
import { registerPermissionModeMessageQueueBinding } from '../../../../../cli/src/agent/runtime/permissions/bindModeQueue';
import { combinePermissionModeQueuedPrompts, isNextTurnContextQueuedPrompt, appendNextTurnContextToQueuedPrompt,
    type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '../../../../../cli/src/agent/runtime/permissions/queuedPrompt';
import { buildTrustedHostSessionInputAdmissionV1, SessionInputRequestV1Schema, withSessionInputRequestV1,
    SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionFollowInputV1Schema, deriveSessionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { createSessionFollowContextReconciler } from '../../../../../cli/src/agent/runtime/session/follow/sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator } from '../../../../../cli/src/agent/runtime/session/follow/sessionFollowSourceHydrator';
import { createResourceDataKey } from '../../../../../cli/src/api/encryption/resourceDataKey';
import { writeSessionDataKeyEnvelopeInTx } from '@/app/session/encryption/sessionDataKeyEnvelopePersistence';
import { inTx } from '@/storage/inTx';
import { hasCanonicalFollowProviderInputAcceptanceInTx } from '@/app/session/follow/providerInputAcceptance';
import { waitForSessionInputResult } from '../../../../../cli/src/session/services/sendSessionMessage';
import { blockPendingQueueV2Delivery } from '../../../../../cli/src/api/session/pendingQueueV2Transport';
import { sendFileReviewNoteToSession } from '../../../../../cli/src/session/services/sendFileReviewNote';
import { runWithServerHttpBaseUrl } from '../../../../../cli/src/api/client/serverHttpBaseUrl';
import { prepareSessionInputForProviderDispatch } from '../../../../../cli/src/agent/runtime/turns/prepareSessionInputForProviderDispatch';

import { runPermissionModePromptLoop } from '../../../../../cli/src/agent/runtime/runPermissionModePromptLoop';
import { MessageBuffer } from '../../../../../cli/src/ui/ink/messageBuffer';
import { HappierStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';

describe('consumed ACP input → host turn → Pending', () => {
    let harness: LightSqliteHarness;
    let app: AppFastify;
    let origin: string;
    const clients = new Set<ApiSessionClient>();
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-consumed-input-', initAuth: true, initEncrypt: true });
        app = Fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        enableErrorHandlers(app);
        enableAuthentication(app);
        registerAccountEncryptionRoutes(app);
        registerAccountProfileRoute(app);
        registerSessionListingRoutes(app);
        registerSessionMessageRoutes(app);
        registerSessionFollowRoutes(app);
        registerSessionFollowSourceRoutes(app);
        sessionPendingRoutes(app);
        featuresRoutes(app);
        startSocket(app);
        origin = await app.listen({ host: '127.0.0.1', port: 0 });
    }, 120_000);
    afterAll(async () => { await app?.close(); await harness?.close(); });
    afterEach(async () => {
        await Promise.all([...clients].map(client => client.close()));
        clients.clear();
        vi.unstubAllEnvs();
    });

    it.each([
        { scenario: 'team', title: 'observes a committed input refusal through real HTTP and advances the next ordinary input' },
        { scenario: 'attachment', title: 'observes a committed attachment refusal and advances the next ordinary input' },
    ] as const)('$title', async ({ scenario }) => {
        harness.resetEnv();
        const authentication = createPresentUserSessionAccessAuthentication();
        const accountSecret = new Uint8Array(32).fill(7);
        const metadata = createTestMetadata({ path: harness.baseDir });
        const owner = await db.account.create({ data: createSignedAccountContentBinding(tweetnacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(accountSecret)).publicKey) });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const credentials = { token, encryption: { type: 'legacy' as const, secret: accountSecret } };
        const resource = await createResourceDataKey({ credentials, mode: 'e2ee' });
        if (resource.mode !== 'e2ee') throw new Error('Expected fixture E2EE resource');
        const sessionKey = resource.dataKey;
        const sealInput = (text: string, meta?: Record<string, unknown>) => encodeBase64(encrypt(sessionKey, 'dataKey', {
            role: 'user', content: { type: 'text', text }, ...(meta ? { meta } : {}),
        }));
        const session = await db.session.create({ data: { tag: randomUUID(), accountId: owner.id,
            metadata: encodeBase64(encrypt(sessionKey, 'dataKey', metadata)) } });
        expect(await inTx(tx => writeSessionDataKeyEnvelopeInTx(tx, { sessionId: session.id,
            recipientAccountId: owner.id, encryptedDataKey: decodeBase64(resource.dataEncryptionKey),
            markRecipientChanged: false }))).toMatchObject({ ok: true });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const client = new ApiSessionClient(token, {
            id: session.id, seq: 0, encryptionMode: 'e2ee', encryptionKey: sessionKey, encryptionVariant: 'dataKey',
            metadata, metadataVersion: 0, agentState: null, agentStateVersion: 0,
        }, {
            metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials },
            localMachineId: machine.id,
            initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
                sessionId: session.id, agentRuntimeApplicability: 'supported',
            })],
            transport: { serverId: 'consumed-input-home', serverUrl: origin, resolveToken: async () => token,
                createSessionSocketTransport: binding => createSessionSocketTransport({ ...binding, token, serverUrl: origin,
                    accessKeyBinding: 'preestablished' }) },
        });
        clients.add(client);
        const deliveredInputIds = new Set<string>();
        // Subscribe to pushed input; the runner's consumer below owns draining.
        client.onUserMessage(message => { if (message.localId) deliveredInputIds.add(message.localId); });
        expect(await client.claimCurrentSessionPublisherAuthorityForStartup()).toMatchObject({ status: 'claimed' });
        await client.updateRuntimeActivityProjection({ runtimeActivityState: 'idle', runtimeActivityActiveCount: 0 });

        const localId = 'withdrawn-' + randomUUID();
        const request = { actorUserId: owner.id, sessionId: session.id, localId, authentication };
        const structuredInput = scenario === 'attachment' ? HappierStructuredInputV1Schema.parse({
            v: 1,
            composerAttachments: ['available', 'unavailable'].map(instanceId => ({
                v: 1, instanceId, key: instanceId, attachment: { pluginId: 'acme.issues', localId: 'issue' },
                value: { sourceInstance: { sourceInstanceId: instanceId } }, presentation: { label: 'Issue', typeLabel: 'Issue' },
            })),
        }) : null;
        const queueForDispatch = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
            mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
        if (structuredInput) registerPermissionModeMessageQueueBinding({ session: client, queue: queueForDispatch,
            getCurrentPermissionMode: () => 'default', setCurrentPermissionMode() {} });
        expect(await enqueuePendingMessage({ ...request, ciphertext: sealInput(
            structuredInput ? 'Review the selected references.' : 'No tools. Reply QA_TEAM_DENIED.',
            structuredInput ? { happierStructuredInputV1: structuredInput } : undefined),
            requestedAction: { v: 1, kind: 'enqueue' } }))
            .toMatchObject({ ok: true });
        expect(await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force',
            deliveryTiming: 'after_foreground_ready' })).toMatchObject({ type: 'materialized', localId });
        // Materialization invokes the real host admission/settlement writer.
        // Live r1113b committed this user before Home refused turn-begin.
        expect(await db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
        })).toMatchObject({ localId, messageRole: 'user' });
        if (structuredInput) {
            const nextId = localId + '-next';
            expect((await axios.post(origin + '/v2/sessions/' + session.id + '/pending', {
                localId: nextId, ciphertext: sealInput('Next ordinary input'), requestedAction: { v: 1, kind: 'enqueue' },
            }, { headers: { Authorization: 'Bearer ' + token } })).data).toMatchObject({ didWrite: true });

            const runtime = createNativeAgentSessionOperations({
                send: async () => { throw new Error('Unexpected native send'); },
                watch: () => ({ dispose() {} }),
                dispose: async () => {},
            }, session.id, undefined, undefined, undefined, undefined, undefined, {
                context: { signal: new AbortController().signal } as AgentSessionRuntimeContext,
                cwd: harness.baseDir, connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
            });
            const stop = new AbortController();
            const resolveComposerAttachmentForDispatch = vi.fn(async () => ({ attachments: [
                { instanceId: 'available', status: 'ready' as const },
                { instanceId: 'unavailable', status: 'unavailable' as const, retryable: false },
            ] }));
            const onPromptFailure = vi.fn();
            const consumer = createSessionProviderInputConsumer({ messageQueue: queueForDispatch,
                session: createSessionProviderInputConsumerSessionAdapter(client),
                pendingQueueDeliveryTiming: 'after_foreground_ready' });
            await runPermissionModePromptLoop({
                providerName: 'Fixture', agentMessageType: 'claude', explicitPermissionMode: undefined,
                session: client, runtime, messageQueue: queueForDispatch, inputConsumer: consumer,
                permissionHandler: { setPermissionMode() {}, reset() {} },
                createOverrideSynchronizer: () => ({ syncFromMetadata() {}, async flushPendingAfterStart() {} }),
                messageBuffer: new MessageBuffer(), shouldExit: () => stop.signal.aborted, getAbortSignal: () => stop.signal,
                keepAlive() {}, setThinking() {}, sendReady: () => stop.abort(),
                currentPermissionModeUpdatedAt: 0, setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {},
                formatPromptErrorMessage: String, registerProviderAcceptedEffect: () => undefined,
                resolveComposerAttachmentForDispatch, onPromptFailure,
            });

            expect(resolveComposerAttachmentForDispatch).toHaveBeenCalledWith(expect.objectContaining({
                request: expect.objectContaining({ localId, attachments: [
                    expect.objectContaining({ instanceId: 'available' }),
                    expect.objectContaining({ instanceId: 'unavailable' }),
                ] }),
            }));
            expect(onPromptFailure).toHaveBeenCalledWith(expect.objectContaining({
                code: 'composer_attachment_resolution_unavailable', retryable: false,
            }), expect.objectContaining({ preparingPrompt: true }));
            const receipt = await axios.get<{ pending: { localId: string; status: string; discardedReason: string | null }[] }>(
                origin + '/v2/sessions/' + session.id + '/pending?includeDiscarded=true',
                { headers: { Authorization: 'Bearer ' + token } },
            );
            const refused = receipt.data.pending.find(row => row.localId === localId);
            expect({ status: refused?.status, discardedReason: refused?.discardedReason })
                .toEqual({ status: 'discarded', discardedReason: 'attachment_unavailable' });
            const next = await consumer.waitForNextInput({ abortSignal: AbortSignal.timeout(5_000) });
            expect(next?.message).toMatchObject({ localId: nextId, text: 'Next ordinary input' });
            return;
        }
        await runWithServerHttpBaseUrl(origin, async () => {
            let observedPending!: () => void;
            const firstPendingRead = new Promise<void>(resolve => { observedPending = resolve; });
            const get = axios.get.bind(axios);
            // Instrument the real HTTP boundary without replacing its response.
            const reads = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
                const response = await get(url, config);
                if (url.includes('/pending')) observedPending();
                return response;
            });
            try {
                const result = waitForSessionInputResult({ credentials, idOrPrefix: session.id, localId,
                    timeoutMs: 5_000, resolveAuthorizationHeaders: () => ({ Authorization: 'Bearer ' + token }) });
                // Old code can return pending without ever reading Pending. Let
                // that terminal result reach the assertion, rather than hanging
                // this test on a read the broken consumer never performs.
                await Promise.race([firstPendingRead, result]);
                expect(await blockPendingQueueV2Delivery({ token, sessionId: session.id, localId,
                    reason: 'team_access_removed' })).toMatchObject({ pendingQueueState: { pendingBlockedCount: 1 } });
                expect.soft(await result).toMatchObject({ ok: true, result: { kind: 'failed' } });
            } finally { reads.mockRestore(); }
        });
        // The grant owner separately proves regrant admission. This is the
        // retained queue shape after that boundary: a fresh enqueue, no bypass.
        expect(await client.reconcilePendingProviderInputCustodyBeforeMaterialization()).toBe(true);
        const freshId = localId + '-after-regrant';
        const queue = new MessageQueue2<string>(mode => mode);
        client.onUserMessage(message => {
            if (message.localId === freshId && message.content.type === 'text') {
                deliveredInputIds.add(message.localId);
                queue.push(message.content.text, 'default');
            }
        });
        const consumer = createSessionProviderInputConsumer({ messageQueue: queue,
            session: createSessionProviderInputConsumerSessionAdapter(client),
            pendingQueueDeliveryTiming: 'after_foreground_ready' });
        const abort = new AbortController();
        const nextInput = consumer.waitForNextInput({ abortSignal: abort.signal });
        try {
            // The public route publishes the committed Pending change; the
            // storage function alone deliberately does not emit that wake.
            expect((await axios.post(origin + '/v2/sessions/' + session.id + '/pending', {
                localId: freshId, ciphertext: sealInput('Fresh prompt'), requestedAction: { v: 1, kind: 'enqueue' },
            }, { headers: { Authorization: 'Bearer ' + token } })).data).toMatchObject({ didWrite: true });
            await waitForCondition(() => Promise.resolve(deliveredInputIds.has(freshId)), {
                timeoutMs: 5_000, intervalMs: 10, label: 'fresh ordinary input pushed past retained Team refusal',
            });
            expect(await nextInput).toMatchObject({ message: 'Fresh prompt' });
        } catch (error) {
            const rows = await db.sessionPendingMessage.findMany({ where: { sessionId: session.id },
                select: { localId: true, status: true, deliveryState: true, deliveryBlockedReason: true } });
            throw new Error(String(error) + JSON.stringify({ rows, state: client.getPendingQueueState(),
                retained: client.hasPendingProviderInput(localId), fresh: client.hasPendingProviderInput(freshId) }));
        } finally {
            abort.abort();
            await nextInput;
        }
        expect(await db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: freshId } },
        })).toMatchObject({ localId: freshId, messageRole: 'user' });
        expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } }))
            .toMatchObject({ deliveryState: 'blocked', deliveryBlockedReason: 'team_access_removed' });
    });

    it.each(['retained', 'reconnect', 'successor', 'ordinary-head', 'person-hold', 'omitted', 'file-review'] as const)(
        'carries a retained quiet original with the next natural Pending input (%s)', async scenario => {
        harness.resetEnv({ HAPPIER_FEATURE_SESSIONS__ENABLED: 'true', HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'true' });
        await getOrCreateServerIdentityId();
        const authentication = createPresentUserSessionAccessAuthentication();
        const accountSecret = new Uint8Array(32).fill(7);
        const metadata = createTestMetadata({ path: harness.baseDir,
            ...(scenario === 'person-hold' ? { sessionExplicitStopV1: {
                v: 1, cause: 'explicit_stop', requestId: 'person-stop', requestedAtMs: 100,
            } } : {}) });
        const owner = await db.account.create({ data: createSignedAccountContentBinding(
            tweetnacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(accountSecret)).publicKey) });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const credentials = { token, encryption: { type: 'legacy' as const, secret: accountSecret } };
        const resource = await createResourceDataKey({ credentials, mode: 'e2ee' });
        if (resource.mode !== 'e2ee') throw new Error('Expected fixture E2EE resource');
        const sessionKey = resource.dataKey;
        const encryptionVariant = 'dataKey' as const;
        const session = await db.session.create({ data: { tag: randomUUID(), accountId: owner.id,
            metadata: encodeBase64(encrypt(sessionKey, encryptionVariant, metadata)) } });
        expect(await inTx(tx => writeSessionDataKeyEnvelopeInTx(tx, { sessionId: session.id,
            recipientAccountId: owner.id, encryptedDataKey: decodeBase64(resource.dataEncryptionKey),
            markRecipientChanged: false }))).toMatchObject({ ok: true });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            installationId: randomUUID(), metadata: encodeBase64(encrypt(accountSecret, 'legacy', {})),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] }, sessionFollow: { contextV1: true } },
            operationProtocolCapabilitiesRevision: 1 } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const transports: ReturnType<typeof createSessionSocketTransport>[] = [];
        const createClient = () => {
            const client = new ApiSessionClient(token, { id: session.id, seq: 0, encryptionMode: 'e2ee',
            encryptionKey: sessionKey, encryptionVariant, metadata, metadataVersion: 0,
            agentState: null, agentStateVersion: 0 }, {
            metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials },
            localMachineId: machine.id,
            initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
                sessionId: session.id, agentRuntimeApplicability: 'supported' })],
            transport: { serverId: 'quiet-input-home', serverUrl: origin, resolveToken: async () => token,
                createSessionSocketTransport: binding => {
                    const transport = createSessionSocketTransport({ ...binding, token, serverUrl: origin,
                        accessKeyBinding: 'preestablished' });
                    transports.push(transport);
                    return transport;
                } },
        });
            clients.add(client);
            return client;
        };
        let client = createClient();
        expect(await client.claimCurrentSessionPublisherAuthorityForStartup()).toMatchObject({ status: 'claimed' });
        const sourceResource = await createResourceDataKey({ credentials, mode: 'e2ee' });
        if (sourceResource.mode !== 'e2ee') throw new Error('Expected fixture E2EE source');
        const source = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), seq: 1,
            metadata: encodeBase64(encrypt(sourceResource.dataKey, 'dataKey', metadata)) } });
        expect(await inTx(tx => writeSessionDataKeyEnvelopeInTx(tx, { sessionId: source.id,
            recipientAccountId: owner.id, encryptedDataKey: decodeBase64(sourceResource.dataEncryptionKey),
            markRecipientChanged: false }))).toMatchObject({ ok: true });
        const sourceMessage = { localId: 'source-original', seq: 1 };
        await db.sessionMessage.create({ data: { sessionId: source.id, ...sourceMessage, messageRole: 'agent',
            content: { t: 'encrypted', c: encodeBase64(encrypt(sourceResource.dataKey, 'dataKey', {
                role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Worker original result' } },
            })) } } });
        const edge = await db.sessionFollowEdge.create({ data: { destinationSessionId: session.id, sourceSessionId: source.id,
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }),
            relation: 'manager', managerSourceSessionId: source.id, policyJson: JSON.stringify({ preset: 'important' }) } });
        const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn', event: { kind: 'update_posted' },
            original: { sourceSessionId: source.id, sourceMessage } });
        const host = buildTrustedHostSessionInputAdmissionV1('agent');
        const request = SessionInputRequestV1Schema.parse({ ...host.request, followDeliveryV1: delivery });
        let quietId: string;
        if (scenario === 'file-review') {
            await runWithServerHttpBaseUrl(origin, () => sendFileReviewNoteToSession({ credentials, sessionId: session.id,
                note: { action: 'discard', paths: ['src/app.ts'], changeCount: 2 } }));
            const rows = await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } });
            expect(rows).toHaveLength(1);
            quietId = rows[0]!.localId;
            expect(rows[0]!.inputAdmissionReceipt).toMatchObject({ nextTurnNote: 'file_review_note.v1' });
        } else {
        quietId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: session.id, original: delivery.original });
        expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: owner.id, sourceMachineId: machine.id,
            targetMachineId: machine.id, sessionId: session.id, localId: quietId,
            requestedAction: { v: 1, kind: 'enqueue' }, followDeliveryV1: delivery,
            followRelations: [{ relation: 'manager', attachedAt: edge.attachedAt.getTime() }],
            content: { t: 'encrypted', c: encodeBase64(encrypt(sessionKey, encryptionVariant, {
                role: 'user', content: { type: 'text', text: '' },
                meta: withSessionInputRequestV1({ [SESSION_MESSAGE_PROVENANCE_META_KEY]: host.provenance }, request),
            })) } })).toMatchObject({ status: 'accepted', localId: quietId });
        }
        const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(() => 'mode', {
            batcher: combinePermissionModeQueuedPrompts, isContextOnly: isNextTurnContextQueuedPrompt,
            withContext: appendNextTurnContextToQueuedPrompt,
        });
        registerPermissionModeMessageQueueBinding({ session: client, queue,
            getCurrentPermissionMode: () => 'default', setCurrentPermissionMode: () => {} });
        expect(await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
            .toMatchObject({ type: 'materialized', localId: quietId });
        expect(queue.size()).toBe(0);
        if (scenario === 'reconnect') {
            const socket = transports.at(-1)!.socket;
            socket.disconnect();
            socket.connect();
            expect(await client.claimCurrentSessionPublisherAuthorityForStartup()).toMatchObject({ status: 'claimed' });
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                sessionId: session.id, localId: quietId } } })).toMatchObject({
                deliveryState: 'blocked', deliveryBlockedReason: 'delivery_outcome_uncertain' });
        }
        if (scenario === 'successor') {
            await client.close();
            clients.delete(client);
            client = createClient();
            expect(await client.claimCurrentSessionPublisherAuthorityForStartup()).toMatchObject({ status: 'claimed' });
        }
        const ordinaryId = `ordinary-${randomUUID()}`;
        if (scenario === 'ordinary-head') {
            expect(await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId: ordinaryId, authentication,
                ciphertext: encodeBase64(encrypt(sessionKey, encryptionVariant, { role: 'user', content: { type: 'text', text: 'Earlier human input' } })),
                requestedAction: { v: 1, kind: 'enqueue' } })).toMatchObject({ ok: true });
            expect(await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
                .toMatchObject({ type: 'materialized', localId: ordinaryId });
        }
        const humanId = `natural-${randomUUID()}`;
        const naturalAdmission = await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId: humanId, authentication,
            ciphertext: encodeBase64(encrypt(sessionKey, encryptionVariant, { role: 'user', content: { type: 'text', text: 'Continue the work' } })),
            requestedAction: { v: 1, kind: 'enqueue' } });
        expect(naturalAdmission, JSON.stringify(naturalAdmission)).toMatchObject({ ok: true });
        await client.reconcilePendingQueueState({ force: true });
        if (scenario === 'person-hold') {
            const consumer = createSessionProviderInputConsumer({ messageQueue: queue,
                session: createSessionProviderInputConsumerSessionAdapter(client) });
            expect(await consumer.drainPending({ reason: 'person-held-quiet-context' })).toMatchObject({
                materialized: 0, stoppedReason: 'materialization_blocked' });
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                sessionId: session.id, localId: humanId } } })).toMatchObject({ status: 'queued', deliveryState: null });
            expect(queue.size()).toBe(0);
            return;
        }
        if (scenario === 'successor') {
            expect(await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).toEqual({ type: 'no_pending' });
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                sessionId: session.id, localId: quietId } } })).toMatchObject({
                status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'delivery_outcome_uncertain' });
            return;
        }
        if (scenario === 'ordinary-head') {
            expect(await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
                .toMatchObject({ type: 'materialized', localId: ordinaryId });
            expect(await client.reconcilePendingProviderInputCustodyBeforeMaterialization()).toBe(false);
            expect(await transports.at(-1)!.socket.emitWithAck('pending-materialize-next', {
                sid: session.id, deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready',
                retainedContext: { localIds: [quietId] }, unexpectedAuthority: true,
            })).toMatchObject({ ok: false, error: 'invalid-params' });
            expect(await transports.at(-1)!.socket.emitWithAck('pending-materialize-next', {
                sid: session.id, deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready',
                retainedContext: { localIds: [quietId, ordinaryId] },
            })).toMatchObject({ ok: false, error: 'invalid-params' });
            return;
        }
        expect(await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
            .toMatchObject({ type: 'materialized', localId: humanId });
        const batch = await queue.waitForMessagesAndGetAsString();
        expect(batch?.message).toMatchObject({ localId: humanId, text: 'Continue the work',
            ...(scenario === 'file-review' ? { fileReviewNoteContext: [{ localId: quietId }] }
                : { followDeliveries: [{ localInputId: quietId, delivery }] }) });
        const hydrateObservation = createSessionFollowSourceHydrator({ session: client, credentials });
        const reconciler = createSessionFollowContextReconciler({ session: client, hydrateObservation,
            maxFollowContextUtf8Bytes: scenario === 'omitted' ? 1 : 8192 });
        if (scenario !== 'file-review') {
        const observed = await client.observePendingSessionFollow({ inputLocalIds: [quietId] });
        expect(observed, JSON.stringify(observed)).toMatchObject({ ok: true });
        expect(observed.ok && observed.observations.some(row => 'kind' in row
            && row.kind === 'admitted_input' && row.localInputId === quietId)).toBe(true);
        const admittedObservation = observed.ok ? observed.observations.find(row => 'kind' in row
            && row.kind === 'admitted_input' && row.localInputId === quietId) : undefined;
        if (!admittedObservation || !('kind' in admittedObservation) || admittedObservation.kind !== 'admitted_input') {
            throw new Error('Missing fixture admitted Follow observation');
        }
        expect(await hydrateObservation({ observation: admittedObservation, signal: new AbortController().signal }))
            .toMatchObject({ reason: 'source_changed', recentMessages: [{ text: 'Worker original result', seq: 1 }] });
        }
        const prepared = scenario === 'file-review' ? null : await reconciler({ signal: new AbortController().signal,
            followDeliveries: batch!.message.followDeliveries });
        const representedIds = scenario === 'file-review' ? [quietId] : prepared?.representedFollowLocalInputIds ?? [];
        expect(representedIds).toEqual(scenario === 'omitted' ? [] : [quietId]);
        const prompt = scenario === 'file-review'
            ? (await prepareSessionInputForProviderDispatch({ prompt: batch!.message, transformedUserText: batch!.message.text,
                providerNativeCommand: false, localId: humanId, signal: new AbortController().signal })).renderPrompt()
            : renderSessionInputContextPromptV1({ sessionFollowUpdates: prepared?.updates,
                transformedUserText: batch!.message.text });
        if (scenario === 'file-review') expect(prompt).toContain('Continue the work\n\nYou discarded 2 changes in "src/app.ts".');
        else if (scenario !== 'omitted') expect(prompt).toContain('Worker original result');
        let emitNative: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        let sequence = 0;
        const native: AgentSessionRuntime = {
            send: async request => {
                expect(request.inputIds).toEqual([humanId]);
                expect(request.input.text).toBe(prompt);
                if (request.delivery.kind !== 'newTurn') throw new Error('Expected natural newTurn');
                emitNative?.({ kind: 'input-accepted', sessionId: session.id, inputIds: request.inputIds,
                    delivery: request.delivery, sequence: ++sequence, emittedAtMs: Date.now() });
                return { status: 'admitted' };
            },
            watch: handler => { emitNative = handler; return { dispose: () => { emitNative = undefined; } }; },
            dispose: async () => undefined,
        };
        const runtime = createNativeAgentSessionOperations(native, session.id, undefined, undefined, undefined,
            undefined, undefined, { context: { signal: new AbortController().signal } as AgentSessionRuntimeContext,
                cwd: harness.baseDir, connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false } });
        const acceptance = createSessionProviderInputOutcomeBinding({ getTarget: () => client });
        let primarySettlement: Promise<void> | undefined;
        const representedInputs = scenario === 'file-review'
            ? batch!.message.fileReviewNoteContext!.map(note => ({ localInputId: note.localId!, userMessageSeq: note.userMessageSeq }))
            : batch!.message.followDeliveries!.filter(input => representedIds.includes(input.localInputId));
        acceptance.registerProviderAcceptedEffect(humanId, settlement => { primarySettlement = settlement; },
            representedInputs.map(input => ({ localId: input.localInputId, userMessageSeq: input.userMessageSeq })));
        for (const { localInputId, userMessageSeq } of representedInputs) {
            acceptance.registerProviderAcceptedEffect(localInputId, settlement => {
                prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId, userMessageSeq }, settlement);
            });
            queue.discardMatching(message => message.localId === localInputId
                && (message.fileReviewNote !== undefined || Boolean(message.followDeliveries?.some(item => item.localInputId === localInputId))));
        }
        const unbind = bindSessionProviderInputOutcome({ runtime, observe: acceptance.observeProviderInputOutcome,
            wakePendingMaterialization: () => client.wakePendingMaterialization() });
        try {
            await runtime.sendTurnPrompt(prompt, { localId: humanId, turnId: `turn-${humanId}` });
            expect(primarySettlement).toBeDefined();
            await primarySettlement;
            expect(await db.sessionMessage.count({ where: { sessionId: session.id, localId: humanId } })).toBe(1);
            expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId: humanId } })).toBe(0);
            if (scenario === 'omitted') {
                expect(queue.getContextOnlyMessages().map(message => message.localId)).toEqual([quietId]);
                expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                    sessionId: session.id, localId: quietId } } })).toMatchObject({ status: 'queued' });
                expect(await inTx(tx => hasCanonicalFollowProviderInputAcceptanceInTx(tx, {
                    destinationSessionId: session.id, localInputId: quietId,
                    userMessageSeq: null, requireProviderAccepted: true }))).toBe(false);
            } else {
                expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId: quietId } })).toBe(0);
                expect(await db.sessionMessage.count({ where: { sessionId: session.id, localId: quietId } })).toBe(1);
                if (scenario !== 'file-review') await waitForCondition(async () => (await db.sessionFollowEdge.findUniqueOrThrow({
                    where: { managerSourceSessionId: source.id } })).deliveredTranscriptSeq === 1,
                { timeoutMs: 5_000, intervalMs: 10, label: 'exact quiet original native-accepted Follow ACK' });
            }
        } finally {
            unbind();
            await runtime.resetOrDisposeRuntime();
        }
    });

    it.each(['failed', 'lost', 'blocked', 'historical', 'recovered', 'recovery-lost', 'rejected', 'metadata-only-hard-cap'] as const)('settles only witnessed consumption (%s)', async scenario => {
        harness.resetEnv();
        if (scenario === 'metadata-only-hard-cap') vi.stubEnv('HAPPIER_ACP_TURN_HARD_CAP_TIMEOUT_MS', '250');
        const authentication = createPresentUserSessionAccessAuthentication();
        const accountSecret = new Uint8Array(32).fill(7);
        const sessionKey = new Uint8Array(32).fill(11);
        const metadata = createTestMetadata({ path: harness.baseDir });
        const sealInput = (text: string) => encodeBase64(encrypt(sessionKey, 'dataKey', { role: 'user', content: { type: 'text', text } }));
        const owner = await db.account.create({ data: createSignedAccountContentBinding(tweetnacl.box.keyPair.fromSecretKey(accountSecret).publicKey) });
        const session = await db.session.create({ data: { tag: randomUUID(), accountId: owner.id,
            metadata: encodeBase64(encrypt(sessionKey, 'dataKey', metadata)) } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const credentials = { token, encryption: { type: 'legacy' as const, secret: accountSecret } };
        const client = new ApiSessionClient(token, {
            id: session.id, seq: 0, encryptionMode: 'e2ee', encryptionKey: sessionKey, encryptionVariant: 'dataKey',
            metadata, metadataVersion: 0, agentState: null, agentStateVersion: 0,
        }, {
            metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials },
            localMachineId: machine.id,
            initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
                sessionId: session.id, agentRuntimeApplicability: 'supported',
            })],
            transport: { serverId: 'consumed-input-home', serverUrl: origin, resolveToken: async () => token,
                createSessionSocketTransport: binding => createSessionSocketTransport({ ...binding, token, serverUrl: origin,
                    accessKeyBinding: 'preestablished' }) },
        });
        clients.add(client);
        expect(await client.claimCurrentSessionPublisherAuthorityForStartup()).toMatchObject({ status: 'claimed' });
        await client.updateRuntimeActivityProjection({ runtimeActivityState: 'idle', runtimeActivityActiveCount: 0 });
        const localId = `consumed-${randomUUID()}`;
        const retryLocalId = `${localId}-retry`;
        const responseReleasePath = join(harness.baseDir, `recovery-response-${session.id}`);
        const request = { actorUserId: owner.id, sessionId: session.id, localId, authentication };
        expect(await enqueuePendingMessage({ ...request, ciphertext: sealInput('original-input'), requestedAction: { v: 1, kind: 'send_now' } })).toMatchObject({ ok: true });
        expect(await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force',
            deliveryTiming: 'after_foreground_ready' })).toMatchObject({ type: 'materialized', localId });
        if (scenario === 'blocked' || scenario === 'historical') {
            // Existing rows retain original input custody; later exact acceptance must
            // upgrade the same row, without copying input or changing its schema.
            const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } });
            await db.session.update({ where: { id: session.id }, data: { seq: 1 } });
            await db.sessionMessage.create({ data: { sessionId: session.id, localId, seq: 1, messageRole: 'user',
                content: pending.content, inputAdmissionReceipt: pending.inputAdmissionReceipt ?? undefined } });
            expect(await blockPendingDelivery({ ...request, reason: 'delivery_outcome_uncertain' })).toMatchObject({ ok: true });
        }
        expect(await deletePendingMessage({ ...request, withdraw: true })).toMatchObject({ ok: true, outcome: 'delivery_unknown' });
        if (scenario === 'historical') {
            // An exited producer cannot recreate its missing acceptance. Existing
            // explicit human settlement retires confirmed historical consumption
            // without dispatching the original input again or rewriting history.
            expect(await markPendingDeliveryHandled(request)).toMatchObject({ ok: true, didResolve: true, pendingCount: 0, pendingBlockedCount: 0 });
            expect(await deletePendingMessage({ ...request, withdraw: true })).toMatchObject({ outcome: 'already_delivered', pendingCount: 0 });
            expect(await db.sessionMessage.count({ where: { sessionId: session.id, localId } })).toBe(1);
            expect(await enqueuePendingMessage({ ...request, localId: `${localId}-retry`, ciphertext: sealInput('new-user-retry'),
                requestedAction: { v: 1, kind: 'send_now' } })).toMatchObject({ ok: true, pendingCount: 1, pendingBlockedCount: 0 });
            return;
        }

        // Only the external ACP process is simulated. Its output and typed request
        // error pass through the real transport, producer and host lifecycle.
        const script = writeAcpTestAgentScript({ dir: harness.baseDir, fileName: `consumed-${scenario}.mjs`, source: `
            import { createInterface } from 'node:readline';
            import { existsSync } from 'node:fs';
            const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
            let promptCount = 0;
            for await (const line of createInterface({ input: process.stdin })) {
                const request = JSON.parse(line);
                if (request.method === 'initialize') send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
                else if (request.method === 'session/new') send({ id: request.id, result: { sessionId: 'provider-consumed' } });
                else if (request.method === 'session/prompt') {
                    promptCount += 1;
                    if (${JSON.stringify(scenario)} === 'metadata-only-hard-cap') {
                        const metadata = () => {
                            for (const update of [{ sessionUpdate: 'current_mode_update', currentModeId: 'metadata-only-mode' },
                                { sessionUpdate: 'config_option_update', configOptions: [] }]) {
                                send({ method: 'session/update', params: { sessionId: request.params.sessionId, update } });
                            }
                        };
                        metadata();
                        setInterval(metadata, 20);
                        // Neither session/prompt nor session/cancel gets a reply.
                        // The existing hard cap must settle unknown custody itself.
                        continue;
                    }
                    if (${JSON.stringify(scenario)} === 'lost') process.exit(17);
                    if (promptCount > 1) {
                        if (${JSON.stringify(scenario)} === 'recovery-lost') process.exit(17);
                        send({ method: 'session/update', params: { sessionId: request.params.sessionId,
                            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'recovered provider reply' } } } });
                        // Hold the external response until the host proves it has
                        // delivered the reply and settled exact successor custody.
                        const release = setInterval(() => {
                            if (!existsSync(${JSON.stringify(responseReleasePath)})) return;
                            clearInterval(release);
                            send({ id: request.id, result: { stopReason: 'end_turn' } });
                        }, 10);
                        continue;
                    }
                    if (${JSON.stringify(scenario)} !== 'rejected') send({ method: 'session/update', params: { sessionId: request.params.sessionId,
                        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial provider reply' } } } });
                    send({ id: request.id, error: { code: -32603, message: 'Cannot connect to API after output' } });
                }
            }
        ` });
        const signal = new AbortController().signal;
        const publications = createNativeAgentSessionPublications({ agentId: 'custom-acp', session: client, signal,
            isCurrent: () => true, supportsInFlightSteer: false });
        const media = createPluginSessionMediaHostAdapter({ agentId: 'custom-acp', readActiveScope: () => ({
            sessionId: session.id, rootPath: harness.baseDir,
            sendAgentSessionMediaCommitted: (provider, request) => client.sendAgentSessionMediaCommitted(provider, request),
        }) });
        const providerSession = await createPublicAcpSession({ kind: 'create', sessionId: session.id, cwd: harness.baseDir }, {
            transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture-acp' } },
        }, {
            pluginId: 'fixture.acp', agentId: 'custom-acp', signal, isCurrent: () => true,
            systemTools: { resolve: async () => ({ toolId: 'fixture-acp', launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
            models: publications.services.models, modes: publications.services.modes,
            interactions: { request: async () => { throw new Error('No ACP permission request expected'); } },
            media: media.forAuthorizedSession(session.id, root => root === harness.baseDir),
        });
        const events: AgentSessionRuntimeEvent[] = [];
        const turn = createSessionTurnLifecycle({ agentId: 'custom-acp', onAcceptedTurnLifecycle: async () => {}, session: client });
        // This newTurn-only fixture selects no direct-control capabilities. The
        // runtime's direct-control context consumes only its real cancellation signal.
        const context = { signal } as AgentSessionRuntimeContext;
        const runtime = createNativeAgentSessionOperations(providerSession, session.id, undefined, undefined, undefined,
            undefined, undefined, {
                context, cwd: harness.baseDir, connectedAccounts: [],
                capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false },
            }, publications, [], {
                onTurnTerminal: () => undefined,
                getCommittedUserMessageSeq: localId => client.getCommittedUserMessageSeq(localId),
                subscribeCommittedUserMessageSeq: listener => client.subscribeCommittedUserMessageSeq(listener),
                subscribePendingProviderInputRetirement: listener => client.subscribePendingProviderInputRetirement(listener),
            });
        const unbindOutcome = bindSessionProviderInputOutcome({
            runtime,
            observe: createSessionProviderInputOutcomeNormalizer({ getTarget: () => client }),
            wakePendingMaterialization: () => client.wakePendingMaterialization(),
        });
        const unsubscribe = runtime.subscribeRuntimeEvents(raw => {
            const event = AgentSessionRuntimeEventV1Schema.parse(raw);
            events.push(event);
            turn.observeRuntimeEvent(event);
        });
        try {
            await runtime.sendTurnPrompt('reply', { localId, turnId: `turn-${localId}` });
            await waitForCondition(() => events.some(event => scenario === 'metadata-only-hard-cap'
                ? event.kind === 'input-custody-unknown' || event.kind === 'turn-failed'
                : event.kind === (scenario === 'lost' ? 'runtime-ended' : scenario === 'rejected' ? 'input-rejected' : 'turn-failed')),
                { timeoutMs: 5_000, intervalMs: 10, label: `ACP ${scenario}` });
            await client.flush();
            await turn.drainAcceptedLifecycle();
            const stored = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            if (scenario === 'rejected') {
                expect(stored).toMatchObject({ latestTurnId: null, pendingCount: 1, pendingBlockedCount: 1 });
                expect(events.some(event => event.kind === 'input-accepted' || event.kind === 'turn-start')).toBe(false);
                const source = createWorkflowOriginContextInputPort({
                    accountId: owner.id, originSessionId: session.id, machineId: machine.id,
                    storage: { execute: async () => ({ runs: [] }) },
                    resolveEncryption: async () => { throw new Error('No workflow rows'); },
                    readDispatchFact: async () => 'not_dispatched', onDispatchedInput() {},
                    onError: error => { throw error; },
                });
                publishSessionFollowWakeInvalidation();
                const queue = new MessageQueue2<string>(value => value);
                const waiting = new AbortController();
                let sourceReads = 0;
                const consumer = createSessionProviderInputConsumer({
                    messageQueue: queue,
                    session: createSessionProviderInputConsumerSessionAdapter(client),
                    beforePendingMaterialize: () => false,
                    waitForContextOnlyInputChange: signal => { sourceReads += 1; return source.waitForChange(signal); },
                    takeContextOnlyInput: async signal => { await source.take(signal); return null; },
                });
                const successor = consumer.waitForNextInput({ abortSignal: waiting.signal });
                try {
                    for (let step = 0; step < 100; step += 1) await Promise.resolve();
                    expect(sourceReads).toBe(0);
                    expect(await deletePendingMessage({ ...request, withdraw: true })).toMatchObject({ outcome: 'removed', pendingCount: 0 });
                    expect(await enqueuePendingMessage({ ...request, localId: retryLocalId, ciphertext: sealInput('new-user-retry'),
                        requestedAction: { v: 1, kind: 'send_now' } })).toMatchObject({ ok: true, pendingCount: 1, pendingBlockedCount: 0 });
                    // Direct owner fixture writes bypass route publication; refresh
                    // the real client before asking its observed drain gate.
                    await client.reconcilePendingQueueState({ force: true });
                    expect(client.getPendingQueueState()).toMatchObject({ pendingCount: 1, pendingBlockedCount: 0 });
                    expect(await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force',
                        deliveryTiming: 'after_foreground_ready' })).toMatchObject({ type: 'materialized', localId: retryLocalId });
                    queue.pushImmediate(retryLocalId, 'mode');
                    const input = await successor;
                    expect(input?.message).toBe(retryLocalId);
                    await runtime.sendTurnPrompt('resend', { localId: input!.message, turnId: `turn-${retryLocalId}` });
                    await waitForCondition(() => events.some(event => event.kind === 'message-delta' && event.turnId === `turn-${retryLocalId}`),
                        { timeoutMs: 5_000, intervalMs: 10, label: 'rejected input successor reply' });
                    await client.flush();
                    expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ pendingCount: 0, pendingBlockedCount: 0 });
                    await writeFile(responseReleasePath, 'release');
                    await waitForCondition(() => events.some(event => event.kind === 'turn-complete' && event.turnId === `turn-${retryLocalId}`),
                        { timeoutMs: 5_000, intervalMs: 10, label: 'rejected input successor completion' });
                    await turn.drainAcceptedLifecycle();
                    expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ latestTurnStatus: 'completed', pendingCount: 0, pendingBlockedCount: 0 });
                } finally {
                    waiting.abort();
                    await successor;
                }
            } else if (scenario === 'lost' || scenario === 'metadata-only-hard-cap') {
                expect(stored).toMatchObject({ pendingCount: 1, pendingBlockedCount: 1 });
                expect(events).toContainEqual(expect.objectContaining({ kind: 'input-custody-unknown', inputIds: [localId] }));
                expect(events.some(event => event.kind === 'input-accepted' || event.kind === 'turn-start')).toBe(false);
                expect(await deletePendingMessage({ ...request, withdraw: true })).toMatchObject({ outcome: 'delivery_unknown' });
            } else {
                expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', text: 'partial provider reply' }));
                expect(stored).toMatchObject({ latestTurnStatus: 'failed', pendingCount: 0, pendingBlockedCount: 0 });
                expect(JSON.parse(stored.lastRuntimeIssue!)).toMatchObject({ code: 'acp_turn_failed', sanitizedPreview: expect.stringContaining('Cannot connect to API after output') });
                expect(await deletePendingMessage({ ...request, withdraw: true })).toMatchObject({ outcome: 'already_delivered', pendingCount: 0 });
                expect(await db.sessionMessage.count({ where: { sessionId: session.id, localId } })).toBe(1);
                expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).toBe(0);
                expect(await enqueuePendingMessage({ ...request, localId: retryLocalId, ciphertext: sealInput('new-user-retry'),
                    requestedAction: { v: 1, kind: 'send_now' } })).toMatchObject({ ok: true, pendingCount: 1, pendingBlockedCount: 0 });
                if (scenario === 'recovered' || scenario === 'recovery-lost') {
                    const retryRequest = { ...request, localId: retryLocalId };
                    expect(await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force',
                        deliveryTiming: 'after_foreground_ready' })).toMatchObject({ type: 'materialized', localId: retryLocalId });
                    await runtime.sendTurnPrompt('resend', { localId: retryLocalId, turnId: `turn-${retryLocalId}` });
                    if (scenario === 'recovered') {
                        await waitForCondition(() => events.some(event => event.kind === 'message-delta' && event.turnId === `turn-${retryLocalId}`),
                            { timeoutMs: 5_000, intervalMs: 10, label: 'successor reply before prompt response' });
                        await client.flush();
                        await turn.drainAcceptedLifecycle();
                        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ pendingCount: 0, pendingBlockedCount: 0 });
                        expect(events.some(event => event.kind === 'turn-complete' && event.turnId === `turn-${retryLocalId}`)).toBe(false);
                        await writeFile(responseReleasePath, 'release');
                    }
                    await waitForCondition(() => events.some(event => event.kind === (scenario === 'recovered' ? 'turn-complete' : 'runtime-ended')),
                        { timeoutMs: 5_000, intervalMs: 10, label: `ACP ${scenario} successor` });
                    await client.flush();
                    await turn.drainAcceptedLifecycle();
                    const recovered = await db.session.findUniqueOrThrow({ where: { id: session.id } });
                    if (scenario === 'recovered') {
                        expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', turnId: `turn-${retryLocalId}`,
                            text: 'recovered provider reply' }));
                        expect(recovered).toMatchObject({ latestTurnStatus: 'completed', pendingCount: 0, pendingBlockedCount: 0 });
                        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId: retryLocalId } })).toBe(0);
                        expect(await db.sessionMessage.count({ where: { sessionId: session.id, localId: retryLocalId } })).toBe(1);
                        expect(await deletePendingMessage({ ...retryRequest, withdraw: true })).toMatchObject({ outcome: 'already_delivered', pendingCount: 0 });
                    } else {
                        expect(recovered).toMatchObject({ pendingCount: 1, pendingBlockedCount: 1 });
                        expect(events).toContainEqual(expect.objectContaining({ kind: 'input-custody-unknown', inputIds: [retryLocalId] }));
                        expect(events.some(event => event.kind === 'input-accepted' && event.inputIds.includes(retryLocalId))).toBe(false);
                        expect(await deletePendingMessage({ ...retryRequest, withdraw: true })).toMatchObject({ outcome: 'delivery_unknown', pendingCount: 1 });
                    }
                }
            }
        } finally {
            unsubscribe();
            unbindOutcome();
            await runtime.resetOrDisposeRuntime('session_closed');
            media.dispose();
            publications.dispose();
        }
    });
});
