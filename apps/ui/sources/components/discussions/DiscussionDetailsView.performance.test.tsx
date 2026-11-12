import 'fake-indexeddb/auto';
import '@happier-dev/protocol/actions/actionApprovalPolicy';
import * as React from 'react';
import type { View as NativeView, ViewProps } from 'react-native';
import type { Socket } from 'socket.io-client';
import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, createSessionFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { createArtifactListHttpResponse, createArtifactReadBatchHttpResponse, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ArtifactReadBatchHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { createRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { answerDiscussionThreadForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { DiscussionReadResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SessionMessageAccountActorV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { createWorkflowDefinitionFixture, createWorkflowInvocationIndexFixture, createWorkflowRunListStorageFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { DiscussionProducerV1Schema } from '@happier-dev/protocol/discussions/content';
import { WorkflowProgressEnvelopeV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';

const counters = vi.hoisted(() => new Map<string, ReturnType<typeof createRenderCommitCounter>>());
const transcriptList = vi.hoisted(() => ({ state: null as null | Readonly<{ props: unknown }> }));
vi.mock('react-native', async () => {
    const React = await import('react');
    const { createRenderCommitCounter, useRenderCommitCounter } = await import('@/dev/testkit/performance/counts');
    const native = await (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock();
    // Observe real rows at the native presentation boundary; all Discussion, Markdown,
    // repository, Action and store logic remains real.
    const View = React.forwardRef<NativeView, ViewProps>((props, ref) => {
        const id = props.testID ?? '';
        const counter = React.useMemo(() => {
            const counter = createRenderCommitCounter();
            if (id.startsWith('session-discussion-message-group-')) counters.set(id, counter);
            return counter;
        }, [id]);
        useRenderCommitCounter(counter);
        return React.createElement(native.View, { ...props, ref });
    });
    return { ...native, View };
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Observe settled disclosures; the default native animation boundary leaves timing callbacks pending.
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated'))
    .createReanimatedModuleMock({ settleTimingCallbacks: true }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    // The host renderer has no measured viewport. Use the canonical native-list
    // presentation boundary (eight visible rows), retaining the real screen,
    // Markdown and data owners. No Discussion logic or row is mocked.
    const mock = createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(),
        renderItemLimit: 8, memoizeItems: true });
    transcriptList.state = mock.state;
    return mock.module;
});
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
}));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { DiscussionDetailsView } = await import('./DiscussionDetailsView');
const { useDiscussionTitles } = await import('./useDiscussionTitles');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
const { getDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepositoryRegistry');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { sessionListRuntimeClock } = await import('@/hooks/session/sessionListRuntimeClock');
const { AgentInput } = await import('@/components/sessions/agentInput');
const { publishMountedDiscussionChanges } = await import('@/sync/domains/discussions/discussionChangeWatch');
const { useWorkflowEditorAccountMemory } = await import('@/components/workflows/screens/useWorkflowEditorAccountMemory');
const { writeDiscussionSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { flushSessionDraftLocally } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { DiscussionComposer } = await import('./DiscussionComposer');
const { DiscussionRouteScreen } = await import('./DiscussionRouteScreen');
const { DiscussionPhoneSurfaceHost } = await import('./DiscussionRightSidebar');
const { PresentedDetailNavigationProvider, usePresentedDetailNavigationChrome } = await import('@/components/appShell/rightSidebar/usePresentedDetailNavigation');
const { TranscriptListShell } = await import('@/components/sessions/transcript/viewport/shell/TranscriptListShell');
const { Modal } = await import('@/modal');
function discussionSuggestions(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const props: React.ComponentProps<typeof AgentInput> = screen.root.findByType(AgentInput).props;
    const source = props.autocompleteSuggestions;
    if (typeof source !== 'function') throw new Error('Expected the Discussion autocomplete handler');
    return (query: string, signal: AbortSignal) => source(query, signal, () => {});
}
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let homeSequence = 0;
afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    counters.clear();
    vi.useRealTimers();
});

async function prepareDiscussionHome(configureSocket?: (socket: Socket) => void, options?: Readonly<{
    losePost?: boolean;
    projectRows?: Parameters<typeof createPlainProjectAccountRowListFixture>[0];
}>) {
    // Each fixture is a cold Home. Reusing an identity also reuses retained
    // Account projections, turning later cold-read cases into warm refreshes.
    const sequence = ++homeSequence;
    const serverUrl = `https://discussion-cost-${sequence}.test`;
    const serverIdentityId = `srv_discussion_cost_${sequence}`;
    const localServerId = await homes.addHome({ name: 'Discussion costs', serverUrl, serverIdentityId, accountId: 'alice', currentAccount: true });
    const serverId = resolveServerProfileScopeIdForIdentifier(localServerId);
    if (options?.projectRows) homes.answer(serverId, 'POST /v1/account/project-rows/list', {
        body: createPlainProjectAccountRowListFixture(options.projectRows),
    });
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, conversations: { enabled: true } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    // A settled empty Account, not a missing materialization endpoint whose
    // canonical retry lifecycle would contaminate an idle-read measurement.
    for (const path of ['/v1/plugins/availability/materializations/read', '/v1/plugins/availability/intents/list']) {
        const response = createEmptyAccountBootstrapHttpResponse(path, { method: 'POST' });
        if (!response) throw new Error(`Missing canonical Account bootstrap fixture: ${path}`);
        homes.answer(serverId, `POST ${path}`, { body: await response.json() });
    }
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    homes.answer(serverId, '/v2/cursor', { body: { cursor: 0, changesFloor: 0 } });
    homes.answer(serverId, '/v2/sessions', { body: { sessions: [], nextCursor: null, hasNext: false } });
    homes.answer(serverId, '/v2/sessions/active', { body: { sessions: [], nextCursor: null, hasNext: false } });
    homes.answer(serverId, '/v2/sessions/metadata-upgrades', { body: { sessionIds: [] } });
    homes.answer(serverId, '/v2/session-organization', { body: SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
        schemaVersion: 1, version: 0, pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
    } }) });
    const fixture = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false, losePost: options?.losePost });
    let roster = DiscussionParticipantsListResponseV1Schema.parse({
        discussionId: 'committed-thread', ownerAccountId: 'alice', access: 'owner', participants: [],
        grants: Array.from({ length: 4 }, (_, index) => ({ principal: { kind: 'account', accountId: `person-${index}` },
            accessLevel: 'edit', createdByAccountId: 'alice', createdAt: 1, display: { name: `Person ${index}`, username: null } })),
        accountActors: ['alice', ...Array.from({ length: 4 }, (_, index) => `person-${index}`)].map(accountId => ({
            v: 1 as const, accountId, accessibility: 'current' as const, profile: {
                name: accountId === 'alice' ? 'Alice' : `Person ${accountId.at(-1)}`,
                firstName: accountId === 'alice' ? 'Alice' : `Person ${accountId.at(-1)}`,
                lastName: null, username: accountId, avatarUrl: null,
            },
        })),
    });
    homes.answer(serverId, '/v1/discussions/committed-thread/participants', { select: () => ({ body: roster }) });
    for (const id of ['alice', ...Array.from({ length: 4 }, (_, index) => `person-${index}`)]) {
        homes.answer(serverId, `/v1/user/${id}`, { body: { user: { id, firstName: id === 'alice' ? 'Alice' : `Person ${id.at(-1)}`,
            lastName: null, username: id, avatar: null, bio: null, status: 'none', publicKey: null } } });
    }
    connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId, accountId: 'alice', configureSocket,
        request: createSessionReadBatchFetchBoundary(homes.request) });
    await prepareSessionDraftPersistenceStorage();
    const scope = { serverId, accountId: 'alice' };
    const client = createDiscussionClient({ scope, availability: 'available' });
    return { serverId, serverUrl, serverIdentityId, scope, fixture, client, roster,
        setRoster: (value: typeof roster) => { roster = value; } };
}

async function prepareLongDiscussion(configureSocket?: (socket: Socket) => void, options?: Parameters<typeof prepareDiscussionHome>[1]) {
    const home = await prepareDiscussionHome(configureSocket, options);
    const { serverId, serverUrl, scope, fixture, client, roster } = home;
    const created = await client.create({ creationLocalId: 'cost-thread', messageLocalId: 'cost-root', title: 'Long discussion',
        content: { v: 1, parts: [{ t: 'text', text: '**Root** question' }] } });
    if (created.kind !== 'succeeded') throw new Error(JSON.stringify(created));
    const root = fixture.messages[0]!;
    let archived = false;
    let participantAccounts = ['alice', ...Array.from({ length: 4 }, (_, index) => `person-${index}`)]
        .map(accountId => SessionMessageAccountActorV1Schema.parse({ v: 1, accountId, profile: {
            name: accountId === 'alice' ? 'Alice' : `Person ${accountId.at(-1)}`,
            firstName: accountId === 'alice' ? 'Alice' : `Person ${accountId.at(-1)}`,
            lastName: null, username: accountId, avatarUrl: null,
        } }));
    const newMessage = (seq: number): typeof root => ({ ...root, id: `message-${seq}`, localId: `local-${seq}`, seq,
        authorAccountId: `person-${seq % 4}`, accountActor: { v: 1, accountId: `person-${seq % 4}`,
            profile: { name: `Person ${seq % 4}`, firstName: null, lastName: null, username: null, avatarUrl: null } },
        producerV1: seq % 100 === 0 ? { v: 1, kind: 'workflow', runId: `run-${seq / 100}`,
            invocationRecordId: `invocation-${seq}`, invocationAttempt: '0',
            execution: { kind: 'action', actionId: 'review.verdict' }, outcome: 'answer' } : null,
        content: { t: 'plain', v: { v: 1, parts: [
            { t: 'text', text: `**Answer ${seq}** with code \`value\` for ` },
            { t: 'mention', participant: { kind: 'account', accountId: 'person-0' } },
        ] } }, mentionedAccountIds: ['person-0'], createdAt: seq });
    fixture.messages.push(...Array.from({ length: 299 }, (_, index) => newMessage(index + 2)));
    // Protected Workflow replies require their exact Run summaries before the
    // timeline can commit its bands. Answer the storage boundary with real
    // accepted-snapshot/key producers, retaining the real Action and reader.
    const workflowRows = await createWorkflowRunListStorageFixture({
        definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'review',
            document: { text: 'Review the answer', references: [], attachments: [] }, result: { kind: 'text' } }] }),
        runs: [1, 2, 3].map(index => createWorkflowRunSummaryFixture({
            id: `run-${index}`, ownerAccountId: 'alice', state: 'succeeded', workflowCustodyState: 'settled',
            origin: { kind: 'direct', discussion: { discussion: { serverId, discussionId: 'committed-thread' },
                messageId: root.id, throughSeq: 1 } },
        })),
    });
    homes.answer(serverId, 'POST /v3/automations/runs/workflow-storage', { select: body => {
        expect(body).toMatchObject({ operation: 'list' });
        return { body: workflowRows };
    } });
    // The current server's summary query already projects the admitted roster's
    // complete profiles, independently of the paged authored messages.
    homes.answer(serverId, 'GET /v1/discussions/committed-thread', { select: () => {
        const latest = fixture.messages.at(-1)!;
        const discussion = fixture.stored()!.discussion;
        return { body: { discussion: { ...discussion, participantAccounts, messageSeq: fixture.messages.length,
            archivedAt: archived ? 1 : null,
            capabilities: { ...discussion.capabilities, postMessages: !archived, archive: !archived, restore: archived },
            unreadCount: fixture.messages.length, latestMessage: { ...discussion.latestMessage,
                id: latest.id, localId: latest.localId, seq: latest.seq, authorAccountId: latest.authorAccountId,
                accountActor: latest.accountActor, producerV1: latest.producerV1, createdAt: latest.createdAt } } } };
    } });
    homes.answer(serverId, 'GET /v1/discussions/committed-thread/messages', { select: (_input, request) => {
        const after = Number(new URL(request.url).searchParams.get('afterSeq') ?? 0);
        return { body: { messages: fixture.messages.filter(row => row.seq > after), hasMoreOlder: false, messageSeq: fixture.messages.length } };
    } });
    const binding = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
    const repository = getDiscussionRepository({ scope, address: { serverId }, client, accountLifetime: binding.getCurrent().get(serverId)! });
    return { ...home, repository, accountLifetime: binding.getCurrent().get(serverId)!, newMessage, workflowRows,
        setParticipantAccounts: (value: typeof participantAccounts) => { participantAccounts = value; },
        setArchived: (value: boolean) => { archived = value; } };
}

