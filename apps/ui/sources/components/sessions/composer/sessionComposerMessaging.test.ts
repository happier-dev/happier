import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ActionApprovalRequestCreatedResultSchema,
    ActionExecuteFailureSchema,
    type ActionExecuteResult,
} from '@happier-dev/protocol/actions/actionExecutionResult';
import { withSessionTargetFanoutResultV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { ComposerSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/composer';
import { MENTION_KIND_V1, buildMentionRefForKindV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ComposerAttachmentDraftV1Schema } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { ComposerContentHandleV1Schema } from '@happier-dev/protocol/runtime/input/composerContentV1';
import { RawIngressStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { deriveSessionMessageInvocationLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageInvocationV1';
import { normalizeRawMessage, RawRecordSchema } from '@happier-dev/session-core/raw';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { readSessionMessageInvocation } from '@/components/sessions/transcript/references/readSessionMessageInvocation';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createSessionDraftRepository } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { createSessionDraftPrivatePayloadV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { projectSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

const rpc = vi.hoisted(() => vi.fn());
// The guarded Machine RPC is the physical network boundary; transfer parsing and custody stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: unknown[]) => rpc(...args),
}));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();

import type { ComposerSubmissionSnapshot } from './composerSubmissionCoordinator';
const messaging = await import('./sessionComposerMessaging');
const { readSessionComposerMessageIntent, readSessionComposerMessagingHandoff, readSessionComposerMessagingOutcome } = messaging;

// Global cleanup retires runtimeFetch after each test; reinstall this suite's physical boundary.
beforeEach(async () => { await homes.reset(); });
afterEach(async () => { rpc.mockReset(); await homes.reset(); });

const sendOutputSchema = withSessionTargetFanoutResultV1(SessionMessageSendResultV1Schema);

function admitted(status: 'accepted' | 'alreadyAccepted', localId: string): ActionExecuteResult {
    return { ok: true, result: SessionMessageSendResultV1Schema.parse({ status, localId }) };
}

function fanout(results: readonly ActionExecuteResult[]): ActionExecuteResult {
    return { ok: true, result: sendOutputSchema.parse({ kind: 'fanout', results: results.map((result, index) => ({
        target: { serverId: 'home', sessionId: `worker-${index}` }, result,
    })) }) };
}

function snapshot(text: string, referenceStart: number | null): ComposerSubmissionSnapshot {
    const token = '@Reviewer';
    return ComposerSnapshotV1Schema.parse({
        ref: { kind: 'session', sessionId: 'source' }, revision: 1, text,
        references: referenceStart === null ? [] : [{
            kind: MENTION_KIND_V1.session,
            ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'reviewer-session'),
            token, start: referenceStart, end: referenceStart + token.length, label: 'Reviewer',
        }],
        attachments: [], layout: 'wrap',
        capabilities: { text: true, references: true, attachments: true, submit: true },
        state: { focused: true, editable: true, submittable: true, submitting: false, running: false },
    });
}

describe('Session composer messaging handoff', () => {
    it('starts a model Ask on Send, retaining the spawned Session and exact message identity after a refused send', async () => {
        const serverId = await homes.addHome({ name: 'Model Ask', serverUrl: 'https://model-ask.test', accountId: 'alice', currentAccount: true });
        homes.answer(serverId, '/v2/sessions/source', { body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: 'source' }) } });
        const values = new Map<string, string>();
        const createRepository = () => createSessionDraftRepository({ syncEnabled: false,
            storage: { getString: key => values.get(key), getAllKeys: () => [...values.keys()], set: (key, value) => { values.set(key, value); }, delete: key => { values.delete(key); } },
            cipher: { seal: async (address, document) => ({ t: 'plain', v: createSessionDraftPrivatePayloadV2(address, document) }),
                open: async (_address, content) => content.t === 'plain' ? content.v.document : null },
        });
        let repository = createRepository();
        const scope = { serverId, accountId: 'alice' };
        const intent = { kind: 'ask_new_session', launch: { executionTarget: { serverId, machineId: 'macbook' },
            directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } } as const;
        repository.writeExistingSessionDraft({ scope, sessionId: 'source', patch: { text: 'Review this', sessionMessaging: intent } });
        const attempt = repository.getOrCreateSessionMessagingDraftMutationAttempt({ scope, sessionId: 'source', intent,
            currentness: repository.captureSessionDraftCurrentness({ scope, address: { kind: 'session', sessionId: 'source' } }) });
        if (!attempt) throw new Error('Draft attempt required');
        homes.answer(serverId, '/v2/sessions/source/messages', { body: { didWrite: true, message: {
            id: 'ask-entry', localId: deriveSessionMessageInvocationLocalIdV1(attempt.localId), seq: 1, createdAt: 10,
        } } });
        const spawns: string[] = [];
        const messages: Array<{ sessionId: string; localId?: string; reply?: string; returnToSessionId?: string }> = [];
        const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({
            sessionSpawnNew: async input => {
                spawns.push(String(input.creationKey));
                if (spawns.length === 1) return { type: 'error', code: 'spawn_failed', retryable: true };
                return projectSessionSpawnNewActionResultV1({ type: 'success', disposition: 'created', sessionId: 'model-session',
                    executionTarget: intent.launch.executionTarget, organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } });
            },
            sessionSendMessage: async input => {
                messages.push(input);
                return messages.length === 1 ? { status: 'rejected', code: 'session_input_target_unavailable' }
                    : { status: 'accepted', localId: input.localId };
            },
        })));
        const send = () => messaging.submitSessionComposerMessagingAction({ scope, sessionId: 'source', localId: attempt.localId,
            text: 'Review this', intent, execute, draftRepository: repository, isCurrent: () => true, isAccountCurrent: () => true,
            actionInput: { message: 'Review this', localId: attempt.localId, requestedAction: { v: 1, kind: 'send_now' } },
            context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'alice', serverId },
        });
        expect(spawns).toEqual([]);
        expect(readSessionComposerMessagingHandoff(await send())).toBe('unaccepted');
        expect(messages).toEqual([]);
        expect(repository.readSessionMessagingDraftMutationAttempt({ scope, sessionId: 'source' })?.localId).toBe(attempt.localId);
        expect(readSessionComposerMessagingHandoff(await send())).toBe('unaccepted');
        expect(repository.readSessionMessagingDraftMutationAttempt({ scope, sessionId: 'source' })?.custody?.targets.targets)
            .toEqual([{ serverId, sessionId: 'model-session' }]);
        repository = createRepository();
        expect(readSessionComposerMessagingHandoff(await send())).toBe('accepted');
        expect(spawns).toHaveLength(2);
        expect(new Set(spawns).size).toBe(1);
        expect(messages).toHaveLength(2);
        expect(messages).toEqual([expect.objectContaining({ sessionId: 'model-session', localId: attempt.localId, reply: 'return', returnToSessionId: 'source' }),
            expect.objectContaining({ sessionId: 'model-session', localId: attempt.localId, reply: 'return', returnToSessionId: 'source' })]);
    });

    it('persists one non-executing source entry with the frozen targets and immediate refusals', async () => {
        const serverId = await homes.addHome({ name: 'Ask source', serverUrl: 'https://ask-source.test', accountId: 'alice', currentAccount: true });
        const source = createPlainSessionCurrentProjectionRecordFixture({ id: 'source' });
        homes.answer(serverId, '/v2/sessions/source', { body: { session: source } });
        let stored: unknown = null;
        homes.answer(serverId, '/v2/sessions/source/messages', { select: async input => {
            stored = input;
            return { body: { didWrite: true, message: { id: 'source-entry', localId: deriveSessionMessageInvocationLocalIdV1('ask-attempt'), seq: 1, createdAt: 10 } } };
        } });
        await messaging.recordSessionComposerMessageResult({ scope: { serverId, accountId: 'alice' }, sessionId: 'source',
            localId: 'ask-attempt', text: 'Review this', intent: { kind: 'ask', target: { selector: 'workers' }, reply: 'return' },
            result: { ok: true, result: sendOutputSchema.parse({ kind: 'fanout', results: [
                { target: { serverId, sessionId: 'a' }, result: admitted('accepted', 'ask-attempt') },
                { target: { serverId, sessionId: 'b' }, result: { ok: false, errorCode: 'permission_denied', error: 'private error prose' } },
            ] }) }, isCurrent: () => true });
        expect(stored).toMatchObject({ localId: deriveSessionMessageInvocationLocalIdV1('ask-attempt'), messageRole: 'event', content: { t: 'plain', v: {
            role: 'agent', content: { type: 'event', data: { type: 'message', message: 'Review this',
                sessionMessageInvocationV1: { v: 1, localId: 'ask-attempt', reply: 'return', target: { selector: 'workers' }, targets: [
                    { target: { serverId, sessionId: 'a' }, localId: 'ask-attempt', immediate: { status: 'accepted' } },
                    { target: { serverId, sessionId: 'b' }, localId: 'ask-attempt', immediate: { status: 'rejected', code: 'permission_denied' } },
                ] } } },
        } } });
        expect(JSON.stringify(stored)).not.toContain('private error prose');
        const normalizedSource = () => {
            if (!stored || typeof stored !== 'object' || !('content' in stored)) throw new Error('Source entry must exist');
            const content = stored.content;
            if (!content || typeof content !== 'object' || !('v' in content)) throw new Error('Plain source content required');
            const normalized = normalizeRawMessage('source-entry', deriveSessionMessageInvocationLocalIdV1('ask-attempt'), 10,
                RawRecordSchema.parse(content.v), { messageRole: 'event', seq: 1 });
            if (!normalized) throw new Error('Source entry must normalize');
            return normalized;
        };
        const state = createReducer();
        const initial = reducer(state, [normalizedSource()]).messages[0]!;
        // The Home harness also records its synthetic GET probe while projecting
        // batch components; only the body-bearing POST is a physical batch read.
        expect(homes.requests.filter(request => request.path === '/v2/sessions/read-batch' && request.input !== null
            || request.path === '/v2/sessions/source/messages').map(request => request.path))
            .toEqual(['/v2/sessions/read-batch', '/v2/sessions/source/messages']);
        homes.answer(serverId, `/v2/sessions/source/messages/by-local-id/${encodeURIComponent(deriveSessionMessageInvocationLocalIdV1('ask-attempt'))}`, { select: () => {
            if (!stored || typeof stored !== 'object' || !('content' in stored)) throw new Error('Source entry must exist');
            return { body: { message: { id: 'source-entry', localId: deriveSessionMessageInvocationLocalIdV1('ask-attempt'), seq: 1,
                createdAt: 10, messageRole: 'event', content: stored.content } } };
        } });
        await messaging.recordSessionComposerMessageResult({ scope: { serverId, accountId: 'alice' }, sessionId: 'source',
            localId: 'ask-attempt', text: 'Review this', intent: { kind: 'ask', target: { selector: 'workers' }, reply: 'return' },
            result: { ok: true, result: sendOutputSchema.parse({ kind: 'fanout', results: [
                { target: { serverId, sessionId: 'b' }, result: admitted('accepted', 'ask-attempt') },
                { target: { serverId, sessionId: 'new-worker' }, result: admitted('accepted', 'ask-attempt') },
            ] }) }, isCurrent: () => true });
        expect(stored).toMatchObject({ content: { v: { content: { data: { sessionMessageInvocationV1: { targets: [
            { target: { serverId, sessionId: 'a' }, localId: 'ask-attempt', immediate: { status: 'accepted' } },
            { target: { serverId, sessionId: 'b' }, localId: 'ask-attempt', immediate: { status: 'accepted' } },
        ] } } } } } });
        // The server publishes this same durable row as message-updated. A retry
        // receipt must replace the event's data, without duplicating the Ask.
        const corrected = { ...normalizedSource(), isAuthoritativeUpdate: true as const };
        const updated = reducer(state, [corrected]).messages;
        expect(updated).toHaveLength(1);
        expect(updated[0]).toMatchObject({ id: initial.id, realID: initial.realID, localId: initial.localId, createdAt: initial.createdAt, seq: initial.seq });
        expect(readSessionMessageInvocation(updated[0]!, { serverId, sessionId: 'source' })?.invocation.targets)
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ target: { serverId, sessionId: 'b' }, immediate: { status: 'accepted' } }),
            ]));
        expect(state.messages.size).toBe(1);
        expect(reducer(state, [structuredClone(corrected)]).messages).toEqual([]);
    });
    it('distinguishes a partial target handoff from a fully admitted fanout', () => {
        const accepted = admitted('accepted', 'request-a');
        const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'session_target_unavailable', error: 'Target unavailable' });
        expect(readSessionComposerMessagingHandoff(fanout([accepted, failure]))).toBe('partial');
        expect(readSessionComposerMessagingHandoff(fanout([accepted, admitted('alreadyAccepted', 'request-b')]))).toBe('accepted');
    });

    it('tells the person how many targets took a partial send, from the frozen fanout itself', () => {
        const accepted = admitted('accepted', 'request-a');
        const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'session_target_unavailable', error: 'Target unavailable' });
        expect(readSessionComposerMessagingOutcome(fanout([accepted, failure, failure]))).toEqual({ kind: 'partial', accepted: 1, total: 3 });
        expect(readSessionComposerMessagingOutcome(failure)).toEqual({ kind: 'unaccepted', error: 'Target unavailable' });
        expect(readSessionComposerMessagingOutcome(fanout([accepted]))).toEqual({ kind: 'accepted' });
    });

    it('keeps rejected or uncertain input unaccepted, including an unresolved member of a fanout', () => {
        const uncertain: ActionExecuteResult = { ok: true, result: SessionMessageSendResultV1Schema.parse({
            status: 'outcomeUnknown', localId: 'request-b', code: 'session_input_admission_identity_mismatch',
        }) };
        const rejected: ActionExecuteResult = { ok: true, result: SessionMessageSendResultV1Schema.parse({
            status: 'rejected', code: 'session_input_target_unavailable',
        }) };
        const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'session_target_empty', error: 'No targets' });
        expect(readSessionComposerMessagingHandoff(uncertain)).toBe('unaccepted');
        expect(readSessionComposerMessagingHandoff(rejected)).toBe('unaccepted');
        expect(readSessionComposerMessagingHandoff(failure)).toBe('unaccepted');
        expect(readSessionComposerMessagingHandoff(fanout([uncertain, rejected, failure]))).toBe('unaccepted');
        expect(readSessionComposerMessagingHandoff(fanout([admitted('accepted', 'request-a'), uncertain]))).toBe('partial');
    });

    it('keeps an approval request pending rather than clearing the composer as admitted', () => {
        const approval = ActionApprovalRequestCreatedResultSchema.parse({
            kind: 'approval_request_created', artifactId: 'approval', actionId: 'session.message.send',
        });
        expect(readSessionComposerMessagingHandoff({ ok: true, result: approval })).toBe('approval_pending');
    });

    it('recognizes durable held input and an admitted terminal result without treating the result as unaccepted', () => {
        const held = SessionMessageSendResultV1Schema.parse({ status: 'held', localId: 'request-a', code: 'autonomous_check_in' });
        const replied = SessionMessageSendResultV1Schema.parse({ status: 'replied', localId: 'request-b', outcome: { kind: 'pass' } });
        expect(readSessionComposerMessagingHandoff(fanout([{ ok: true, result: held }, { ok: true, result: replied }]))).toBe('accepted');
    });
});

