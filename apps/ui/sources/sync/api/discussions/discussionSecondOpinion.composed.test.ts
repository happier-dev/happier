// Initialize declaration-derived policy before the catalog's current approval-request cycle.
import '@happier-dev/protocol/actions/actionApprovalPolicy';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, answerDiscussionThreadForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainSessionWithDisplayRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { readDiscussionSecondOpinionSourceV1 } from '@happier-dev/protocol/actions/executor/discussionSecondOpinion';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { DiscussionSecondOpinionPreviewV1Schema } from '@happier-dev/protocol/discussions/secondOpinion';
import { DiscussionCreateRequestV1Schema, DiscussionPostRequestV1Schema } from '@happier-dev/protocol/discussions/api';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDiscussionClient } = await import('./discussionActions');
const { createDiscussionSecondOpinionController } = await import('@/components/discussions/discussionSecondOpinionController');
const { getStorage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const initial = getStorage().getState();
beforeEach(async () => {
    await homes.reset();
    setRuntimeFetch(createSessionReadBatchFetchBoundary(homes.request));
});
afterEach(() => { getStorage().setState(initial, true); standardCleanup(); });

async function sourceHome() {
    const serverId = await homes.addHome({ name: 'Review', serverUrl: 'https://review.test', accountId: 'alice', currentAccount: true });
    const source = { kind: 'session' as const, message: { kind: 'session' as const,
        session: { serverId, sessionId: 'source-session' }, messageId: 'committed-answer' } };
    const session = createPlainSessionWithDisplayRecordFixture({ id: 'source-session' });
    homes.answer(serverId, '/v2/sessions/source-session', { body: { session } });
    homes.answer(serverId, '/v2/sessions/source-session?accessProjectionVersion=1', { body: { session } });
    const messageRequests: URL[] = [];
    homes.answer(serverId, '/v1/sessions/source-session/messages', { select: (_input, request) => {
        messageRequests.push(new URL(request.url));
        return { body: {
            messages: [{ id: 'committed-answer', seq: 7, localId: null, createdAt: 1, messageRole: 'agent',
                content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'The source answer.' } } } }],
            hasMore: false, nextBeforeSeq: null,
        } };
    } });
    const preview = DiscussionSecondOpinionPreviewV1Schema.parse({ source, sourceAudienceAccountIds: ['alice'],
        sourceContentReady: true, discussionAudienceAccountIds: ['alice'], missingDiscussionSourceAccountIds: [],
        discussionDisclosure: { ok: true }, canGrantSource: true, reviewers: [] });
    homes.answer(serverId, 'POST /v1/discussions/second-opinion/preview', { body: { ok: true, value: preview } });
    return { serverId, source, preview, messageRequests };
}

it('previews the exact committed server answer independently of Voice privacy or loaded transcript state', async () => {
    const { serverId, source, preview, messageRequests } = await sourceHome();
    getStorage().setState({ sessionMessages: {}, sessions: {}, settings: { ...initial.settings,
        voice: { ...initial.settings.voice, privacy: { ...initial.settings.voice.privacy, shareRecentMessages: false } } } });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    const outcome = await client.secondOpinion({ intent: 'preview', source, title: 'Review', question: 'What changes?', reviewers: [],
        retry: { creationLocalId: 'creation', quoteLocalId: 'quote', questionLocalId: 'question' } });
    expect(outcome).toEqual({ kind: 'succeeded', value: { status: 'preview', preview, sourceText: 'The source answer.' } });
    expect(messageRequests).toHaveLength(1);
    expect(messageRequests[0]!.searchParams.get('messageId')).toBe(source.message.messageId);
    expect(messageRequests[0]!.searchParams.has('limit')).toBe(false);
    const writes = homes.requests.filter(row => row.input !== null && row.path !== '/v1/discussions/second-opinion/preview')
        .map(row => ({ path: row.path, method: row.method }));
    expect(writes, JSON.stringify(writes)).toEqual([]);
    const voice = await createDefaultActionExecutor().execute('session.transcript.get', { sessionId: 'source-session' },
        { surface: 'voice', serverId, expectedAccountId: 'alice' });
    expect(voice).toMatchObject({ ok: false, errorCode: 'recent_messages_disabled' });
});