it('keeps the focused composer mounted when the first draft message becomes a thread', async () => {
    const { serverId, serverUrl } = await prepareDiscussionHome();
    const pendingCreate = createDeferred<void>();
    const answer = homes.findByServerUrl(serverUrl)!.answers.get('POST /v1/discussions')!;
    homes.answer(serverId, 'POST /v1/discussions', { select: async (input, request) => ({
        ...await answer.select!(input, request), respondAfter: pendingCreate.promise,
    }) });
    const { readComposerPresentationSnapshot } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
    function DraftConversation() {
        const [target, setTarget] = React.useState<React.ComponentProps<typeof DiscussionDetailsView>['target']>({
            kind: 'new', address: { serverId }, draftId: '00000000-0000-4000-8000-000000001111',
        });
        return <DiscussionDetailsView target={target} active onCreated={discussion => setTarget({
            kind: 'discussion', address: { serverId }, discussionId: discussion.id,
        })} />;
    }
    const screen = await renderScreen(<AppPaneProvider><DraftConversation /></AppPaneProvider>);
    await vi.waitFor(() => expect(screen.root.findAllByType(AgentInput)).toHaveLength(1));
    await vi.waitFor(() => expect(screen.root.findByType(AgentInput).props.disabled).toBe(false));
    const composer = screen.root.findByType(AgentInput);
    await act(async () => {
        screen.changeTextByTestId('session-discussion-title', 'First message continuity');
        composer.props.onChangeText!('The first message stays here');
        composer.props.onComposerFocusChange!(true);
    });
    await act(async () => { await screen.root.findByType(AgentInput).props.onSend!(); });
    await vi.waitFor(() => expect(screen.findByTestId('session-discussion-new-empty')).toBeNull());
    try {
        expect(screen.root.findByType(AgentInput) === composer, 'the optimistic opener must retain the editor instance').toBe(true);
        expect(composer.props.disabled, 'sending must keep the focused editor editable').toBe(false);
        await act(async () => { composer.props.onChangeText!('The next question'); });
    } finally {
        pendingCreate.resolve();
    }
    await vi.waitFor(() => expect(screen.findByTestId('session-discussion-details'), screen.getTextContent()).not.toBeNull());
    expect(screen.getTextContent()).toContain('The first message stays here');
    expect(screen.root.findAllByType(AgentInput)).toHaveLength(1);
    expect(screen.root.findByType(AgentInput) === composer, 'the first Send must retain the editor instance').toBe(true);
    expect(composer.props.value, 'confirmation must preserve edits made while the first Send was pending').toBe('The next question');
    expect(readComposerPresentationSnapshot({ kind: 'discussion', discussionId: 'committed-thread' },
        { serverId, accountId: 'alice' })?.state.focused).toBe(true);
    await screen.unmount();
});

it('names a busy Discussion read and retries the same conversation', async () => {
    const { serverId, fixture, repository } = await prepareLongDiscussion();
    let busy = true;
    homes.answer(serverId, 'GET /v1/discussions/committed-thread/messages', { select: () => busy
        ? { status: 503, body: { error: 'database_transaction_timeout' } }
        : { body: { messages: fixture.messages, hasMoreOlder: false, messageSeq: fixture.messages.length } } });
    const screen = await renderScreen(<AppPaneProvider><DiscussionDetailsView
        target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active /></AppPaneProvider>);
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('Server busy'));
    expect(screen.findByTestId('session-discussion-thread-state')).not.toBeNull();
    busy = false;
    await screen.pressByTestIdAsync('session-discussion-thread-state-action');
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('Root'));
    expect(screen.findByTestId('session-discussion-thread-state')).toBeNull();
    busy = true;
    await act(async () => { await repository.refreshDiscussion('committed-thread'); });
    await vi.waitFor(() => expect(screen.findByTestId('session-discussion-freshness')).not.toBeNull());
    expect(screen.getTextContent()).toContain('Server busy');
    expect(screen.getTextContent()).toContain('Root');
    busy = false;
    await screen.pressByTestIdAsync('session-discussion-freshness-action');
    await vi.waitFor(() => expect(screen.findByTestId('session-discussion-freshness')).toBeNull());
    await screen.unmount();
});

it('retains a busy post cause through the real Action and retries the same message', async () => {
    const { DiscussionPostRequestV1Schema } = await import('@happier-dev/protocol/discussions/api');
    const { serverId, fixture, repository } = await prepareLongDiscussion();
    fixture.messages.splice(1);
    let busy = true;
    const bodies: unknown[] = [];
    homes.answer(serverId, 'POST /v1/discussions/committed-thread/messages', { select: input => {
        bodies.push(input);
        if (busy) return { status: 503, body: { error: 'database_transaction_timeout' } };
        const request = DiscussionPostRequestV1Schema.parse(input);
        const message = { ...fixture.messages[0]!, id: 'retried-message', localId: request.localId, seq: 2, content: request.content };
        return { body: { message, messageSeq: 2 } };
    } });
    const screen = await renderScreen(<AppPaneProvider><DiscussionDetailsView
        target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active /></AppPaneProvider>);
    await vi.waitFor(() => expect(screen.root.findAllByType(DiscussionComposer)).toHaveLength(1));
    await act(async () => screen.root.findByType(DiscussionComposer).props.onSend({ v: 1, parts: [{ t: 'text', text: 'Keep this question' }] }));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('Server busy'));
    expect(Object.values(repository.getSnapshot().mutations)).toEqual([expect.objectContaining({
        failureCause: expect.objectContaining({ errorCode: 'database_transaction_timeout' }),
    })]);
    busy = false;
    await screen.pressByTestIdAsync('session-discussion-mutation-retry');
    await vi.waitFor(() => expect(Object.values(repository.getSnapshot().mutations).every(mutation => mutation.status === 'observed_success')).toBe(true));
    expect(bodies.at(-1)).toEqual(bodies[0]);
    await screen.unmount();
});

it('loads one-round Debate facts for Agent returns on a cold Discussion and folds around the digest', async () => {
    const { serverId, fixture, newMessage, workflowRows } = await prepareLongDiscussion();
    const root = fixture.messages[0]!;
    // REPLAY4-1108: native Session leaves publish Agent returns, with their exact
    // Workflow invocation under replyReturn.workflow rather than producer kind workflow.
    const rows = [
        { id: 'f4a83613-647f-43ca-bdf5-9fb61e17b3fd', blockId: 'reply', sessionId: 'speaker', text: 'Tea offers a gentler caffeine lift.' },
        { id: 'f9872160-6c15-493a-be44-28414a9ebd41', blockId: 'default-digest', sessionId: 'summarizer', text: 'The round summary.' },
    ].map((leaf, index) => {
        const invocation = createWorkflowInvocationIndexFixture({ id: leaf.id, runId: 'run-1', sequence: String(index + 1), lifecycle: 'completed' });
        const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
            logicalInvocationRecordId: leaf.id, invocationPath: { blockId: leaf.blockId,
                scope: [{ kind: 'iteration', blockId: 'rounds', index: 0 },
                    ...(leaf.blockId === 'reply' ? [{ kind: 'iteration', blockId: 'speakers', index: 0 }] : [])] },
            blockKind: 'step', attempt: '0', result: leaf.text,
            execution: { kind: 'session', sessionId: leaf.sessionId, localInputId: `input-${leaf.id}` } });
        const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'invocation_progress', accountId: 'alice', runId: 'run-1', recordId: leaf.id,
                sequence: invocation.sequence, parentRecordId: invocation.parentRecordId, memberOrdinal: invocation.memberOrdinal, attempt: '0' }, progress }));
        const message = { ...newMessage(index + 2), id: `answer-${leaf.blockId}`, replyTarget: { kind: 'message' as const, messageId: root.id },
            producerV1: DiscussionProducerV1Schema.parse({ v: 1, kind: 'agent', sessionId: leaf.sessionId, runId: 'run-1',
                replyReturn: { serverId, requestLocalId: `input-${leaf.id}`, outcome: 'answer',
                    workflow: { runId: 'run-1', invocationRecordId: leaf.id, invocationAttempt: '0' } } }),
            content: { t: 'plain' as const, v: { v: 1 as const, parts: [{ t: 'text' as const, text: leaf.text }] } } };
        return { invocation, contentEnvelope, message };
    });
    fixture.messages.splice(1, fixture.messages.length - 1, ...rows.map(row => row.message));
    const route = '/v3/automations/runs/workflow-storage';
    homes.answer(serverId, `POST ${route}`, { select: input => {
        if (!input || typeof input !== 'object' || !('operation' in input)) throw new Error('Expected storage operation');
        if (input.operation === 'list') return { body: workflowRows };
        if (input.operation === 'invocations.list') return { body: { invocations: rows.map(row => row.invocation), parentRevision: 1,
            keyCensus: workflowRows.keyCensusByRunId['run-1'],
            progressEnvelopesByInvocationId: Object.fromEntries(rows.map(row => [row.invocation.id, row.contentEnvelope])) } };
        throw new Error(`Unexpected storage operation:${input.operation}`);
    } });
    const screen = await renderScreen(<AppPaneProvider><DiscussionDetailsView
        target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active /></AppPaneProvider>);
    await vi.waitFor(() => expect(screen.findByTestId('discussion-workflow-round:run-1:0')).not.toBeNull());
    expect(screen.getTextContent()).toContain('The round summary.');
    expect(screen.getTextContent()).not.toContain('Tea offers a gentler caffeine lift.');
    const reads = () => homes.requestsFor(route).map(request => request.input)
        .filter(input => input && typeof input === 'object' && 'operation' in input && input.operation === 'invocations.list');
    expect(reads()).toEqual([expect.objectContaining({ runId: 'run-1', progressEnvelopes: true })]);
    await screen.pressByTestIdAsync('workflow-run-fold-toggle:run-1:round:0');
    expect(screen.getTextContent()).toContain('Tea offers a gentler caffeine lift.');
    expect(screen.getTextContent()).toContain('The round summary.');
    await screen.pressByTestIdAsync('workflow-run-fold-toggle:run-1:round:0');
    await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('Tea offers a gentler caffeine lift.'));
    expect(reads()).toHaveLength(1);
});

