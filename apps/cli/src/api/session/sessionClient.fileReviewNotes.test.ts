import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createAccountEncryptionCurrentnessFixture, createMockSession, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createInitialHostRuntimeActivityMutation } from '@/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ApiSessionClient } from './sessionClient';
import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import { prepareSessionInputForProviderDispatch } from '@/agent/runtime/turns/prepareSessionInputForProviderDispatch';
import { FILE_REVIEW_NOTE_KIND, formatFileReviewNoteV1 } from '@happier-dev/protocol/messages/structured/fileReviewNoteV1';
import { buildCodexAppServerTurnInput } from '@happier-dev/plugins-codex/agent/runtime/appServer/turnInput';
import { sendFileReviewNoteToSession } from '@/session/services/sendFileReviewNote';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

vi.mock('axios');
// All Home socket traffic uses the injected canonical boundary fixture.
vi.mock('socket.io-client', () => ({ io: () => createApiSessionSocketStub() }));

describe('file review notes at the provider input boundary', () => {
    let client: ApiSessionClient | undefined;
    beforeEach(() => {
        vi.mocked(axios.get).mockReset().mockResolvedValue({ status: 404, data: {} });
        vi.mocked(axios.post).mockReset();
    });
    afterEach(async () => {
        await client?.close();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('retains materialized review notes from the sender in the next provider input', async () => {
        const sessionId = 'c111111111111111111111111';
        const serverUrl = 'https://review.example.test';
        const note = { action: 'discard' as const, paths: ['src/app.ts'], changeCount: 2 };
        let storedContent: unknown;
        let admittedNote: unknown;
        let noteLocalId: string | undefined;
        vi.mocked(axios.get).mockImplementation(async url => String(url).endsWith('/v1/account/encryption/currentness')
            ? { status: 200, data: createAccountEncryptionCurrentnessFixture() }
            : String(url) === `${serverUrl}/v2/sessions/${sessionId}`
                ? { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, active: true,
                    encryptionMode: 'plain', metadataLayoutVersion: 1,
                    metadata: JSON.stringify({ v: 1, agentPresentation: { agentId: 'codex' } }), share: null,
                    ownerMetadata: { t: 'plain', v: { v: 1, workspace: { path: '/repo', machineId: 'review-machine' } } },
                }) } } : { status: 404, data: {} });
        vi.mocked(axios.post).mockImplementation(async (url, body: unknown) => {
            expect(String(url)).toBe(`${serverUrl}/v2/sessions/${sessionId}/pending`);
            if (!body || typeof body !== 'object' || !('content' in body) || !('nextTurnNote' in body)
                || !('localId' in body) || typeof body.localId !== 'string') {
                throw new Error('Expected a plain informational Pending input');
            }
            storedContent = body.content;
            admittedNote = body.nextTurnNote;
            noteLocalId = body.localId;
            return { status: 200, data: { didWrite: true } };
        });
        let claimed = false;
        const activity = createSessionRuntimeActivityHomeStub({ machineId: 'review-machine' });
        const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
            if (event === 'pending-materialize-next' && !claimed) {
                claimed = true;
                return { ok: true, didMaterialize: true, didWrite: false, localId: noteLocalId,
                    pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2,
                    message: { id: null, seq: null, localId: noteLocalId, providerAction: 'send', messageRole: 'user',
                        inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'review-account',
                            sessionRelationship: 'owner', nextTurnNote: admittedNote },
                        content: storedContent,
                        createdAt: 1, updatedAt: 1, deliveryState: { mode: 'provider', unresolved: true } },
                };
            }
            return activity.answer(event, payload) ?? { ok: false };
        } });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {
            sharing: { pendingQueueV2: { enabled: true } } }, capabilities: { session: {
                runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 5 }, publisherAuthority: { protocolVersion: 1 },
            } } }))));
        await runWithServerHttpBaseUrl(serverUrl, () => sendFileReviewNoteToSession({
            credentials: { token: 'review-token', encryption: null }, sessionId, note,
        }));
        expect(admittedNote).toBe(FILE_REVIEW_NOTE_KIND);
        client = new ApiSessionClient('review-token', createMockSession({ id: sessionId, encryptionMode: 'plain',
            metadata: createTestMetadata(), pendingCount: 1, pendingVersion: 1 }), {
            metadataAuthority: { kind: 'shared_editor' }, localMachineId: 'review-machine',
            durableMutationDeliveryInitiallyActive: false,
            initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({ sessionId,
                agentRuntimeApplicability: 'supported' })],
            transport: { serverId: 'review-home', serverUrl,
                createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
        });
        await vi.waitFor(() => expect(socket.getHandler('session')).toBeTypeOf('function'));
        await expect(client.claimCurrentSessionPublisherAuthorityForStartup()).resolves.toEqual({ status: 'claimed' });
        await client.activateDurableMutationDelivery();
        const state = createPermissionModeQueueState({ session: client,
            agentTargetKey: 'agent:happier.agent.codex/codex', initialPermissionMode: 'default' });
        const materialized = await client.materializeNextPendingMessageSafely();
        expect(materialized.type).toBe('materialized');
        expect(state.messageQueue.size()).toBe(0);
        expect(state.messageQueue.getContextOnlyMessages()).toHaveLength(1);
        expect(state.messageQueue.getContextOnlyMessages()[0]?.localId).toBe(noteLocalId);
        state.messageQueue.push({ text: 'Continue', localId: 'next-input' }, { permissionMode: 'default' });
        const batch = await state.messageQueue.waitForMessagesAndGetAsString();
        expect(batch).not.toBeNull();
        const prepared = await prepareSessionInputForProviderDispatch({ prompt: batch!.message,
            transformedUserText: batch!.message.text, providerNativeCommand: false,
            localId: 'next-input', signal: new AbortController().signal });
        expect(prepared.renderPrompt()).not.toContain(formatFileReviewNoteV1(note));
        expect(buildCodexAppServerTurnInput({ text: prepared.renderPrompt() })).toEqual([
            { type: 'text', text: `Continue\n\n<happier_review_note>${JSON.stringify({ text:
                'The person reviewing your work discarded 2 of your changes in "src/app.ts". Do not reapply them unless asked.',
            })}</happier_review_note>` },
        ]);
        state.messageQueue.close();
    });

});