describe('Session composer structured addressing', () => {
    it('turns a selected leading Session reference into an Ask for its actual Session identity', () => {
        expect(readSessionComposerMessageIntent(snapshot('  @Reviewer inspect this change', 2))).toEqual({
            kind: 'ask', target: 'reviewer-session',
        });
    });

    it.each([
        ['unselected text', '@Reviewer inspect this change', null],
        ['contextual reference', 'I asked @Reviewer about this change', 8],
        ['quoted reference', '"@Reviewer inspect this change"', 1],
        ['quoted block', '> @Reviewer inspect this change', 2],
        ['stale selected reference', '@SomeoneElse inspect this change', 0],
    ] as const)('keeps %s inert', (_case, text, referenceStart) => {
        expect(readSessionComposerMessageIntent(snapshot(text, referenceStart))).toBeNull();
    });

    it('preserves an explicit recipient choice over a leading reference', () => {
        const explicit = { kind: 'send', target: { selector: 'workers' } } as const;
        expect(readSessionComposerMessageIntent(snapshot('@Reviewer inspect this change', 0), explicit)).toEqual(explicit);
    });
});

describe('Session composer invocation attachment capture', () => {
    const sourceComposerRef = { kind: 'session', sessionId: 'source-session' } as const;
    const handle = ComposerContentHandleV1Schema.parse({ v: 1, id: 'original-stage',
        executionTarget: { serverId: 'home-a', machineId: 'machine-a' },
        owner: { pluginId: 'com.example.media', localId: 'image' }, mediaKind: 'image',
        mimeType: 'image/png', name: 'picture.png', sizeBytes: 4, sha256: 'a'.repeat(64) });
    const attachment = ComposerAttachmentDraftV1Schema.parse({ v: 1, instanceId: 'attachment-a',
        attachment: handle.owner, key: 'photo', value: { caption: 'keep' },
        presentation: { label: 'Picture', typeLabel: 'Image' }, content: { kind: 'stagedMedia', handle } });
    const { content: _content, ...contentless } = attachment;
    const structuredInput = RawIngressStructuredInputV1Schema.parse({ v: 1,
        composerAttachments: [contentless, attachment] });
    const fork = { ...handle, id: 'invocation-snapshot' };
    const input = { structuredInput, sourceComposerRef, messageLocalId: 'message-a', isCurrent: () => true };
    const releasedIds = () => rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE)
        .map(([call]) => call.payload.handle.id);

    it.each([true, false])('captures exact staged fields while preserving originals and cleanup ownership (newlyAcquired:%s)', async newlyAcquired => {
        rpc.mockResolvedValueOnce({ success: true, newlyAcquired, handle: fork });
        const captured = await messaging.captureSessionComposerMessageAttachments(input);
        expect(captured?.structuredInput).toEqual({ ...structuredInput,
            composerAttachments: [contentless, { ...attachment, content: { kind: 'stagedMedia', handle: fork } }] });
        expect(structuredInput.composerAttachments?.[1]?.content?.handle).toEqual(handle);
        expect(rpc.mock.calls[0]?.[0]).toMatchObject({ method: RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM,
            payload: { handle, claimant: { composer: sourceComposerRef, attachmentInstanceId: attachment.instanceId },
                submission: { destinationComposerRef: sourceComposerRef, messageLocalId: 'message-a' } } });
        rpc.mockResolvedValue({ success: true });
        await captured?.releaseSnapshots();
        await captured?.releaseSnapshots();
        expect(releasedIds()).toEqual(newlyAcquired ? [fork.id] : []);
        if (newlyAcquired) expect(rpc.mock.calls.at(-1)?.[0].payload.claimant).toEqual({
            composer: sourceComposerRef, attachmentInstanceId: attachment.instanceId });
    });

    it.each(['failed', 'stale', 'cancelled'] as const)('releases captured snapshots only when a later capture is %s', async outcome => {
        let current = true;
        const cancellation = new AbortController();
        rpc.mockImplementation(async (call: { method: string; payload: { handle: { id: string } } }) => {
            if (call.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE) return { success: true };
            if (call.payload.handle.id === handle.id) return { success: true, newlyAcquired: true, handle: fork };
            if (outcome === 'stale') current = false;
            if (outcome === 'cancelled') cancellation.abort();
            return outcome === 'failed' ? { success: false, error: 'Unavailable' }
                : { success: true, newlyAcquired: true, handle: { ...handle, id: 'second-snapshot' } };
        });
        const second = { ...attachment, instanceId: 'attachment-b', content: { kind: 'stagedMedia' as const,
            handle: { ...handle, id: 'second-original' } } };
        await expect(messaging.captureSessionComposerMessageAttachments({ ...input,
            structuredInput: { v: 1, composerAttachments: [attachment, second] },
            signal: cancellation.signal, isCurrent: () => current })).resolves.toBeNull();
        expect(releasedIds()).toEqual(outcome === 'failed' ? [fork.id] : [fork.id, 'second-snapshot']);
    });

    it('does not capture when stale or cancelled and leaves contentless input untouched', async () => {
        const cancelled = new AbortController(); cancelled.abort();
        expect(await messaging.captureSessionComposerMessageAttachments({ ...input, signal: cancelled.signal })).toBeNull();
        expect(await messaging.captureSessionComposerMessageAttachments({ ...input, isCurrent: () => false })).toBeNull();
        const empty = { v: 1 as const, composerAttachments: [contentless] };
        expect((await messaging.captureSessionComposerMessageAttachments({ ...input, structuredInput: empty }))?.structuredInput).toBe(empty);
        expect((await messaging.captureSessionComposerMessageAttachments({ ...input, structuredInput: undefined }))?.structuredInput).toBeUndefined();
        expect(rpc).not.toHaveBeenCalled();
    });

    it('observes cleanup failure and permits a retry without releasing the original', async () => {
        rpc.mockResolvedValueOnce({ success: true, newlyAcquired: true, handle: fork });
        const captured = await messaging.captureSessionComposerMessageAttachments(input);
        rpc.mockResolvedValueOnce({ success: false, error: 'Machine unavailable' });
        await expect(captured?.releaseSnapshots()).rejects.toThrow('Machine unavailable');
        rpc.mockResolvedValueOnce({ success: true });
        await expect(captured?.releaseSnapshots()).resolves.toBeUndefined();
        expect(releasedIds()).toEqual([fork.id, fork.id]);
    });

    it('settles a cancelled snapshot cleanup observer while exact-Home cleanup remains live for a late answer', async () => {
        rpc.mockResolvedValueOnce({ success: true, newlyAcquired: true, handle: fork });
        const cancellation = new AbortController();
        const captured = await messaging.captureSessionComposerMessageAttachments({ ...input, signal: cancellation.signal });
        let finish!: (result: { success: true }) => void;
        let cleanupSignal: AbortSignal | undefined;
        rpc.mockImplementationOnce(async (call: { signal?: AbortSignal }) => {
            cleanupSignal = call.signal;
            return await new Promise(resolve => { finish = resolve; });
        });
        const cleanup = captured!.releaseSnapshots();
        const observed = cleanup.then(() => ({ status: 'released' }), error => ({ status: 'failed', error }));
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        cancellation.abort();
        let settled = false;
        void observed.then(() => { settled = true; });
        await vi.waitFor(() => expect(settled).toBe(true));
        await expect(observed).resolves.toMatchObject({ status: 'failed', error: { name: 'AbortError' } });
        expect(cleanupSignal?.aborted).toBe(false);
        finish({ success: true });
        await Promise.resolve();
        rpc.mockResolvedValueOnce({ success: true, newlyAcquired: true, handle: { ...fork, id: 'next-snapshot' } });
        const next = await messaging.captureSessionComposerMessageAttachments({ ...input, signal: new AbortController().signal });
        rpc.mockResolvedValueOnce({ success: true });
        await expect(next?.releaseSnapshots()).resolves.toBeUndefined();
        expect(releasedIds()).toEqual([fork.id, 'next-snapshot']);
    });
});
