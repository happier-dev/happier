/**
 * Identity-stability contract for the transcript item renderer.
 *
 * FlashList view holders bail out of re-rendering only when `renderItem` keeps its
 * identity (ViewHolder memo compares it with ===). ChatList re-renders on every
 * transcript apply, passing a fresh `props` object literal whose FIELDS are stable;
 * the renderer must derive its identity from the fields it actually uses, not from
 * the containing object.
 */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ExternalSessionOperationProgressV1Schema,
    ExternalSessionOperationResumeInputV1Schema,
    ExternalSessionOperationRetryInputV1Schema,
    ExternalSessionOperationCancelInputV1Schema,
    ExternalSessionOperationDiscardInputV1Schema,
    type ExternalSessionOperationProgressV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ApprovalRequestV1Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';
import { listTranscriptApprovalArtifactsForSession, type OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { ToolCallsGroupUnitToolRowWithSessionCommon } from '../toolCalls/units/ToolCallsGroupUnitToolRow';

import type { ChatListItem } from '@/components/sessions/chatListItems';

const resumeOperationSpy = vi.hoisted(() => vi.fn());
const retryOperationSpy = vi.hoisted(() => vi.fn());
const cancelOperationSpy = vi.hoisted(() => vi.fn());
const discardOperationSpy = vi.hoisted(() => vi.fn());

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(async (request) => {
        const operation = request.method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME
            ? { schema: ExternalSessionOperationResumeInputV1Schema, transport: resumeOperationSpy }
            : request.method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RETRY
                ? { schema: ExternalSessionOperationRetryInputV1Schema, transport: retryOperationSpy }
                : request.method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_CANCEL
                    ? { schema: ExternalSessionOperationCancelInputV1Schema, transport: cancelOperationSpy }
                    : request.method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_DISCARD
                        ? { schema: ExternalSessionOperationDiscardInputV1Schema, transport: discardOperationSpy }
                        : null;
        if (!operation) throw new Error(`Unexpected external operation RPC ${request.method}`);
        return operation.transport({ machineId: request.machineId, ...operation.schema.parse(request.payload) }, {
            serverId: request.serverId,
        });
    });
});

import { createMachineFixture, createSessionFixture, flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getForkedTranscriptSnapshotCached } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createTranscriptMeasurementReconciler } from '@/components/sessions/transcript/measurement/transcriptMeasurementReconciler';
import { buildTranscriptRowShellSignature } from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import { createReducer } from '@happier-dev/session-core/reducer';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';

import { TranscriptRowShell } from '@/components/sessions/transcript/ChatListRows';
import { PendingMessagesTranscriptBlock } from '@/components/sessions/pending/PendingMessagesTranscriptBlock';
import { TranscriptWindowGapRow } from '@/components/sessions/transcript/viewport/window/TranscriptWindowGapRow';
import { ExternalSessionOperationSharedCard } from '@/components/sessions/external/progress/ExternalSessionOperationSharedCard';
import { TranscriptLiveMessagesRowShell } from './TranscriptLiveMessagesRowShell';
import { useTranscriptItemRenderer, type TranscriptItemRendererDeps } from './useTranscriptRowHost';

function createRef<T>(current: T): { current: T } {
    return { current };
}

type ExternalSessionOperationItem = Extract<ChatListItem, { kind: 'external-session-operation' }>;

function createExternalSessionOperationProgress(input: Readonly<{
    operationId: string;
    status: ExternalSessionOperationProgressV1['status'];
    phase: ExternalSessionOperationProgressV1['phase'];
}>): ExternalSessionOperationProgressV1 {
    return ExternalSessionOperationProgressV1Schema.parse({
        v: 1,
        operationId: input.operationId,
        revision: 1,
        request: {
            plan: 'materialize',
            targetStorageMode: 'external-linked',
            targetRuntimeMode: null,
        },
        status: input.status,
        phase: input.phase,
        timeline: ['validating', 'staging', 'importing', 'publishing'],
        updatedAtMs: 1,
        priorStableStorage: { state: 'machine_only' },
        currentStorageState: input.status === 'completed' ? 'snapshot_complete' : 'machine_only',
        checkpoint: {
            sourcePagesRead: 0,
            stagedItemCount: 0,
            importedItemCount: 0,
            requiredItemFailures: {
                total: 0,
                record: 0,
                media: 0,
                conversion: 0,
                diagnosticsTruncated: false,
            },
        },
        fence: { kind: 'none' },
        ...(input.status === 'completed' ? {
            publication: {
                materializationPublicationId: `publication-${input.operationId}`,
                materializedThroughSourceAt: 1,
                publishedThroughServerSeq: 0,
            },
        } : {}),
    });
}

function createRendererProps(overrides?: Partial<TranscriptItemRendererDeps['props']>): TranscriptItemRendererDeps['props'] {
    return {
        sessionId: 's1',
        sessionSurfaceKey: 'surface-s1',
        sessionActive: true,
        sessionThinking: false,
        groupingMode: 'linear',
        items: [],
        maxTurnEntriesPerListItem: 1,
        transcriptNavigationEntries: [],
        eventEmphasisByMessageId: {},
        hostWakeCountByMessageId: {},
        committedMessagesCount: 0,
        latestCommittedActivityKey: null,
        isLoaded: true,
        forkMessageMetadataById: null,
        metadata: null,
        interaction: {
            canSendMessages: true,
            canApprovePermissions: true,
        },
        approvalRequests: [],
        messagePins: [],
        onToggleMessagePin: vi.fn(),
        onEditPendingMessage: vi.fn(),
        onDismissExternalSessionOperation: vi.fn(),
        onDismissPluginTranscriptActivity: vi.fn(),
        onOpenPluginTranscriptActivityAction: vi.fn(),
        onCheckAgainExternalSessionOperation: null,
        onExternalSessionOperationActionResult: vi.fn(),
        externalSessionOperationOwnerTarget: null,
        forkCommon: { ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null },
        messageDisplayCommon: { ...settingsDefaults, workspacePath: null, debugInformationEnabled: false },
        toolChromeCommon: settingsDefaults,
        toolRouteCommon: { messagesById: {}, reducerState: createReducer() },
        rollbackActionsByMessageId: {},
        rollbackRanges: [],
        messagesById: {},
        activeThinkingMessageId: null,
        forkedTranscriptEnabled: false,
        ...overrides,
    };
}