it.each(['pending', 'failed'] as const)('shows readable cold-thread messages when the optional Run read is %s', async phase => {
    const { serverId, workflowRows } = await prepareLongDiscussion();
    const requested = createDeferred<void>();
    const release = createDeferred<void>();
    homes.answer(serverId, 'POST /v3/automations/runs/workflow-storage', { select: async () => {
        requested.resolve();
        if (phase === 'pending') await release.promise;
        return { status: 503, body: { error: 'unavailable' } };
    } });
    const screen = await renderScreen(<AppPaneProvider><DiscussionDetailsView
        target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active /></AppPaneProvider>);
    try {
        await requested.promise;
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Root'));
        expect(screen.findByTestId('session-discussion-thread-state')).toBeNull();
        if (phase === 'failed') {
            await vi.waitFor(() => expect(screen.findByTestId('session-discussion-workflow-runs-state')).not.toBeNull());
            const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
            const card = screen.root.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'session-discussion-workflow-runs-state');
            expect(card?.props.kind).toBe('unavailable');
            homes.answer(serverId, 'POST /v3/automations/runs/workflow-storage', { body: workflowRows });
            await act(async () => card?.props.action.onPress());
            await vi.waitFor(() => expect(screen.findByTestId('session-discussion-workflow-runs-state')).toBeNull());
            expect(screen.getTextContent()).toContain('Root');
            expect(screen.findByTestId('discussion-workflow-run:run-1')).not.toBeNull();
        }
    } finally {
        release.resolve();
        await screen.unmount();
    }
});

it.each(['inventory-page', 'catch-up'] as const)('mounts a cold private Post from %s before historical approval paging settles', async arrival => {
    const sockets: Socket[] = [];
    const { serverId, serverIdentityId, repository, fixture, newMessage } = await prepareLongDiscussion(value => {
        sockets.push(value);
        configureConnectedServerSocketBoundary(value);
    });
    const sessionId = 'draft-participant';
    const question = { ...newMessage(301), content: { t: 'plain' as const, v: { v: 1 as const, parts: [
        { t: 'mention' as const, participant: { kind: 'session' as const, sessionId } },
        { t: 'text' as const, text: 'Answer the root question privately.' },
    ] } } };
    fixture.messages.push(question);
    const actionArgs = { discussionId: 'committed-thread', localId: 'original-return',
        content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'A private answer' }] },
        replyTarget: { kind: 'message' as const, messageId: question.id } };
    const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId }, requestedSurface: 'agent', actionId: 'discussion.reply',
        actionArgs, discussionDraftReview: true, summary: 'Review the answer',
        executionOriginV1: buildApprovalExecutionOriginV1({ actionId: 'discussion.reply', input: actionArgs,
            targetSessionId: null, context: { surface: 'agent', authority: 'account_automation',
                serverId: 'daemon-local-profile', serverIdentityId, runtimeAccountId: 'alice',
                actionCaller: { kind: 'host' }, defaultSessionId: sessionId, defaultSessionMachineId: 'machine',
                actionRequestId: actionArgs.localId,
                discussionReplyReturn: { serverId: serverIdentityId, requestLocalId: 'original-input', acceptedTurnId: 'turn' } } }),
    });
    const artifactId = '11111111-1111-4111-8111-111111112919';
    const artifact = createPlainArtifactHttpFixture({ id: artifactId, header: buildApprovalRequestArtifactHeaderV1(approval),
        title: approval.summary, body: JSON.stringify(approval), isDecrypted: true,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }, 'alice');
    const inventoryRequested = createDeferred<void>();
    const releaseInventory = createDeferred<void>();
    const bodyReads: string[][] = [];
    let changed = false;
    // The Inbox reads open requests. Fill that actual selected inventory so the
    // current private draft cannot wait for its trailing pages to complete.
    const oldRequest = ApprovalRequestV2Schema.parse({ ...approval, updatedAtMs: 2,
        executionOriginV1: { ...approval.executionOriginV1, sessionId: 'unrelated-history' } });
    const oldArtifact = createPlainArtifactHttpFixture({ id: '11111111-1111-4111-8111-111111112918',
        header: buildApprovalRequestArtifactHeaderV1(oldRequest), title: oldRequest.summary,
        body: JSON.stringify(oldRequest), isDecrypted: true, headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: 1, updatedAt: 1 }, 'alice');
    const historical = Array.from({ length: 500 }, (_, index) => ({ ...oldArtifact,
        id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        updatedAt: index + 2, seq: index + 2 }));
    const newest = { ...artifact, updatedAt: 1000, seq: 1000 };
    homes.answer(serverId, 'GET /v1/artifacts', { select: async (_body, request) => {
        const url = new URL(request.url);
        if (url.searchParams.has('cursor')) {
            inventoryRequested.resolve();
            await releaseInventory.promise;
        }
        return { body: await createArtifactListHttpResponse(url, arrival === 'inventory-page'
            ? [newest, ...historical] : historical).json() };
    } });
    homes.answer(serverId, 'POST /v1/artifacts/read', { select: async body => {
        const read = ArtifactReadBatchHttpInputV1Schema.parse(body);
        if (!('projection' in read)) bodyReads.push(read.artifactIds);
        return { body: await createArtifactReadBatchHttpResponse(body, id => id === artifactId
            ? { artifactId: id, ok: true, recipientCensus: null, artifact: newest }
            : { artifactId: id, ok: false, error: 'artifact_not_found', retryable: false, status: 404 }).json() };
    } });
    homes.answer(serverId, 'GET /v2/cursor', { select: () => ({ body: { cursor: changed ? 1 : 0, changesFloor: 0 } }) });
    homes.answer(serverId, 'GET /v2/changes', { select: (_body, request) => ({ body: { changes: changed
        && Number(new URL(request.url).searchParams.get('after') ?? 0) < 1 ? [{
        cursor: 1, kind: 'artifact', entityId: artifactId, changedAt: 1000, hint: null,
    }] : [], nextCursor: changed ? 1 : 0 } }) });
    const screen = await renderScreen(<AppPaneProvider>
        <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }}
            active standaloneSurface />
    </AppPaneProvider>);
    try {
        await inventoryRequested.promise;
        await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(301));
        if (arrival === 'catch-up') {
            const { storage } = await import('@/sync/domains/state/storage');
            expect(storage.getState().artifacts[artifactId]).toBeUndefined();
            changed = true;
            const receivers = sockets.filter(value => value.listeners('update').length > 0 || value.listenersAny().length > 0);
            expect(receivers.length).toBeGreaterThan(0);
            const wake = UpdateContainerSchema.parse({ id: 'approval-arrival', seq: 1,
                createdAt: 1000, body: { t: 'account-change', entityIds: [artifactId], changeKinds: ['artifact'] } });
            await act(async () => {
                for (const socket of receivers) {
                    for (const listener of socket.listenersAny()) listener('update', wake);
                    for (const listener of socket.listeners('update')) listener(wake);
                }
            });
        }
        const { storage } = await import('@/sync/domains/state/storage');
        await vi.waitFor(() => expect(storage.getState().artifacts[artifactId]?.body).toBe(JSON.stringify(approval)));
        await vi.waitFor(() => expect(screen.findHostByTestId('session-discussion-waiting-approval-approve')).not.toBeNull());
        expect(screen.findHostByTestId('session-discussion-waiting-approval-decline')).not.toBeNull();
        // A rich approval must scroll with the conversation. In the composer band
        // it can consume the entire host and give the real list a zero-height viewport.
        const approvalOwners: string[] = [];
        for (let node = screen.findHostByTestId('session-discussion-waiting-approval-approve')?.parent; node; node = node.parent) {
            if (typeof node.props.testID === 'string') approvalOwners.push(node.props.testID);
        }
        expect(approvalOwners).toContain('agent-content-layer');
        expect(approvalOwners).not.toContain('agent-content-input-footer');
        // The private draft reads as the answer it is, not as the Action's operands.
        expect(JSON.stringify(screen.findHostByTestId('session-discussion-waiting-approval-draft')?.props.children)).toContain('A private answer');
        // Who is waiting leads the card once the draft's Session is known; until then the generic line stands.
        await act(async () => { storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId,
            metadata: { path: '/repo', host: 'box', machineId: 'machine', flavor: 'codex', homeDir: '/home/a',
                summary: { text: 'Release bot', updatedAt: 1 } } })]); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Release bot’s draft waits for you'));
        expect(storage.getState().artifactInventoryKindsLoaded).not.toContain('approval_request.v1');
        expect(bodyReads.filter(ids => ids.includes(artifactId))).toEqual([[artifactId]]);
    } finally { releaseInventory.resolve(); await screen.unmount(); }
});

it('keeps phone-covered and unfocused messages unread while the active Discussion stays live', async () => {
    const { serverId, repository, fixture, newMessage } = await prepareLongDiscussion();
    const reads: number[] = [];
    homes.answer(serverId, 'PUT /v1/discussions/committed-thread/read', { select: body => {
        if (!body || typeof body !== 'object' || !('lastReadSeq' in body) || typeof body.lastReadSeq !== 'number') {
            throw new Error('Expected canonical private read cursor');
        }
        reads.push(body.lastReadSeq);
        return { body: DiscussionReadResponseV1Schema.parse({ discussionId: 'committed-thread', lastReadSeq: body.lastReadSeq, didChange: true }) };
    } });
    const frame = (surface: 'chat' | 'participants' | 'agents' | 'details', active = true) => <AppPaneProvider>
        <DiscussionPhoneSurfaceHost surface={surface} onBackToThread={() => {}}
            main={<DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }}
                active={active} standaloneSurface />} />
    </AppPaneProvider>;
    const screen = await renderScreen(frame('chat'));
    await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(300));
    const observe = async (seq: number) => {
        // Message acquisition precedes the exact Run reads and their composed
        // timeline commit. Observe the rendered viewport, not the storage edge.
        await vi.waitFor(() => expect(screen.root.findByType(TranscriptListShell).props.data.some(row =>
            row !== null && typeof row === 'object' && 'kind' in row && row.kind === 'human_message'
            && 'message' in row && row.message !== null && typeof row.message === 'object'
            && 'seq' in row.message && row.message.seq === seq)).toBe(true));
        const props = screen.root.findByType(TranscriptListShell).props;
        const index = props.data.findIndex(row => row !== null && typeof row === 'object' && 'kind' in row
            && row.kind === 'human_message' && 'message' in row && row.message !== null && typeof row.message === 'object'
            && 'seq' in row.message && row.message.seq === seq);
        const item = props.data[index];
        const onViewableItemsChanged = props.onViewableItemsChanged;
        if (item === undefined || !onViewableItemsChanged) throw new Error('Expected mounted Discussion viewport row');
        // Native viewport is the only substituted boundary. Delayed/cached list
        // observations must not turn a retained, covered thread into seen content.
        const tokens = [{ item, index, key: props.keyExtractor(item, index), isViewable: true }];
        await act(async () => onViewableItemsChanged({ viewableItems: tokens, changed: tokens }));
        await flushHookEffects();
    };
    await observe(300);
    await vi.waitFor(() => expect(reads).toEqual([300]));
    for (const [index, surface] of (['participants', 'agents', 'details'] as const).entries()) {
        await act(async () => screen.update(frame(surface)));
        const seq = 301 + index;
        fixture.messages.push(newMessage(seq));
        await act(async () => { await repository.refreshDiscussion('committed-thread'); });
        expect(repository.getSnapshot().threads['committed-thread']?.messages.at(-1)?.seq).toBe(seq);
        await observe(seq);
        expect(reads).toEqual([300]);
    }
    await act(async () => screen.update(frame('chat', false)));
    await observe(303);
    expect(reads).toEqual([300]);
    await act(async () => screen.update(frame('chat')));
    await vi.waitFor(() => expect(reads).toEqual([300, 303]));
});

