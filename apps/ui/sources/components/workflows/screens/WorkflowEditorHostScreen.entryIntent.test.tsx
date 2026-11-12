import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, renderHook, standardCleanup, findTestInstanceByTypeContainingText } from '@/dev/testkit';
import { reportCollectionLayout } from '@/dev/testkit/harness/collectionLayoutHarness';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { authoringMemoryDefaults } from '@/sync/store/domains/authoringMemory';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getActionSpec} from '@happier-dev/protocol/actions/actionSpecs';
import { type WorkflowDefinitionGetResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

/**
 * The saved-row entry intents, consumed at the one editor owner.
 *
 * Edit, Run now and Schedule arrive through the same route because only this
 * page has the reviewed Machine, the page-level Run as choice and the declared
 * inputs. Run opens the reviewed composer; Schedule opens this page's settings.
 * Both use the real page command gate on the hydrated revision; Edit opens neither.
 */

let restoreWebGlobals: (() => void) | undefined;
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();

const routerMock = vi.hoisted(() => ({ value: null as { spies: { push: ReturnType<typeof vi.fn> } } | null }));
const machineRpc = vi.hoisted(() => vi.fn(async (_request: Readonly<{ method: string; payload?: unknown }>) => {
    throw new Error('Machine capability RPC unavailable in this fixture');
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
    const native = await createReactNativeWebMock({ useWindowDimensions: () => dimensions });
    return { ...native, Dimensions: { ...native.Dimensions, get: () => dimensions } };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock();
    routerMock.value = mock;
    return mock.module;
});
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
// The DOM menu SDK is outside the native renderer; Modal state stays real.
vi.mock('@/utils/web/radixCjs', async () =>
    (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
// Leave detached-support decisions real; only its machine RPC is unavailable.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc')>(),
    machineRpcWithServerScope: machineRpc,
}));
// React Test Renderer has no DOM anchor or portal; render the real popover's
// content inline rather than replacing its Workflow command/composer owners.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 800, maxWidth: 520, placement: 'bottom' }));

// The actual Account Action, Artifact codec, editor and Run controller execute
// below HTTP, credential persistence, navigation and native rendering boundaries.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { WorkflowRunComposer } = await import('../run/WorkflowRunComposer');
const { ModalProvider, useModal } = await import('@/modal/ModalProvider');
const { createWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const DEFINITION_ID = '00000000-0000-4000-8000-000000000301';
const SECOND_DEFINITION_ID = '00000000-0000-4000-8000-000000000302';
let serverId: string;
let modals: ReturnType<typeof useModal>['state']['modals'] = [];
function ObserveModals() { modals = useModal().state.modals; return null; }
function visibleModals() { return modals.filter(modal => 'visible' in modal && modal.visible === true); }
function settingsModal() {
    return visibleModals().find((modal): modal is Extract<(typeof modals)[number], { type: 'custom' }> =>
        modal.type === 'custom' && modal.chrome?.testID === 'workflow-editor-settings-modal');
}

function expectNoWorkflowWrites(): void {
    // Account storage reads use POST too. Capture may read its accepted Run,
    // but no Artifact/Run mutation or execution is allowed before Save.
    expect(home.requests.filter(request => {
        if (request.input === null || !(request.path.startsWith('/v1/artifacts') || request.path.startsWith('/v3/automations'))) return false;
        const input = request.input;
        const runRead = request.path === '/v3/automations/runs/workflow-storage' && typeof input === 'object'
            && input !== null && 'operation' in input && ['get', 'invocations.list', 'run-key.census', 'summaries'].includes(String(input.operation));
        const triggerRead = request.path === '/v3/automations/query';
        return !runRead && !triggerRead;
    }).map(({ path, input }) => ({ path, input }))).toEqual([]);
    expect(machineRpc.mock.calls.filter(([request]) => request.method === getActionSpec('workflow.run.start').bindings?.rpcMethod)).toEqual([]);
}

/** A saved revision the canonical validator accepts, with one declared input. */
function savedDefinition(): WorkflowDefinitionGetResultV1 {
    return {
        definitionId: DEFINITION_ID,
        access: 'owner',
        revision: { headerVersion: 1, bodyVersion: 2 },
        metadata: { title: 'Release check' },
        definition: createWorkflowDefinitionFixture({
            inputs: [{ name: 'topic', valueType: 'string', required: true }],
            defaults: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            },
            blocks: [{
                kind: 'step',
                id: 'review',
                document: { text: 'Review the release', references: [], attachments: [] },
                input: [],
                result: { kind: 'text' },
            }],
        }),
    };
}

function pushSpy(): ReturnType<typeof vi.fn> {
    const spy = routerMock.value?.spies.push;
    if (!spy) throw new Error('Expected the router mock to expose its push spy');
    return spy;
}

function EditorPaneWrapper({ children }: React.PropsWithChildren) {
    return <AppPaneProvider><ModalProvider><ObserveModals />{children}</ModalProvider></AppPaneProvider>;
}

beforeEach(async () => {
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    serverId = await home.addHome({ name: 'Editor entries', serverUrl: 'https://editor-entries.test', accountId: 'account-a' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    restoreWebGlobals = withPopoverWebGlobals();
    // Account lifetime is internal owner state, not a mockable boundary. In
    // particular, manufacturing a fresh lifetime per snapshot loops React's
    // external-store subscription before any entry-intent assertion can run.
    storage.setState({ profileScope: { serverId, accountId: 'account-a' },
        settingsScope: { serverId, accountId: 'account-a' }, isDataReady: true, isSessionDraftsReady: true,
        settings: settingsDefaults,
        authoringMemory: { ...authoringMemoryDefaults, recentMachinePaths: [{ machineId: 'machine-1', path: '/repo/project' }] },
        machines: { 'machine-1': createMachineFixture({ id: 'machine-1' }) }, machineListByServerId: {} });
    modals = [];
    machineRpc.mockClear();
    home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
    const saved = savedDefinition();
    await createWorkflowDefinition({ definitionId: saved.definitionId, definition: saved.definition, metadata: saved.metadata });
    home.requests.splice(0);
    routerMock.value?.spies.push.mockClear();
});

afterEach(async () => {
    await standardCleanup();
    await home.reset();
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousRuntimeAvailable);
    restoreWebGlobals?.();
});

async function answerCaptureDiscussion(runId?: string, extraAnswer = false) {
    const { DiscussionSummaryV1Schema } = await import('@happier-dev/protocol/discussions/models');
    const discussionId = 'capture-discussion';
    const actor = { v: 1 as const, accountId: 'account-a', profile: null };
    home.answer(serverId, `/v1/discussions/${discussionId}`, { body: { discussion: DiscussionSummaryV1Schema.parse({
        id: discussionId, ownerAccountId: 'account-a', encryptionMode: 'plain', anchor: null, access: 'owner', keyReadiness: true,
        dataEncryptionKey: null, creationLocalId: null, titleContent: { t: 'plain', v: { v: 1, title: 'Compare the proposals' } },
        latestMessage: { id: 'answer', localId: null, seq: 2, authorAccountId: 'account-a', accountActor: actor,
            producerV1: { v: 1, kind: 'agent', sessionId: 'answerer' }, createdAt: 2 }, messageSeq: 2, lastReadSeq: 0,
        unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: ['account-a'], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
    }) } });
    const messages = [
        { id: 'question', discussionId, seq: 1, localId: null, authorAccountId: 'account-a', accountActor: actor, producerV1: null,
            content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Compare the proposals' }] } }, mentionedAccountIds: [], createdAt: 1 },
        { id: 'answer', discussionId, seq: 2, localId: null, authorAccountId: 'account-a', accountActor: actor,
            producerV1: runId ? { v: 1, kind: 'workflow', runId, invocationRecordId: 'captured-answer', invocationAttempt: '0',
                execution: { kind: 'not_started', blockKind: 'step' }, outcome: 'pass' }
                : { v: 1, kind: 'agent', sessionId: 'answerer' }, replyTarget: { kind: 'message', messageId: 'question' },
            content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Private answer prose' }] } }, mentionedAccountIds: [], createdAt: 2 },
        { id: 'unlinked-human', discussionId, seq: 3, localId: null, authorAccountId: 'account-a', accountActor: actor, producerV1: null,
            content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Separate human note' }] } }, mentionedAccountIds: [], createdAt: 3 },
        ...(extraAnswer ? [{ id: 'other-answer', discussionId, seq: 4, localId: null, authorAccountId: 'account-a', accountActor: actor,
            producerV1: { v: 1, kind: 'agent', sessionId: 'other-answerer' }, replyTarget: { kind: 'message', messageId: 'question' },
            content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Other private answer' }] } }, mentionedAccountIds: [], createdAt: 4 }] : []),
    ];
    home.answer(serverId, `/v1/discussions/${discussionId}/messages`, { select: (_input, request) => {
        const query = new URL(request.url).searchParams;
        const messageId = query.get('messageId');
        const frontier = extraAnswer ? 4 : 3;
        const messageSeq = Math.min(frontier, Number(query.get('throughSeq') ?? frontier));
        return { body: { messages: messages.filter(message => message.seq <= messageSeq
            && (messageId === null || message.id === messageId)), hasMoreOlder: false, messageSeq } };
    } });
    return discussionId;
}

describe('WorkflowEditorHostScreen saved-entry intents', () => {
    it.each(['builtin', 'external-plugin'] as const)('reviews, seeds and saves the identical authored %s run definition', async sourceKind => {
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { useDiscussionWorkflowCapture } = await import('@/components/discussions/useDiscussionWorkflowCapture');
        const { DiscussionPatternCapturePanel } = await import('@/components/discussions/DiscussionPatternCapturePanel');
        const { Text } = await import('@/components/ui/text/Text');
        const { projectWorkflowPluginSourceV1, resolveBuiltinWorkflowDefinitionV1, materializeWorkflowAcceptedSnapshotV1 } = await import('@happier-dev/protocol/workflows');
        const { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } = await import('@happier-dev/protocol/actions/actionCatalog');
        const { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } = await import('@happier-dev/protocol/workflows/workflowStoredContentV1');
        const { WorkflowRunRecipientCensusResponseV1Schema } = await import('@happier-dev/protocol/workflows/workflowRunKeyV1');
        const { createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        const { projectWorkflowFlow } = await import('../flow/workflowFlowProjection');
        const { readWorkflowDefinitionDraftSeed } = await import('@/sync/domains/workflows/workflowDefinitionDraftSeed');
        const participants = ['answerer', 'reviewer'].map(sessionId => ({ kind: 'session' as const, session: { serverId, sessionId } }));
        const plugin = projectWorkflowPluginSourceV1({ pluginId: 'com.acme.patterns', pluginVersion: '1.0.0',
            definition: { id: 'opinions', title: 'Independent review', definition: createWorkflowDefinitionFixture({
                version: 1, defaults: {}, inputs: [{ name: 'question', valueType: 'string', required: true },
                    { name: 'participants', valueType: 'json', multiple: true, required: true, inputType: { hostType: 'agentParticipant' } }],
                blocks: [{ kind: 'loop', id: 'plugin-answers', name: 'Independent plugin answers',
                    repetition: { kind: 'items', items: { kind: 'input', name: 'participants' }, execution: 'parallel', failurePolicy: 'collect_outcomes' },
                    body: [{ kind: 'step', id: 'plugin-answer', name: 'Plugin answer',
                        document: { text: 'Answer independently', references: [], attachments: [] },
                        execution: { participant: { kind: 'item', field: 'value' } }, input: [{ kind: 'input', name: 'question' }], result: { kind: 'text' } }] }],
            }) } });
        const catalog = sourceKind === 'builtin' ? resolveBuiltinWorkflowDefinitionV1('fresh-opinions')! : plugin;
        const ref = sourceKind === 'builtin' ? 'builtin:fresh-opinions' : plugin.workflow;
        const run = createWorkflowRunSummaryFixture({ id: 'captured-run', ownerAccountId: 'account-a', origin: { kind: 'direct' } });
        const discussionId = await answerCaptureDiscussion(run.id);
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('missing_account_scope');
        const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: catalog.definition, admission: { kind: 'user' },
            context: { source: { kind: 'catalog', ref, version: catalog.version }, inputs: { question: 'Compare', participants },
                machineId: run.machineId, executionTarget: { kind: 'session' },
                workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct', discussion: { discussion: { serverId, discussionId }, messageId: 'question', throughSeq: 3 } },
                authorization: { principal: { kind: 'host' } } },
            effects: { resolveTargetAvailability: async () => true,
                resolveSessionTarget: async value => typeof value === 'object' && value !== null && !Array.isArray(value)
                    && 'sessionId' in value && typeof value.sessionId === 'string'
                    ? { address: { serverId, sessionId: value.sessionId }, machineId: run.machineId } : null,
                readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(id as Parameters<typeof getActionSpec>[0]))),
            } });
        if (!accepted.ok) throw new Error(`fixture_materialization_failed:${accepted.error.code}`);
        const authored = accepted.snapshot.authoredDefinition;
        const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: run.ownerAccountId, runId: run.id }, acceptedSnapshot: accepted.snapshot }));
        const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: run.ownerAccountId,
            access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
            ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
        home.answer(serverId, '/v3/automations/runs/workflow-storage', { select: input => {
            if (!input || typeof input !== 'object' || !('operation' in input)) throw new Error('Expected the real storage request');
            if (input.operation === 'get') return { body: { run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null, keyCensus } };
            if (input.operation === 'invocations.list') return { body: { invocations: [], parentRevision: run.revision,
                keyCensus, progressEnvelopesByInvocationId: {} } };
            if (input.operation === 'run-key.census') return { body: keyCensus };
            throw new Error(`Unexpected storage operation:${input.operation}`);
        } });
        let capture: ReturnType<typeof useDiscussionWorkflowCapture> | undefined;
        function Harness() {
            capture = useDiscussionWorkflowCapture({ discussion: { serverId, discussionId }, accountLifetime: lifetime! });
            return <DiscussionPatternCapturePanel capture={capture} anchorRef={React.useRef(null)} discussionTitle="Compare"
                messages={[]} accountLifetime={lifetime!} />;
        }
        const review = await renderScreen(<Harness />);
        await act(async () => { await capture!.open(['question', 'answer']); });
        expect(capture!.state.error).toBeNull();
        expect(capture!.state.draft?.definition).toEqual(authored);
        const assertReviewedBlocks = () => {
            const expected = projectWorkflowFlow(capture!.state.draft!.definition!).nodes;
            for (const node of expected) {
                const row = review.findHostByTestId(`discussion-pattern-capture-step:${node.nodeId}`);
                expect(row).not.toBeNull();
                expect(findTestInstanceByTypeContainingText(row!, Text, node.label)).toBeDefined();
            }
            // Deliberately different message-derived steps must never substitute for the authored body.
            expect(review.findByTestId('discussion-pattern-capture-step:answer:header')).toBeNull();
            expect(review.findByTestId('discussion-pattern-capture-step:question')).toBeNull();
        };
        assertReviewedBlocks();
        expect(review.findByTestId('discussion-pattern-capture-ask:participants')).not.toBeNull();
        expectNoWorkflowWrites();
        await review.pressByTestIdAsync('discussion-pattern-capture-open-editor');
        const route = pushSpy().mock.calls.at(-1)?.[0] as { params: { definitionDraftSeedId: string } };
        expect(readWorkflowDefinitionDraftSeed(route.params.definitionDraftSeedId, lifetime.scope)?.definition).toEqual(authored);
        const editor = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', definitionDraftSeedId: route.params.definitionDraftSeedId }} />,
            { wrapper: EditorPaneWrapper });
        await editor.pressByTestIdAsync('workflow-editor-save');
        const { listWorkflowDefinitions, getWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        const saved = (await listWorkflowDefinitions()).definitions.find(row => row.metadata?.title === 'Compare');
        if (!saved) throw new Error('missing_saved_capture');
        const stored = await getWorkflowDefinition({ definitionId: saved.definitionId });
        expect(stored.definition).toEqual(authored);
        expect(stored.metadata.captureProvenance?.workflow?.source).toMatchObject({ kind: 'catalog', ref, version: catalog.version });
        await editor.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: saved.definitionId }} />);
        const { WorkflowBlockListEditor } = await import('../editor/WorkflowBlockListEditor');
        const reopened = editor.findAllByType(WorkflowBlockListEditor).find(row => row.props.list.kind === 'root');
        expect(reopened?.props.blocks).toEqual(authored.blocks);
        expect(reopened?.props.draft.inputs).toEqual(authored.inputs);
    });
    it('reviews an authorized Discussion capture before editor handoff and retains source attribution on save', async () => {
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { useDiscussionWorkflowCapture } = await import('@/components/discussions/useDiscussionWorkflowCapture');
        const discussionId = await answerCaptureDiscussion();
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('missing_account_scope');
        const hook = await renderHook(() => useDiscussionWorkflowCapture({ discussion: { serverId, discussionId }, accountLifetime: lifetime }));
        await act(async () => { await hook.getCurrent().open(['question', 'answer', 'unlinked-human']); });
        expect(hook.getCurrent().state.error).toBeNull();
        expect(hook.getCurrent().state).toMatchObject({ status: 'review', draft: { status: 'needs_review', definition: null,
            unresolved: [{ messageId: 'unlinked-human', reason: 'unlinked_message' }] } });
        expect(hook.getCurrent().canOpenEditor).toBe(false);
        await act(async () => { hook.getCurrent().openEditor(); });
        expect(pushSpy()).not.toHaveBeenCalled();
        expectNoWorkflowWrites();
        await act(async () => { await hook.getCurrent().review({ choices: [{ messageId: 'unlinked-human', role: 'exclude' }] }); });
        expect(hook.getCurrent().state).toMatchObject({ status: 'review', draft: { status: 'ready' } });
        // The name typed in the review panel names the unsaved editor draft; the graph is unchanged.
        await act(async () => { hook.getCurrent().openEditor({ name: '  Retry policy check ' }); });
        const route = pushSpy().mock.calls.at(-1)?.[0] as { pathname: string; params: { definitionDraftSeedId: string } };
        expect(route).toMatchObject({ pathname: '/workflows/[id]', params: { id: 'new' } });
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', definitionDraftSeedId: route.params.definitionDraftSeedId }} />,
            { wrapper: EditorPaneWrapper });
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('Retry policy check');
        expect(screen.findByTestId('workflow-editor-step-step_1')).not.toBeNull();
        expectNoWorkflowWrites();
        expect(screen.findByTestId('workflow-editor-save')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-save')?.props.disabled).not.toBe(true);
        // A failed revision retains the last draft for recovery, but reopening
        // must not silently approve it as the newly requested capture.
        home.answer(serverId, `/v1/discussions/${discussionId}/messages`, { status: 403, body: { error: 'discussion_read_denied' } });
        await act(async () => { await hook.getCurrent().review({ name: 'Revised capture' }); });
        expect(hook.getCurrent().state).toMatchObject({ status: 'failed', draft: { status: 'ready' } });
        await act(async () => { hook.getCurrent().close(); });
        await act(async () => { await hook.getCurrent().open(); });
        expect(hook.getCurrent().state.status).toBe('failed');
        expect(hook.getCurrent().canOpenEditor).toBe(false);
        const navigations = pushSpy().mock.calls.length;
        await act(async () => { hook.getCurrent().openEditor(); });
        expect(pushSpy().mock.calls).toHaveLength(navigations);
        const { listWorkflowDefinitions, getWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        await screen.pressByTestIdAsync('workflow-editor-save');
        const created = (await listWorkflowDefinitions()).definitions.find(row => row.metadata?.title === 'Retry policy check');
        if (!created) throw new Error('missing_saved_capture');
        const captureProvenance = { discussion: { serverId, discussionId }, messages: expect.arrayContaining([
            expect.objectContaining({ source: { kind: 'discussion', discussion: { serverId, discussionId }, messageId: 'question' }, authorAccountId: 'account-a' }),
            expect.objectContaining({ source: { kind: 'discussion', discussion: { serverId, discussionId }, messageId: 'answer' }, participantSessionId: 'answerer' }),
        ]) };
        expect((await getWorkflowDefinition({ definitionId: created.definitionId })).metadata).toMatchObject({ captureProvenance });
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: created.definitionId }} />);
        await act(async () => { screen.changeTextByTestId('workflow-editor-name', 'Reused exchange'); });
        await screen.pressByTestIdAsync('workflow-editor-save');
        const reopened = await getWorkflowDefinition({ definitionId: created.definitionId });
        expect(reopened.metadata).toMatchObject({ title: 'Reused exchange', captureProvenance });
        expect(JSON.stringify(reopened.definition)).not.toContain(discussionId);
    });

    it('saves a duplicated definition immediately and rejects a missing handoff instead of offering a blank replacement', async () => {
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: DEFINITION_ID }} />,
            { wrapper: EditorPaneWrapper });
        const { WorkflowEditorBody } = await import('./WorkflowEditorBody');
        const duplicate = screen.findByType(WorkflowEditorBody).props.menuActions.find((action: { id: string }) => action.id === 'duplicate');
        await act(async () => { duplicate.onSelect(); });
        const route = pushSpy().mock.calls.at(-1)?.[0] as { params: { definitionDraftSeedId: string } };
        expect(route.params.definitionDraftSeedId).toBeTypeOf('string');
        expectNoWorkflowWrites();

        // Mis-bound producer handle: the real intake must refuse the source,
        // rather than presenting a different draft as the requested copy.
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'new', definitionDraftSeedId: 'missing-copy-seed' }} />);
        expect(screen.findByTestId('workflow-editor-save')).toBeNull();
        expect(screen.findAllByType(WorkflowEditorBody)).toHaveLength(0);
        expectNoWorkflowWrites();

        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'new', definitionDraftSeedId: route.params.definitionDraftSeedId }} />);
        expect(screen.findByTestId('workflow-editor-save')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-save')?.props.disabled).not.toBe(true);
        const title = screen.findByTestId('workflow-editor-name')?.props.value;
        await screen.pressByTestIdAsync('workflow-editor-save');
        const { listWorkflowDefinitions, getWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        const copies = (await listWorkflowDefinitions()).definitions.filter(row => row.definitionId !== DEFINITION_ID);
        expect(copies).toHaveLength(1);
        const copy = await getWorkflowDefinition({ definitionId: copies[0]!.definitionId });
        expect(copy.metadata.title).toBe(title);
        expect(copy.definition).toEqual(savedDefinition().definition);
    });

    it('Save as pattern review chooses messages in thread order, keeps each choice, and opens the named draft', async () => {
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { useDiscussionWorkflowCapture } = await import('@/components/discussions/useDiscussionWorkflowCapture');
        const { DiscussionPatternCapturePanel } = await import('@/components/discussions/DiscussionPatternCapturePanel');
        const discussionId = await answerCaptureDiscussion(undefined, true);
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('missing_account_scope');
        const captureRef: { current: ReturnType<typeof useDiscussionWorkflowCapture> | null } = { current: null };
        const messages = [{ id: 'question', author: 'Ana', text: 'Compare the proposals' },
            { id: 'answer', author: 'Reviewer', text: 'Private answer prose' },
            { id: 'unlinked-human', author: 'Ana', text: 'Separate human note' },
            { id: 'other-answer', author: 'Other reviewer', text: 'Other private answer' }];
        function Harness() {
            const capture = useDiscussionWorkflowCapture({ discussion: { serverId, discussionId }, accountLifetime: lifetime! });
            captureRef.current = capture;
            const anchor = React.useRef(null);
            return <DiscussionPatternCapturePanel capture={capture} anchorRef={anchor} discussionTitle="Compare the proposals"
                messages={messages} accountLifetime={lifetime!} />;
        }
        const screen = await renderScreen(<Harness />);
        await act(async () => { await captureRef.current!.open(); });
        for (const id of ['unlinked-human', 'answer', 'question', 'other-answer']) await screen.pressByTestIdAsync(`discussion-pattern-capture-message:${id}`);
        await screen.pressByTestIdAsync('discussion-pattern-capture-review');
        expect(captureRef.current!.state).toMatchObject({ status: 'review', request: { messageIds: ['question', 'answer', 'unlinked-human', 'other-answer'] },
            draft: { status: 'needs_review' } });
        // The answer is settled first; settling the unresolved note must keep that earlier choice.
        await screen.pressByTestIdAsync('discussion-pattern-capture-step:answer:header');
        await screen.pressByTestIdAsync('discussion-pattern-capture-role:answer:step');
        await screen.pressByTestIdAsync('discussion-pattern-capture-role:unlinked-human:exclude');
        expect(captureRef.current!.state.request?.choices).toEqual(expect.arrayContaining([
            expect.objectContaining({ messageId: 'answer', role: 'step' }),
            expect.objectContaining({ messageId: 'unlinked-human', role: 'exclude' })]));
        expect(captureRef.current!.state).toMatchObject({ status: 'review', draft: { status: 'ready' } });
        expectNoWorkflowWrites();
        // The name is an editable, prefilled value (the Discussion's title), not an empty field behind a placeholder.
        expect(screen.findByTestId('discussion-pattern-capture-name')?.props.value).toBe('Compare the proposals');
        // Resolved review reads the executable draft, including its declared per-run inputs.
        expect(screen.findByTestId('discussion-pattern-capture-step:step_1')).not.toBeNull();
        const answerAsked = () => captureRef.current!.state.draft!.definition!.inputs.find(input => input.name === 'participants')!.required;
        const askedBefore = answerAsked();
        await screen.pressByTestIdAsync('discussion-pattern-capture-ask:participants');
        expect(answerAsked()).toBe(!askedBefore);
        expect(captureRef.current!.state.draft!.steps.filter(step => step.role === 'step').map(step => step.perRun))
            .toEqual([false, false]);
        await act(async () => { screen.changeTextByTestId('discussion-pattern-capture-name', 'Proposal check'); });
        await screen.pressByTestIdAsync('discussion-pattern-capture-open-editor');
        const route = pushSpy().mock.calls.at(-1)?.[0] as { pathname: string; params: { definitionDraftSeedId: string } };
        expect(route).toMatchObject({ pathname: '/workflows/[id]', params: { id: 'new' } });
        expect(captureRef.current!.state.status).toBe('closed');
        const editor = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', definitionDraftSeedId: route.params.definitionDraftSeedId }} />,
            { wrapper: EditorPaneWrapper });
        expect(editor.findByTestId('workflow-editor-name')?.props.value).toBe('Proposal check');
        expectNoWorkflowWrites();
    });
    it('inserts an example into the current draft as one undoable change without saving or running', async () => {
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />, { wrapper: EditorPaneWrapper });
        await screen.pressByTestIdAsync('workflow-editor-add-root-examples');
        await reportCollectionLayout(screen, 'workflow-examples:cards');
        await screen.pressByTestIdAsync('workflow-examples:morning-digest:use');
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('workflows.examples.morningDigest.title');
        expect(screen.findByTestId('workflow-editor-step-digest')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-undo');
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('');
        expect(screen.findByTestId('workflow-editor-step-digest')).toBeNull();
        expectNoWorkflowWrites();
    });
    it('opens a catalog example as an unsaved draft and keeps edits across rerenders', async () => {
        const { WORKFLOW_STARTER_EXAMPLES_V1} = await import('@happier-dev/protocol/workflows/builtins/examples');
        const example = WORKFLOW_STARTER_EXAMPLES_V1.find((entry) => entry.key === 'morning-digest')!;
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', exampleKey: example.key }} />,
            { wrapper: EditorPaneWrapper });
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe(example.titleKey);
        expectNoWorkflowWrites();
        await act(async () => { screen.changeTextByTestId('workflow-editor-name', 'My morning digest'); });
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'new', exampleKey: example.key }} />);
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('My morning digest');
    });
    it('opens the definition and triggers nothing when the entry was Edit', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: DEFINITION_ID }} />, { wrapper: EditorPaneWrapper });
        await act(async () => {});

        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('Release check');
        expect(visibleModals()).toHaveLength(0);
        expect(pushSpy()).not.toHaveBeenCalled();
        expectNoWorkflowWrites();
    });

    it('collects declared inputs through the Run-now owner for a Run intent', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderScreen(
            <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: DEFINITION_ID, intent: 'run' }} />,
            { wrapper: EditorPaneWrapper },
        );
        await act(async () => {});

        // The reviewed revision is what the person sees and runs; the intent does
        // not replace the hydrated draft with a fresh one.
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('Release check');
        const composers = screen.findAllByType(WorkflowRunComposer);
        expect(composers).toHaveLength(1);
        expect(composers[0]?.props.inputs).toMatchObject([{ name: 'topic', required: true }]);
        // A required declared input is blocking, so nothing is admitted yet and
        // no Automation is written.
        expectNoWorkflowWrites();
        expect(pushSpy()).not.toHaveBeenCalled();
    });

    it('opens the page settings for a Schedule intent without creating an Automation', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const source = { kind: 'saved', definitionId: DEFINITION_ID, intent: 'schedule' } as const;
        const screen = await renderScreen(<WorkflowEditorHostScreen source={source} />, { wrapper: EditorPaneWrapper });
        await act(async () => {});

        expect(pushSpy()).not.toHaveBeenCalled();
        expect(settingsModal()).toBeDefined();
        expectNoWorkflowWrites();

        // A rerender of the same logical source is not a second Schedule.
        await screen.update(<WorkflowEditorHostScreen source={{ ...source }} />);
        await act(async () => {});
        expect(pushSpy()).not.toHaveBeenCalled();
    });

    it('consumes a new saved-row intent when the same mounted route changes definition', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderScreen(
            <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: DEFINITION_ID, intent: 'schedule' }} />,
            { wrapper: EditorPaneWrapper },
        );
        await act(async () => {});
        expect(settingsModal()).toBeDefined();
        await screen.pressByTestIdAsync('modal-card-close');
        expect(settingsModal()).toBeUndefined();

        await createWorkflowDefinition({ definitionId: SECOND_DEFINITION_ID, definition: savedDefinition().definition,
            metadata: { title: 'Second release check' } });
        await screen.update(
            <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SECOND_DEFINITION_ID, intent: 'schedule' }} />,
        );
        await act(async () => {});

        // A route rerender is not another press, but a different definition is
        // a distinct row action and must reach the Schedule owner once.
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('Second release check');
        expect(settingsModal()).toBeDefined();
        expect(pushSpy()).not.toHaveBeenCalled();
    });
});