function createRendererDeps(props: TranscriptItemRendererDeps['props']): TranscriptItemRendererDeps {
    const items: readonly never[] = [];
    return {
        buildRowShellSignature: (item) => buildTranscriptRowShellSignature({
            item, activeThinkingMessageId: null, expandedToolCallsAnchorMessageIds: new Set(),
            forkMessageMetadataById: props.forkMessageMetadataById, getMessageById: () => null,
            getMessageRevisionById: () => 1, groupingMode: 'linear', latestCommittedActivityKey: null,
            resolveActionDraftFieldOptions: () => [], resolveThinkingExpanded: () => false,
            sessionActive: props.sessionActive, widthBucket: 'w', fontScaleKey: 'default',
        }),
        expandedToolCallsAnchorMessageIds: new Set<string>(),
        getMessageById: vi.fn(() => null),
        getMessageRevisionById: vi.fn(() => 1),
        handleRowLayoutMutation: vi.fn(),
        handleRowShellMeasured: vi.fn(),
        itemsRef: createRef(items),
        listData: items,
        listOrientation: 'standard',
        measurementReconciler: createTranscriptMeasurementReconciler(),
        props,
        resolveKindForMessageId: vi.fn(() => null),
        resolveThinkingExpanded: vi.fn(() => false),
        returnFocusToTranscriptViewport: vi.fn(),
        resolveToolCallMessagesForIds: vi.fn(() => []),
        setThinkingExpanded: vi.fn(),
        setToolCallsGroupExpanded: vi.fn(),
        toolTimelineChromeMode: 'cards',
        toolRouteCommon: props.toolRouteCommon,
    };
}

