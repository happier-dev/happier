import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import type { AgentInputSendOptions } from '@/components/sessions/agentInput/agentInputSendOptions';
import type { DiscussionDraftSubmission } from '@/sync/ops/discussions/discussionRepository';
import { captureDocPassageV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { deriveDocCommentDiscussionCreationLocalIdV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { DiscussionMessageContentV1StoredSchema } from '@happier-dev/protocol/discussions/content';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { MENTION_KIND_V1, buildMentionRefForKindV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { answerDiscussionThreadForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';

const route = vi.hoisted(() => ({ params: {} as Record<string, string | string[] | undefined> }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/discussions/new', params: () => route.params,
}).module);
// The browser Markdown adapter is an external SDK boundary in the native host harness.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
}));
// The host renderer has no native viewport. Substitute only the recycler SDK so real message rows render.
vi.mock('@legendapp/list/react-native', async importOriginal =>
    (await import('@/dev/testkit/mocks/legendList')).createCapturingLegendListMock({
        original: await importOriginal<Record<string, unknown>>(), renderItems: true,
    }).module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createArtifactActionsClient } = await import('./artifactActionsClient');
const { ArtifactPassageQuote } = await import('./ArtifactPassageQuote');
const { DiscussionRouteScreen } = await import('@/components/discussions/DiscussionRouteScreen');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
const { createDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepository');
const { getDiscussionRepository, clearDiscussionRepositoryRegistryForTests } = await import('@/sync/ops/discussions/discussionRepositoryRegistry');
const { useDiscussionDraft } = await import('@/components/discussions/useDiscussionDraft');
const { getSessionDraftSnapshot, resetSessionDraftRepositoryForTests, writeDiscussionSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { buildDiscussionRouteHref, readDiscussionRouteDraftId } = await import('@/components/discussions/discussionRoutes');
const { createInboxItemRoute, readInboxItemFocus, resolveInboxItemPageRoute } = await import('@/components/inbox/inboxItemFocus');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { buildDiscussionContent } = await import('@/components/discussions/discussionComposerDocument');
const { useArtifactTitleProjections } = await import('./useArtifactTitleProjections');
const { storage } = await import('@/sync/domains/state/storageStore');
const { ArtifactNewPassageThread } = await import('./ArtifactNewPassageThread');
const { AgentInput } = await import('@/components/sessions/agentInput');
const { useArtifactOperations } = await import('./useArtifactOperations');
const { Modal } = await import('@/modal');
const { t } = await import('@/text');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

beforeEach(async () => { route.params = {}; await homes.reset(); });
afterEach(async () => { clearDiscussionRepositoryRegistryForTests(); resetSessionDraftRepositoryForTests(); standardCleanup();
    await connection?.dispose(); connection = undefined; await homes.reset(); });

describe('Doc collaboration data through the real Actions and Discussion repository', () => {
    it('names a Doc delete 503 and leaves the Doc available for a deliberate retry', async () => {
        const serverUrl = 'https://doc-delete-busy.test';
        const serverId = await homes.addHome({ name: 'Doc Home', serverUrl, accountId: 'alice', currentAccount: true });
        connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', request: homes.request });
        const created = await createArtifactActionsClient({ serverId, accountId: 'alice' }).createArtifact({
            header: { kind: 'artifact.legacy', title: 'Keep until deleted' }, body: 'Opening hours',
        });
        if (!('ok' in created) || !created.ok) throw new Error('Expected Doc');
        const artifactId = created.value.artifactId;
        let refuse = true;
        homes.answer(serverId, `DELETE /v1/artifacts/${artifactId}/revision/1/1`, {
            select: async (_input, request) => {
                if (refuse) return { status: 503, body: { error: 'database_transaction_conflict_exhausted' } };
                const response = await homes.artifacts(serverId).handle(new URL(request.url).pathname, request.init);
                if (!response) throw new Error('Expected Artifact delete route');
                return { status: response.status, body: await response.json().catch(() => undefined) };
            },
        });
        const onDeleted = vi.fn();
        const { sync } = await import('@/sync/sync');
        const artifact = await sync.fetchArtifactWithBody(artifactId);
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const hook = await renderHook(() => ({ ...useArtifactOperations(artifact, onDeleted),
            binding: useServerCredentialAccountScopeBinding(serverId).binding }));
        await vi.waitFor(() => expect(hook.getCurrent().binding?.isCurrent()).toBe(true));
        expect(hook.getCurrent().canManage).toBe(true);
        await act(async () => { await hook.getCurrent().remove(); });
        expect(homes.requestsFor(`/v1/artifacts/${artifactId}/revision/1/1`).filter(row => row.method === 'DELETE')).toHaveLength(1);
        expect(Modal.alert).toHaveBeenLastCalledWith(t('approvals.transientFailureTitle'), t('approvals.transientFailure'));
        expect(onDeleted).not.toHaveBeenCalled();
        expect(storage.getState().artifacts[artifactId]).toBeDefined();
        refuse = false;
        await act(async () => { await hook.getCurrent().remove(); });
        expect(onDeleted).toHaveBeenCalledOnce();
        expect(homes.requestsFor(`/v1/artifacts/${artifactId}/revision/1/1`).filter(row => row.method === 'DELETE')).toHaveLength(2);
    });

    it.each(['controlled', 'send-override'] as const)('keeps one first-comment attempt pending and retryable with %s text', async entry => {
        const serverUrl = `https://doc-first-send-${entry}.test`;
        const serverId = await homes.addHome({ name: 'Comment Home', serverUrl, accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, conversations: { enabled: true } } } });
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', request: homes.request });
        const artifacts = createArtifactActionsClient(scope);
        const created = await artifacts.createArtifact({ header: { kind: 'artifact.legacy', title: 'Café opening plan' }, body: 'Opening hours' });
        if (!('ok' in created) || !created.ok) throw new Error('Expected Doc');
        const doc = await artifacts.readDoc({ ref: { kind: 'doc', serverId, artifactId: created.value.artifactId } });
        if (!doc.ok) throw new Error('Expected readable Doc');
        const passage = captureDocPassageV1({ ref: doc.value.ref, revision: doc.value.artifact.revision,
            source: 'Opening hours', range: { start: 0, end: 13 } });
        const comment = { ...artifacts.startPassageComment(passage), passage };
        answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const release = createDeferred<void>();
        homes.answer(serverId, 'POST /v1/discussions', { status: 503,
            body: { error: 'database_transaction_conflict_exhausted' }, respondAfter: release.promise });
        const onCreated = vi.fn();
        const element = createElement(ArtifactNewPassageThread, { scope, comment, onCreated, onOpenDiscussion() {}, onClose() {} });
        let screen = await renderScreen(element);
        const input = () => screen.root.findByType(AgentInput);
        const changeText = (value: string) => {
            const onChangeText = input().props.onChangeText;
            if (!onChangeText) throw new Error('Expected a controlled AgentInput');
            onChangeText(value);
        };
        const send = (value?: AgentInputSendOptions) => {
            const onSend = input().props.onSend;
            if (!onSend) throw new Error('Expected an AgentInput send handler');
            return onSend(value);
        };
        const text = 'Please review the opening hours.';
        if (entry === 'controlled') await act(async () => { changeText(text); });
        await act(async () => { void send(entry === 'send-override' ? { inputTextOverride: text } : undefined); });
        await vi.waitFor(() => expect(homes.requestsFor('/v1/discussions').filter(row => row.method === 'POST')).toHaveLength(1));
        const repository = getDiscussionRepository({ scope, address: { serverId }, client: createDiscussionClient({ scope, availability: 'available' }) });
        const attempt = Object.values(repository.getSnapshot().mutations)[0]!;
        expect(attempt).toMatchObject({ kind: 'create', status: 'sending' });
        try {
            expect(input().props.isSending).toBe(true);
            // A second activation before settlement cannot become another server write.
            await act(async () => { void send({ inputTextOverride: text }); });
            expect(homes.requestsFor('/v1/discussions').filter(row => row.method === 'POST')).toHaveLength(1);
        } finally {
            await act(async () => { release.resolve(); });
        }
        await vi.waitFor(() => expect(repository.getSnapshot().mutations[attempt.localId]).toMatchObject({
            status: 'failed', errorCode: 'database_transaction_conflict_exhausted', recovery: 'retry',
            failureCause: { errorCode: 'database_transaction_conflict_exhausted', httpStatus: 503 },
        }));
        await screen.unmount();
        screen = await renderScreen(element);
        expect(Object.keys(repository.getSnapshot().mutations)).toEqual([attempt.localId]);
        const network = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        await act(async () => { await repository.retry(attempt.localId); });
        await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
        const sends = homes.requestsFor('/v1/discussions').filter(row => row.method === 'POST');
        expect(sends).toHaveLength(2);
        expect(sends[1]?.input).toMatchObject({ creationLocalId: attempt.localId, firstMessage: { localId: attempt.messageLocalId } });
        expect(sends[0]?.input).toMatchObject({ creationLocalId: attempt.localId, firstMessage: { localId: attempt.messageLocalId } });
        expect(network.messages).toHaveLength(1);
    });

    it('opens missing Doc labels through exact headers without fetching bodies or rereading at idle', async () => {
        const serverId = await homes.addHome({ name: 'Review Home', serverUrl: 'https://doc-labels.test', accountId: 'alice', currentAccount: true });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://doc-labels.test', accountId: 'alice', request: homes.request });
        const scope = { serverId, accountId: 'alice' };
        expect(storage.getState().profileScope).toEqual(scope);
        const created = await createArtifactActionsClient(scope).createArtifact({ header: { kind: 'artifact.legacy', title: 'Release notes' }, body: 'Private body' });
        if (!('ok' in created) || !created.ok) throw new Error('Expected Doc');
        const artifactId = created.value.artifactId;
        storage.getState().deleteArtifact(artifactId);
        const artifactIds = [artifactId];
        const before = homes.requests.length;
        const renders = createRenderCommitCounter();
        const hook = await renderHook(() => {
            useRenderCommitCounter(renders);
            return useArtifactTitleProjections(scope, artifactIds);
        });
        await vi.waitFor(() => expect(hook.getCurrent()).toEqual(['Release notes']));
        expect(storage.getState().artifacts[artifactId]?.body).toBeUndefined();
        const reads = homes.requests.slice(before).filter(request => request.path === '/v1/artifacts/read');
        expect(reads.map(request => request.input)).toEqual([{ artifactIds, projection: 'headers' }]);
        renders.reset();
        await act(async () => {
            for (let index = 0; index < 20; index++) storage.setState({ artifacts: { ...storage.getState().artifacts } });
        });
        expect(hook.getCurrent()).toEqual(['Release notes']);
        expect(renders.read()).toEqual({ renders: 0, commits: 0 });
        expect(homes.requests.slice(before).filter(request => request.path === '/v1/artifacts/read')).toHaveLength(1);
        const row = storage.getState().artifacts[artifactId]!;
        if (!row.isDecrypted) throw new Error('Expected the decrypted Artifact row');
        await act(async () => storage.getState().applyArtifacts([{ ...row, title: 'Published notes', headerVersion: row.headerVersion + 1 }]));
        expect(hook.getCurrent()).toEqual(['Published notes']);
        expect(renders.read()).toEqual({ renders: 1, commits: 1 });
        await act(async () => storage.setState({ profileScope: { serverId: 'other-home', accountId: 'alice' } }));
        expect(hook.getCurrent()).toEqual([null]);
        await hook.unmount();
    });

    it.each(['redo', 'reattach', 'redo-refused', 'retained-redo'] as const)('sends the prepared %s through the real Discussion composer and Doc/Discussion Actions', async kind => {
        const serverId = await homes.addHome({ name: 'Recovery Home', serverUrl: `https://doc-recovery-${kind}.test`, accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { session: { enabled: true } } } });
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        const artifacts = createArtifactActionsClient(scope);
        const source = 'Original passage.';
        const created = await artifacts.createArtifact({ header: { kind: 'artifact.legacy', title: 'Recovery notes' }, body: source });
        if (!('ok' in created) || !created.ok) throw new Error('Expected Doc');
        const doc = await artifacts.readDoc({ ref: { kind: 'doc', serverId, artifactId: created.value.artifactId } });
        if (!doc.ok) throw new Error('Expected admitted Doc');
        const passage = captureDocPassageV1({ ref: doc.value.ref, revision: doc.value.artifact.revision, source, range: { start: 0, end: source.length } });
        const network = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const root = await artifacts.replyToPassage({ target: passage, localId: 'root', content: { v: 1, parts: [{ t: 'text', text: 'Review this.' }] } });
        if (!('ok' in root) || !root.ok) throw new Error(JSON.stringify(root));
        const discussionRef = root.value.message.messageRef.discussion;
        const proposed = await artifacts.proposeEdit({ discussionRef, target: passage, baseRevision: passage.revision,
            before: passage.quote, after: 'Suggested passage.', reason: 'Clarify.', localId: 'proposal', replyTo: root.value.message.messageRef });
        if (!('ok' in proposed) || !proposed.ok) throw new Error(JSON.stringify(proposed));
        const proposalRef = proposed.value.message.messageRef;
        expect(proposed.value.message.replyTarget).toEqual({ kind: 'message', messageId: root.value.message.messageRef.messageId });
        homes.answer(serverId, `/v1/discussions/${discussionRef.discussionId}/participants`, { body: DiscussionParticipantsListResponseV1Schema.parse({
            discussionId: discussionRef.discussionId, ownerAccountId: 'alice', access: 'owner', grants: [],
            participants: [{ participant: { kind: 'session', sessionId: 'proposer' }, answerPolicy: 'when_addressed', createdAt: 1 }],
        }) });
        const address = { kind: 'discussion' as const, discussionId: discussionRef.discussionId };
        const updated = await artifacts.updateArtifact({ artifactId: doc.value.ref.artifactId, expectedRevision: passage.revision,
            header: doc.value.artifact.header, body: 'Fresh passage.' });
        if (!('ok' in updated) || !updated.ok) throw new Error(JSON.stringify(updated));
        let expectedPassage = passage;
        const reference = { kind: MENTION_KIND_V1.session, ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'proposer'), label: 'Proposal Agent' };
        const mention = formatInlineReferenceTokenV1(reference);
        const redoText = `${mention} Please redo this proposal.`;
        if (kind === 'reattach') {
            expectedPassage = captureDocPassageV1({ ref: doc.value.ref, revision: updated.value.revision, source: 'Fresh passage.', range: { start: 0, end: 14 } });
            writeDiscussionSessionDraft({ scope, address, patch: { text: 'My retained recovery comment', replyTarget: { kind: 'message', messageId: proposalRef.messageId } } });
            artifacts.beginPassageReattach({ discussionId: discussionRef.discussionId, passage: expectedPassage });
        } else {
            artifacts.beginProposalReply({ proposalRef, text: redoText,
                mentions: [{ ...reference, start: 0, end: mention.length, tokenText: mention }] });
        }
        if (kind === 'redo-refused') {
            // HTTP is the boundary; all draft, composer, Action and codec owners remain real.
            homes.answer(serverId, `POST /v1/discussions/${discussionRef.discussionId}/messages`, {
                status: 409, body: { error: 'discussion_invalid_reply_target' },
            });
        }
        const repository = getDiscussionRepository({ scope, address: { serverId }, client: createDiscussionClient({ scope, availability: 'available' }) });
        if (kind === 'retained-redo') {
            // Captured pre-fix producer shape: an already-submitted reply wrongly wrapped as a passage comment.
            // Keep its exact old identity/content; recovery must release that refusal, not rewrite an uncertain send.
            const draft = await renderHook(() => useDiscussionDraft({ scope, address }));
            const content = { kind: 'doc_passage_comment' as const, passage,
                content: buildDiscussionContent(draft.getCurrent().text, draft.getCurrent().mentions) };
            const replyTarget = { kind: 'message' as const, messageId: proposalRef.messageId };
            await act(async () => {
                const draftSubmission = draft.getCurrent().captureSubmittedCurrentness({ kind: 'post',
                    discussionId: discussionRef.discussionId, localId: 'retained-redo', replyTarget }, { content });
                expect(await repository.post({ discussionId: discussionRef.discussionId, localId: 'retained-redo',
                    content, replyTarget, draftSubmission })).toEqual({ kind: 'failed', errorCode: 'doc_passage_mismatch' });
            });
            expect(repository.getSnapshot().mutations['retained-redo']).toMatchObject({ status: 'failed', recovery: 'dismiss' });
            await draft.unmount();
        }
        route.params = { serverId, discussionId: discussionRef.discussionId, messageId: proposalRef.messageId };
        const screen = await renderScreen(createElement(AppPaneProvider, null, createElement(DiscussionRouteScreen, { kind: 'discussion' })));
        await vi.waitFor(() => expect(screen.findByTestId('new-session-composer-send')).not.toBeNull());
        await screen.pressByTestIdAsync('new-session-composer-send');
        if (kind === 'redo-refused') {
            await vi.waitFor(() => expect(Object.values(repository.getSnapshot().mutations)).toEqual([
                expect.objectContaining({ status: 'failed', errorCode: 'discussion_invalid_reply_target', recovery: 'dismiss' }),
            ]));
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('discussion_invalid_reply_target'));
            expect(network.messages).toHaveLength(2);
            const draft = await renderHook(() => useDiscussionDraft({ scope, address }));
            expect(draft.getCurrent()).toMatchObject({ text: redoText, replyTarget: { kind: 'message', messageId: proposalRef.messageId } });
            await draft.unmount();
            await screen.unmount();
            return;
        }
        await vi.waitFor(() => expect(network.messages, JSON.stringify(repository.getSnapshot().mutations)).toHaveLength(3));
        expect(network.messages[2]).toMatchObject(kind !== 'reattach'
            ? { replyTarget: { kind: 'message', messageId: proposalRef.messageId }, content: { t: 'plain', v: { v: 1, parts: [
                { t: 'mention', participant: { kind: 'session', sessionId: 'proposer' } }, { t: 'text', text: ' Please redo this proposal.' },
            ] } } }
            : { replyTarget: { kind: 'doc_passage', doc: { ref: expectedPassage.ref, revision: expectedPassage.revision } },
                content: { t: 'plain', v: { kind: 'doc_passage_comment', passage: expectedPassage, content: { v: 1, parts: [{ t: 'text', text: 'My retained recovery comment' }] } } } });
        await screen.unmount();
    });
    it('mounts the keyed New Discussion rather than the unrelated singleton draft', async () => {
        const serverId = await homes.addHome({ name: 'Draft Route Home', serverUrl: 'https://doc-passage-draft-route.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const features = createRootLayoutFeaturesResponse();
        for (const feature of ['sharing.session', 'sessions.conversations'] as const) {
            if (!tryWriteServerEnabledBitInPlace(features, feature, true)) throw new Error(`Unable to enable ${feature}`);
        }
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        const artifacts = createArtifactActionsClient(scope);
        const passage = captureDocPassageV1({ ref: { kind: 'doc', serverId, artifactId: 'notes' },
            revision: { headerVersion: 1, bodyVersion: 2 }, source: 'Private passage.', range: { start: 0, end: 16 } });
        const href = new URL(artifacts.beginPassageComment(passage), 'https://home.invalid');
        const nextHref = new URL(artifacts.beginPassageComment({ ...passage, revision: { ...passage.revision, bodyVersion: 3 } }), 'https://home.invalid');
        const draftId = readDiscussionRouteDraftId(href.searchParams.get('draftId') ?? undefined);
        const nextDraftId = readDiscussionRouteDraftId(nextHref.searchParams.get('draftId') ?? undefined);
        if (!draftId || !nextDraftId) throw new Error('Expected keyed passage routes');
        writeDiscussionSessionDraft({ scope, address: { kind: 'newDiscussion' }, patch: { title: 'Unrelated N2 title', text: 'Unrelated N2 text' } });
        writeDiscussionSessionDraft({ scope, address: { kind: 'newDiscussion', draftId }, patch: { title: 'Passage title', text: 'Passage question' } });
        writeDiscussionSessionDraft({ scope, address: { kind: 'newDiscussion', draftId: nextDraftId }, patch: { title: 'Next passage title', text: 'Next passage question' } });
        answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        route.params = Object.fromEntries(href.searchParams.entries());
        const screen = await renderScreen(createElement(AppPaneProvider, null, createElement(DiscussionRouteScreen, { kind: 'new' })));
        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-title')?.props.value, screen.getTextContent()).toBe('Passage title'));
        const unrelated = await renderHook(() => useDiscussionDraft({ scope, address: { kind: 'newDiscussion' } }));
        let submission: DiscussionDraftSubmission | undefined;
        act(() => { submission = unrelated.getCurrent().captureSubmittedCurrentness({ kind: 'create',
            creationLocalId: 'unrelated-create', messageLocalId: 'unrelated-message' }); });
        const repository = getDiscussionRepository({ scope, address: { serverId }, client: createDiscussionClient({ scope, availability: 'available' }) });
        await act(async () => { repository.adoptPendingIntent({ kind: 'create', creationLocalId: 'unrelated-create',
            messageLocalId: 'unrelated-message', title: 'Unrelated N2 title', content: { v: 1, parts: [{ t: 'text', text: 'Unrelated N2 text' }] },
            draftSubmission: submission! }); });
        expect(screen.findByTestId('session-discussion-new-empty')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('Unrelated N2 text');
        route.params = Object.fromEntries(nextHref.searchParams.entries());
        await screen.update(createElement(AppPaneProvider, null, createElement(DiscussionRouteScreen, { kind: 'new' })));
        expect(screen.findByTestId('session-discussion-title')?.props.value).toBe('Next passage title');
        expect(screen.findByTestId('session-discussion-new-empty')).not.toBeNull();
        route.params = { ...route.params, draftId: 'unsupported-key' };
        await screen.update(createElement(AppPaneProvider, null, createElement(DiscussionRouteScreen, { kind: 'new' })));
        expect(screen.findByTestId('session-discussion-new-details')).toBeNull();
        await unrelated.unmount();
        await screen.unmount();
    });
    it('isolates passage drafts from the singleton and other passages while reopening the same retained passage', async () => {
        const serverId = await homes.addHome({ name: 'Draft Home', serverUrl: 'https://doc-passage-drafts.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const client = createArtifactActionsClient(scope);
        const passage = captureDocPassageV1({ ref: { kind: 'doc', serverId, artifactId: 'notes' },
            revision: { headerVersion: 1, bodyVersion: 2 }, source: 'Private first. Private second.', range: { start: 0, end: 14 } });
        const unrelated = captureDocPassageV1({ ref: { ...passage.ref, artifactId: 'unrelated' }, revision: passage.revision,
            source: 'Unrelated private source', range: { start: 0, end: 24 } });
        writeDiscussionSessionDraft({ scope, address: { kind: 'newDiscussion' }, patch: { title: 'Unrelated draft', text: 'N2 retained text', passage: unrelated } });
        const readAddress = (href: string) => {
            const url = new URL(href, 'https://home.invalid');
            const draftId = readDiscussionRouteDraftId(url.searchParams.get('draftId') ?? undefined);
            expect(draftId).toEqual(expect.any(String));
            if (!draftId) throw new Error('Expected qualified passage draft');
            return { kind: 'newDiscussion' as const, draftId };
        };
        const href = client.beginPassageComment(passage);
        expect(getSessionDraftSnapshot(scope, { kind: 'newDiscussion' })?.document)
            .toMatchObject({ title: { value: 'Unrelated draft' }, composer: { text: { value: 'N2 retained text' } } });
        expect(getSessionDraftSnapshot(scope, { kind: 'newDiscussion' })?.document).toMatchObject({ passage: { value: unrelated } });
        const address = readAddress(href);
        const hook = await renderHook(() => useDiscussionDraft({ scope, address }));
        expect(hook.getCurrent().passage).toEqual(passage);
        await act(async () => hook.getCurrent().setText('Retained passage question'));
        await hook.unmount();
        expect(client.beginPassageComment({ ...passage, prefix: 'changed context', suffix: 'still private' })).toBe(href);
        const restored = await renderHook(() => useDiscussionDraft({ scope, address: readAddress(href) }));
        expect(restored.getCurrent().text).toBe('Retained passage question');
        const different = captureDocPassageV1({ ref: passage.ref, revision: passage.revision,
            source: 'Private first. Private second.', range: { start: 15, end: 30 } });
        for (const next of [different, { ...passage, ref: { ...passage.ref, artifactId: 'other-notes' } },
            { ...passage, revision: { ...passage.revision, headerVersion: 2 } },
            { ...passage, revision: { ...passage.revision, bodyVersion: 3 } }]) {
            const nextAddress = readAddress(client.beginPassageComment(next));
            expect(nextAddress).not.toEqual(address);
            expect(getSessionDraftSnapshot(scope, nextAddress)?.document).toMatchObject({ composer: { text: { value: '' } } });
        }
        expect(href).not.toContain(passage.quote);
        expect(href).not.toContain('Private');
        await restored.unmount();
    });
    it('re-attaches an existing thread by seeding its own draft with the fresh passage and opening it, leaving other drafts alone', async () => {
        const serverId = await homes.addHome({ name: 'Reattach Home', serverUrl: 'https://doc-passage-reattach.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const client = createArtifactActionsClient(scope);
        const passage = captureDocPassageV1({ ref: { kind: 'doc', serverId, artifactId: 'notes' },
            revision: { headerVersion: 1, bodyVersion: 4 }, source: 'A reworded sentence.', range: { start: 0, end: 20 } });
        writeDiscussionSessionDraft({ scope, address: { kind: 'discussion', discussionId: 'other-thread' }, patch: { text: 'Keep this' } });
        writeDiscussionSessionDraft({ scope, address: { kind: 'discussion', discussionId: 'thread-1' },
            patch: { text: 'My retained comment', replyTarget: { kind: 'message', messageId: 'old-basis-comment' } } });
        const href = client.beginPassageReattach({ discussionId: 'thread-1', passage, returnArtifactId: 'notes' });
        expect(href).toBe(buildDiscussionRouteHref({ target: { kind: 'discussion', address: { serverId }, discussionId: 'thread-1' },
            returnArtifactId: 'notes' }));
        const reattached = await renderHook(() => useDiscussionDraft({ scope, address: { kind: 'discussion', discussionId: 'thread-1' } }));
        expect(reattached.getCurrent().passage).toEqual(passage);
        expect(reattached.getCurrent().text).toBe('My retained comment');
        expect(reattached.getCurrent().replyTarget).toBeNull();
        const other = await renderHook(() => useDiscussionDraft({ scope, address: { kind: 'discussion', discussionId: 'other-thread' } }));
        expect(other.getCurrent().passage).toBeNull();
        expect(other.getCurrent().text).toBe('Keep this');
        await reattached.unmount();
        await other.unmount();
    });
    it.each(['', 'My own redo request'])('prepares the exact proposal reply atomically while preserving existing words (%s)', async retainedText => {
        const serverId = await homes.addHome({ name: 'Redo Home', serverUrl: 'https://doc-redo-draft.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const address = { kind: 'discussion' as const, discussionId: 'thread-1' };
        const passage = captureDocPassageV1({ ref: { kind: 'doc', serverId, artifactId: 'notes' },
            revision: { headerVersion: 1, bodyVersion: 1 }, source: 'Old basis.', range: { start: 0, end: 10 } });
        writeDiscussionSessionDraft({ scope, address, patch: { text: retainedText, passage,
            replyTarget: { kind: 'message', messageId: 'unrelated-parent' } } });
        const draft = await renderHook(() => useDiscussionDraft({ scope, address }));
        const observed: unknown[] = [];
        const { subscribeSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const unsubscribe = subscribeSessionDraft(scope, address, () => observed.push(getSessionDraftSnapshot(scope, address)?.document));
        await act(async () => { createArtifactActionsClient(scope).beginProposalReply({ proposalRef: { kind: 'discussion',
            discussion: { serverId, discussionId: address.discussionId }, messageId: 'exact-proposal' }, text: 'Please redo this proposal.', mentions: [] }); });
        expect(draft.getCurrent()).toMatchObject({ text: retainedText || 'Please redo this proposal.',
            replyTarget: { kind: 'message', messageId: 'exact-proposal' }, passage: null });
        expect(observed).toHaveLength(1);
        unsubscribe();
        await draft.unmount();
    });
    it('refuses initial participants at the Doc-comment delegation before writing and preserves participant-free comments', async () => {
        const serverId = await homes.addHome({ name: 'Saved Doc', serverUrl: 'https://doc-comment-audience.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const artifacts = createArtifactActionsClient(scope);
        const source = 'Review this passage.';
        const created = await artifacts.createArtifact({ header: { kind: 'artifact.legacy', title: 'Notes' }, body: source });
        if (!('ok' in created) || !created.ok) throw new Error('Expected source Doc');
        const doc = await artifacts.readDoc({ ref: { kind: 'doc', serverId, artifactId: created.value.artifactId } });
        if (!doc.ok) throw new Error('Expected readable source Doc');
        const passage = captureDocPassageV1({ ref: doc.value.ref, revision: doc.value.artifact.revision, source,
            range: { start: 0, end: source.length } });
        const network = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        const messageLocalId = 'comment-audience';
        const input = { creationLocalId: deriveDocCommentDiscussionCreationLocalIdV1({ ref: doc.value.ref, localId: messageLocalId }),
            messageLocalId, title: 'Comment', content: { kind: 'doc_passage_comment' as const, passage,
                content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Please review.' }] } } };
        expect(await client.create({ ...input, participants: [{ kind: 'session',
            sessionId: { selector: 'discussion', discussionId: 'reviewers' } }] }))
            .toEqual({ kind: 'failed', errorCode: 'invalid_parameters' });
        expect(network.messages).toHaveLength(0);
        expect(homes.requestsFor('/v1/discussions').filter(request => request.input && typeof request.input === 'object'
            && 'firstMessage' in request.input)).toHaveLength(0);
        expect(await client.create(input)).toMatchObject({ kind: 'succeeded' });
        expect(network.messages).toHaveLength(1);
    });

    it('rejoins a lost root acknowledgement and reopens that same qualified passage from Doc, Discussion and Inbox', async () => {
        const serverId = await homes.addHome({ name: 'Saved Doc', serverUrl: 'https://doc-comments.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const artifacts = createArtifactActionsClient(scope);
        const source = 'Repeated passage.\n\nRepeated passage.';
        const created = await artifacts.createArtifact({ header: { kind: 'artifact.legacy', title: 'Notes' }, body: source });
        if (!('ok' in created) || !created.ok) throw new Error(`Artifact create failed: ${JSON.stringify(created)}`);
        const doc = await artifacts.readDoc({ ref: { kind: 'doc', serverId, artifactId: created.value.artifactId } });
        if (!doc.ok) throw new Error(`Doc read failed: ${JSON.stringify(doc)}`);
        const passage = captureDocPassageV1({ ref: doc.value.ref, revision: doc.value.artifact.revision, source,
            range: { start: source.lastIndexOf('Repeated'), end: source.length } });
        const network = answerDiscussionThreadForTests(homes, serverId);
        // Changing the selected Home after capture cannot redirect this repository or its Action.
        await homes.addHome({ name: 'Other', serverUrl: 'https://other-doc-comments.test', accountId: 'other', currentAccount: true });
        const client = createDiscussionClient({ scope, availability: 'available' });
        let repository = createDiscussionRepository({ scope, address: { serverId }, client });
        const localId = 'retained-comment';
        const creationLocalId = deriveDocCommentDiscussionCreationLocalIdV1({ ref: doc.value.ref, localId });
        expect(() => artifacts.beginPassageComment({ ...passage, ref: { ...passage.ref, serverId: 'other-home' } }))
            .toThrow('exact captured Home');
        expect(getSessionDraftSnapshot(scope, { kind: 'newDiscussion' })).toBeNull();
        const newRoute = new URL(artifacts.beginPassageComment(passage), 'https://home.invalid');
        const draftId = readDiscussionRouteDraftId(newRoute.searchParams.get('draftId') ?? undefined);
        if (!draftId) throw new Error('Expected qualified passage draft');
        const draftAddress = { kind: 'newDiscussion' as const, draftId };
        expect(newRoute.searchParams.get('serverId')).toBe(serverId);
        let draft = await renderHook(() => useDiscussionDraft({ scope, address: draftAddress }));
        const quote = await renderScreen(createElement(ArtifactPassageQuote, { testID: 'c5-passage-preview', passage: draft.getCurrent().passage }));
        expect(quote.findByTestId('c5-passage-preview.text')?.props.children).toBe(passage.quote);
        await act(async () => { draft.getCurrent().setComposer({ text: 'Please review the second passage.', mentions: [] }); });
        const content = draft.getCurrent().prepareContent({ v: 1, parts: [{ t: 'text', text: 'Please review the second passage.' }] });
        let submission: DiscussionDraftSubmission | undefined;
        await act(async () => { submission = draft.getCurrent().captureSubmittedCurrentness({ kind: 'create', creationLocalId,
            messageLocalId: localId }, { content, title: 'Document comments' }); });
        const intent = { creationLocalId, messageLocalId: localId, title: 'Document comments', content,
            draftSubmission: submission! };
        expect(await repository.create(intent)).toEqual({ kind: 'checking' });
        await vi.waitFor(() => expect(repository.getSnapshot().mutations[creationLocalId]?.status).toBe('outcome_unknown'));
        await act(async () => { draft.getCurrent().setText('Newer unfinished question');
            draft.getCurrent().setPassage({ ...passage, ref: { ...passage.ref, artifactId: 'different-doc' } }); });
        await draft.unmount();
        draft = await renderHook(() => useDiscussionDraft({ scope, address: draftAddress }));
        const frozen = draft.getCurrent().submitted;
        expect(frozen).toMatchObject({ attemptLocalId: creationLocalId, content });
        if (!frozen) throw new Error('Expected original submitted content');
        repository = createDiscussionRepository({ scope, address: { serverId }, client });
        repository.adoptPendingIntent({ kind: 'create', ...intent, title: frozen.title!, content: frozen.content });
        await vi.waitFor(() => expect(repository.getSnapshot().mutations[creationLocalId]?.status,
            JSON.stringify({ committedRoot: network.messages[0]?.id, requests: homes.requests.map(row => row.path) })).toBe('observed_success'));
        expect(network.stored()?.discussion.creationLocalId).toBe(creationLocalId);
        expect(network.stored()?.discussion.anchor).toEqual({ kind: 'doc', doc: { ref: doc.value.ref, revision: passage.revision } });
        expect(network.messages).toHaveLength(1);
        await act(async () => { await draft.getCurrent().clearAfterObservedSuccess(submission!); });
        expect(draft.getCurrent().text).toBe('Newer unfinished question');
        const root = repository.getSnapshot().threads['committed-thread']?.messages[0];
        expect(root?.content).toEqual(content);
        expect(root?.replyTarget).toEqual({ kind: 'doc_passage', doc: { ref: doc.value.ref, revision: passage.revision } });
        if (!root) throw new Error('Expected reconciled committed root');
        const ref = root.messageRef;
        const route = buildDiscussionRouteHref({ target: { kind: 'discussion', address: ref.discussion,
            discussionId: ref.discussion.discussionId, messageId: ref.messageId } });
        const focus = { kind: 'discussion' as const, serverId: ref.discussion.serverId, id: ref.discussion.discussionId, messageId: ref.messageId };
        expect(resolveInboxItemPageRoute(readInboxItemFocus(createInboxItemRoute(focus).params.item)!)).toBe(route);
        const reopened = createDiscussionRepository({ scope, address: { serverId }, client });
        expect(await reopened.openMessage(ref)).toMatchObject({ messageRef: ref });
        expect(reopened.getSnapshot().threads[ref.discussion.discussionId]?.messages[0]?.messageRef).toEqual(ref);
        expect(DiscussionMessageContentV1StoredSchema.parse(reopened.getSnapshot().threads[ref.discussion.discussionId]?.messages[0]?.content)).toEqual(content);
        await reopened.post({ discussionId: ref.discussion.discussionId, localId: 'reply', content,
            replyTarget: { kind: 'message', messageId: ref.messageId }, draftSubmission: intent.draftSubmission });
        expect(network.messages[1]?.replyTarget).toEqual({ kind: 'message', messageId: ref.messageId });
        expect(network.messages[1]?.content).toEqual({ t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Please review the second passage.' }] } });
        network.deny();
        await reopened.refreshDiscussion(ref.discussion.discussionId);
        expect(JSON.stringify(reopened.getSnapshot())).not.toContain(passage.quote);
        expect(homes.requestsFor('/v1/discussions').every(request => request.serverId === serverId)).toBe(true);
        await draft.unmount();
    });

    it.each(['denied', 'unavailable'] as const)('refuses a %s source without returning a committed payload or its quote', async state => {
        const serverId = await homes.addHome({ name: 'Unavailable', serverUrl: `https://${state}-doc.test`, accountId: 'alice', currentAccount: true });
        const status = state === 'denied' ? 404 : 503;
        homes.answer(serverId, '/v1/artifacts/missing', { status, body: { error: state === 'denied' ? 'not_found' : 'unavailable' } });
        homes.answer(serverId, 'POST /v1/discussions', { status: 409, body: { error: 'discussion_content_unavailable' } });
        const client = createArtifactActionsClient({ serverId, accountId: 'alice' });
        const target = captureDocPassageV1({ ref: { kind: 'doc', artifactId: 'missing', serverId },
            revision: { headerVersion: 1, bodyVersion: 1 }, source: 'Private retained quote', range: { start: 0, end: 22 } });
        const result = await client.replyToPassage({ target, localId: 'denied-comment', content: { v: 1, parts: [{ t: 'text', text: 'Review' }] } });
        expect(result).toMatchObject({ ok: false, failure: { code: 'discussion_content_unavailable' } });
        expect(JSON.stringify(result)).not.toContain(target.quote);
        expect('value' in result).toBe(false);
    });
});