it('does not borrow a Home-list source refusal or write a persisted draft when New mounts', async () => {
    const { serverId, repository } = await prepareLongDiscussion();
    const scope = { serverId, accountId: 'alice' };
    const address = { kind: 'newDiscussion' as const, draftId: '00000000-0000-5000-8000-000000000007' };
    const passage = { ref: { kind: 'doc' as const, artifactId: 'private-notes', serverId },
        revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 6 }, quote: 'source' };
    writeDiscussionSessionDraft({ scope, address, patch: { text: 'Retained question', passage } });
    const before = getSessionDraftSnapshot(scope, address)?.document;
    homes.answer(serverId, 'GET /v1/discussions', { status: 403, body: { error: 'discussion_access_forbidden' } });
    await repository.refreshList('active');
    const screen = await renderScreen(<AppPaneProvider><DiscussionDetailsView
        target={{ kind: 'new', address: { serverId }, draftId: address.draftId }} active /></AppPaneProvider>);
    await flushHookEffects();
    expect(getSessionDraftSnapshot(scope, address)?.document).toEqual(before);
    expect(screen.getTextContent()).not.toContain('unavailable Document passage');
});

it('gives a bare New route a fresh document while preserving the abandoned singleton', async () => {
    const { serverId } = await prepareLongDiscussion();
    const scope = { serverId, accountId: 'alice' };
    writeDiscussionSessionDraft({ scope, address: { kind: 'newDiscussion' }, patch: { text: 'An older abandoned draft' } });
    const screen = await renderScreen(<AppPaneProvider><DiscussionRouteScreen kind="new" /></AppPaneProvider>);
    await flushHookEffects();
    expect(screen.root.findByType(DiscussionDetailsView).props.target).toMatchObject({ kind: 'new',
        draftId: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
    expect(screen.root.findByType(DiscussionComposer).props.value.text).toBe('');
    expect(getSessionDraftSnapshot(scope, { kind: 'newDiscussion' })?.document).toMatchObject({ composer: { text: { value: 'An older abandoned draft' } } });
});

it.each([false, true])('opens the confirmed thread once and reports a device persistence failure (%s)', async failClear => {
    const { serverId } = await prepareDiscussionHome();
    const fixture = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
    const scope = { serverId, accountId: 'alice' };
    const address = { kind: 'newDiscussion' as const, draftId: '00000000-0000-5000-8000-000000000008' };
    writeDiscussionSessionDraft({ scope, address, patch: { title: 'Creation review', text: 'A first question' } });
    await flushSessionDraftLocally({ scope });
    const onCreated = vi.fn();
    vi.mocked(Modal.alert).mockClear();
    const screen = await renderScreen(<AppPaneProvider><DiscussionDetailsView
        target={{ kind: 'new', address: { serverId }, draftId: address.draftId }} active onCreated={onCreated} /></AppPaneProvider>);
    await vi.waitFor(() => expect(screen.root.findByType(DiscussionComposer).props.disabled).toBe(false));
    expect(getSessionDraftSnapshot(scope, address)?.document).toMatchObject({ composer: { text: { value: 'A first question' } } });
    const originalPut = IDBObjectStore.prototype.put;
    let refused = false;
    // IndexedDB is the real device persistence boundary; every draft and creation owner stays real.
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value, key) {
        if (failClear && fixture.stored() && typeof key === 'string' && key.startsWith('session-drafts-repository-v1:')
            && typeof value === 'string' && value.includes(address.draftId) && !value.includes('discussionMutationAttempt')) {
            refused = true;
            throw new DOMException('Device storage is full', 'QuotaExceededError');
        }
        return originalPut.call(this, value, key);
    });
    try {
        await act(async () => screen.root.findByType(DiscussionComposer).props.onSend({ v: 1, parts: [{ t: 'text', text: 'A first question' }] }));
        await vi.waitFor(() => expect(fixture.stored()).not.toBeNull());
        if (failClear) {
            await vi.waitFor(() => expect(refused).toBe(true));
            await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalled());
            expect(onCreated).toHaveBeenCalledOnce();
            expect(screen.findByTestId('session-discussion-details')).not.toBeNull();
        } else {
            await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
            await vi.waitFor(() => expect(getSessionDraftSnapshot(scope, address)).toBeNull());
        }
    } finally {
        put.mockRestore();
        await flushSessionDraftLocally({ scope });
    }
});

it('reads a cold Discussion title without reading its 300 message bodies', async () => {
    const { serverId, repository } = await prepareLongDiscussion();
    const start = homes.requests.length;
    const address = { serverId };
    const discussionIds = ['committed-thread'];
    const titles = await renderHook(() => useDiscussionTitles({ address, discussionIds }));
    await vi.waitFor(() => expect(titles.getCurrent().get('committed-thread')).toBe('Long discussion'));
    await flushHookEffects();
    const reads = homes.requests.slice(start).filter(request => request.path.includes('/v1/discussions/'))
        .map(request => request.path);
    console.info('Discussion title reads', reads);
    expect(reads.filter(path => path.includes('/messages'))).toEqual([]);
    expect(repository.getSnapshot().threads['committed-thread']?.messages ?? []).toHaveLength(0);
});

it('keeps unaffected mounted message rows quiet when one message arrives in a 300-message Discussion', async () => {
    const { serverId, serverUrl, fixture, newMessage, repository, setArchived } = await prepareLongDiscussion();
    const frame = <AppPaneProvider><SurfaceStateSizeProvider size="pane">
        <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active />
    </SurfaceStateSizeProvider></AppPaneProvider>;
    const starts = homes.requests.length;
    const screen = await renderScreen(frame);
    await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(300));
    await flushHookEffects();
    await vi.waitFor(() => expect(counters.size).toBeGreaterThan(0));
    const routesSince = (start: number) => homes.requests.slice(start).reduce<Record<string, number>>((counts, request) => {
        const route = new URL(request.path, serverUrl).pathname;
        counts[route] = (counts[route] ?? 0) + 1;
        return counts;
    }, {});
    const cold = routesSince(starts);
    const mounted = [...counters.entries()];
    for (const [, counter] of mounted) counter.reset();
    fixture.messages.push(newMessage(301));
    await act(async () => { await repository.refreshMessages('committed-thread'); });
    await flushHookEffects();
    const counts = mounted.reduce((sum, [, counter]) => ({ renders: sum.renders + counter.read().renders,
        commits: sum.commits + counter.read().commits }), { renders: 0, commits: 0 });
    const changedRows = mounted.filter(([, counter]) => counter.read().renders > 0).map(([id]) => id);
    console.info('Discussion arrival cost', { history: 300, mounted: mounted.length, ...counts });
    expect(screen.getTextContent()).toContain('Long discussion');
    // Empty message reads now preserve identity. Real metadata changes must still
    // reach mounted/recycled rows through the list's non-item input owner.
    expect(screen.findHostByTestId('session-discussion-reply-committed-root')).not.toBeNull();
    await act(async () => { setArchived(true); await repository.refreshSummary('committed-thread'); });
    await flushHookEffects();
    expect(screen.findHostByTestId('session-discussion-reply-committed-root') === null).toBe(true);
    await act(async () => { setArchived(false); await repository.refreshSummary('committed-thread'); });
    await flushHookEffects();
    expect(screen.findHostByTestId('session-discussion-reply-committed-root')).not.toBeNull();
    await screen.unmount();
    const warmStart = homes.requests.length;
    await renderScreen(frame);
    await flushHookEffects();
    const warm = routesSince(warmStart);
    console.info('Discussion screen open reads', { cold, warm });
    expect(cold['/v1/account/project-rows/list'] ?? 0).toBe(0);
    expect(warm['/v1/account/project-rows/list'] ?? 0).toBe(0);
    expect(counts, changedRows.join(', '))
        .toEqual({ renders: 0, commits: 0 });
});