it('previews one selected Session through the real default UI controller without preparing approval or a question', async () => {
    const { serverId, source, preview } = await sourceHome();
    const reviewers = [{ selection: { kind: 'session' as const, session: { serverId, sessionId: 'reviewer' } } }];
    const selectedPreview = DiscussionSecondOpinionPreviewV1Schema.parse({ ...preview, reviewers: [{ ...reviewers[0], sourceAccess: 'read',
        runtimeAccountId: 'alice', audienceAccountIds: ['alice'], missingSourceAccountIds: [], canGrantSource: true,
        disclosure: { ok: true } }] });
    homes.answer(serverId, 'POST /v1/discussions/second-opinion/preview', { body: { ok: true, value: selectedPreview } });
    const controller = createDiscussionSecondOpinionController({ scope: { serverId, accountId: 'alice' },
        availability: 'available', source, draft: { title: 'Review', question: 'What changes?', reviewers } });
    await controller.preview();
    expect(controller.getSnapshot()).toMatchObject({ working: false, submitted: false,
        preview: { status: 'preview', preview: selectedPreview, sourceText: 'The source answer.' },
        result: { outcome: { kind: 'succeeded' } } });
    const writes = homes.requests.filter(row => row.input !== null && row.path !== '/v1/discussions/second-opinion/preview')
        .map(row => ({ path: row.path, method: row.method }));
    expect(writes, JSON.stringify(writes)).toEqual([]);
});

it('retains explicit Require on a UI preview before disclosing the selected source', async () => {
    const { serverId, source, preview } = await sourceHome();
    const reviewers = [{ selection: { kind: 'session' as const, session: { serverId, sessionId: 'reviewer' } } }];
    const selectedPreview = DiscussionSecondOpinionPreviewV1Schema.parse({ ...preview, reviewers: [{ ...reviewers[0], sourceAccess: 'read',
        runtimeAccountId: 'alice', audienceAccountIds: ['alice'], missingSourceAccountIds: [], canGrantSource: true,
        disclosure: { ok: true } }] });
    homes.answer(serverId, 'POST /v1/discussions/second-opinion/preview', { body: { ok: true, value: selectedPreview } });
    const input = { intent: 'preview' as const, source, title: 'Review', question: 'What changes?', reviewers,
        retry: { creationLocalId: 'creation', quoteLocalId: 'quote', questionLocalId: 'question' } };
    const executor = createDefaultActionExecutor();
    const context = { surface: 'ui' as const, serverId, expectedAccountId: 'alice' };
    await homes.requireUiApproval(serverId, 'discussion.second_opinion.start');
    expect(await executor.execute('discussion.second_opinion.start', input, context))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'discussion.second_opinion.start' } });
    expect(homes.requestsFor('/v1/sessions/source-session/messages')).toHaveLength(0);
    expect(homes.requestsFor('/v1/discussions/second-opinion/preview')).toHaveLength(0);
    expect(homes.requestsFor('/v1/discussions')).toHaveLength(0);
});

it('resolves an allowed Voice source through the real transcript Action when its rendered id differs from the committed id', async () => {
    const { serverId, source } = await sourceHome();
    const rendered = { kind: 'agent-text' as const, id: 'rendered-block', localId: null,
        text: 'Stale rendered answer.', createdAt: 1,
        messageActionReference: { v: 1 as const, sessionId: 'source-session', messageId: 'committed-answer', observedRevision: '1' } };
    getStorage().setState({ settings: { ...initial.settings, voice: { ...initial.settings.voice,
        privacy: { ...initial.settings.voice.privacy, shareRecentMessages: true } } },
        sessions: { 'source-session': createSessionFixture({ id: 'source-session', serverId }) },
        sessionMessages: { 'source-session': createSessionMessagesFixture({ isLoaded: true,
            messageIdsOldestFirst: [rendered.id], messagesById: { [rendered.id]: rendered } }) } });
    const executor = createDefaultActionExecutor();
    expect(await readDiscussionSecondOpinionSourceV1(source, executor.execute,
        { surface: 'voice', serverId, expectedAccountId: 'alice' })).toBe('The source answer.');
    expect(homes.requestsFor('/v1/discussions')).toHaveLength(0);
});

