import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentTextMessage } from '@happier-dev/session-core/messages';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createWorkflowActionHttpTransport } from '@/dev/testkit/fixtures/workflowActionHttpTransport';
const state = vi.hoisted(() => ({ serverId: 'server-a' }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The real modal owns authoring custody; only Radix's DOM primitives are replaced.
vi.mock('@/utils/web/radixCjs', async () =>
    (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
// Install network/credential boundaries before importing the real Action/composer graph.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createSessionFixture, createTestSessionTranscriptSource, renderScreen: renderTestScreen, standardCleanup, wrapWithSessionTranscriptSource } = await import('@/dev/testkit');
const { ModalProvider, useModal } = await import('@/modal/ModalProvider');
const { WorkflowAgentAuthoringDraft } = await import('./useWorkflowAgentAuthoring');
type ModalEntries = ReturnType<typeof useModal>['state']['modals'];
let modalEntries: ModalEntries = [];
function ObserveModals() {
    modalEntries = useModal().state.modals;
    return null;
}
function ModalCustody({ children }: React.PropsWithChildren) {
    return <ModalProvider><ObserveModals />{children}</ModalProvider>;
}
function renderScreen(content: React.ReactElement) {
    return renderTestScreen(content, { wrapper: ModalCustody });
}
function visibleModals() {
    return modalEntries.filter(entry => 'visible' in entry && entry.visible === true);
}
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { readNewSessionDraftProjectionFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { WorkflowsColumnActions } = await import('../column/WorkflowsColumnActions');
const { WorkflowsLibraryHome } = await import('../library/WorkflowsLibraryHome');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { buildWorkflowAgentAuthoringSeed } = await import('@/sync/domains/workflows/workflowAgentAuthoringSeed');
const { createWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
const { createWorkflowDefinitionFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
const { getSessionDraftSnapshot, listNewSessionDraftProjections, resetSessionDraftRepositoryForTests, writeExistingSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { createRepositoryComposerDocumentOwner } = await import('@/components/sessions/composer/repositoryComposerDocumentOwner');
const { projectComposerDocumentSnapshot } = await import('@/components/sessions/composer/composerSnapshotProjection');
const { registerSessionComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { MultiTextInput } = await import('@/components/ui/forms/MultiTextInput');
const { useWorkflowMakeRepeatable } = await import('./useWorkflowMakeRepeatable');
const { CommittedMessageActions } = await import('@/components/sessions/transcript/messageActions/CommittedMessageActions');
const { resolveSelectableMessageText } = await import('@/components/sessions/transcript/messageSelection/resolveSelectableMessageText');
const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { AUTHORING_MEMORY_ROUTE_V1} = await import('@happier-dev/protocol/account/authoringMemory');
beforeEach(async () => {
    await home.reset();
    resetSessionDraftRepositoryForTests();
    await prepareSessionDraftPersistenceStorage();
    state.serverId = await home.addHome({ serverUrl: 'https://repeatable.test', name: 'Repeatable test', accountId: 'account-a' });
    home.answer(state.serverId, '/v1/auth/ping', { body: { success: true } });
    home.answer(state.serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const workflowTransport = createWorkflowActionHttpTransport({ fixtureResponse: async () => ({ ok: true, result: { definitions: [] } }), accountId: () => 'account-a' });
    home.answer(state.serverId, '/v1/features', { body: workflowTransport.features });
    home.answer(state.serverId, '/v1/features/authenticated', { body: workflowTransport.features });
    home.answer(state.serverId, AUTHORING_MEMORY_ROUTE_V1, { body: { rows: [] } });
    home.answer(state.serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
    home.answer(state.serverId, '/v3/automations/runs/workflow-storage', { select: (input) => {
        const operation = (input as { operation?: unknown }).operation;
        return { body: operation === 'summaries' ? { summaries: [] }
            : { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } };
    } });
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://repeatable.test');
    if (!credentials) throw new Error('Test Home must be signed in');
    await restoreConnectionToActiveServer(credentials);
    modalEntries = [];
    getStorage().setState({ profileScope: { serverId: state.serverId, accountId: 'account-a' }, settings: settingsDefaults });
    getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { automations: true, workflows: true } });
    await getServerFeaturesSnapshot({ serverId: state.serverId, force: true });
});
afterEach(async () => { await standardCleanup(); await disconnectActiveServerConnection(); vi.unstubAllGlobals(); });

function expectSeededSheet(screen: Awaited<ReturnType<typeof renderScreen>>) {
    expect(visibleModals()).toHaveLength(1);
    const modal = visibleModals()[0];
    if (modal.type !== 'custom') throw new Error('Expected the real custom authoring sheet');
    expect(modal?.chrome?.testID).toBe('workflow-agent-authoring-sheet');
    const props = modal?.props as { draftId: string } | undefined;
    expect(props?.draftId).toBeTruthy();
    const snapshot = props ? readNewSessionDraftProjectionFromRepository({ draftId: props.draftId, scope: { serverId: state.serverId, accountId: 'account-a' } }) : null;
    expect(snapshot?.draft.input).toBe(buildWorkflowAgentAuthoringSeed({ kind: 'create' }).prompt);
    // The sheet states what happens before anything is sent (07 S22).
    if (modal.chrome?.kind !== 'card') throw new Error('Expected authoring sheet card chrome');
    expect(modal.chrome.subtitle).toBe('workflows.authoring.description');
    const composers = screen.findAllByType(WorkflowAgentAuthoringDraft);
    expect(composers).toHaveLength(1);
    expect(composers[0].props.draftId).toBe(props?.draftId);
    expect(screen.findHostByTestId('workflow-agent-authoring-sheet')).not.toBeNull();
}

it('the column + entry opens the seeded real-composer sheet', async () => {
    const screen = await renderScreen(<WorkflowsColumnActions canCreate />);
    const menu = screen.root.findAllByType(DropdownMenu).find((node) => node.props.testID === 'workflows-column:add:menu');
    expect(menu?.props.items.some((item: { id: string }) => item.id === 'agent')).toBe(true);
    await act(async () => menu?.props.onSelect('agent'));
    expectSeededSheet(screen);
});

it.each([false, true])('the first-visit/home entry opens the same seeded sheet (populated=%s)', async (populated) => {
    if (populated) {
        await createWorkflowDefinition({ definitionId: '00000000-0000-4000-8000-000000000005',
            definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'review',
                document: { text: 'Review the result', references: [], attachments: [] } }] }), metadata: { title: 'Saved' } });
    }
    const screen = await renderScreen(<WorkflowsLibraryHome />);
    const entryId = populated ? 'workflows-home:agent' : 'workflows-home:firstVisit:agent';
    await vi.waitFor(async () => {
        await act(async () => {});
        expect(screen.findByTestId(entryId), screen.getTextContent()).not.toBeNull();
    });
    await screen.pressByTestIdAsync(entryId);
    expectSeededSheet(screen);
});

function MountedComposer(props: Readonly<{
    composer: ReturnType<typeof createRepositoryComposerDocumentOwner>;
    scope: ServerAccountScope;
    focused: () => boolean;
    registered?: boolean;
    editable?: boolean;
}>) {
    const { composer, scope, focused, registered = true, editable = true } = props;
    React.useSyncExternalStore(composer.observe, () => composer.read().revision);
    React.useEffect(() => {
        if (!registered) return;
        if (composer.ref.kind !== 'session') throw new Error('Expected the Session composer');
        return registerSessionComposerPresentationTarget({ serverId: scope.serverId, sessionId: composer.ref.sessionId }, {
            readScope: () => scope,
            readRevision: () => composer.read().revision,
            replace: (text) => composer.replaceDocument({ ...composer.read().document, text }),
            readSnapshot: () => projectComposerDocumentSnapshot({ owner: composer, attachmentCatalog: { entriesById: null }, presentation: {
                layout: 'wrap', focused: false, editable, submittable: editable, submitting: false, running: false,
            } }),
            commitDocument: ({ expectedRevision, mutation }) => composer.apply(expectedRevision, mutation),
            commitDocumentEmitsChange: true,
            focusComposer: focused,
        });
    }, [composer, editable, focused, registered, scope]);
    return <MultiTextInput testID="repeatable-composer" value={composer.read().document.text} editable={editable}
        onChangeText={(text) => composer.replaceDocument({ ...composer.read().document, text })} />;
}

function HeaderRepeatableEntry(props: Readonly<{ sessionId: string; serverId: string }>) {
    const repeatable = useWorkflowMakeRepeatable(props);
    return <button disabled={!repeatable.available} onClick={repeatable.openRepeatable} />;
}

function MessageBody(props: Readonly<{ row: React.ReactNode; onRender: () => void }>) {
    props.onRender();
    return <>{props.row}</>;
}

it.each([
    ['header', 'keep me'], ['message', 'keep me'], ['header', 'keep me\n'], ['header', ''],
] as const)('the %s repeatable action appends to the unsent Session draft (%j) without opening a sheet or creating a Session', async (entry, initialText) => {
    const server = { id: state.serverId };
    const session = createSessionFixture({ id: 'source-session', serverId: server.id });
    getStorage().setState({ profileScope: { serverId: server.id, accountId: 'account-a' }, sessions: { [session.id]: session } });
    const scope = { serverId: server.id, accountId: 'account-a' };
    const address = { kind: 'session' as const, sessionId: session.id };
    writeExistingSessionDraft({ scope, sessionId: session.id, patch: { text: initialText } });
    const composer = createRepositoryComposerDocumentOwner({ scope, ref: { kind: 'session', sessionId: session.id } });
    const focused = vi.fn(() => true);
    const earlierDraftIds = listNewSessionDraftProjections(scope).map((draft) => draft.draftId);
    const message = { id: 'message-7', text: 'The successful audit' };
    const bodyRender = vi.fn();
    function HeaderEntry() {
        const settings = getStorage()((current) => current.settings);
        if (entry === 'message') {
            const committed: AgentTextMessage = { ...message, kind: 'agent-text', localId: null, createdAt: 1 };
            return <CommittedMessageActions message={committed} sessionId={session.id} serverId={server.id} touchRevealKey={null}
                selectableText={resolveSelectableMessageText({ message: committed, isStructuredOnly: false, hasAttachmentBlockToStrip: false })}
                copyText={message.text} isStructuredOnly={false} canFork={false} isForkAllowed={() => false}
                forkCommon={{ sessionReplayEnabled: false, sessionReplayMaxSeedChars: 0, sessionReplayStrategy: 'recent_messages',
                    sessionReplaySummaryRunnerV1: null, executionRunsEnabled: false, agentSwitchingEnabled: false,
                    sessionForkSupportSource: { metadata: null } }}
                settings={{ ...settings, workspacePath: null, debugInformationEnabled: false }}
                showActions showPinAction={false} timestampText={null} invertTimestampAndActions={false}
                onActionsFocus={() => {}} onActionsBlur={() => {}}>{(row) => <MessageBody row={row} onRender={bodyRender} />}</CommittedMessageActions>;
        }
        return <HeaderRepeatableEntry sessionId={session.id} serverId={server.id} />;
    }
    const source = createTestSessionTranscriptSource({ sessionId: session.id, serverId: server.id });
    const content = () => wrapWithSessionTranscriptSource(<><MountedComposer composer={composer} scope={scope} focused={focused} /><HeaderEntry /></>, source);
    const screen = await renderScreen(content());
    if (entry === 'message') {
        expect(screen.findHostByTestId('transcript-message-repeatable:message-7')).not.toBeNull();
        for (const text of ['The successful audit continued', 'The final successful audit']) {
            const before = bodyRender.mock.calls.length;
            message.text = text;
            await screen.update(content());
            // Text updates need their own render, not a second capability-publication render.
            expect(bodyRender.mock.calls.length - before).toBe(1);
        }
        message.id = 'recycled-message';
        message.text = 'The recycled successful audit';
        await screen.update(content());
        expect(screen.findHostByTestId('transcript-message-repeatable:message-7')).toBeNull();
        await screen.pressByTestIdAsync(`transcript-message-repeatable:${message.id}`);
    }
    else {
        expect(screen.root.findByType('button').props.disabled).toBe(false);
        await act(async () => screen.root.findByType('button').props.onClick());
    }
    const expected = buildWorkflowAgentAuthoringSeed({ kind: 'repeatable', sessionId: session.id, serverId: server.id,
        ...(entry === 'message' ? { message } : {}),
    }).prompt;
    const appended = `${initialText}${initialText && !initialText.endsWith('\n') ? '\n' : ''}${expected}`;
    expect(getSessionDraftSnapshot(scope, address)?.document).toMatchObject({ composer: { text: { value: appended } } });
    expect(composer.read().document.text).toBe(appended);
    expect(screen.root.findByType(MultiTextInput).props.value).toBe(appended);
    expect(focused).toHaveBeenCalled();
    expect(visibleModals()).toHaveLength(0);
    expect(listNewSessionDraftProjections(scope).map((draft) => draft.draftId)).toEqual(earlierDraftIds);
    expect(Object.keys(getStorage().getState().sessions)).toEqual([session.id]);
    if (entry === 'message') {
        await act(async () => getStorage().getState().applySettingsLocal({ transcriptMessageMakeRepeatableActionEnabled: false }));
        expect(screen.findHostByTestId(`transcript-message-repeatable:${message.id}`)).toBeNull();
    }
    // The ordinary composer remains the editable owner after prefilling.
    await act(async () => screen.root.findByType(MultiTextInput).props.onChangeText(`${appended}\nMy change`));
    expect(getSessionDraftSnapshot(scope, address)?.document).toMatchObject({ composer: { text: { value: `${appended}\nMy change` } } });
});

it.each(['unmounted', 'readOnly', 'conflict'] as const)('keeps the draft and does not focus when the repeatable composer is %s', async (condition) => {
    const scope = { serverId: state.serverId, accountId: 'account-a' };
    const session = createSessionFixture({ id: 'source-session', serverId: state.serverId });
    getStorage().setState({ sessions: { [session.id]: session } });
    writeExistingSessionDraft({ scope, sessionId: session.id, patch: { text: 'keep me' } });
    const composer = createRepositoryComposerDocumentOwner({ scope, ref: { kind: 'session', sessionId: session.id } });
    const focused = vi.fn(() => true);
    function Entry() {
        const repeatable = useWorkflowMakeRepeatable({ sessionId: session.id, serverId: state.serverId });
        return <button disabled={!repeatable.available} onClick={repeatable.openRepeatable} />;
    }
    const screen = await renderScreen(<><MountedComposer composer={composer} scope={scope} focused={focused}
        registered={condition !== 'unmounted'} editable={condition !== 'readOnly'} /><Entry /></>);
    expect(screen.root.findByType('button').props.disabled).toBe(false);
    const expected = condition === 'conflict' ? 'keep me\nTyped meanwhile' : 'keep me';
    await act(async () => {
        const pending = screen.root.findByType('button').props.onClick();
        // The person edits after the append captures its revision, before Action admission finishes.
        if (condition === 'conflict') composer.replaceDocument({ ...composer.read().document, text: expected });
        await pending;
    });
    expect(screen.root.findByType(MultiTextInput).props.value).toBe(expected);
    expect(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: session.id })?.document).toMatchObject({ composer: { text: { value: expected } } });
    expect(focused).not.toHaveBeenCalled();
    expect(visibleModals()).toHaveLength(0);
});
