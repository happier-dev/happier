import { act, createElement, Fragment, useEffect, useMemo, type ReactElement } from 'react';
import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook, renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { answerDiscussionThreadForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
// Native measurement/recycling is the boundary; the Discussion, shell, row adapter and cards stay real.
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<typeof import('@legendapp/list/react-native')>(), memoizeItems: true }).module;
});
const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
const { publishMountedDiscussionChanges } = await import('@/sync/domains/discussions/discussionChangeWatch');
const { clearDiscussionRepositoryRegistryForTests, readRegisteredDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepositoryRegistry');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { resolveDocPassageThreadsAdmission, useDocPassageThreads } = await import('./useDocPassageThreads');
const { useDocCollaboration } = await import('./useDocCollaboration');
const { ArtifactEditProposal } = await import('./ArtifactEditProposal');
const { ArtifactView } = await import('./ArtifactView');
const { DiscussionDetailsView } = await import('@/components/discussions/DiscussionDetailsView');
const { DiscussionComposer } = await import('@/components/discussions/DiscussionComposer');
const { useDiscussionComposerSnapshot } = await import('@/sync/ops/discussions/useDiscussionRepositorySnapshot');
const { TranscriptListShell } = await import('@/components/sessions/transcript/viewport/shell/TranscriptListShell');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { t } = await import('@/text');
const { createArtifactActionsClient } = await import('./artifactActionsClient');
const { createAccountArtifactStoredEnvelope } = await import('@/sync/domains/artifacts/accountArtifactEnvelope');
const { storage } = await import('@/sync/domains/state/storage');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const syncModule = await import('@/sync/sync');

let previousProfileScope = storage.getState().profileScope;
let previousSettingsScope = storage.getState().settingsScope;
const previousPlatform = Platform.OS;
beforeEach(async () => { previousProfileScope = storage.getState().profileScope; previousSettingsScope = storage.getState().settingsScope; await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => { standardCleanup(); Object.defineProperty(Platform, 'OS', { configurable: true, value: previousPlatform }); storage.setState({ profileScope: previousProfileScope, settingsScope: previousSettingsScope }); clearDiscussionRepositoryRegistryForTests(); resetServerFeaturesClientForTests(); await homes.reset(); });

describe('Doc passage thread demand', () => {
    it('keeps unresolved admission loading and reserves unavailable for settled refusal', () => {
        expect(resolveDocPassageThreadsAdmission({ artifactId: 'doc', credential: 'resolving', collaboration: 'loading' })).toBe('loading');
        expect(resolveDocPassageThreadsAdmission({ artifactId: 'doc', credential: 'bound', collaboration: 'loading' })).toBe('loading');
        expect(resolveDocPassageThreadsAdmission({ artifactId: 'doc', credential: 'unavailable', collaboration: 'loading' })).toBe('unavailable');
        expect(resolveDocPassageThreadsAdmission({ artifactId: 'doc', credential: 'unavailable', collaboration: 'available' })).toBe('unavailable');
        expect(resolveDocPassageThreadsAdmission({ artifactId: 'doc', credential: 'bound', collaboration: 'unavailable' })).toBe('unavailable');
        expect(resolveDocPassageThreadsAdmission({ artifactId: 'doc', credential: 'bound', collaboration: 'available' })).toBe('ready');
    });
    async function mountedDoc(initialThreads: number, options: { unreadableTitle?: boolean } = {}) {
        const serverId = await homes.addHome({ name: 'Subscribed Doc', serverUrl: 'https://subscribed-doc.test', accountId: 'alice', currentAccount: true });
        const features = createRootLayoutFeaturesResponse();
        for (const feature of ['sharing.session', 'sessions.conversations'] as const) tryWriteServerEnabledBitInPlace(features, feature, true);
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        const scope = { serverId, accountId: 'alice' };
        storage.setState({ profileScope: scope });
        const doc = { ref: { kind: 'doc' as const, serverId, artifactId: 'doc-a' }, revision: { headerVersion: 1, bodyVersion: 1 } };
        const envelope = await createAccountArtifactStoredEnvelope({ mode: 'plain', header: { kind: 'artifact.legacy', title: 'Review' }, body: { body: 'Before' } });
        if (!envelope) throw new Error('Expected the real Plain Artifact codec');
        homes.artifacts(serverId).replaceStoredRow({ ...envelope, id: 'doc-a', encryptionMode: 'plain', ownerAccountId: 'alice', access: 'owner',
            publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        const network = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        expect((await client.create({ title: 'Review', creationLocalId: 'remote-review', messageLocalId: 'remote-proposal',
            anchor: { kind: 'doc', doc }, replyTarget: { kind: 'doc_passage', doc }, content: { kind: 'doc_edit_proposal', proposal: {
                target: { ...doc, range: { start: 0, end: 6 }, quote: 'Before' }, baseRevision: doc.revision,
                before: 'Before', after: 'After', reason: 'Review' } } })).kind).toBe('succeeded');
        const stored = network.stored()!;
        const second = { ...stored, discussion: { ...stored.discussion, id: 'remote-thread', creationLocalId: 'remote-second',
            latestMessage: { ...stored.discussion.latestMessage, id: 'remote-root' } },
            firstMessage: { ...stored.firstMessage, id: 'remote-root', discussionId: 'remote-thread', localId: 'remote-second-root' } };
        const entries = [stored, second].slice(0, initialThreads);
        let refused = false;
        homes.answer(serverId, 'GET /v1/discussions', { select: (_input, request) => {
            const url = new URL(request.url);
            return { body: { discussions: entries.filter(entry => (url.searchParams.get('state') === 'archived') === (entry.discussion.archivedAt !== null))
                .filter(entry => !url.searchParams.has('anchorDocArtifactId') || (entry.discussion.anchor?.kind === 'doc'
                    && entry.discussion.anchor.doc.ref.artifactId === url.searchParams.get('anchorDocArtifactId')))
                .map(entry => ({ ...entry.discussion, ...(options.unreadableTitle ? { titleContent: { t: 'plain', v: { invalidTitle: true } } } : {}), ...(url.searchParams.has('anchorDocArtifactId')
                    ? { firstMessage: refused ? null : entry.firstMessage } : {}) })), nextCursor: null } };
        } });
        for (const entry of [stored, second]) {
            homes.answer(serverId, `/v1/discussions/${entry.discussion.id}`, { select: () => refused
                ? { status: 409, body: { error: 'discussion_content_unavailable' } }
                : { body: { discussion: (entries.find(current => current.discussion.id === entry.discussion.id) ?? entry).discussion } } });
            homes.answer(serverId, `GET /v1/discussions/${entry.discussion.id}/messages`, { select: () => refused
                ? { status: 409, body: { error: 'discussion_content_unavailable' } }
                : { body: { messages: entry.discussion.id === stored.discussion.id ? network.messages : [entry.firstMessage], hasMoreOlder: false,
                    messageSeq: entry.discussion.id === stored.discussion.id ? network.messages.length : 1 } } });
        }
        const artifact = { id: 'doc-a', header: { kind: 'markdown', title: 'Review' }, title: 'Review', body: 'Before', isDecrypted: true as const,
            ...doc.revision, seq: 1, createdAt: 1, updatedAt: 1, ownerAccountId: 'alice', access: 'owner' as const,
            storageMode: 'plain' as const, publicAudience: 'none' as const };
        const hook = await renderHook(() => useDocCollaboration(artifact, true));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.openCommentCount).toBe(initialThreads));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.threads).toHaveLength(initialThreads));
        return { scope, hook, artifact, entries, second, network, client, refuse: (docToo = true) => {
            refused = true;
            if (docToo) homes.answer(serverId, 'GET /v1/artifacts/doc-a', { status: 409, body: { error: 'artifact_content_unavailable' } });
        } };
    }

    it('keeps this Doc read and projection idle for unrelated threads, while its root, replies and disposition remain live', async () => {
        const { scope, entries, second, network, client } = await mountedDoc(1);
        let renders = 0;
        let projections = 0;
        const probe = await renderHook(() => {
            renders += 1;
            const read = useDocPassageThreads({ serverId: scope.serverId, artifactId: 'doc-a' });
            const projection = useMemo(() => { projections += 1; return read.threads.map(thread => thread.messages); }, [read]);
            return { read, projection };
        });
        await waitForHomeGovernance(() => expect(probe.getCurrent().read.status).toBe('ready'));
        const repository = readRegisteredDiscussionRepository(scope, { serverId: scope.serverId })!;
        let composerRenders = 0;
        const composerProbe = await renderHook(() => {
            composerRenders += 1;
            return useDiscussionComposerSnapshot(repository, 'committed-thread');
        });
        const unrelated = { ...entries[0]!.discussion, id: 'unrelated-thread', anchor: null };
        homes.answer(scope.serverId, '/v1/discussions/unrelated-thread', { body: { discussion: unrelated } });
        homes.answer(scope.serverId, 'GET /v1/discussions/unrelated-thread/messages', { body: { messages: [], hasMoreOlder: false, messageSeq: 0 } });
        const before = { value: probe.getCurrent(), renders, projections, composer: composerProbe.getCurrent(), composerRenders };
        await act(async () => { await repository.refreshDiscussion('unrelated-thread'); });
        expect.soft(probe.getCurrent().read).toBe(before.value.read);
        expect.soft(probe.getCurrent().projection).toBe(before.value.projection);
        expect.soft(renders).toBe(before.renders);
        expect.soft(projections).toBe(before.projections);
        expect.soft(composerProbe.getCurrent()).toBe(before.composer);
        expect.soft(composerRenders).toBe(before.composerRenders);

        entries.push(second);
        await act(async () => { await repository.refreshDocList('doc-a'); });
        expect(probe.getCurrent().read).not.toBe(before.value.read);
        expect(probe.getCurrent().read.threads[1]?.messages[0]?.id).toBe('remote-root');
        const afterRoot = probe.getCurrent().read;
        await client.post({ discussionId: 'committed-thread', localId: 'local-reply', content: { v: 1, parts: [{ t: 'text', text: 'New reply' }] } });
        await act(async () => { await repository.refreshDiscussion('committed-thread'); });
        expect(probe.getCurrent().read).not.toBe(afterRoot);
        expect(JSON.stringify(probe.getCurrent().read)).toContain('New reply');
        expect(composerProbe.getCurrent()).not.toBe(before.composer);
        expect(composerProbe.getCurrent().thread?.messages.at(-1)?.localId).toBe('local-reply');
        const afterReply = probe.getCurrent().read;
        network.messages[0] = { ...network.messages[0]!, docEditProposalDispositionV1: { state: 'declined', decidedBy: { accountId: 'alice', atMs: 20 } } };
        entries[0]!.firstMessage = network.messages[0]!;
        await act(async () => { await repository.refreshDocList('doc-a'); });
        expect(probe.getCurrent().read).not.toBe(afterReply);
        expect(probe.getCurrent().read.threads[0]?.messages[0]?.docEditProposalDispositionV1?.state).toBe('declined');
    });

    it('updates membership and the admitted count after remote create/archive and admitted root withdrawal', async () => {
        const { scope, hook, entries, second, refuse } = await mountedDoc(1);
        entries.push(second);
        await act(async () => publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: 'remote-thread', changedAt: 2 }] }));
        await waitForTestEvent(hook.subscribe, () => {
            expect(hook.getCurrent()?.threads).toHaveLength(2);
            expect(hook.getCurrent()?.openCommentCount).toBe(2);
        });
        entries[0] = { ...entries[0]!, discussion: { ...entries[0]!.discussion, archivedAt: 3 } };
        await act(async () => publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 2, kind: 'discussion', entityId: 'committed-thread', changedAt: 3 }] }));
        await waitForTestEvent(hook.subscribe, () => {
            expect(hook.getCurrent()?.threads.map(thread => thread.id)).toEqual(['remote-thread']);
            expect(hook.getCurrent()?.openCommentCount).toBe(1);
        });
        refuse();
        await act(async () => publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 3, kind: 'artifact', entityId: 'doc-a', changedAt: 4 }] }));
        await waitForTestEvent(hook.subscribe, () => {
            expect(hook.getCurrent()?.openCommentCount).toBe(0);
            expect(hook.getCurrent()?.threads).toHaveLength(0);
        });
    });

    it('does not hydrate closed-margin threads or repeat the Doc count enumeration for each mounted proposal card', async () => {
        const { hook } = await mountedDoc(2);
        expect.soft(homes.requests.filter(request => /\/v1\/discussions\/[^/]+\/messages/.test(request.path))).toHaveLength(0);
        const artifactReads = () => homes.requests.filter(request => request.path === '/v1/artifacts/doc-a');
        const beforeCards = artifactReads().length;
        const countPages = () => homes.requests.filter(request => request.path.includes('anchorDocArtifactId=doc-a'));
        expect(countPages()).toHaveLength(1);
        const screen = await renderScreen(createElement(Fragment, null,
            ...hook.getCurrent()!.threads.map(thread => hook.getCurrent()!.margin.renderCard(thread.id))));
        await waitForHomeGovernance(() => expect(screen.findByTestId('artifact:passage-thread:remote-thread.proposal.current')).not.toBeNull());
        expect(artifactReads()).toHaveLength(beforeCards);
        expect(countPages()).toHaveLength(1);
        // A shown card acquires its replies once; it reuses the parent Doc admission and census.
        expect(homes.requests.filter(request => /\/v1\/discussions\/[^/]+\/messages/.test(request.path))).toHaveLength(2);
    });

    it('opens the shared reply composer only for the selected margin card and posts into that thread', async () => {
        const { artifact, scope, network } = await mountedDoc(1);
        function Margin() {
            const current = useDocCollaboration(artifact, true);
            return createElement(Fragment, null, current?.margin.renderCard('committed-thread'));
        }
        const screen = await renderScreen(createElement(Margin));
        expect(screen.findAllByType(DiscussionComposer)).toHaveLength(0);
        await act(async () => screen.findByTestId('artifact:passage-thread:committed-thread.focus')!.props.onPress());
        await waitForHomeGovernance(() => expect(screen.findAllByType(DiscussionComposer)).toHaveLength(1));
        const composer = () => screen.findAllByType(DiscussionComposer)[0]!;
        expect(composer().props.disabled).toBe(false);
        await act(async () => composer().props.onChange({ text: 'The margin reply.', mentions: [] }));
        expect(composer().props.disabled).toBe(false);
        await act(async () => composer().props.onSend({ v: 1, parts: [{ t: 'text', text: 'The margin reply.' }] }));
        await waitForHomeGovernance(() => expect(network.messages).toHaveLength(2));
        expect(network.messages[1]!.discussionId).toBe('committed-thread');
        await waitForHomeGovernance(() => expect(composer().props.value.text).toBe(''));
        expect(composer().props.disabled).toBe(false);
        expect(homes.requests.filter(request => request.serverId === scope.serverId && request.method === 'POST'
            && request.path === '/v1/discussions/committed-thread/messages')).toHaveLength(1);
    });

    it('shows the latest committed reply body beside its passage after remounting the Doc', async () => {
        const { artifact, client, network, hook } = await mountedDoc(1);
        for (let seq = 2; seq <= 4; seq += 1) {
            await client.post({ discussionId: 'committed-thread', localId: `retry-${seq}`,
                content: { v: 1, parts: [{ t: 'text', text: `Committed reply ${seq}` }] } });
        }
        function Margin() {
            const current = useDocCollaboration(artifact, true);
            return createElement(Fragment, null, current?.margin.renderCard('committed-thread'));
        }
        await hook.unmount();
        for (let mount = 0; mount < 2; mount += 1) {
            clearDiscussionRepositoryRegistryForTests();
            const screen = await renderScreen(createElement(Margin));
            const latestId = network.messages[3]!.id;
            await waitForHomeGovernance(() => expect(screen.findByTestId(`session-discussion-message-content-${latestId}`)).not.toBeNull());
            expect(screen.getTextContent()).toContain('Committed reply 4');
            expect(screen.getTextContent()).not.toContain('Committed reply 3');
            expect(screen.findByTestId('artifact:passage-thread:committed-thread.reply')).not.toBeNull();
            await screen.unmount();
        }
    });

    it('shows a held Discussion draft beside its Doc passage and withdraws it when the canonical approval settles', async () => {
        const { artifact, scope } = await mountedDoc(1);
        function Margin() {
            const current = useDocCollaboration(artifact, true);
            useEffect(() => current?.margin.reportShown?.(true), [current?.margin.reportShown]);
            return createElement(Fragment, null, current?.margin.renderCard('committed-thread'));
        }
        const screen = await renderScreen(createElement(Margin));
        const actionArgs = { discussionId: 'committed-thread', localId: 'draft-local',
            content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'The held margin answer.' }] },
            replyTarget: { kind: 'message' as const, messageId: 'committed-root' } };
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'drafter' }, requestedSurface: 'agent', actionId: 'discussion.reply',
            actionArgs, discussionDraftReview: true, summary: 'Review answer',
            executionOriginV1: buildApprovalExecutionOriginV1({ actionId: 'discussion.reply', input: actionArgs,
                targetSessionId: null, context: { surface: 'agent', authority: 'account_automation', serverId: scope.serverId,
                    serverIdentityId: scope.serverId, runtimeAccountId: scope.accountId, actionCaller: { kind: 'host' },
                    defaultSessionId: 'drafter', defaultSessionMachineId: 'machine', actionRequestId: actionArgs.localId,
                    discussionReplyReturn: { serverId: scope.serverId, requestLocalId: 'original-input', acceptedTurnId: 'turn' } } }) });
        const approval: DecryptedArtifact = { id: 'held-draft', title: request.summary ?? null,
            header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request), isDecrypted: true,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        await act(async () => storage.getState().applyArtifacts([approval]));
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-discussion-waiting-approval')).not.toBeNull());
        const settled = ApprovalRequestV2Schema.parse({ ...request, status: 'rejected', updatedAtMs: 2, decision: { kind: 'reject', decidedAtMs: 2 } });
        await act(async () => storage.getState().applyArtifacts([{ ...approval, headerVersion: 2, bodyVersion: 2,
            header: buildApprovalRequestArtifactHeaderV1(settled), body: JSON.stringify(settled) }]));
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-discussion-waiting-approval')).toBeNull());
    });

    it.each([false, true])('shares each shown Discussion proposal Doc read without mixing neighboring Docs, and refreshes revision and refused access (other Home focused: %s)', async (otherHomeFocused) => {
        const { scope, client, hook } = await mountedDoc(1);
        const repository = readRegisteredDiscussionRepository(scope, { serverId: scope.serverId })!;
        const root = repository.getSnapshot().threads['committed-thread']!.messages[0]!;
        if (!root.content || !('kind' in root.content) || root.content.kind !== 'doc_edit_proposal') throw new Error('Expected proposal');
        const proposal = root.content.proposal;
        await hook.unmount();
        expect((await client.post({ discussionId: 'committed-thread', localId: 'same-doc-proposal', content: root.content })).kind).toBe('succeeded');
        const stored = homes.artifacts(scope.serverId).read('doc-a')!;
        homes.artifacts(scope.serverId).replaceStoredRow({ ...stored, id: 'doc-b' });
        expect((await client.post({ discussionId: 'committed-thread', localId: 'other-doc-proposal', content: { kind: 'doc_edit_proposal',
            proposal: { ...proposal, target: { ...proposal.target, ref: { ...proposal.target.ref, artifactId: 'doc-b' } } } } })).kind).toBe('succeeded');
        const focusedScope = otherHomeFocused
            ? { serverId: await homes.addHome({ name: 'Another focused Home', serverUrl: 'https://other-discussion-home.test', accountId: 'brenda', currentAccount: true }), accountId: 'brenda' }
            : scope;
        await homes.selectHomes([focusedScope.serverId]);
        storage.setState(state => ({ profileScope: focusedScope, settingsScope: focusedScope,
            artifacts: Object.fromEntries(Object.entries(state.artifacts).filter(([id]) => id !== 'doc-a' && id !== 'doc-b')) }));
        const reads = (id: string) => homes.requests.filter(request => request.path === `/v1/artifacts/${id}`).length;
        const pages = (id: string) => homes.requests.filter(request => request.path.includes(`anchorDocArtifactId=${id}`)).length;
        const before = { a: reads('doc-a'), b: reads('doc-b'), countA: pages('doc-a'), countB: pages('doc-b') };
        const screen = await renderScreen(createElement(AppPaneProvider, null, createElement(DiscussionDetailsView, { target: { kind: 'discussion',
            address: { serverId: scope.serverId }, discussionId: 'committed-thread' }, active: true, standaloneSurface: true })));
        await waitForHomeGovernance(() => expect(screen.findAllByType(ArtifactEditProposal)).toHaveLength(3));
        expect.soft(reads('doc-a') - before.a).toBe(0);
        expect.soft(reads('doc-b') - before.b).toBe(0);
        const shell = screen.findAllByType(TranscriptListShell)[0]!;
        const visible = shell.props.data.filter((item: { kind: string }) => item.kind === 'human_message')
            .map((item: unknown) => ({ isViewable: true, item }));
        await act(async () => shell.props.onViewableItemsChanged({ viewableItems: visible.slice(0, 2) }));
        await waitForHomeGovernance(() => {
            expect(screen.findByTestId('discussion-proposal-committed-root.current')).not.toBeNull();
            expect(screen.findByTestId('discussion-proposal-committed-2.current')).not.toBeNull();
        });
        expect.soft(reads('doc-b') - before.b).toBe(0);
        await act(async () => shell.props.onViewableItemsChanged({ viewableItems: visible }));
        await waitForHomeGovernance(() => {
            expect(screen.findByTestId('discussion-proposal-committed-3.current')).not.toBeNull();
        });
        expect.soft(reads('doc-a') - before.a).toBe(1);
        expect.soft(reads('doc-b') - before.b).toBe(1);
        expect.soft(pages('doc-a') - before.countA).toBe(1);
        expect.soft(pages('doc-b') - before.countB).toBe(1);

        homes.artifacts(scope.serverId).replaceStoredRow({ ...stored, bodyVersion: 2, updatedAt: 2 });
        await act(async () => publishHomeAccountChange(scope.serverId, ['doc-a'], { changeKinds: ['artifact'] }));
        await waitForHomeGovernance(() => {
            expect(screen.findByTestId('discussion-proposal-committed-root.movedOn')).not.toBeNull();
            expect(screen.findByTestId('discussion-proposal-committed-2.movedOn')).not.toBeNull();
        });
        expect.soft(reads('doc-a') - before.a).toBe(2);
        expect.soft(reads('doc-b') - before.b).toBe(1);
        expect(screen.findByTestId('discussion-proposal-committed-3.current')).not.toBeNull();
        homes.answer(scope.serverId, 'GET /v1/artifacts/doc-a', { status: 403, body: { error: 'artifact_access_forbidden' } });
        await act(async () => publishHomeAccountChange(scope.serverId, ['doc-a'], { changeKinds: ['artifact'] }));
        await waitForHomeGovernance(() => {
            const refused = screen.findAllByType(ArtifactEditProposal).filter(node => node.props.proposal.target.ref.artifactId === 'doc-a');
            expect(refused.map(node => node.props.docRead?.status)).toEqual(['unavailable', 'unavailable']);
            expect(screen.findByTestId('discussion-proposal-committed-root.movedOn')).toBeNull();
            expect(screen.findByTestId('discussion-proposal-committed-2.movedOn')).toBeNull();
            expect(reads('doc-a') - before.a).toBe(3);
        });
        expect(screen.findByTestId('discussion-proposal-committed-3.current')).not.toBeNull();
        expect(homes.requests.filter(request => /^\/v1\/artifacts\/doc-[ab]$/.test(request.path))
            .every(request => request.serverId === scope.serverId)).toBe(true);
        // An already-dispatched read belongs to the credential lifetime that admitted it.
        const late = createDeferred<void>();
        const entered = createDeferred<void>();
        homes.answer(scope.serverId, 'GET /v1/artifacts/doc-a', { select: () => {
            entered.resolve();
            return { respondAfter: late.promise, body: stored };
        } });
        await act(async () => publishHomeAccountChange(scope.serverId, ['doc-a'], { changeKinds: ['artifact'] }));
        await entered.promise;
        homes.answer(scope.serverId, '/v1/discussions/committed-thread', { status: 403, body: { error: 'discussion_access_forbidden' } });
        homes.answer(scope.serverId, 'GET /v1/discussions', { status: 403, body: { error: 'discussion_access_forbidden' } });
        await act(async () => { await homes.switchAccount(scope.serverId, 'bob', { currentAccount: true }); late.resolve(); });
        await waitForHomeGovernance(() => expect(screen.findAllByType(ArtifactEditProposal)).toHaveLength(0));
        expect(screen.findByTestId('discussion-proposal-committed-root.current')).toBeNull();
    });

    it('retains readable Doc roots and the canonical count when only the thread title is unavailable', async () => {
        const { hook } = await mountedDoc(1, { unreadableTitle: true });
        expect(hook.getCurrent()?.threads).toHaveLength(1);
        expect(hook.getCurrent()?.openCommentCount).toBe(1);
    });

    it('establishes admitted zero after scoped discovery excludes an exactly refused root', async () => {
        const { scope, hook, refuse } = await mountedDoc(1);
        refuse(false);
        await act(async () => publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: 'committed-thread', changedAt: 2 }] }));
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent()?.openCommentCount).toBeNull();
            expect(hook.getCurrent()?.threads).toHaveLength(0);
        });
        // Exact denial proves withdrawal, not the complete Doc-scoped corpus.
        // Its authoritative null-root discovery can separately prove zero.
        await act(async () => publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 2, kind: 'artifact', entityId: 'doc-a', changedAt: 3 }] }));
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent()?.openCommentCount).toBe(0);
            expect(hook.getCurrent()?.threads).toHaveLength(0);
        });
    });

    it('keeps a successful empty Doc read distinct from loading and a failed read', async () => {
        const { scope, hook: seeded, artifact } = await mountedDoc(0);
        await seeded.unmount();
        clearDiscussionRepositoryRegistryForTests();
        const pending = createDeferred<void>();
        const entered = createDeferred<void>();
        homes.answer(scope.serverId, 'GET /v1/discussions', { select: () => {
            entered.resolve();
            return { respondAfter: pending.promise, body: { discussions: [], nextCursor: null } };
        } });

        const empty = await renderHook(
            ({ value }: { value: typeof artifact }) => useDocCollaboration(value, true),
            { initialProps: { value: artifact } },
        );
        await entered.promise;
        expect(empty.getCurrent()?.commentCountStatus).toBe('loading');
        expect(empty.getCurrent()?.openCommentCount).toBeNull();
        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => {
            expect(empty.getCurrent()?.commentCountStatus).toBe('ready');
            expect(empty.getCurrent()?.openCommentCount).toBe(0);
            expect(empty.getCurrent()?.threads).toEqual([]);
        });
        homes.answer(scope.serverId, 'GET /v1/discussions', { status: 403, body: { error: 'discussion_access_forbidden' } });
        await act(async () => publishMountedDiscussionChanges({ ...scope,
            changes: [{ cursor: 1, kind: 'artifact', entityId: artifact.id, changedAt: 2 }] }));
        await waitForHomeGovernance(() => expect(empty.getCurrent()?.commentCountStatus).toBe('unavailable'));
        expect(empty.getCurrent()?.openCommentCount).toBeNull();
        await empty.unmount();
    });

    it('does not restart settled Doc membership when the parallel body first arrives, but consumes real Doc changes', async () => {
        const { scope, hook: seeded, artifact } = await mountedDoc(0);
        await seeded.unmount();
        clearDiscussionRepositoryRegistryForTests();
        homes.answer(scope.serverId, 'GET /v1/discussions', { status: 503, body: { error: 'server_error' } });
        const count = () => homes.requests.filter(request => request.path.includes('anchorDocArtifactId=doc-a')).length;
        const hook = await renderHook<ReturnType<typeof useDocCollaboration>, { value: DecryptedArtifact }>(({ value }) => useDocCollaboration(value, true), {
            initialProps: { value: { ...artifact, body: undefined, bodyVersion: undefined } },
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.commentCountStatus).toBe('unavailable'));
        const settledReads = count();
        const held = createDeferred<void>();
        homes.answer(scope.serverId, 'GET /v1/discussions', { select: () => ({ respondAfter: held.promise,
            body: { discussions: [], nextCursor: null } }) });
        try {
            await hook.rerender({ value: artifact });
            expect.soft(hook.getCurrent()?.commentCountStatus).toBe('unavailable');
            expect.soft(count()).toBe(settledReads);
        } finally {
            await act(async () => held.resolve());
        }
        // A real source change still refreshes the one membership owner and reaches its consumer.
        homes.answer(scope.serverId, 'GET /v1/discussions', { body: { discussions: [], nextCursor: null } });
        await act(async () => publishMountedDiscussionChanges({ ...scope,
            changes: [{ cursor: 1, kind: 'artifact', entityId: artifact.id, changedAt: 2 }] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.commentCountStatus).toBe('ready'));
        expect(hook.getCurrent()?.openCommentCount).toBe(0);
        expect(count()).toBe(settledReads + 1);
    });

    it('reads audience only when its identity or sharing facts change, while content revisions stay live', async () => {
        const { scope, hook: seeded, artifact } = await mountedDoc(0);
        await seeded.unmount();
        const hook = await renderHook<ReturnType<typeof useDocCollaboration>, { value: DecryptedArtifact }>(({ value }) => useDocCollaboration(value, true), {
            initialProps: { value: artifact },
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.audience?.shared).toBe(false));
        const grantReads = () => homes.requests.filter(request => request.path.startsWith('/v1/artifacts/doc-a/')
            && request.path.includes('grants')).length;
        const before = grantReads();
        expect(before).toBeGreaterThan(0);
        for (let revision = 2; revision <= 4; revision += 1) {
            await hook.rerender({ value: { ...artifact, body: `Revision ${revision}`, bodyVersion: revision } });
        }
        expect(grantReads()).toBe(before);
        await hook.rerender({ value: { ...artifact, body: 'Revision 4', bodyVersion: 4, publicAudience: 'retained' } });
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.audience?.publicLink).toBe(true));
        expect(grantReads()).toBe(before + 1);
        await hook.unmount();
    });

    it('keeps an empty markdown Doc and its existing threads admitted after deleting all prose', async () => {
        const { scope, hook: seeded, artifact } = await mountedDoc(1);
        await seeded.unmount();
        const hook = await renderHook<ReturnType<typeof useDocCollaboration>, { value: DecryptedArtifact }>(({ value }) => useDocCollaboration(value, true), {
            initialProps: { value: artifact },
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.openCommentCount).toBe(1));
        const emptyArtifact = { ...artifact, body: '', bodyVersion: 2 };
        const envelope = await createAccountArtifactStoredEnvelope({ mode: 'plain',
            header: { kind: 'artifact.legacy', title: 'Review' }, body: { body: '' } });
        if (!envelope) throw new Error('Expected the real Plain Artifact codec');
        const stored = homes.artifacts(scope.serverId).read(artifact.id)!;
        homes.artifacts(scope.serverId).replaceStoredRow({ ...stored, ...envelope, bodyVersion: 2 });
        await hook.rerender({ value: emptyArtifact });
        expect.soft(hook.getCurrent()?.openCommentCount).toBe(1);
        expect.soft(hook.getCurrent()?.threads[0]?.id).toBe('committed-thread');
        expect.soft(hook.getCurrent()?.margin.passages[0]?.location.state).toBe('detached');
        const { ArtifactPassageSelection } = await import('./ArtifactPassageSelection');
        const screen = await renderScreen(createElement(ArtifactView, {
            artifactId: artifact.id, artifact: emptyArtifact, presentation: 'page',
        }));
        await waitForHomeGovernance(() => expect(screen.findAllByType(ArtifactPassageSelection)).toHaveLength(1));
        expect(screen.findByType(ArtifactPassageSelection).props.markdown).toBe('');
        expect(screen.findByType(ArtifactPassageSelection).props.margin.passages[0]?.location.state).toBe('detached');
        expect(screen.getTextContent()).toContain(t('artifacts.noContent'));
    });

    it('starts the empty Doc thread list beside the held body read and publishes ready-zero first', async () => {
        const { scope, hook: seeded, artifact } = await mountedDoc(0);
        await seeded.unmount();
        clearDiscussionRepositoryRegistryForTests();
        const parallelArtifactId = 'parallel-doc';
        const stored = homes.artifacts(scope.serverId).read(artifact.id)!;
        homes.artifacts(scope.serverId).replaceStoredRow({ ...stored, id: parallelArtifactId });
        const pending = createDeferred<void>();
        homes.answer(scope.serverId, 'POST /v1/artifacts/read', { select: async input => {
            await pending.promise;
            const response = await homes.artifacts(scope.serverId).handle('/v1/artifacts/read', {
                method: 'POST', body: JSON.stringify(input),
            });
            if (!response) throw new Error('Expected the Artifact read boundary');
            return { body: await response.json() };
        } });
        homes.answer(scope.serverId, `GET /v1/artifacts/${parallelArtifactId}`, { select: async () => {
            await pending.promise;
            const response = await homes.artifacts(scope.serverId).handle(`/v1/artifacts/${parallelArtifactId}`, { method: 'GET' });
            if (!response) throw new Error('Expected the Artifact read boundary');
            return { body: await response.json() };
        } });

        const bodyRead = vi.spyOn(syncModule.sync, 'fetchArtifactForView');
        const screen = await renderScreen(createElement(ArtifactView, {
            artifactId: parallelArtifactId,
            artifact: { ...artifact, id: parallelArtifactId, body: undefined },
            presentation: 'page',
        }));
        const menu = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'artifact:comments.menu');
        const button = () => screen.findAllByType(RoundButton).find(node => node.props.testID === 'artifact:comments');
        await waitForHomeGovernance(() => expect(bodyRead).toHaveBeenCalledWith(parallelArtifactId, expect.objectContaining({ signal: expect.any(AbortSignal) })));
        bodyRead.mockRestore();
        await waitForHomeGovernance(() => expect(homes.requests.filter(request => request.path.includes(`anchorDocArtifactId=${parallelArtifactId}`))).toHaveLength(1));
        await waitForHomeGovernance(() => expect(button()?.props.title).toBe('0'));
        expect(button()?.props.accessibilityLabel).toBe(t('artifacts.browser.passage.count', { count: 0 }));
        expect(menu()).toBeDefined();

        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => expect(button()?.props.title).toBe('0'));
        expect(button()?.props.disabled).toBe(false);
        expect(button()?.props.accessibilityLabel).toBe(t('artifacts.browser.passage.count', { count: 0 }));
        const empty = await renderScreen(menu()?.props.emptyLabel as ReactElement);
        expect(empty.findByTestId('artifact:comments.empty')).not.toBeNull();
        expect(empty.getTextContent()).toContain(t('artifacts.browser.passage.noComments'));
        await empty.unmount();
        await screen.pressByTestIdAsync('artifact:comments');
        await waitForHomeGovernance(() => expect(menu()?.props.open).toBe(true));
        await screen.unmount();
    });

    it('keeps the Doc in its wide column from loading to none, threads and failure, and fills its comments column by state', async () => {
        const { ItemList } = await import('@/components/ui/lists/ItemList');
        const { ArtifactPassageSelection } = await import('./ArtifactPassageSelection');
        const { scope, hook: seeded, artifact } = await mountedDoc(0);
        await seeded.unmount();
        clearDiscussionRepositoryRegistryForTests();
        const pending = createDeferred<void>();
        homes.answer(scope.serverId, 'GET /v1/discussions', { select: () => ({ respondAfter: pending.promise, body: { discussions: [], nextCursor: null } }) });
        const screen = await renderScreen(createElement(ArtifactView, { artifactId: artifact.id, artifact, presentation: 'page' }));
        const column = () => screen.findAllByType(ItemList).find(node => node.props.testID === 'artifact:page')?.props.pageColumn;
        const margin = () => screen.findAllByType(ArtifactPassageSelection)[0]?.props.margin;
        const idle = async () => {
            const node = margin()?.idle;
            if (!node) return [];
            const rendered = await renderScreen(node as ReactElement);
            const ids = ['loading', 'empty', 'unavailable'].filter(id => rendered.findByTestId(`artifact:comments.${id}`) !== null);
            await rendered.unmount();
            return ids;
        };
        await waitForHomeGovernance(() => expect(margin()).toBeDefined());
        expect(column()).toBe('wide');
        expect(await idle()).toEqual(['loading']);

        await act(async () => pending.resolve());
        await waitForHomeGovernance(async () => expect(await idle()).toEqual(['empty']));
        expect(column()).toBe('wide');

        homes.answer(scope.serverId, 'GET /v1/discussions', { status: 403, body: { error: 'discussion_access_forbidden' } });
        await act(async () => publishMountedDiscussionChanges({ ...scope,
            changes: [{ cursor: 1, kind: 'artifact', entityId: artifact.id, changedAt: 2 }] }));
        await waitForHomeGovernance(async () => expect(await idle()).toEqual(['unavailable']));
        expect(column()).toBe('wide');
        await screen.unmount();
    });

    it('keeps the wide column with threads and leaves the column to their cards', async () => {
        const { ItemList } = await import('@/components/ui/lists/ItemList');
        const { ArtifactPassageSelection } = await import('./ArtifactPassageSelection');
        const { artifact } = await mountedDoc(1);
        const screen = await renderScreen(createElement(ArtifactView, { artifactId: artifact.id, artifact, presentation: 'page' }));
        const margin = () => screen.findAllByType(ArtifactPassageSelection)[0]?.props.margin;
        await waitForHomeGovernance(() => expect(margin()?.passages).toHaveLength(1));
        expect(margin()?.idle ?? null).toBeNull();
        expect(screen.findAllByType(ItemList).find(node => node.props.testID === 'artifact:page')?.props.pageColumn).toBe('wide');
        await screen.unmount();
    });

    it('opens the same existing Doc thread menu for an ambiguous native passage tap', async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        const { scope, artifact } = await mountedDoc(2);
        const screen = await renderScreen(createElement(ArtifactView, { artifactId: artifact.id, artifact, presentation: 'page' }));
        const menu = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'artifact:comments.menu')!;
        await waitForHomeGovernance(() => expect(menu()?.props.items).toHaveLength(2));
        const trigger = screen.findAllByType('Pressable').find(node => String(node.props.testID ?? '').startsWith('markdown-source-range-trigger') && !node.props.disabled)!;
        expect(trigger).toBeDefined();
        expect(menu().props.open).toBe(false);
        await act(async () => trigger.props.onPress());
        expect(menu().props.open).toBe(true);
        const stored = homes.artifacts(scope.serverId).read(artifact.id)!;
        homes.artifacts(scope.serverId).replaceStoredRow({ ...stored, id: 'other-doc' });
        await act(async () => screen.update(createElement(ArtifactView, { artifactId: 'other-doc', artifact: { ...artifact, id: 'other-doc' }, presentation: 'page' })));
        expect(menu().props.open).toBe(false);
        await act(async () => screen.update(createElement(ArtifactView, { artifactId: artifact.id, artifact, presentation: 'page' })));
        await waitForHomeGovernance(() => expect(menu().props.items).toHaveLength(2));
        expect(menu().props.open).toBe(false);
    });

    it('does not fall back to per-card reads for loading or unavailable parent admission, while standalone proposals still admit their source', async () => {
        const { scope } = await mountedDoc(1);
        const root = readRegisteredDiscussionRepository(scope, { serverId: scope.serverId })!.getSnapshot().threads['committed-thread']!.messages[0]!;
        if (!root.content || !('kind' in root.content) || root.content.kind !== 'doc_edit_proposal') throw new Error('Expected the opened proposal root');
        const props = { client: createArtifactActionsClient(scope), proposalRef: root.messageRef, proposal: root.content.proposal,
            disposition: root.docEditProposalDispositionV1, viewerAccountId: 'alice', resolveAccountLabel: () => null };
        const sourceReads = () => homes.requests.filter(request => request.path === '/v1/artifacts/doc-a').length;
        const countPages = () => homes.requests.filter(request => request.path.includes('anchorDocArtifactId=doc-a')).length;
        const before = { reads: sourceReads(), pages: countPages() };
        for (const status of ['loading', 'unavailable'] as const) {
            const screen = await renderScreen(createElement(ArtifactEditProposal, { ...props, docRead: { status } }));
            expect(screen.findByTestId('artifact-edit-proposal.current')).toBeNull();
            expect(sourceReads()).toBe(before.reads);
            expect(countPages()).toBe(before.pages);
            await screen.unmount();
        }
        const standalone = await renderScreen(createElement(ArtifactEditProposal, props));
        await waitForHomeGovernance(() => expect(standalone.findByTestId('artifact-edit-proposal.current')).not.toBeNull());
        expect(sourceReads()).toBe(before.reads + 1);
        expect(countPages()).toBe(before.pages + 1);
    });

    it.each([{ rootOutsideTail: false, delayInitial: false, refusal: 'thread' }, { rootOutsideTail: true, delayInitial: false, refusal: 'thread' },
        { rootOutsideTail: true, delayInitial: true, refusal: 'thread' },
        { rootOutsideTail: true, delayInitial: false, refusal: 'list' },
        { rootOutsideTail: true, delayInitial: false, refusal: 'null' }])('reconciles a root proposal without reviving refused source ($rootOutsideTail/$delayInitial/$refusal)', async ({ rootOutsideTail, delayInitial, refusal }) => {
        const serverId = await homes.addHome({ name: 'Doc margin', serverUrl: 'https://doc-margin-changes.test', accountId: 'alice', currentAccount: true });
        const features = createRootLayoutFeaturesResponse();
        for (const feature of ['sharing.session', 'sessions.conversations'] as const) {
            expect(tryWriteServerEnabledBitInPlace(features, feature, true)).toBe(true);
        }
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        const scope = { serverId, accountId: 'alice' };
        const doc = { ref: { kind: 'doc' as const, serverId, artifactId: 'doc-a' }, revision: { headerVersion: 1, bodyVersion: 1 } };
        const network = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        const created = await client.create({ title: 'Review', creationLocalId: 'margin-review', messageLocalId: 'margin-proposal',
            anchor: { kind: 'doc', doc }, content: { kind: 'doc_edit_proposal', proposal: {
                target: { ...doc, range: { start: 0, end: 6 }, quote: 'Before' }, baseRevision: doc.revision,
                before: 'Before', after: 'After', reason: 'Review' } } });
        expect(created.kind).toBe('succeeded');
        await client.post({ discussionId: 'committed-thread', localId: 'later-2', content: { v: 1, parts: [{ t: 'text', text: 'Later reply' }] } });
        await client.post({ discussionId: 'committed-thread', localId: 'later-3', content: { v: 1, parts: [{ t: 'text', text: 'Latest reply' }] } });
        let refused = false;
        const initialList = createDeferred<void>();
        const initialEntered = createDeferred<void>();
        const summary = () => {
            const row = network.stored()!.discussion;
            const latest = network.messages.at(-1)!;
            return { ...row, messageSeq: latest.seq, latestMessage: { ...row.latestMessage,
                id: latest.id, localId: latest.localId, seq: latest.seq, createdAt: latest.createdAt } };
        };
        homes.answer(serverId, 'GET /v1/discussions', { select: (_input, request) => {
            const url = new URL(request.url);
            if (refused && refusal === 'list') return { status: 403, body: { error: 'discussion_access_forbidden' } };
            if (delayInitial && url.searchParams.has('anchorDocArtifactId')) initialEntered.resolve();
            return { ...(delayInitial && url.searchParams.has('anchorDocArtifactId') ? { respondAfter: initialList.promise } : {}),
                body: { discussions: url.searchParams.get('state') === 'archived' ? []
                : [{ ...summary(), ...(url.searchParams.has('anchorDocArtifactId') ? { firstMessage: refused && refusal === 'null' ? null : network.messages[0] } : {}) }], nextCursor: null } };
        } });
        homes.answer(serverId, '/v1/discussions/committed-thread', { select: () => refused
            ? { status: 409, body: { error: 'discussion_content_unavailable' } } : { body: { discussion: summary() } } });
        homes.answer(serverId, 'GET /v1/discussions/committed-thread/messages', { select: (_input, request) => {
            if (refused) return { status: 409, body: { error: 'discussion_content_unavailable' } };
            const url = new URL(request.url);
            const after = url.searchParams.get('afterSeq');
            const before = url.searchParams.get('beforeSeq');
            const messages = after !== null ? network.messages.filter(row => row.seq > Number(after)).slice(0, 2)
                : network.messages.filter(row => before === null || row.seq < Number(before)).slice(rootOutsideTail ? -2 : 0);
            return { body: { messages, hasMoreOlder: (messages[0]?.seq ?? 1) > 1, messageSeq: network.messages.length } };
        } });
        const hook = await renderHook(() => useDocPassageThreads({ serverId, artifactId: 'doc-a' }));
        if (delayInitial) {
            await initialEntered.promise;
            const repository = readRegisteredDiscussionRepository(scope, { serverId })!;
            expect(repository.getSnapshot().threads['committed-thread']).toBeUndefined();
            refused = true;
            await act(async () => { await repository.refreshDiscussion('committed-thread'); initialList.resolve(); });
            await waitForHomeGovernance(() => {
                expect(hook.getCurrent().status).toBe('unavailable');
                expect(JSON.stringify(hook.getCurrent())).not.toContain('Before');
            });
            expect(repository.getSnapshot().threads['committed-thread']).toMatchObject({ summary: null, messages: [] });
            expect(JSON.stringify(repository.getSnapshot())).not.toContain('Before');
            return;
        }
        await waitForTestEvent(hook.subscribe, () => expect(hook.getCurrent().threads[0]?.messages[0]?.docEditProposalDispositionV1?.state).toBe('open'));
        let releaseThread: () => void = () => {};
        await act(async () => { releaseThread = hook.getCurrent().mountThread('committed-thread'); });
        const repository = readRegisteredDiscussionRepository(scope, { serverId })!;
        await waitForTestEvent(repository.subscribe, () => expect(repository.getSnapshot().threads['committed-thread']?.status).toBe('ready'));
        network.messages[0] = { ...network.messages[0]!, docEditProposalDispositionV1: {
            state: 'declined', decidedBy: { accountId: 'alice', atMs: 10 } } };
        await act(async () => { publishMountedDiscussionChanges({ ...scope,
            changes: [{ cursor: 1, kind: 'discussion', entityId: 'committed-thread', changedAt: 10 }] }); });
        await waitForTestEvent(hook.subscribe, () => expect(hook.getCurrent().threads[0]?.messages[0]?.docEditProposalDispositionV1?.state).toBe('declined'));
        expect(hook.getCurrent().threads[0]?.summary.firstMessage?.docEditProposalDispositionV1?.state).toBe('declined');
        refused = true;
        if (refusal === 'thread') await act(async () => { publishMountedDiscussionChanges({ ...scope,
            changes: [{ cursor: 2, kind: 'discussion', entityId: 'committed-thread', changedAt: 20 }] }); });
        else await act(async () => publishMountedDiscussionChanges({ ...scope,
            changes: [{ cursor: 2, kind: 'artifact', entityId: 'doc-a', changedAt: 20 }] }));
        await waitForTestEvent(hook.subscribe, () => expect(JSON.stringify(hook.getCurrent())).not.toContain('Before'));
        expect(JSON.stringify(hook.getCurrent())).not.toContain('After');
        expect(hook.getCurrent().status).toBe(refusal === 'null' ? 'ready' : 'unavailable');
        expect(JSON.stringify(readRegisteredDiscussionRepository(scope, { serverId })!.getSnapshot())).not.toContain('Before');
        releaseThread();
        await hook.unmount();
        const reads = homes.requests.length;
        publishMountedDiscussionChanges({ ...scope,
            changes: [{ cursor: 3, kind: 'discussion', entityId: 'committed-thread', changedAt: 30 }] });
        expect(homes.requests).toHaveLength(reads);
    });
});