it('requests ordinary approval before a nonwaived Voice second-opinion root can disclose source', async () => {
    const { serverId, source } = await sourceHome();
    const outcome = await createDefaultActionExecutor().execute('discussion.second_opinion.start', {
        intent: 'preview', source, title: 'Review', question: 'What changes?', reviewers: [],
        retry: { creationLocalId: 'creation', quoteLocalId: 'quote', questionLocalId: 'question' },
    }, { surface: 'voice', serverId, expectedAccountId: 'alice' });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true,
        result: { kind: 'approval_request_created', actionId: 'discussion.second_opinion.start' } });
    expect(homes.requestsFor('/v1/sessions/source-session/messages')).toHaveLength(0);
});

it('keeps Voice path and tool disclosure policy on server-backed semantic rows even when raw content is requested', async () => {
    const { serverId, source } = await sourceHome();
    const share = (shareToolNames: boolean, shareToolArgs: boolean) => getStorage().setState({ settings: {
        ...initial.settings, voice: { ...initial.settings.voice, privacy: { ...initial.settings.voice.privacy,
            shareRecentMessages: true, shareToolNames, shareToolArgs, shareFilePaths: false } },
    } });
    const messages = [
        { id: 'committed-answer', seq: 7, localId: null, createdAt: 1, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Read /home/alice/private/file.ts' } } } },
        { id: 'tool-row', seq: 8, localId: null, createdAt: 2, messageRole: 'agent', content: { t: 'plain', v: {
            role: 'agent', content: { type: 'acp', data: { type: 'tool-call', name: 'shell', callId: 'call',
                input: { command: 'private-command /home/alice/private/file.ts' } } },
        } } },
    ];
    homes.answer(serverId, '/v1/sessions/source-session/messages', { select: (_input, request) => {
        const messageId = new URL(request.url).searchParams.get('messageId');
        return { body: { messages: messageId ? messages.filter(row => row.id === messageId) : messages,
            hasMore: false, nextBeforeSeq: null, nextAfterSeq: null } };
    } });
    const execute = () => createDefaultActionExecutor().execute('session.transcript.get', { sessionId: 'source-session',
        includeTools: true, includeRaw: true, includeStructuredPayload: true },
        { surface: 'voice', serverId, expectedAccountId: 'alice' });
    share(false, false);
    const hidden = await execute();
    expect(hidden).toMatchObject({ ok: true, result: { items: [{ id: 'committed-answer', text: 'Read <path_redacted>' }] } });
    expect(JSON.stringify(hidden)).not.toContain('shell');
    expect(JSON.stringify(hidden)).not.toContain('/home/alice');
    expect(JSON.stringify(hidden)).not.toContain('"raw"');
    share(true, false);
    const named = await execute();
    expect(named).toMatchObject({ ok: true, result: { items: [{ id: 'committed-answer' }, { id: 'tool-row', text: 'Tool: shell' }] } });
    expect(JSON.stringify(named)).not.toContain('private-command');
    share(true, true);
    const detailed = await execute();
    // Canonical Voice settings hardening refuses persisted attempts to share tool arguments.
    expect(JSON.stringify(detailed)).not.toContain('private-command');
    expect(JSON.stringify(detailed)).not.toContain('/home/alice');
    expect(JSON.stringify(detailed)).not.toContain('"raw"');
    const executor = createDefaultActionExecutor();
    await expect(readDiscussionSecondOpinionSourceV1(source, executor.execute,
        { surface: 'voice', serverId, expectedAccountId: 'alice' })).rejects.toMatchObject({ code: 'discussion_content_unavailable' });
    expect(homes.requestsFor('/v1/discussions')).toHaveLength(0);
});

it('admits Voice transcript reads through the same exact-Home Follow and other-session privacy decision', async () => {
    const { serverId } = await sourceHome();
    getStorage().setState({ sessions: {}, settings: { ...initial.settings, voice: { ...initial.settings.voice,
        privacy: { ...initial.settings.voice.privacy, shareRecentMessages: true },
        ui: { ...initial.settings.voice.ui, updates: { ...initial.settings.voice.ui.updates, otherSessionsSnippetsMode: 'never' } },
    } } });
    const execute = () => createDefaultActionExecutor().execute('session.transcript.get', { sessionId: 'source-session' },
        { surface: 'voice', serverId, expectedAccountId: 'alice' });
    expect(await execute()).toMatchObject({ ok: false, errorCode: 'other_sessions_snippets_disabled' });
    expect(homes.requestsFor('/v1/sessions/source-session/messages')).toHaveLength(0);
    getStorage().setState({ sessions: { 'source-session': createSessionFixture({ id: 'source-session', serverId,
        viewer: createSessionViewerFixture({ follow: { follows: true, notificationLevel: 'important', includeInVoice: true } }) }) } });
    expect(await execute()).toMatchObject({ ok: true, result: { items: [{ id: 'committed-answer', text: 'The source answer.' }] } });
});

it('rechecks Voice sharing before publishing a transcript response that was already in flight', async () => {
    const { serverId } = await sourceHome();
    getStorage().setState({ settings: { ...initial.settings, voice: { ...initial.settings.voice,
        privacy: { ...initial.settings.voice.privacy, shareRecentMessages: true } } } });
    const reading = createDeferred<void>();
    const released = createDeferred<void>();
    homes.answer(serverId, '/v1/sessions/source-session/messages', { select: () => {
        reading.resolve();
        return { respondAfter: released.promise, body: { messages: [{ id: 'committed-answer', seq: 7, localId: null,
            createdAt: 1, messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: {
                type: 'text', text: 'The source answer.',
            } } } }], hasMore: false } };
    } });
    const pending = createDefaultActionExecutor().execute('session.transcript.get', { sessionId: 'source-session' },
        { surface: 'voice', serverId, expectedAccountId: 'alice' });
    await reading.promise;
    getStorage().setState(current => ({ settings: { ...current.settings, voice: { ...current.settings.voice,
        privacy: { ...current.settings.voice.privacy, shareRecentMessages: false } } } }));
    released.resolve();
    expect(await pending).toMatchObject({ ok: false, errorCode: 'recent_messages_disabled' });
});