describe('useTranscriptItemRenderer identity stability', () => {
    beforeEach(() => {
        resumeOperationSpy.mockReset();
        retryOperationSpy.mockReset();
        cancelOperationSpy.mockReset();
        discardOperationSpy.mockReset();
        getStorage().setState({ machines: { 'machine-1': createMachineFixture({ id: 'machine-1' }) } });
    });

    it('renders only the native-bound row on an approval arrival among 100 mounted tool rows', async () => {
        const home = await serveSessionActionHome();
        const store = getStorage();
        const previous = store.getState();
        const sessionId = 'row-host-approval-cost';
        const target = { serverId: home.serverId, sessionId };
        const messages = Array.from({ length: 100 }, (_, index) => createToolCallMessageFixture({
            id: `message-${index}`, tool: { ...createToolCallMessageFixture().tool,
                id: `native-${index}`, name: 'mcp__happier__action_execute', state: 'completed',
                input: { actionId: 'session.list', input: {} }, result: { ok: true } },
        }));
        const artifacts = Array.from({ length: 13 }, (_, index) => {
            const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                createdBy: { surface: 'agent', sessionId }, requestedSurface: 'agent',
                actionId: 'session.list', actionArgs: {}, summary: 'List sessions',
                origin: { kind: 'transcript_tool_call', sessionId, toolCallId: `native-${index}` } });
            return { id: `row-host-approval-${index}`, isDecrypted: true as const, title: approval.summary,
                header: buildApprovalRequestArtifactHeaderV1(approval, { legacyServerId: home.serverId }),
                body: JSON.stringify(approval), headerVersion: 1, bodyVersion: 1, seq: index, createdAt: 1, updatedAt: 1 };
        });
        const toolMessageIds = messages.map(message => message.id);
        const items = messages.map(message => ({ kind: 'tool-group-tool' as const,
            id: `unit-${message.id}`, toolMessageId: message.id, toolMessageIds,
            groupId: 'group', expanded: true, createdAt: 1, seq: message.seq ?? null }));
        const messagesById = Object.fromEntries(messages.map(message => [message.id, message]));
        const props = createRendererProps({ sessionId, messagesById,
            toolRouteCommon: { messagesById, reducerState: createReducer() } });
        const deps = { ...createRendererDeps(props), listData: items, itemsRef: createRef(items),
            getMessageById: (id: string) => messagesById[id] ?? null };
        function Rows(input: { approvals: readonly OpenApprovalArtifactForSession[]; reversed?: boolean }) {
            const renderer = useTranscriptItemRenderer({ ...deps, props: { ...props, approvalRequests: input.approvals } });
            return <>{(input.reversed ? [...items].reverse() : items).map((item, index) =>
                <React.Fragment key={item.id}>{renderer.renderItem({ item, index })}</React.Fragment>)}</>;
        }
        // Call-through on React's actual memo render: no replacement row, matcher or approval policy.
        const unit = ToolCallsGroupUnitToolRowWithSessionCommon as React.MemoExoticComponent<
            React.FunctionComponent<React.ComponentProps<typeof ToolCallsGroupUnitToolRowWithSessionCommon>>>;
        const render = vi.spyOn(unit, 'type');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            store.getState().applySessions([createSessionFixture({ id: sessionId, serverId: home.serverId })]);
            const approvals = listTranscriptApprovalArtifactsForSession(artifacts.slice(0, 12), target);
            const view = (requests: readonly OpenApprovalArtifactForSession[], reversed = false) =>
                <AppSessionTranscriptSourceProvider sessionId={sessionId}><Rows approvals={requests} reversed={reversed} /></AppSessionTranscriptSourceProvider>;
            screen = await renderScreen(view(approvals));
            expect(new Set(render.mock.calls.map(([input]) => input.message.id)).size).toBe(100);
            render.mockClear();
            const arrived = listTranscriptApprovalArtifactsForSession(artifacts, target);
            await screen.update(view(arrived));
            expect(render.mock.calls.map(([input]) => input.message.id)).toEqual(['message-12']);
            expect(screen.tree.findAllByType(unit).find(row => row.props.message.id === 'message-12')?.props.approvalRequests)
                .toEqual([arrived[12]]);
            // Recycler position is not an association key; retained matches survive reorder/withdrawal.
            render.mockClear();
            await screen.update(view(arrived, true));
            expect(render).not.toHaveBeenCalled();
            await screen.update(view(approvals, true));
            expect(render.mock.calls.map(([input]) => input.message.id)).toEqual(['message-12']);
        } finally {
            await screen?.unmount();
            render.mockRestore();
            store.setState(previous);
            await home.dispose();
        }
    });

    it('does not rerender the row renderer for unrelated machine publications', async () => {
        let renders = 0;
        const deps = createRendererDeps(createRendererProps());
        const hook = await renderHook(() => {
            renders += 1;
            return useTranscriptItemRenderer(deps);
        });
        const baseline = renders;
        await act(async () => getStorage().setState({ machines: {
            'machine-1': createMachineFixture({ id: 'machine-1', active: false }),
        } }));
        expect(renders).toBe(baseline);
        await hook.unmount();
    });

    it('keeps 100 mounted tool rows local across message batches and updates only the changed result', async () => {
        const home = await serveSessionActionHome();
        const store = getStorage();
        const previous = store.getState();
        const sessionId = 'row-host-message-cost';
        const calls: NormalizedMessage[] = Array.from({ length: 100 }, (_, index) => ({
            id: `call-${index}`, seq: index + 1, localId: null, createdAt: index + 1,
            role: 'agent', isSidechain: false,
            content: [{ type: 'tool-call', id: `native-${index}`, name: 'Bash', input: { command: `echo ${index}` },
                description: null, uuid: `call-${index}`, parentUUID: null }],
        }));
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        // Observe React's real memo boundary; the row, live source and reducer all execute.
        const unit = ToolCallsGroupUnitToolRowWithSessionCommon as React.MemoExoticComponent<
            React.FunctionComponent<React.ComponentProps<typeof ToolCallsGroupUnitToolRowWithSessionCommon>>>;
        const render = vi.spyOn(unit, 'type');
        try {
            store.getState().applySessions([createSessionFixture({ id: sessionId, serverId: home.serverId })]);
            store.getState().applyMessages(sessionId, calls);
            const initial = store.getState().sessionMessages[sessionId]!;
            const toolMessageIds = initial.messageIdsOldestFirst;
            const items = toolMessageIds.map(id => ({ kind: 'tool-group-tool' as const,
                id: `unit-${id}`, toolMessageId: id, toolMessageIds, groupId: 'group', expanded: true,
                createdAt: initial.messagesById[id]!.createdAt, seq: initial.messagesById[id]!.seq ?? null }));
            const props = createRendererProps({ sessionId });
            const deps = { ...createRendererDeps(props), listData: items, itemsRef: createRef(items),
                getMessageById: (id: string) => store.getState().sessionMessages[sessionId]?.messagesById[id] ?? null };
            function Rows() {
                const source = useSessionTranscriptSource();
                const messagesById = source.useMessagesById();
                const reducerState = source.useReducerState();
                const toolRouteCommon = React.useMemo(() => ({ messagesById, reducerState }), [messagesById, reducerState]);
                const renderer = useTranscriptItemRenderer({ ...deps, toolRouteCommon,
                    props: { ...props, messagesById, toolRouteCommon } });
                return <>{items.map((item, index) =>
                    <React.Fragment key={item.id}>{renderer.renderItem({ item, index })}</React.Fragment>)}</>;
            }
            screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId={sessionId}><Rows /></AppSessionTranscriptSourceProvider>);
            expect(new Set(render.mock.calls.map(([input]) => input.message.id)).size).toBe(100);
            render.mockClear();
            await act(async () => {
                store.getState().applyMessages(sessionId, [{ id: 'new-text', seq: 101, localId: null, createdAt: 101,
                    role: 'agent', isSidechain: false,
                    content: [{ type: 'text', text: 'Unrelated streaming batch', uuid: 'new-text', parentUUID: null }] }]);
            });
            expect(render.mock.calls.map(([input]) => input.message.id)).toEqual([]);
            render.mockClear();
            await act(async () => {
                store.getState().applyMessages(sessionId, [{ id: 'result-12', seq: 102, localId: null, createdAt: 102,
                    role: 'agent', isSidechain: false,
                    content: [{ type: 'tool-result', tool_use_id: 'native-12', content: 'row-local result',
                        is_error: false, uuid: 'result-12', parentUUID: null }] }]);
            });
            expect(render.mock.calls.map(([input]) => input.message.tool.id)).toEqual(['native-12']);
            expect(render.mock.calls[0]?.[0].message.tool.result).toBe('row-local result');
        } finally {
            await screen?.unmount();
            render.mockRestore();
            store.setState(previous);
            await home.dispose();
        }
    });

    it('keeps renderItem identity when a fresh props object carries unchanged fields', async () => {
        const stableFieldValues = createRendererProps();
        const baseDeps = createRendererDeps(stableFieldValues);
        const hook = await renderHook(
            ({ props }: { props: TranscriptItemRendererDeps['props'] }) =>
                useTranscriptItemRenderer({ ...baseDeps, props }),
            { initialProps: { props: stableFieldValues } },
        );

        const first = hook.getCurrent().renderItem;
        // Fresh object literal, identical field values/identities — the ChatList re-render shape.
        await hook.rerender({ props: { ...stableFieldValues } as TranscriptItemRendererDeps['props'] });
        const second = hook.getCurrent().renderItem;

        expect(second).toBe(first);
    });

    it('changes renderItem identity when a used field actually changes', async () => {
        const initial = createRendererProps();
        const baseDeps = createRendererDeps(initial);
        const hook = await renderHook(
            ({ props }: { props: TranscriptItemRendererDeps['props'] }) =>
                useTranscriptItemRenderer({ ...baseDeps, props }),
            { initialProps: { props: initial } },
        );

        const first = hook.getCurrent().renderItem;
        await hook.rerender({
            props: { ...initial, interaction: { ...initial.interaction, canSendMessages: false } },
        });
        const second = hook.getCurrent().renderItem;

        expect(second).not.toBe(first);
    });

    it('keeps a retained pending-row edit handler current without invalidating unchanged rows', async () => {
        const initial = createRendererProps();
        const baseDeps = createRendererDeps(initial);
        const hook = await renderHook(
            ({ props }: { props: TranscriptItemRendererDeps['props'] }) => useTranscriptItemRenderer({ ...baseDeps, props }),
            { initialProps: { props: initial } },
        );
        const first = hook.getCurrent().renderItem;
        const shell = first({ item: { kind: 'pending-queue', id: 'pending', pendingMessages: [], discardedMessages: [] }, index: 0 });
        if (!React.isValidElement<{ children: React.ReactNode }>(shell)) throw new Error('Missing pending shell');
        const enter = shell.props.children;
        if (!React.isValidElement<{ children: React.ReactNode }>(enter)) throw new Error('Missing pending enter wrapper');
        const block = enter.props.children;
        if (!React.isValidElement<React.ComponentProps<typeof PendingMessagesTranscriptBlock>>(block)
            || block.type !== PendingMessagesTranscriptBlock) throw new Error('Missing pending block');
        const latestEdit = vi.fn<NonNullable<TranscriptItemRendererDeps['props']['onEditPendingMessage']>>();
        await hook.rerender({ props: { ...initial, onEditPendingMessage: latestEdit } });
        expect(hook.getCurrent().renderItem).toBe(first);
        const { createPendingMessageFixture } = await import('@/dev/testkit');
        const message = createPendingMessageFixture();
        const request = { id: message.id, text: message.text, message, mode: 'edit' as const };
        await block.props.onEditPendingMessage?.(request);
        expect(latestEdit).toHaveBeenCalledWith(request);
        expect(initial.onEditPendingMessage).not.toHaveBeenCalled();
        await hook.rerender({ props: { ...initial, onEditPendingMessage: undefined } });
        expect(hook.getCurrent().renderItem).not.toBe(first);
        await hook.unmount();
    });

    it('keeps a synthetic gap in recycler geometry without publishing a viewport-anchor shell', async () => {
        const hook = await renderHook(() => useTranscriptItemRenderer(
            createRendererDeps(createRendererProps()),
        ));
        const row = hook.getCurrent().renderItem({
            item: {
                direction: 'older',
                id: 'transcript-window-gap:window-1:older',
                kind: 'transcript-window-gap',
            },
            index: 0,
        }) as { type: unknown; props: { gap?: unknown } };

        expect(row.type).toBe(TranscriptWindowGapRow);
        expect(row.type).not.toBe(TranscriptRowShell);
        expect(row.props.gap).toMatchObject({
            direction: 'older',
            id: 'transcript-window-gap:window-1:older',
        });
    });

    it('routes a forked tool group row subscription to each message origin session', async () => {
        const props = createRendererProps({
            forkedTranscriptEnabled: true,
            forkMessageMetadataById: {
                'tool-a': { originSessionId: 'origin-a', isReadOnlyContext: true },
                'tool-b': { originSessionId: 'origin-b', isReadOnlyContext: true },
            },
        });
        const hook = await renderHook(() => useTranscriptItemRenderer(createRendererDeps(props)));
        const row = hook.getCurrent().renderItem({
            item: {
                kind: 'tool-group-header',
                id: 'group-1#header',
                groupId: 'group-1',
                toolMessageIds: ['tool-a', 'tool-b'],
                expanded: false,
                hiddenCount: 0,
                createdAt: 1,
            },
            index: 0,
        }) as { type: unknown; props: { messageRefs: unknown } };

        expect(row.type).toBe(TranscriptLiveMessagesRowShell);
        expect(row.props.messageRefs).toEqual([
            { sessionId: 'origin-a', messageId: 'tool-a' },
            { sessionId: 'origin-b', messageId: 'tool-b' },
        ]);
    });

    it('keeps a linear fork child body current while preserving retained ancestor context', async () => {
        const home = await serveSessionActionHome();
        const store = getStorage();
        const previous = store.getState();
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        const parent = createSessionFixture({ id: 'linear-parent' });
        const child = createSessionFixture({ id: 'linear-child', metadata: {
            ...createSessionFixture().metadata!,
            forkV1: { v: 1, parentSessionId: parent.id, parentCutoffSeqInclusive: 1, createdAtMs: 2, strategy: 'replay' },
        } });
        const chunk = (text: string, tick: number): NormalizedMessage => ({
            id: 'linear-stream', seq: 2, localId: 'linear-stream', createdAt: 2,
            role: 'agent', isSidechain: false,
            content: [{ type: 'text', text, uuid: 'linear-stream', parentUUID: null }],
            meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentLocalId: 'linear-stream',
                segmentState: 'streaming', startedAtMs: 2, updatedAtMs: tick } },
        });
        try {
            store.getState().applySessions([parent, child]);
            store.getState().applyMessages(parent.id, [{ id: 'ancestor', seq: 1, localId: null, createdAt: 1,
                role: 'agent', isSidechain: false,
                content: [{ type: 'text', text: 'Retained ancestor reply', uuid: 'ancestor', parentUUID: null }],
            }]);
            store.getState().applyMessages(child.id, [chunk('Initial child reply', 2)]);
            store.getState().applyMessagesLoaded(parent.id);
            store.getState().applyMessagesLoaded(child.id);
            store.setState(state => ({ sessionMessagesHistoryStartLoaded: {
                ...state.sessionMessagesHistoryStartLoaded, [parent.id]: true, [child.id]: true,
            } }));
            const fork = getForkedTranscriptSnapshotCached(store.getState(), child.id, { textUpdates: false });
            if (!fork) throw new Error('Expected the real fork transcript');
            const items = fork.combinedMessageIdsOldestFirst.map((messageId) => ({
                kind: 'message' as const, id: `msg:${messageId}`, messageId,
                originSessionId: fork.messageOriginById[messageId]!.sessionId,
                isReadOnlyContext: fork.messageOriginById[messageId]!.isReadOnlyContext,
                createdAt: fork.combinedMessagesById[messageId]!.createdAt,
                seq: fork.combinedMessagesById[messageId]!.seq ?? null,
            }));
            const childId = items.find(item => item.originSessionId === child.id)!.messageId;
            const props = createRendererProps({
                sessionId: child.id, messagesById: fork.combinedMessagesById,
                forkedTranscriptEnabled: true,
                messageDisplayCommon: { ...settingsDefaults, workspacePath: null, debugInformationEnabled: false,
                    transcriptStreamingSmoothingEnabled: false, transcriptStreamingPartialOutputEnabled: true,
                    transcriptStreamingMarkdownRenderingEnabled: true },
            });
            const deps = { ...createRendererDeps(props), listData: items, itemsRef: createRef(items),
                getMessageById: (id: string) => fork.combinedMessagesById[id] ?? null,
                getMessageRevisionById: (id: string) => {
                    const origin = fork.messageOriginById[id]?.sessionId;
                    return origin ? store.getState().sessionMessages[origin]?.messageRevisionsById?.[id] ?? null : null;
                },
            };
            function Rows() {
                const renderer = useTranscriptItemRenderer(deps);
                return <>{items.map((item, index) => <React.Fragment key={item.id}>
                    {renderer.renderItem({ item, index })}
                </React.Fragment>)}</>;
            }
            screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId={child.id}><Rows /></AppSessionTranscriptSourceProvider>);
            const rendered = screen;
            const bodies = () => rendered.getTextContent();
            expect(bodies()).toContain('Initial child reply');
            expect(bodies()).toContain('Retained ancestor reply');
            await act(async () => {
                store.getState().applyMessages(child.id, [chunk('Updated child reply', 3)]);
                await flushHookEffects({ cycles: 2, turns: 2 });
            });
            expect(fork.combinedMessagesById[childId]).toMatchObject({ text: 'Initial child reply' });
            expect(bodies()).toContain('Updated child reply');
            await act(async () => {
                store.setState(state => {
                    const sessionMessages = { ...state.sessionMessages };
                    delete sessionMessages[parent.id];
                    return { sessionMessages };
                });
                await flushHookEffects({ cycles: 2, turns: 2 });
            });
            expect(bodies()).toContain('Retained ancestor reply');
        } finally {
            await screen?.unmount();
            store.setState(previous);
            await home.dispose();
        }
    });

    it('keeps pushed progress authoritative while a successful action waits for metadata publication', async () => {
        const onExternalSessionOperationActionResult = vi.fn();
        const initialProgress = {
            v: 1 as const,
            operationId: 'operation-1',
            revision: 1,
            request: {
                plan: 'takeover' as const,
                targetStorageMode: 'persisted' as const,
                targetRuntimeMode: 'terminal' as const,
            },
            status: 'awaiting_user_resume' as const,
            phase: 'validating' as const,
            timeline: [
                'validating',
                'quiescing',
                'staging',
                'importing',
                'final_catch_up',
                'admitting',
                'spawning',
                'finalizing',
            ] as const,
            updatedAtMs: 1,
            priorStableStorage: { state: 'machine_only' as const },
            currentStorageState: 'machine_only' as const,
            checkpoint: {
                sourcePagesRead: 0,
                stagedItemCount: 0,
                importedItemCount: 0,
                requiredItemFailures: {
                    total: 0,
                    record: 0,
                    media: 0,
                    conversion: 0,
                    diagnosticsTruncated: false,
                },
            },
            fence: { kind: 'none' as const },
            retryTargetPhase: 'validating' as const,
        };
        const nextProgress = {
            ...initialProgress,
            revision: 2,
            updatedAtMs: 2,
        };
        resumeOperationSpy.mockResolvedValue({
            ok: true,
            progress: nextProgress,
        });
        const hook = await renderHook(() => useTranscriptItemRenderer(
            createRendererDeps(createRendererProps({
                externalSessionOperationOwnerTarget: {
                    machineId: 'machine-1',
                    machineOnline: true,
                    machineStatusKnown: true,
                    serverId: 'server-1',
                },
                onExternalSessionOperationActionResult,
            })),
        ));
        const item = {
            kind: 'external-session-operation' as const,
            id: 'external-session-operation:operation-1',
            presentation: {
                v: 1 as const,
                operationId: 'operation-1',
                revision: 1,
                kind: 'takeover_persisted' as const,
                status: 'awaiting_user_resume' as const,
                phase: 'validating' as const,
            },
            progress: initialProgress,
            createdAt: 1,
        };

        const firstRow = hook.getCurrent().renderItem({ item, index: 0 }) as {
            props: { children: { props: { children: { props: Record<string, unknown> } } } };
        };
        const firstCard = firstRow.props.children.props.children;
        await act(async () => {
            await (firstCard.props.onResume as (
                ref: { operationId: string; revision: number },
            ) => Promise<void>)({
                operationId: 'operation-1',
                revision: 1,
            });
        });

        const nextRow = hook.getCurrent().renderItem({ item, index: 0 }) as {
            props: { children: { props: { children: { props: Record<string, unknown> } } } };
        };
        const nextCard = nextRow.props.children.props.children;
        expect(resumeOperationSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            sessionId: 's1',
            operationId: 'operation-1',
            revision: 1,
        }, { serverId: 'server-1' });
        expect(nextCard.props.progress).toMatchObject({
            operationId: 'operation-1',
            revision: 1,
        });
        expect(nextCard.props.observationContext).toBe('hydrated');
        expect(onExternalSessionOperationActionResult).toHaveBeenCalledWith(nextProgress);

        const publishedRow = hook.getCurrent().renderItem({
            item: {
                ...item,
                presentation: {
                    ...item.presentation,
                    revision: 2,
                },
                progress: nextProgress,
            },
            index: 0,
        }) as {
            props: { children: { props: { children: { props: Record<string, unknown> } } } };
        };
        expect(publishedRow.props.children.props.children.props.progress)
            .toMatchObject({ operationId: 'operation-1', revision: 2 });
        await hook.unmount();
    });

    it('delegates terminal-card dismissal to the mounted transcript owner with the exact revision', async () => {
        const onDismissExternalSessionOperation = vi.fn();
        const progress = {
            v: 1 as const,
            operationId: 'operation-terminal',
            revision: 7,
            request: {
                plan: 'materialize' as const,
                targetStorageMode: 'external-linked' as const,
                targetRuntimeMode: null,
            },
            status: 'completed' as const,
            phase: 'publishing' as const,
            timeline: [
                'validating',
                'staging',
                'importing',
                'publishing',
            ] as const,
            updatedAtMs: 1,
            priorStableStorage: { state: 'machine_only' as const },
            currentStorageState: 'snapshot_complete' as const,
            checkpoint: {
                sourcePagesRead: 1,
                stagedItemCount: 1,
                importedItemCount: 1,
                totalItemEstimate: 1,
                requiredItemFailures: {
                    total: 0,
                    record: 0,
                    media: 0,
                    conversion: 0,
                    diagnosticsTruncated: false,
                },
            },
            fence: { kind: 'none' as const },
            publication: {
                materializationPublicationId: 'publication-1',
                materializedThroughSourceAt: 1,
                publishedThroughServerSeq: 1,
            },
        };
        const hook = await renderHook(() => useTranscriptItemRenderer(
            createRendererDeps(createRendererProps({
                onDismissExternalSessionOperation,
            })),
        ));
        const row = hook.getCurrent().renderItem({
            item: {
                kind: 'external-session-operation',
                id: `external-session-operation:${progress.operationId}`,
                presentation: {
                    v: 1,
                    operationId: progress.operationId,
                    revision: progress.revision,
                    kind: 'materialize',
                    status: progress.status,
                    phase: progress.phase,
                },
                progress,
                createdAt: 1,
            },
            index: 0,
        }) as {
            props: { children: { props: { children: { props: Record<string, unknown> } } } };
        };
        const card = row.props.children.props.children;

        await (card.props.onDismiss as (
            ref: { operationId: string; revision: number },
        ) => void)({
            operationId: progress.operationId,
            revision: progress.revision,
        });

        expect(onDismissExternalSessionOperation).toHaveBeenCalledWith({
            operationId: progress.operationId,
            revision: progress.revision,
        });
        await hook.unmount();
    });

    it('routes materialize validating recovery through Retry with the exact current revision', async () => {
        const progress = {
            v: 1 as const,
            operationId: 'operation-materialize-validating',
            revision: 4,
            request: {
                plan: 'materialize' as const,
                targetStorageMode: 'external-linked' as const,
                targetRuntimeMode: null,
            },
            status: 'awaiting_user_resume' as const,
            phase: 'validating' as const,
            timeline: [
                'validating',
                'staging',
                'importing',
                'finalizing',
                'publishing',
            ] as const,
            updatedAtMs: 1,
            priorStableStorage: { state: 'machine_only' as const },
            currentStorageState: 'machine_only' as const,
            checkpoint: {
                sourcePagesRead: 0,
                stagedItemCount: 0,
                importedItemCount: 0,
                requiredItemFailures: {
                    total: 0,
                    record: 0,
                    media: 0,
                    conversion: 0,
                    diagnosticsTruncated: false,
                },
            },
            fence: { kind: 'none' as const },
            retryTargetPhase: 'validating' as const,
        };
        retryOperationSpy.mockResolvedValue({
            ok: true,
            progress: { ...progress, revision: 5, updatedAtMs: 2 },
        });
        const hook = await renderHook(() => useTranscriptItemRenderer(
            createRendererDeps(createRendererProps({
                metadata: createSessionFixture().metadata,
                externalSessionOperationOwnerTarget: {
                    machineId: 'machine-1',
                    machineOnline: true,
                    machineStatusKnown: true,
                    serverId: 'server-1',
                },
            })),
        ));
        const row = hook.getCurrent().renderItem({
            item: {
                kind: 'external-session-operation',
                id: `external-session-operation:${progress.operationId}`,
                presentation: {
                    v: 1,
                    operationId: progress.operationId,
                    revision: progress.revision,
                    kind: 'materialize',
                    status: progress.status,
                    phase: progress.phase,
                },
                progress,
                createdAt: 1,
            },
            index: 0,
        }) as {
            props: { children: { props: { children: { props: Record<string, unknown> } } } };
        };
        const card = row.props.children.props.children;

        await act(async () => {
            await (card.props.onRetry as (
                ref: { operationId: string; revision: number },
            ) => Promise<void>)({
                operationId: progress.operationId,
                revision: progress.revision,
            });
        });

        expect(retryOperationSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            sessionId: 's1',
            operationId: progress.operationId,
            revision: progress.revision,
        }, { serverId: 'server-1' });
        expect(resumeOperationSpy).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('delegates shared terminal dismissal without invoking an owner machine action', async () => {
        const onDismissExternalSessionOperation = vi.fn();
        const hook = await renderHook(() => useTranscriptItemRenderer(
            createRendererDeps(createRendererProps({
                metadata: createSessionFixture().metadata,
                onDismissExternalSessionOperation,
            })),
        ));
        const row = hook.getCurrent().renderItem({
            item: {
                kind: 'external-session-operation',
                id: 'external-session-operation:operation-1',
                presentation: {
                    v: 1,
                    operationId: 'operation-1',
                    revision: 4,
                    kind: 'materialize',
                    status: 'completed',
                    phase: 'publishing',
                },
                progress: null,
                createdAt: 0,
            },
            index: 0,
        }) as {
            props: { children: { props: { children: { type: unknown; props: Record<string, unknown> } } } };
        };
        const card = row.props.children.props.children;

        expect(card.type).toBe(ExternalSessionOperationSharedCard);
        expect(card.props).toMatchObject({
            presentation: {
                v: 1,
                operationId: 'operation-1',
                revision: 4,
                kind: 'materialize',
                status: 'completed',
                phase: 'publishing',
            },
            onDismiss: onDismissExternalSessionOperation,
        });
        await (card.props.onDismiss as (
            ref: { operationId: string; revision: number },
        ) => void)({ operationId: 'operation-1', revision: 4 });
        expect(onDismissExternalSessionOperation).toHaveBeenCalledWith({
            operationId: 'operation-1',
            revision: 4,
        });
        expect(resumeOperationSpy).not.toHaveBeenCalled();
        expect(retryOperationSpy).not.toHaveBeenCalled();
        expect(cancelOperationSpy).not.toHaveBeenCalled();
        expect(discardOperationSpy).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('returns focus from a removed or hydrated operation card to the stable transcript viewport', async () => {
        // The action card is deliberately not the focus owner: Dismiss removes its whole row,
        // while Check Again can replace SharedCard with ImportProgressCard. In both cases the
        // card-local effect unmounts before it can run. The mounted row/viewport owner must
        // observe the transition after commit and focus the surviving transcript target.
        const returnFocusToTranscriptViewport = vi.fn();
        const sharedItem: Extract<ChatListItem, { kind: 'external-session-operation' }> = {
            kind: 'external-session-operation' as const,
            id: 'external-session-operation:operation-focus',
            presentation: {
                v: 1 as const,
                operationId: 'operation-focus',
                revision: 1,
                kind: 'materialize' as const,
                status: 'completed' as const,
                phase: 'publishing' as const,
            },
            progress: null,
            createdAt: 0,
        };
        const hydratedItem: Extract<ChatListItem, { kind: 'external-session-operation' }> = {
            ...sharedItem,
            progress: createExternalSessionOperationProgress({
                operationId: 'operation-focus',
                status: 'completed',
                phase: 'publishing',
            }),
        };
        const baseDeps = {
            ...createRendererDeps(createRendererProps({
                onCheckAgainExternalSessionOperation: vi.fn(async () => false),
            })),
            returnFocusToTranscriptViewport,
        } as unknown as TranscriptItemRendererDeps;
        const hook = await renderHook(
            ({ listData }: { listData: readonly ChatListItem[] }) => useTranscriptItemRenderer({
                ...baseDeps,
                listData,
            }),
            { initialProps: { listData: [sharedItem] } },
        );
        const row = hook.getCurrent().renderItem({ item: sharedItem, index: 0 }) as {
            props: { children: { props: { children: { props: Record<string, unknown> } } } };
        };
        const card = row.props.children.props.children;
        const armTransition = card.props.onTranscriptOperationActionTransition as (
            kind: 'dismiss' | 'check_again',
        ) => void;

        expect(typeof armTransition).toBe('function');
        await act(async () => {
            armTransition('check_again');
        });
        await hook.rerender({ listData: [hydratedItem] });
        expect(returnFocusToTranscriptViewport).toHaveBeenCalledTimes(1);

        const hydratedRow = hook.getCurrent().renderItem({ item: hydratedItem, index: 0 }) as {
            props: { children: { props: { children: { props: Record<string, unknown> } } } };
        };
        const hydratedCard = hydratedRow.props.children.props.children;
        const armHydratedDismiss = hydratedCard.props.onTranscriptOperationActionTransition as (
            kind: 'dismiss',
        ) => void;
        await act(async () => {
            armHydratedDismiss('dismiss');
        });
        await hook.rerender({ listData: [] });
        expect(returnFocusToTranscriptViewport).toHaveBeenCalledTimes(2);
        await hook.unmount();
    });

    it.each([
        ['onResume', resumeOperationSpy],
        ['onRetry', retryOperationSpy],
        ['onCancel', cancelOperationSpy],
        ['onDiscard', discardOperationSpy],
    ] as const)(
        'returns focus from %s when its detailed card is replaced to the stable transcript viewport',
        async (actionProp, actionSpy) => {
        const returnFocusToTranscriptViewport = vi.fn();
        const progress = ExternalSessionOperationProgressV1Schema.parse({
            v: 1,
            operationId: 'operation-owner-focus',
            revision: 1,
            request: {
                plan: 'materialize',
                targetStorageMode: 'external-linked',
                targetRuntimeMode: null,
            },
            status: 'awaiting_user_resume',
            phase: 'validating',
            timeline: ['validating', 'staging', 'importing', 'publishing'],
            updatedAtMs: 1,
            priorStableStorage: { state: 'machine_only' },
            currentStorageState: 'machine_only',
            checkpoint: {
                sourcePagesRead: 0,
                stagedItemCount: 0,
                importedItemCount: 0,
                requiredItemFailures: {
                    total: 0,
                    record: 0,
                    media: 0,
                    conversion: 0,
                    diagnosticsTruncated: false,
                },
            },
            fence: { kind: 'none' },
            retryTargetPhase: 'validating',
        });
        actionSpy.mockResolvedValue({
            ok: true,
            progress: {
                ...progress,
                revision: 2,
                updatedAtMs: 2,
            },
        });
        const hydratedItem: Extract<ChatListItem, { kind: 'external-session-operation' }> = {
            kind: 'external-session-operation' as const,
            id: 'external-session-operation:operation-owner-focus',
            presentation: {
                v: 1 as const,
                operationId: 'operation-owner-focus',
                revision: 1,
                kind: 'materialize' as const,
                status: 'awaiting_user_resume' as const,
                phase: 'validating' as const,
            },
            progress,
            createdAt: 0,
        };
        const sharedItem: Extract<ChatListItem, { kind: 'external-session-operation' }> = {
            ...hydratedItem,
            progress: null,
        };
        const baseDeps = {
            ...createRendererDeps(createRendererProps({
                externalSessionOperationOwnerTarget: {
                    machineId: 'machine-1',
                    machineOnline: true,
                    machineStatusKnown: true,
                    serverId: 'server-1',
                },
            })),
            returnFocusToTranscriptViewport,
        } as TranscriptItemRendererDeps;
        const hook = await renderHook(
            ({ listData }: { listData: readonly ChatListItem[] }) => useTranscriptItemRenderer({
                ...baseDeps,
                listData,
            }),
            { initialProps: { listData: [hydratedItem] } },
        );
        const row = hook.getCurrent().renderItem({ item: hydratedItem, index: 0 }) as {
            props: { children: { props: { children: { props: Record<string, unknown> } } } };
        };
        const card = row.props.children.props.children;

        await act(async () => {
            await (card.props[actionProp] as (
                ref: { operationId: string; revision: number },
            ) => Promise<void>)({
                operationId: 'operation-owner-focus',
                revision: 1,
            });
        });
        await hook.rerender({ listData: [sharedItem] });
        expect(returnFocusToTranscriptViewport).toHaveBeenCalledOnce();
        await hook.unmount();
        },
    );

    it('leaves focus on the surviving shared card when Check Again only removes its own action', async () => {
        // The card-local action hook already knows how to advance focus to Dismiss when the
        // same SharedCard survives. The row/viewport owner is only for whole-card retirement
        // or SharedCard -> ImportProgressCard hydration; stealing focus here would discard the
        // nearer surviving control.
        const returnFocusToTranscriptViewport = vi.fn();
        const sharedItem: ExternalSessionOperationItem = {
            kind: 'external-session-operation' as const,
            id: 'external-session-operation:operation-local-focus',
            presentation: {
                v: 1 as const,
                operationId: 'operation-local-focus',
                revision: 1,
                kind: 'materialize' as const,
                status: 'completed' as const,
                phase: 'publishing' as const,
            },
            progress: null,
            createdAt: 0,
        };
        const beforeCheckAgain = createRendererProps({
            onCheckAgainExternalSessionOperation: vi.fn(async () => false),
        });
        const afterCheckAgain = {
            ...beforeCheckAgain,
            onCheckAgainExternalSessionOperation: null,
        } as TranscriptItemRendererDeps['props'];
        const baseDeps = {
            ...createRendererDeps(beforeCheckAgain),
            returnFocusToTranscriptViewport,
        } as TranscriptItemRendererDeps;
        const hook = await renderHook((params: Readonly<{
            listData: readonly typeof sharedItem[];
            props: TranscriptItemRendererDeps['props'];
        }>) => useTranscriptItemRenderer({
            ...baseDeps,
            listData: params.listData,
            props: params.props,
        }), {
            initialProps: {
                listData: [sharedItem],
                props: beforeCheckAgain,
            },
        });
        const row = hook.getCurrent().renderItem({ item: sharedItem, index: 0 }) as {
            props: { children: { props: { children: { props: Record<string, unknown> } } } };
        };
        const card = row.props.children.props.children;
        const armTransition = card.props.onTranscriptOperationActionTransition as (
            kind: 'dismiss' | 'check_again',
        ) => void;

        await act(async () => {
            armTransition('check_again');
        });
        await hook.rerender({
            listData: [sharedItem],
            props: afterCheckAgain,
        });
        expect(returnFocusToTranscriptViewport).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('disarms a check-again activation that settles without replacing the control', async () => {
        // A failed re-read leaves the Check Again control in place. The armed
        // transition must be released with the settlement; otherwise a later
        // unrelated revision (here: hydration) would move focus the reader's
        // action never caused.
        const returnFocusToTranscriptViewport = vi.fn();
        const sharedItem: ExternalSessionOperationItem = {
            kind: 'external-session-operation' as const,
            id: 'external-session-operation:operation-check-settle',
            presentation: {
                v: 1 as const,
                operationId: 'operation-check-settle',
                revision: 1,
                kind: 'materialize' as const,
                status: 'completed' as const,
                phase: 'publishing' as const,
            },
            progress: null,
            createdAt: 0,
        };
        const hydratedItem: ExternalSessionOperationItem = {
            ...sharedItem,
            progress: createExternalSessionOperationProgress({
                operationId: 'operation-check-settle',
                status: 'completed',
                phase: 'publishing',
            }),
        };
        const baseDeps = {
            ...createRendererDeps(createRendererProps({
                onCheckAgainExternalSessionOperation: vi.fn(async () => false),
            })),
            returnFocusToTranscriptViewport,
        } as unknown as TranscriptItemRendererDeps;
        const hook = await renderHook(
            ({ listData }: { listData: readonly ExternalSessionOperationItem[] }) => useTranscriptItemRenderer({
                ...baseDeps,
                listData,
            }),
            { initialProps: { listData: [sharedItem] } },
        );
        const row = hook.getCurrent().renderItem({ item: sharedItem, index: 0 }) as {
            props: { children: { props: { children: { props: Record<string, unknown> } } } };
        };
        const card = row.props.children.props.children;

        await act(async () => {
            await (card.props.onCheckAgain as () => Promise<boolean>)();
        });
        await hook.rerender({ listData: [hydratedItem] });
        expect(returnFocusToTranscriptViewport).not.toHaveBeenCalled();
        await hook.unmount();
    });
    it('trims the older tool row tail instead of pulling the newer row above its recycler cell', async () => {
        // The recycler cell paints inside its own box, so a row pulled above its top edge loses its
        // first lines. A tool row followed by another tool row gives up its own trailing gap instead.
        const rowOf = (messageId: string) => ({
            kind: 'message' as const, id: `msg:${messageId}`, messageId, createdAt: 1, seq: null,
        });
        const items = [rowOf('tool-a'), rowOf('tool-b'), rowOf('reply')];
        const hook = await renderHook(() => useTranscriptItemRenderer({
            ...createRendererDeps(createRendererProps()),
            listData: items,
            itemsRef: createRef(items),
            toolTimelineChromeMode: 'activity_feed',
            resolveKindForMessageId: (messageId: string) => messageId.startsWith('tool') ? 'tool-call' : 'text',
        } as unknown as TranscriptItemRendererDeps));
        const wrapperStyle = (index: number) => {
            const row = hook.getCurrent().renderItem({ item: items[index]!, index }) as {
                props: { children: { props: { children: { props: { style?: { marginTop?: number; marginBottom?: number } } } } } };
            };
            return row.props.children.props.children.props.style ?? {};
        };
        expect(wrapperStyle(0).marginBottom ?? 0).toBeLessThan(0);
        expect(wrapperStyle(1).marginTop ?? 0).toBeGreaterThanOrEqual(0);
        expect(wrapperStyle(1).marginBottom ?? 0).toBeGreaterThanOrEqual(0);
        expect(wrapperStyle(2).marginTop ?? 0).toBeGreaterThanOrEqual(0);
        await hook.unmount();
    });
});