it('warm-mounts retained former rows from the current roster actor and exposes that author to the composer', async () => {
    const { serverId, fixture, newMessage, repository, roster, setRoster, setParticipantAccounts } = await prepareLongDiscussion();
    const bobActor = SessionMessageAccountActorV1Schema.parse({
        v: 1,
        accountId: 'bob',
        accessibility: 'current',
        profile: { name: 'QA N3 Bob', firstName: null, lastName: null, username: 'qa-n3b', avatarUrl: null },
    });
    const root = fixture.messages[0]!;
    const unrelated = {
        ...newMessage(2),
        id: 'unrelated-message',
        localId: 'unrelated-local',
        authorAccountId: 'carol',
        accountActor: SessionMessageAccountActorV1Schema.parse({
            v: 1,
            accountId: 'carol',
            accessibility: 'current',
            profile: { name: 'Carol', firstName: null, lastName: null, username: 'carol', avatarUrl: null },
        }),
        producerV1: null,
    };
    const historicalFormerBob = SessionMessageAccountActorV1Schema.parse({ ...bobActor, accessibility: 'former' });
    const bobStart = {
        ...newMessage(3),
        id: 'bob-group-start',
        localId: 'bob-group-start-local',
        authorAccountId: 'bob',
        accountActor: historicalFormerBob,
        producerV1: null,
    };
    const bobOlder = {
        ...newMessage(4),
        id: 'bob-group-older',
        localId: 'bob-group-older-local',
        authorAccountId: 'bob',
        accountActor: historicalFormerBob,
        producerV1: null,
    };
    const carolLatest = {
        ...newMessage(5),
        id: 'carol-latest',
        localId: 'carol-latest-local',
        authorAccountId: 'carol',
        accountActor: unrelated.accountActor,
        producerV1: null,
    };
    fixture.messages.splice(0, fixture.messages.length, root, unrelated, bobStart, bobOlder, carolLatest);
    setParticipantAccounts([historicalFormerBob]);
    setRoster({ ...roster, accountActors: [...(roster.accountActors ?? []), bobActor] });
    await repository.refreshDiscussion('committed-thread');
    expect(repository.getSnapshot().threads['committed-thread']?.messages.slice(2, 4)
        .map(message => message.accountActor?.accessibility)).toEqual(['former', 'former']);

    const screen = await renderScreen(<AppPaneProvider><SurfaceStateSizeProvider size="pane">
        <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active />
    </SurfaceStateSizeProvider></AppPaneProvider>);
    await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(5));
    await vi.waitFor(() => expect(screen.findHostByTestId('session-discussion-message-actor-bob-group-start')?.props.children)
        .toBe('QA N3 Bob'));
    expect(screen.findHostByTestId('session-discussion-reply-bob-group-older')?.props.accessibilityLabel).toContain('QA N3 Bob');
    expect(screen.findHostByTestId('session-discussion-message-actor-carol-latest')?.props.children).toBe('Carol');
    expect((await discussionSuggestions(screen)('@', new AbortController().signal))
        .find(row => row.key === 'bob')).toMatchObject({ label: 'QA N3 Bob' });
    await flushHookEffects();

    const unrelatedCounters = [
        counters.get(`session-discussion-message-group-start-${root.id}`),
        counters.get('session-discussion-message-group-start-unrelated-message'),
        counters.get('session-discussion-message-group-start-carol-latest'),
    ];
    const bobCounters = [
        counters.get('session-discussion-message-group-start-bob-group-start'),
        counters.get('session-discussion-message-group-continuation-bob-group-older'),
    ];
    expect([...unrelatedCounters, ...bobCounters].every(Boolean)).toBe(true);
    for (const counter of [...unrelatedCounters, ...bobCounters]) counter?.reset();

    setRoster({ ...roster, accountActors: [...(roster.accountActors ?? []), historicalFormerBob] });
    await act(async () => { publishMountedDiscussionChanges({ serverId, accountId: 'alice', changes: [
        { kind: 'discussion', entityId: 'committed-thread', cursor: 1, changedAt: 2, hint: null },
    ] }); });
    await flushHookEffects();

    expect(repository.getSnapshot().threads['committed-thread']?.messages[2]?.accountActor?.accessibility).toBe('former');
    expect(repository.getSnapshot().threads['committed-thread']?.messages[3]?.accountActor?.accessibility).toBe('former');
    expect(repository.getSnapshot().threads['committed-thread']?.messages[4]?.authorAccountId).toBe('carol');
    expect(screen.findHostByTestId('session-discussion-message-actor-bob-group-start')?.props.children).toBe('Former member');
    expect(screen.findHostByTestId('session-discussion-reply-bob-group-older')?.props.accessibilityLabel).toContain('Former member');
    expect(screen.findHostByTestId('session-discussion-message-actor-carol-latest')?.props.children).toBe('Carol');
    expect((await discussionSuggestions(screen)('@', new AbortController().signal))
        .find(row => row.key === 'bob')).toMatchObject({ label: 'Former member' });
    expect(bobCounters.map(counter => counter?.read().renders ?? 0).every(renders => renders > 0)).toBe(true);
    expect(unrelatedCounters.map(counter => counter?.read())).toEqual([
        { renders: 0, commits: 0 },
        { renders: 0, commits: 0 },
        { renders: 0, commits: 0 },
    ]);

    for (const counter of [...unrelatedCounters, ...bobCounters]) counter?.reset();
    setRoster({ ...roster, accountActors: [...(roster.accountActors ?? []), bobActor] });
    await act(async () => { publishMountedDiscussionChanges({ serverId, accountId: 'alice', changes: [
        { kind: 'discussion', entityId: 'committed-thread', cursor: 2, changedAt: 3, hint: null },
    ] }); });
    await flushHookEffects();
    expect(screen.findHostByTestId('session-discussion-message-actor-bob-group-start')?.props.children).toBe('QA N3 Bob');
    expect(screen.findHostByTestId('session-discussion-reply-bob-group-older')?.props.accessibilityLabel).toContain('QA N3 Bob');
    expect(screen.findHostByTestId('session-discussion-message-actor-carol-latest')?.props.children).toBe('Carol');
    expect((await discussionSuggestions(screen)('@', new AbortController().signal))
        .find(row => row.key === 'bob')).toMatchObject({ label: 'QA N3 Bob' });
    expect(bobCounters.map(counter => counter?.read().renders ?? 0).every(renders => renders > 0)).toBe(true);
    expect(unrelatedCounters.map(counter => counter?.read())).toEqual([
        { renders: 0, commits: 0 },
        { renders: 0, commits: 0 },
        { renders: 0, commits: 0 },
    ]);
});

it('catches up replies when a retained Discussion is reopened without a reload', async () => {
    const { serverId, serverUrl, fixture, newMessage, repository } = await prepareLongDiscussion();
    const frame = (active: boolean) => <AppPaneProvider><SurfaceStateSizeProvider size="pane">
        <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active={active} />
    </SurfaceStateSizeProvider></AppPaneProvider>;
    const screen = await renderScreen(frame(true));
    await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(300));
    await flushHookEffects();
    const mounted = [...counters.values()];
    for (const counter of mounted) counter.reset();
    const { getStorage } = await import('@/sync/domains/state/storage');
    await act(async () => { getStorage().setState({ lastSyncAt: Date.now() }); });
    expect(mounted.reduce((sum, counter) => sum + counter.read().renders, 0)).toBe(0);
    await act(async () => screen.update(frame(false)));
    await flushHookEffects();
    fixture.messages.push(newMessage(301));
    await act(async () => {
        publishMountedDiscussionChanges({ serverId, accountId: 'alice', changes: [
            { cursor: 301, kind: 'discussion', entityId: 'committed-thread', changedAt: 301, hint: null },
        ] });
        await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.summary?.messageSeq).toBe(301));
    });
    await flushHookEffects();
    // Hidden surfaces refresh summary facts only; their history remains retained.
    expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(300);
    const start = homes.requests.length;
    await act(async () => screen.update(frame(true)));
    await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages.at(-1)?.seq).toBe(301));
    expect(homes.requests.slice(start).some(request => new URL(request.path, serverUrl).pathname
        === '/v1/discussions/committed-thread/messages')).toBe(true);
    await vi.waitFor(() => expect(screen.root.findByType(TranscriptListShell).props.data.some(row => row !== null && typeof row === 'object' && 'kind' in row
        && row.kind === 'human_message' && 'message' in row && row.message !== null
        && typeof row.message === 'object' && 'id' in row.message && row.message.id === 'message-301')).toBe(true));
});

it('keeps the workspace census demanded by real Workflow editors', async () => {
    const workspace = { id: 'editor-checkout', serverId: 'workspace-home', machineId: 'editor-machine',
        rootPath: '/projects/editor', label: 'Editor checkout', createdAtMs: 1 } satisfies WorkspaceRefV1;
    const { accountLifetime } = await prepareLongDiscussion(undefined, { projectRows: { workspaceRefs: [workspace] } });
    const memory = await renderHook(() => useWorkflowEditorAccountMemory(accountLifetime));
    // The Account row owner may already hold the bootstrap census. The editor must
    // consume its real rows whether this mount needs HTTP or reuses that owner.
    await vi.waitFor(() => expect(memory.getCurrent().workspaceRefs).toEqual([workspace]));
});

it('shares the mounted roster across queries, refreshes one invalidation, and still denies Send at the server', async () => {
    const { serverId, repository, fixture, roster, setRoster } = await prepareLongDiscussion();
    const screen = await renderScreen(<AppPaneProvider><SurfaceStateSizeProvider size="pane">
        <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active />
    </SurfaceStateSizeProvider></AppPaneProvider>);
    const input = (): React.ComponentProps<typeof AgentInput> => screen.root.findByType(AgentInput).props;
    const path = '/v1/discussions/committed-thread/participants';
    await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(300));
    await flushHookEffects();
    const start = homes.requestsFor(path).length;
    for (const query of ['@p', '@pe', '@per', '@person']) {
        const rows = await discussionSuggestions(screen)(query, new AbortController().signal);
        expect(rows.some(row => row.label === 'Person 0')).toBe(true);
    }
    const queryReads = homes.requestsFor(path).length - start;
    setRoster({ ...roster, grants: [...roster.grants, { principal: { kind: 'account', accountId: 'new-person' },
        accessLevel: 'edit', createdByAccountId: 'alice', createdAt: 2, display: { name: 'New person', username: null } }],
        accountActors: [...(roster.accountActors ?? []), { v: 1, accountId: 'new-person', accessibility: 'current',
            profile: { name: 'New person', firstName: 'New', lastName: 'person', username: 'new-person', avatarUrl: null } }] });
    const membershipStart = homes.requestsFor(path).length;
    await act(async () => { publishMountedDiscussionChanges({ serverId, accountId: 'alice', changes: [
        { kind: 'discussion', entityId: 'committed-thread', cursor: 1, changedAt: 2, hint: null },
    ] }); });
    await flushHookEffects();
    const membershipReads = homes.requestsFor(path).length - membershipStart;
    const afterChange = await discussionSuggestions(screen)('@new', new AbortController().signal);
    const hasNewMember = afterChange.some(row => row.label === 'New person');
    let deniedSends = 0;
    homes.answer(serverId, 'POST /v1/discussions/committed-thread/messages', { select: () => {
        deniedSends += 1;
        return { status: 403, body: { error: 'discussion_read_denied' } };
    } });
    const changeText = input().onChangeText;
    if (!changeText) throw new Error('Expected the writable Discussion input');
    await act(async () => { changeText('A stale displayed roster is not Send authority'); });
    const retainedSuggestions = discussionSuggestions(screen);
    await act(async () => { await input().onSend?.(); });
    await vi.waitFor(() => expect(deniedSends).toBe(1));
    await flushHookEffects();
    expect(repository.getSnapshot().threads['committed-thread']?.status).toBe('revoked');
    expect(repository.getSnapshot().threads['committed-thread']?.messages).toEqual([]);
    expect(fixture.messages).toHaveLength(300);
    console.info('Discussion roster cost', { queries: 4, queryReads, membershipReads, deniedSends });
    expect(await retainedSuggestions('@person', new AbortController().signal)).toEqual([]);
    expect({ queryReads, membershipReads, hasNewMember }).toEqual({ queryReads: 0, membershipReads: 1, hasNewMember: true });
});

it('presents a refused Session invitation during Send without an unknown delivery or Retry', async () => {
    const { serverId, repository, fixture } = await prepareLongDiscussion();
    fixture.messages.splice(1);
    const invitePath = '/v1/discussions/committed-thread/participants/invite';
    homes.answer(serverId, `POST ${invitePath}`, { status: 403, body: { error: 'discussion_access_forbidden' } });
    const screen = await renderScreen(<AppPaneProvider><DiscussionDetailsView
        target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active />
    </AppPaneProvider>);
    await vi.waitFor(() => expect(screen.root.findAllByType(DiscussionComposer)).toHaveLength(1));
    const postsBefore = homes.requestsFor('/v1/discussions/committed-thread/messages').filter(request => request.method === 'POST').length;
    await act(async () => screen.root.findByType(DiscussionComposer).props.onSend({ v: 1, parts: [
        { t: 'mention', participant: { kind: 'session', sessionId: 'uninvitable-session' } },
        { t: 'text', text: ' Please review this passage' },
    ] }));
    await vi.waitFor(() => expect(homes.requestsFor(invitePath)).toHaveLength(1));
    await flushHookEffects();
    expect(Object.values(repository.getSnapshot().mutations)).toEqual([expect.objectContaining({
        status: 'failed', errorCode: 'discussion_access_forbidden', recovery: 'dismiss',
    })]);
    expect(screen.getTextContent()).toContain('Permission denied');
    expect(screen.getTextContent()).not.toContain('Delivery unknown');
    expect(screen.findByTestId('session-discussion-mutation-retry')).toBeNull();
    expect(screen.findByTestId('session-discussion-mutation-dismiss')).not.toBeNull();
    expect(repository.getSnapshot().threads['committed-thread']?.summary).not.toBeNull();
    expect(screen.getTextContent()).toContain('Root');
    expect(homes.requestsFor('/v1/discussions/committed-thread/messages').filter(request => request.method === 'POST')).toHaveLength(postsBefore);
    expect(fixture.messages).toHaveLength(1);
    await screen.unmount();
});