it('retains the quote and separate create identity through an uncertain people-only Discuss and explicit retry', async () => {
    const { serverId, source } = await sourceHome();
    answerDiscussionThreadForTests(homes, serverId, { accountId: 'alice', loseCreate: true, loseFirstRejoin: false });
    const controller = createDiscussionSecondOpinionController({ scope: { serverId, accountId: 'alice' },
        availability: 'available', source, draft: { title: 'Review', question: 'What changes?', reviewers: [] } });
    const retry = controller.getSnapshot().retry;
    expect(new Set(Object.values(retry)).size).toBe(3);
    expect(homes.requestsFor('/v1/discussions')).toHaveLength(0);
    await controller.preview();
    expect(controller.getSnapshot().preview?.sourceText).toBe('The source answer.');
    expect(homes.requestsFor('/v1/discussions')).toHaveLength(0);
    await controller.discuss();
    expect(controller.getSnapshot().result).toMatchObject({ operation: 'discuss', outcome: { kind: 'failed', errorCode: 'outcome_unknown' } });
    expect(controller.updateDraft({ title: 'Changed', question: 'Changed', reviewers: [] })).toBe(false);
    await controller.retry();
    expect(controller.getSnapshot()).toMatchObject({ retry, draft: { title: 'Review', question: 'What changes?' },
        // The committed Discussion message is opened through useOpenDiscussion, not a route href (d6484a119d).
        discussionMessage: { kind: 'discussion', discussion: { discussionId: 'committed-thread' }, messageId: 'committed-root' } });
    const requests = homes.requestsFor('/v1/discussions').filter(row => row.input !== null)
        .map(row => DiscussionCreateRequestV1Schema.parse(row.input));
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]).toMatchObject({ creationLocalId: retry.creationLocalId,
        anchor: { kind: 'session', sessionId: 'source-session', messageId: 'committed-answer' },
        firstMessage: { localId: retry.quoteLocalId, mentionedSessionIds: [],
            // The current controller retains both the source quote and the authored question.
            // Their adjacent text parts follow discussionSecondOpinionController.discuss.
            content: { t: 'plain', v: { v: 1, parts: [
                { t: 'text', text: 'The source answer.' }, { t: 'text', text: 'What changes?' },
            ] } } } });
});

it('requires explicit confirmation of a changed preview, then retries the one ordinary question with its retained identity', async () => {
    const { serverId, source, preview } = await sourceHome();
    const reviewers = [{ selection: { kind: 'session' as const, session: { serverId, sessionId: 'reviewer' } } }];
    const oldPreview = DiscussionSecondOpinionPreviewV1Schema.parse({ ...preview, reviewers: [{ ...reviewers[0], sourceAccess: 'read',
        runtimeAccountId: 'alice', audienceAccountIds: ['alice'], missingSourceAccountIds: [], canGrantSource: true,
        disclosure: { ok: true } }] });
    const changedPreview = DiscussionSecondOpinionPreviewV1Schema.parse({ ...oldPreview,
        reviewers: oldPreview.reviewers.map(row => ({ ...row, sourceAccess: 'quote_only' })) });
    let previewReads = 0;
    homes.answer(serverId, 'POST /v1/discussions/second-opinion/preview', { select: () => ({ body: {
        ok: true, value: ++previewReads === 1 ? oldPreview : changedPreview,
    } }) });
    const thread = answerDiscussionThreadForTests(homes, serverId, { accountId: 'alice', loseCreate: false, loseFirstRejoin: false, losePost: true });
    homes.answer(serverId, 'POST /v1/discussions/committed-thread/participants/invite', { body: {
        discussionId: 'committed-thread', ownerAccountId: 'alice', access: 'owner', grants: [], changed: true,
    } });
    const controller = createDiscussionSecondOpinionController({ scope: { serverId, accountId: 'alice' },
        availability: 'available', source, draft: { title: 'Review', question: 'What changes?', reviewers } });
    const retry = controller.getSnapshot().retry;
    await controller.preview();
    expect(homes.requestsFor('/v1/discussions')).toHaveLength(0);
    await controller.ask();
    expect(controller.getSnapshot().result).toMatchObject({ operation: 'second_opinion', outcome: {
        kind: 'succeeded', value: { status: 'preview_changed', preview: changedPreview },
    } });
    await controller.retry();
    expect(homes.requestsFor('/v1/discussions')).toHaveLength(0);
    await controller.ask();
    expect(controller.getSnapshot().result).toMatchObject({ operation: 'second_opinion', outcome: {
        kind: 'succeeded', value: { status: 'pending', stage: 'ask', errorCode: 'outcome_unknown' },
    } });
    await controller.retry();
    expect(controller.getSnapshot().result).toMatchObject({ operation: 'second_opinion', outcome: {
        kind: 'succeeded', value: { status: 'asked', discussion: { serverId, discussionId: 'committed-thread' } },
    } });
    expect(thread.messages).toHaveLength(2);
    expect(homes.requestsFor('/v1/discussions/committed-thread/messages').filter(row => row.input !== null)
        .map(row => DiscussionPostRequestV1Schema.parse(row.input).localId)).toEqual([retry.questionLocalId, retry.questionLocalId]);
});

it.each([false, true])('carries selected Workflow placement to multi-reviewer admission and refuses its absence before creation (project=%s)', async withProject => {
    const { serverId, source, preview } = await sourceHome();
    const reviewers = ['a', 'b'].map(sessionId => ({
        selection: { kind: 'session' as const, session: { serverId, sessionId } },
    }));
    const selectedPreview = DiscussionSecondOpinionPreviewV1Schema.parse({ ...preview,
        reviewers: reviewers.map(reviewer => ({ ...reviewer, sourceAccess: 'read', runtimeAccountId: 'alice',
            audienceAccountIds: ['alice'], missingSourceAccountIds: [], canGrantSource: true, disclosure: { ok: true } })) });
    homes.answer(serverId, 'POST /v1/discussions/second-opinion/preview', { body: { ok: true, value: selectedPreview } });
    answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
    // Stop at the real Home invitation boundary; the Protocol composition covers Run admission/start.
    homes.answer(serverId, 'POST /v1/discussions/committed-thread/participants/invite', {
        status: 403, body: { error: 'discussion_access_forbidden' },
    });
    const draft: Parameters<typeof createDiscussionSecondOpinionController>[0]['draft'] = {
        title: 'Review', question: 'What changes?', reviewers,
    };
    const controller = createDiscussionSecondOpinionController({ scope: { serverId, accountId: 'alice' }, availability: 'available', source,
        draft });
    await controller.preview();
    expect(controller.getSnapshot().preview?.preview).toEqual(selectedPreview);
    await controller.ask({ project: withProject ? { machineId: 'review-machine', directory: '/selected/review' } : null });
    expect(controller.getSnapshot().result).toMatchObject({ operation: 'second_opinion',
        outcome: withProject ? { kind: 'succeeded', value: { status: 'pending', stage: 'invite', errorCode: 'discussion_access_forbidden' } }
            : { kind: 'failed', errorCode: 'target_unavailable' } });
    expect(homes.requestsFor('/v1/discussions').filter(row => row.input !== null)).toHaveLength(withProject ? 1 : 0);
    if (withProject) {
        await controller.retry();
        expect(controller.getSnapshot().result).toMatchObject({ outcome: { kind: 'succeeded', value: {
            status: 'pending', stage: 'invite', errorCode: 'discussion_access_forbidden',
        } } });
    }
});