it('keeps the transcript and its page out of a redraw while the person types a message', async () => {
    const { serverId } = await prepareLongDiscussion();
    const screen = await renderScreen(<AppPaneProvider><SurfaceStateSizeProvider size="pane">
        <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active />
    </SurfaceStateSizeProvider></AppPaneProvider>);
    await vi.waitFor(() => expect(counters.size).toBeGreaterThan(0));
    await flushHookEffects();
    const input = (): React.ComponentProps<typeof AgentInput> => screen.root.findByType(AgentInput).props;
    const listProps = transcriptList.state?.props;
    expect(listProps).toBeTruthy();
    for (const text of ['D', 'Dr', 'Dra', 'Draft']) await act(async () => { input().onChangeText?.(text); });
    await flushHookEffects();
    expect(input().value).toBe('Draft');
    // Each keystroke belongs to the composer; the transcript list receives no new props.
    expect(transcriptList.state?.props).toBe(listProps);
    await screen.unmount();
});

it('retries an unavailable roster through the mounted acquisition owner, not through another query', async () => {
    const { serverId, roster } = await prepareLongDiscussion();
    const path = '/v1/discussions/committed-thread/participants';
    let unavailable = true;
    homes.answer(serverId, `GET ${path}`, { select: () => unavailable
        ? { status: 503, body: { error: 'unavailable' } } : { body: roster } });
    const screen = await renderScreen(<AppPaneProvider><SurfaceStateSizeProvider size="pane">
        <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active />
    </SurfaceStateSizeProvider></AppPaneProvider>);
    await flushHookEffects();
    const starts = homes.requestsFor(path).length;
    const rows = await discussionSuggestions(screen)('@person', new AbortController().signal);
    const retry = rows.find(row => row.listStatus?.kind === 'retry')?.listStatus;
    expect(retry?.kind).toBe('retry');
    expect(homes.requestsFor(path)).toHaveLength(starts);
    unavailable = false;
    await act(async () => { if (retry?.kind === 'retry') retry.retry(); });
    await flushHookEffects();
    const refreshed = await discussionSuggestions(screen)('@person', new AbortController().signal);
    expect(refreshed.some(row => row.label === 'Person 0')).toBe(true);
    expect(homes.requestsFor(path)).toHaveLength(starts + 1);
});

it('advances a visible message age without rerendering its message body', async () => {
    const { serverId, fixture } = await prepareLongDiscussion();
    const now = Date.now();
    fixture.messages[0] = { ...fixture.messages[0]!, createdAt: now - 61_000 };
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const screen = await renderScreen(<AppPaneProvider><SurfaceStateSizeProvider size="pane">
        <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active />
    </SurfaceStateSizeProvider></AppPaneProvider>);
    await vi.waitFor(() => expect(screen.findHostByTestId('session-discussion-message-timestamp-committed-root')?.props.children).toBe('1m'));
    await flushHookEffects();
    const body = counters.get('session-discussion-message-group-start-committed-root');
    expect(body).toBeDefined();
    body?.reset();
    const clockFires = vi.fn();
    const unsubscribe = sessionListRuntimeClock.subscribe(clockFires);
    const idleStart = homes.requests.length;
    try {
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        const idleRequests = homes.requests.slice(idleStart).map(request => request.path);
        console.info('Discussion visible age boundary cost', { clockFires: clockFires.mock.calls.length, body: body?.read(), idleRequests });
        expect(screen.findHostByTestId('session-discussion-message-timestamp-committed-root')?.props.children).toBe('2m');
        expect(body?.read()).toEqual({ renders: 0, commits: 0 });
        expect(clockFires).toHaveBeenCalledTimes(1);
        expect(idleRequests.filter(path => path.startsWith('/v1/discussions'))).toHaveLength(0);
        await screen.unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(clockFires).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
});

it('starts a no-input Pattern with the current Discussion draft after its panel opened empty', async () => {
    const { DiscussionWorkflowStartDetails } = await import('./DiscussionWorkflowStartDetails');
    const { WorkflowStartDetailsBody, createWorkflowStartDetailsTab } = await import('@/components/workflows/run/WorkflowStartDetails');
    const { useWorkflowComposerStart } = await import('@/components/workflows/run/useWorkflowComposerStart');
    const { serverId, fixture, accountLifetime, repository } = await prepareLongDiscussion();
    const discussion = { serverId, discussionId: 'committed-thread' };
    const address = { kind: 'discussion' as const, discussionId: discussion.discussionId };
    writeDiscussionSessionDraft({ scope: accountLifetime.scope, address, patch: { text: '' } });
    const tab = { ...createWorkflowStartDetailsTab({ kind: 'catalog', workflow: 'builtin:plan-with-a-panel' }, 'Panel',
        { kind: 'discussion', discussion }), isPinned: true, isPreview: false };
    const scope = { kind: 'global' as const };
    const screen = await renderScreen(<DiscussionWorkflowStartDetails input={{ tab, active: true, scope, region: 'details', callbacks: {},
        descriptor: { surfaceId: 'discussion-workflow-start', resourceKey: tab.key, scope, region: 'details', status: 'available' } }} />);
    await vi.waitFor(() => expect(screen.root.findAllByType(WorkflowStartDetailsBody)).toHaveLength(1));
    const body: React.ComponentProps<typeof WorkflowStartDetailsBody> = screen.root.findByType(WorkflowStartDetailsBody).props;
    expect(body.retainedDraft).toBe('');
    const start = await renderHook(() => useWorkflowComposerStart({ accountLifetime, project: { machineId: 'machine-1', directory: '/repo' },
        prepareOrigin: body.prepareOrigin, onStarted: () => undefined }));
    const definition = createWorkflowDefinitionFixture({ inputs: [], blocks: [{ kind: 'wait', id: 'wait',
        document: { text: 'Continue when ready', references: [], attachments: [] } }] });
    await act(async () => { start.getCurrent().start({ id: 'wait-pattern', name: 'Pause for thought', description: '', definition,
        source: { kind: 'inline', definition } }, { retainedDraft: '' }); });
    await act(async () => { writeDiscussionSessionDraft({ scope: accountLifetime.scope, address, patch: { text: 'A fresh question' } }); });
    const postsBefore = homes.requestsFor('/v1/discussions/committed-thread/messages').filter(request => request.method === 'POST').length;
    await act(async () => { start.getCurrent().composerProps!.onRun(undefined); });
    await vi.waitFor(() => expect(fixture.messages.some(message => message.localId?.startsWith('workflow-run:')
        && JSON.stringify(message.content).includes('A fresh question'))).toBe(true));
    expect(homes.requestsFor('/v1/discussions/committed-thread/messages').filter(request => request.method === 'POST')).toHaveLength(postsBefore + 1);
    const submission = Object.values(repository.getSnapshot().mutations).find(mutation => mutation.localId.startsWith('workflow-run:'))?.draftSubmission;
    expect(submission).toBeDefined();
    const { useDiscussionDraft } = await import('./useDiscussionDraft');
    const draft = await renderHook(() => useDiscussionDraft({ scope: accountLifetime.scope, address }));
    await act(async () => { await draft.getCurrent().clearAfterObservedSuccess(submission!); });
    expect(draft.getCurrent().text).toBe('');
    await draft.unmount();
    await start.unmount();
    await screen.unmount();
});

it.each([false, true])('lets the mounted Workflow Start commit and rejoin its ordinary question before returning the Discussion origin (lost response=%s)', async losePost => {
    const { DiscussionPaneHost } = await import('./DiscussionRightSidebar');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { WorkflowStartDetailsBody, createWorkflowStartDetailsTab } = await import('@/components/workflows/run/WorkflowStartDetails');
    const { discussionWorkflowRunListFilterId, workflowRunListWindowStoreKey } = await import('@/sync/store/domains/workflowRuns');
    const { serverId, repository, fixture, accountLifetime } = await prepareLongDiscussion(undefined, { losePost });
    const discussion = { serverId, discussionId: 'committed-thread' };
    const address = { kind: 'discussion' as const, discussionId: discussion.discussionId };
    writeDiscussionSessionDraft({ scope: accountLifetime.scope, address, patch: { text: 'Retained question' } });
    const tab = { ...createWorkflowStartDetailsTab({ kind: 'catalog', workflow: 'builtin:plan-with-a-panel' }, 'Panel',
        { kind: 'discussion', discussion }), isPinned: true, isPreview: false };
    const paneRef: { current: ReturnType<typeof useAppPaneScope> | null } = { current: null };
    function ObservePane() {
        paneRef.current = useAppPaneScope('discussion');
        return null;
    }
    const screen = await renderScreen(<AppPaneProvider><DiscussionPaneHost main={<ObservePane />} /></AppPaneProvider>);
    await act(async () => paneRef.current!.openDetailsTab(tab, { intent: 'pinned', start: true }));
    await vi.waitFor(() => expect(screen.root.findAllByType(WorkflowStartDetailsBody)).toHaveLength(1));
    const body: React.ComponentProps<typeof WorkflowStartDetailsBody> = screen.root.findByType(WorkflowStartDetailsBody).props;
    expect(body.retainedDraft).toBe('Retained question');
    // The thread remains editable while Start reviews its retained question.
    await act(async () => { writeDiscussionSessionDraft({ scope: accountLifetime.scope, address, patch: { text: 'Next unsent question' } }); });
    expect(fixture.messages.filter(message => message.localId === 'workflow-run:workflow-question')).toHaveLength(0);
    const before = homes.requestsFor('/v1/discussions/committed-thread/messages').filter(request => request.method === 'POST').length;
    let origin: Awaited<ReturnType<NonNullable<typeof body.prepareOrigin>>> | undefined;
    await act(async () => {
        origin = await body.prepareOrigin!({ runId: 'workflow-question', inputs: undefined,
            retainedDraft: 'Retained question', submittedDraft: 'Reviewed workflow question' });
    });
    const committed = fixture.messages.find(message => message.localId === 'workflow-run:workflow-question');
    expect(committed).toMatchObject({ content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Reviewed workflow question' }] } } });
    expect(origin).toEqual({ kind: 'discussion', discussion, addressingMessageId: committed!.id });
    expect(fixture.messages.filter(message => message.localId === 'workflow-run:workflow-question')).toHaveLength(1);
    expect(homes.requestsFor('/v1/discussions/committed-thread/messages').filter(request => request.method === 'POST')).toHaveLength(before + 1);
    expect(repository.getSnapshot().mutations['workflow-run:workflow-question']?.draftSubmission).toMatchObject({ scope: accountLifetime.scope, address });
    const { useDiscussionDraft } = await import('./useDiscussionDraft');
    const draft = await renderHook(() => useDiscussionDraft({ scope: accountLifetime.scope, address }));
    await act(async () => { await draft.getCurrent().clearAfterObservedSuccess(repository.getSnapshot().mutations['workflow-run:workflow-question']!.draftSubmission!); });
    expect(draft.getCurrent().text).toBe('Next unsent question');
    expect(draft.getCurrent().submitted).toBeNull();
    await draft.unmount();
    const run = createWorkflowRunSummaryFixture({ id: 'workflow-question', ownerAccountId: 'alice', origin: {
        kind: 'direct', discussion: { discussion, messageId: committed!.id, throughSeq: committed!.seq },
    } });
    await act(async () => body.onStarted({ admission: 'created', run }, serverId));
    expect(paneRef.current!.scopeState?.details.tabs).toEqual([expect.objectContaining({
        resource: { kind: 'workflowRunPeek', serverId, runId: run.id } })]);
    const windowId = workflowRunListWindowStoreKey(discussionWorkflowRunListFilterId(discussion.discussionId), accountLifetime.scope);
    const { getStorage } = await import('@/sync/domains/state/storage');
    expect(getStorage().getState().workflowRunListWindows[windowId]?.runIds).toContain(run.id);
    await screen.unmount();
    // The committed composer question and acknowledged Run outlive this process's
    // projection. Reopen without any retained id and before its first reply.
    expect(committed!.producerV1).toBeNull();
    getStorage().setState({ workflowRunsById: {}, workflowRunListWindows: {}, workflowRunInvocationsByRunId: {} });
    const coldRows = await createWorkflowRunListStorageFixture({ definition: createWorkflowDefinitionFixture({ blocks: [{
        kind: 'wait', id: 'answer', document: { text: 'Answer', references: [], attachments: [] }, result: { kind: 'text' },
    }] }), runs: [run] });
    homes.answer(serverId, 'POST /v3/automations/runs/workflow-storage', { select: body => {
        expect(body).toMatchObject({ operation: 'list' });
        return { body: coldRows };
    } });
    const { useDiscussionManagedWorkflowRuns } = await import('./useDiscussionManagedWorkflowRuns');
    const reloaded = await renderHook(() => useDiscussionManagedWorkflowRuns({ discussion, accountLifetime }));
    await flushHookEffects({ cycles: 40 });
    expect(reloaded.getCurrent().runs.map(value => value.id)).toEqual([run.id]);
    await reloaded.unmount();
});

it.each([
    { text: '', refusal: null, code: 'discussion_invalid_content' },
    { text: 'A question', refusal: 'discussion_invalid_mention', code: 'discussion_invalid_mention' },
])('preserves the Discussion cause before Workflow admission ($code)', async ({ text, refusal, code }) => {
    const { DiscussionWorkflowStartDetails } = await import('./DiscussionWorkflowStartDetails');
    const { WorkflowStartDetailsBody, createWorkflowStartDetailsTab } = await import('@/components/workflows/run/WorkflowStartDetails');
    const { WorkflowActionError } = await import('@/sync/domains/workflows/workflowActionError');
    const { resolveWorkflowProblemPresentation } = await import('@/components/workflows/presentation/workflowProblemPresentation');
    const { discussionFailureLabel } = await import('./discussionFailureLabel');
    const { serverId } = await prepareLongDiscussion();
    if (refusal) homes.answer(serverId, 'POST /v1/discussions/committed-thread/messages', {
        select: () => ({ status: 400, body: { error: refusal } }),
    });
    const tab = { ...createWorkflowStartDetailsTab({ kind: 'catalog', workflow: 'builtin:plan-with-a-panel' }, 'Panel',
        { kind: 'discussion', discussion: { serverId, discussionId: 'committed-thread' } }), isPinned: true, isPreview: false };
    const scope = { kind: 'global' as const };
    const screen = await renderScreen(<DiscussionWorkflowStartDetails input={{ tab, active: true, scope, region: 'details', callbacks: {},
        descriptor: { surfaceId: 'discussion-workflow-start', resourceKey: tab.key, scope, region: 'details', status: 'available' } }} />);
    await vi.waitFor(() => expect(screen.root.findAllByType(WorkflowStartDetailsBody)).toHaveLength(1));
    const body: React.ComponentProps<typeof WorkflowStartDetailsBody> = screen.root.findByType(WorkflowStartDetailsBody).props;
    let failure: unknown;
    await act(async () => {
        try { await body.prepareOrigin!({ runId: 'workflow-refused-question', inputs: undefined, retainedDraft: text, submittedDraft: text }); }
        catch (error) { failure = error; }
    });
    expect(failure).toBeInstanceOf(WorkflowActionError);
    expect(failure).toMatchObject({ rawCode: code });
    expect(resolveWorkflowProblemPresentation(failure)).toMatchObject({ message: discussionFailureLabel(code), repair: 'none' });
    if (text === '') expect(homes.requestsFor('/v1/discussions/committed-thread/messages').filter(request => request.method === 'POST')).toHaveLength(0);
    await screen.unmount();
});

it('keeps the current Discussion post attempt in custody while Workflow Start is open', async () => {
    const { DiscussionWorkflowStartDetails } = await import('./DiscussionWorkflowStartDetails');
    const { WorkflowStartDetailsBody, createWorkflowStartDetailsTab } = await import('@/components/workflows/run/WorkflowStartDetails');
    const { useDiscussionDraft } = await import('./useDiscussionDraft');
    const { serverId, repository, fixture, accountLifetime } = await prepareLongDiscussion();
    const discussion = { serverId, discussionId: 'committed-thread' };
    const address = { kind: 'discussion' as const, discussionId: discussion.discussionId };
    const tab = { ...createWorkflowStartDetailsTab({ kind: 'catalog', workflow: 'builtin:plan-with-a-panel' }, 'Panel',
        { kind: 'discussion', discussion }), isPinned: true, isPreview: false };
    const scope = { kind: 'global' as const };
    const screen = await renderScreen(<DiscussionWorkflowStartDetails input={{ tab, active: true, scope, region: 'details', callbacks: {},
        descriptor: { surfaceId: 'discussion-workflow-start', resourceKey: tab.key, scope, region: 'details', status: 'available' } }} />);
    await vi.waitFor(() => expect(screen.root.findAllByType(WorkflowStartDetailsBody)).toHaveLength(1));
    const draft = await renderHook(() => useDiscussionDraft({ scope: accountLifetime.scope, address }));
    const requested = createDeferred<void>();
    const release = createDeferred<void>();
    const { DiscussionPostRequestV1Schema } = await import('@happier-dev/protocol/discussions/api');
    homes.answer(serverId, 'POST /v1/discussions/committed-thread/messages', { select: async input => {
        const request = DiscussionPostRequestV1Schema.parse(input);
        if (request.localId === 'ordinary-post') { requested.resolve(); await release.promise; }
        const message = { ...fixture.messages[0]!, id: `committed-${request.localId}`, localId: request.localId,
            seq: fixture.messages.length + 1, content: request.content };
        return { body: { message, messageSeq: message.seq } };
    } });
    let ordinaryPost: ReturnType<typeof repository.post>;
    await act(async () => {
        ordinaryPost = repository.post({ discussionId: discussion.discussionId, localId: 'ordinary-post',
            content: { v: 1, parts: [{ t: 'text', text: 'Ordinary question' }] }, draftSubmission: draft.getCurrent().captureSubmittedCurrentness() });
        await requested.promise;
    });
    const before = homes.requestsFor('/v1/discussions/committed-thread/messages').filter(request => request.method === 'POST').length;
    const body: React.ComponentProps<typeof WorkflowStartDetailsBody> = screen.root.findByType(WorkflowStartDetailsBody).props;
    try {
        await act(async () => {
            await expect(body.prepareOrigin!({ runId: 'competing-workflow', inputs: undefined, retainedDraft: '', submittedDraft: 'Workflow question' })).rejects.toThrow('discussion_post_unavailable');
        });
        expect(homes.requestsFor('/v1/discussions/committed-thread/messages').filter(request => request.method === 'POST')).toHaveLength(before);
        expect(repository.getSnapshot().mutations['ordinary-post']).toBeDefined();
        expect(repository.getSnapshot().mutations['workflow-run:competing-workflow']).toBeUndefined();
    } finally { await act(async () => { release.resolve(); await ordinaryPost!; }); }
    await draft.unmount();
    await screen.unmount();
});

it('replaces a dismissable refused Discussion post with the reviewed Workflow question', async () => {
    const { DiscussionWorkflowStartDetails } = await import('./DiscussionWorkflowStartDetails');
    const { WorkflowStartDetailsBody, createWorkflowStartDetailsTab } = await import('@/components/workflows/run/WorkflowStartDetails');
    const { useDiscussionDraft } = await import('./useDiscussionDraft');
    const { DiscussionPostRequestV1Schema } = await import('@happier-dev/protocol/discussions/api');
    const { serverId, repository, fixture, accountLifetime } = await prepareLongDiscussion();
    const discussion = { serverId, discussionId: 'committed-thread' };
    const address = { kind: 'discussion' as const, discussionId: discussion.discussionId };
    writeDiscussionSessionDraft({ scope: accountLifetime.scope, address, patch: { text: 'Retained question' } });
    const draft = await renderHook(() => useDiscussionDraft({ scope: accountLifetime.scope, address }));
    homes.answer(serverId, 'POST /v1/discussions/committed-thread/messages', { select: input => {
        const request = DiscussionPostRequestV1Schema.parse(input);
        if (request.localId === 'refused-question') return { status: 400, body: { error: 'discussion_invalid_mention' } };
        const message = { ...fixture.messages[0]!, id: `committed-${request.localId}`, localId: request.localId,
            seq: fixture.messages.length + 1, content: request.content };
        return { body: { message, messageSeq: message.seq } };
    } });
    const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Refused question' }] };
    await act(async () => {
        const draftSubmission = draft.getCurrent().captureSubmittedCurrentness({ kind: 'post', discussionId: discussion.discussionId,
            localId: 'refused-question' }, { content });
        await repository.post({ discussionId: discussion.discussionId, localId: 'refused-question', content, draftSubmission });
    });
    expect(repository.getSnapshot().mutations['refused-question']).toMatchObject({ status: 'failed', recovery: 'dismiss' });
    const tab = { ...createWorkflowStartDetailsTab({ kind: 'catalog', workflow: 'builtin:plan-with-a-panel' }, 'Panel',
        { kind: 'discussion', discussion }), isPinned: true, isPreview: false };
    const scope = { kind: 'global' as const };
    const screen = await renderScreen(<DiscussionWorkflowStartDetails input={{ tab, active: true, scope, region: 'details', callbacks: {},
        descriptor: { surfaceId: 'discussion-workflow-start', resourceKey: tab.key, scope, region: 'details', status: 'available' } }} />);
    await vi.waitFor(() => expect(screen.root.findAllByType(WorkflowStartDetailsBody)).toHaveLength(1));
    const body: React.ComponentProps<typeof WorkflowStartDetailsBody> = screen.root.findByType(WorkflowStartDetailsBody).props;
    await act(async () => {
        await body.prepareOrigin!({ runId: 'fresh-workflow-question', inputs: undefined, retainedDraft: 'Retained question', submittedDraft: 'Reviewed workflow question' });
    });
    expect(repository.getSnapshot().mutations['refused-question']).toBeUndefined();
    expect(repository.getSnapshot().mutations['workflow-run:fresh-workflow-question']).toMatchObject({ status: 'observed_success' });
    expect(draft.getCurrent().pendingMutationAttempt).toMatchObject({ localId: 'workflow-run:fresh-workflow-question' });
    expect(draft.getCurrent().submitted?.content).toEqual({ v: 1, parts: [{ t: 'text', text: 'Reviewed workflow question' }] });
    await draft.unmount();
    await screen.unmount();
});

it('detail-navigation.T2 demands the real Discussion companion only while open and publishes no unrelated Discussion chrome commits', async () => {
    const { DiscussionPaneHost } = await import('./DiscussionRightSidebar');
    const { invokeScopeAction } = await import('@/sync/ops/actions/scopeActionFamily');
    const { serverId, accountLifetime, repository } = await prepareLongDiscussion();
    const publication: { current: ReturnType<typeof usePresentedDetailNavigationChrome> } = { current: null };
    let commits = 0;
    function Chrome() {
        publication.current = usePresentedDetailNavigationChrome();
        React.useLayoutEffect(() => { commits += 1; });
        return null;
    }
    const selected: string[] = [];
    const main = <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active standaloneSurface />;
    function MountedDiscussion() {
        const [surface, setSurface] = React.useState<import('@/components/workspaceCockpit/discussion/discussionCockpitState').DiscussionMobileSurface>('chat');
        return <DiscussionPaneHost discussionId="committed-thread" scope={accountLifetime.scope} phoneSurface={surface}
            onSurfaceChange={next => { selected.push(next); setSurface(next); }} main={main} />;
    }
    const screen = await renderScreen(<PresentedDetailNavigationProvider><AppPaneProvider>
        <MountedDiscussion /><Chrome />
    </AppPaneProvider></PresentedDetailNavigationProvider>);
    await vi.waitFor(() => expect(publication.current?.identity).toBe('committed-thread'));
    await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(300));
    await flushHookEffects();
    expect(publication.current!.items.map(item => item.id)).toEqual(['chat', 'discussionParticipants', 'discussionAgents', 'discussionDetails']);
    expect(screen.findHostByTestId('discussion-participants-tab')).toBeNull();
    expect(screen.findHostByTestId('discussion-agents-tab')).toBeNull();
    const input = screen.root.findByType(AgentInput);
    // Chat already demands the shared roster for recipients, mentions and header faces.
    // Opening a companion must reuse that acquisition, never add a second participant reader.
    const rosterReads = homes.requestsFor('/v1/discussions/committed-thread/participants').length;
    const before = homes.requests.length;
    const read = (column: 'main' | 'side') => ({ kind: 'shell.column' as const, column, read: () => publication.current!.readColumn(column) });
    expect(publication.current!.readColumn('main').openNavigationCustomizer).toBeTypeOf('function');
    expect(await invokeScopeAction('shell.column.get', { column: 'main' }, undefined, read('main')))
        .toMatchObject({ tabs: ['chat'], activeTab: 'chat' });
    await act(async () => { await invokeScopeAction('shell.column.set', { column: 'side', visible: true, tab: 'discussionParticipants' }, undefined, read('side')); });
    expect(selected).toEqual(['participants']);
    expect(screen.findHostByTestId('discussion-participants-tab')).not.toBeNull();
    expect(screen.findHostByTestId('discussion-agents-tab')).toBeNull();
    expect(screen.root.findByType(AgentInput)).toBe(input);
    await act(async () => { await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: 'chat' }, undefined, read('main')); });
    expect(selected).toEqual(['participants', 'chat']);
    expect(screen.findHostByTestId('discussion-participants-tab')).toBeNull();
    expect(screen.root.findByType(AgentInput)).toBe(input);
    expect(homes.requestsFor('/v1/discussions/committed-thread/participants')).toHaveLength(rosterReads);
    const companionRequests = homes.requests.slice(before).map(request => request.path);
    console.info('detail-navigation.T2 additional Home paths', companionRequests);
    expect(companionRequests.filter(path => path.startsWith('/v1/discussions/'))).toEqual([]);
    const settled = commits;
    await act(async () => publishMountedDiscussionChanges({ serverId, accountId: accountLifetime.scope.accountId,
        changes: [{ kind: 'discussion', entityId: 'another-discussion', cursor: 2, changedAt: 2, hint: null }] }));
    expect(commits).toBe(settled);
    console.info('detail-navigation.T2 Discussion', { selected, rosterReads, addedCompanionReads: companionRequests.filter(path => path.startsWith('/v1/discussions/')).length, additionalHomePaths: companionRequests,
        unrelatedChromeCommits: commits - settled });
    await screen.unmount();
});