it('removes a configured model by its retained selection and refuses changes during its real preview', async () => {
    const { serverId, source, preview } = await sourceHome();
    const reading = createDeferred<void>();
    const released = createDeferred<void>();
    homes.answer(serverId, 'POST /v1/discussions/second-opinion/preview', { select: () => {
        reading.resolve();
        return { body: { ok: true, value: preview }, respondAfter: released.promise };
    } });
    const controller = createDiscussionSecondOpinionController({ scope: { serverId, accountId: 'alice' },
        availability: 'available', source, draft: { title: 'Review', question: 'What changes?', reviewers: [] } });
    const selection = { kind: 'model' as const, launch: { executionTarget: { serverId, machineId: 'review-machine' },
        directory: { kind: 'path' as const, path: '/work' },
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } };
    const retry = controller.getSnapshot().retry;
    expect(controller.toggleReviewer(selection, 'Reviewed question')).toBe(true);
    const reviewers = controller.getSnapshot().draft.reviewers;
    expect(reviewers).toMatchObject([{ selection, participantSlotId: expect.any(String) }]);
    const pending = controller.preview();
    await reading.promise;
    expect(controller.toggleReviewer(selection, 'Changed while loading')).toBe(false);
    expect(controller.getSnapshot().draft).toMatchObject({ question: 'Reviewed question', reviewers });
    released.resolve();
    await pending;
    expect(controller.toggleReviewer(selection, 'Reviewed question')).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ retry, draft: { reviewers: [] }, preview: null });
    expect(homes.requestsFor('/v1/discussions')).toHaveLength(0);
});

it('reads the exact committed source row and refuses a mismatched envelope without using a loaded quote', async () => {
    const { serverId, source } = await sourceHome();
    let pageReads = 0;
    homes.answer(serverId, '/v1/sessions/source-session/messages', { select: (_input, request) => {
        pageReads++;
        const query = new URL(request.url).searchParams;
        const selected = query.get('messageId') === 'committed-answer' || query.get('beforeSeq') === '8';
        return { body: { messages: [{ id: selected ? 'committed-answer' : 'later-answer', seq: selected ? 7 : 8,
            localId: null, createdAt: 1, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: selected ? 'The source answer.' : 'Later answer.' } } } }],
            hasMore: !selected, nextBeforeSeq: selected ? null : 8 } };
    } });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    const input = { intent: 'preview' as const, source, title: 'Review', question: 'What changes?', reviewers: [],
        retry: { creationLocalId: 'creation', quoteLocalId: 'quote', questionLocalId: 'question' } };
    expect(await client.secondOpinion(input)).toMatchObject({ kind: 'succeeded', value: { status: 'preview', sourceText: 'The source answer.' } });
    expect(pageReads).toBe(1);
    homes.answer(serverId, '/v1/sessions/source-session/messages', { body: { messages: [{ id: 'committed-answer', seq: 7,
        localId: null, createdAt: 1, messageRole: 'agent', content: { t: 'encrypted', c: 'unavailable' } }], hasMore: false } });
    expect(await client.secondOpinion(input)).toEqual({ kind: 'failed', errorCode: 'session_transcript_content_unavailable' });
    expect(homes.requestsFor('/v1/discussions')).toHaveLength(0);
});

it('rechecks source authorization before opening committed content', async () => {
    const { serverId, source } = await sourceHome();
    homes.answer(serverId, '/v2/sessions/source-session', { status: 403, body: { error: 'Forbidden' } });
    homes.answer(serverId, '/v2/sessions/source-session?accessProjectionVersion=1', { status: 403, body: { error: 'Forbidden' } });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    expect(await client.secondOpinion({ intent: 'preview', source, title: 'Review', question: 'What changes?', reviewers: [],
        retry: { creationLocalId: 'creation', quoteLocalId: 'quote', questionLocalId: 'question' } })).toMatchObject({ kind: 'failed' });
    expect(homes.requestsFor('/v1/sessions/source-session/messages')).toHaveLength(0);
    expect(homes.requestsFor('/v1/discussions')).toHaveLength(0);
});