it('edits Discussion desktop placement once without seeding or changing Project App or phone choices', async () => {
    const { DiscussionPaneHost } = await import('./DiscussionRightSidebar');
    const { DiscussionNavigationContext } = await import('@/components/workspaceCockpit/discussion/discussionNavigation');
    const { useNavigationSurfacePlacementActionWriter } = await import('@/components/ui/navigation/useNavigationSurfacePlacement');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { accountLifetime } = await prepareLongDiscussion();
    const workspaceRail = { orderedIds: ['git'], placements: { git: 'hidden' as const, discussionParticipants: 'hidden' as const } };
    const phoneItems = { orderedIds: [], placements: { discussionAgents: 'overflow' as const } };
    storage.setState({ localSettings: { ...storage.getState().localSettings,
        navigationSurfacePlacementsV1: { workspaceRail, detailPages: { discussion: { phone: { items: phoneItems } } } } } });
    const observed: { navigation: React.ContextType<typeof DiscussionNavigationContext>;
        write?: ReturnType<typeof useNavigationSurfacePlacementActionWriter> } = { navigation: null };
    function Probe() {
        observed.navigation = React.useContext(DiscussionNavigationContext);
        observed.write = useNavigationSurfacePlacementActionWriter({ pageKind: 'discussion', device: 'desktop', section: 'companions' });
        return null;
    }
    const screen = await renderScreen(<AppPaneProvider><DiscussionPaneHost discussionId="committed-thread"
        scope={accountLifetime.scope} paneEnabled={false} main={<Probe />} /></AppPaneProvider>);
    const participantPlacement = () => observed.navigation?.readColumn('side').items?.find(item => item.id === 'discussionParticipants')?.placement;
    expect(participantPlacement()).toBe('pinned');
    expect(storage.getState().localSettings.navigationSurfacePlacementsV1.detailPages?.discussion?.desktop).toBeUndefined();
    let commits = 0;
    const unsubscribe = storage.subscribe((state, previous) => {
        if (state.localSettings.navigationSurfacePlacementsV1 !== previous.localSettings.navigationSurfacePlacementsV1) commits += 1;
    });
    const reads = homes.requests.length;
    try {
        await act(async () => { expect(await observed.write!({ orderedIds: [], placements: { discussionParticipants: 'hidden' } })).toBe(true); });
        expect(participantPlacement()).toBe('hidden');
        expect(commits).toBe(1);
        const saved = storage.getState().localSettings.navigationSurfacePlacementsV1;
        expect(saved.workspaceRail).toBe(workspaceRail);
        expect(saved.detailPages?.discussion?.phone?.items).toBe(phoneItems);
        expect(homes.requests).toHaveLength(reads);
        await act(async () => { expect(await observed.write!({ orderedIds: [], placements: { discussionParticipants: 'hidden' } })).toBe(true); });
        expect(commits).toBe(1);
    } finally { unsubscribe(); await screen.unmount(); }
});

it('detail-navigation.T4 commits one addressed Discussion phone edit and opens More Customize without body reads', async () => {
    await prepareLongDiscussion();
    const { withPopoverWebGlobals } = await import('@/dev/testkit/harness/popoverHarness');
    const restorePopoverGlobals = withPopoverWebGlobals();
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { resolveDetailNavigationItems } = await import('@/components/appShell/rightSidebar/detailNavigationItems');
    const { DiscussionCockpitTabBar } = await import('@/components/navigation/mobile/chrome/bars/DiscussionCockpitTabBar');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const { DetailNavigationCustomizer } = await import('@/components/ui/navigation/NavigationPlacementCustomizer');
    const { resolveDiscussionNavigationCustomizer } = await import('@/components/workspaceCockpit/discussion/discussionNavigationCustomizer');
    const workspaceRail = { orderedIds: ['git'], placements: { git: 'hidden' as const } };
    const desktop = { companions: { orderedIds: [], placements: { discussionParticipants: 'hidden' as const } } };
    storage.setState({ localSettings: { ...storage.getState().localSettings,
        navigationSurfacePlacementsV1: { workspaceRail, detailPages: { discussion: { desktop } } } } });
    const items = resolveDetailNavigationItems({ scope: 'discussion' });
    const screen = await renderScreen(<DiscussionCockpitTabBar discussionId="committed-thread" items={items}
        activeSurface="chat" onSurfacePress={() => { throw new Error('Customize must not select a body'); }} />);
    await flushHookEffects();
    let commits = 0;
    const unsubscribe = storage.subscribe((state, previous) => {
        if (state.localSettings.navigationSurfacePlacementsV1 !== previous.localSettings.navigationSurfacePlacementsV1) commits += 1;
    });
    const reads = homes.requests.length;
    try {
        await act(async () => screen.pressByTestId('discussion-cockpit-tab-more'));
        expect(commits).toBe(0);
        await act(async () => screen.root.findByType(DropdownMenu).props.onSelect('customize'));
        await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({ component: DetailNavigationCustomizer,
            props: expect.objectContaining({ pageKind: 'discussion', device: 'phone' }) })));
        const editor = await renderScreen(<DetailNavigationCustomizer {...resolveDiscussionNavigationCustomizer({ items, device: 'phone' })}
            onClose={() => {}} />);
        expect(homes.requests).toHaveLength(reads);
        expect(commits).toBe(0);
        await act(async () => editor.pressByTestId('discussion-navigation-customizer.items.placement:discussionAgents:overflow'));
        await vi.waitFor(() => expect(commits).toBe(1));
        const saved = storage.getState().localSettings.navigationSurfacePlacementsV1;
        expect(saved.detailPages?.discussion?.phone?.items?.placements.discussionAgents).toBe('overflow');
        expect(saved.detailPages?.discussion?.desktop).toBe(desktop);
        expect(saved.workspaceRail).toBe(workspaceRail);
        expect(homes.requests).toHaveLength(reads);
        await act(async () => editor.pressByTestId('discussion-navigation-customizer.items.placement:discussionAgents:overflow'));
        expect(commits).toBe(1);
        console.info('detail-navigation.T4 Discussion', { completedEditCommits: commits, moreCustomizeBodyReads: homes.requests.length - reads });
        await editor.unmount();
    } finally { unsubscribe(); await screen.unmount(); restorePopoverGlobals(); }
});
