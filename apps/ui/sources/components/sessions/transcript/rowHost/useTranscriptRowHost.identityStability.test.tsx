/**
 * Identity-stability contract for the transcript item renderer.
 *
 * FlashList view holders bail out of re-rendering only when `renderItem` keeps its
 * identity (ViewHolder memo compares it with ===). ChatList re-renders on every
 * transcript apply, passing a fresh `props` object literal whose FIELDS are stable;
 * the renderer must derive its identity from the fields it actually uses, not from
 * the containing object.
 */
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resumeOperationSpy = vi.hoisted(() => vi.fn());
const retryOperationSpy = vi.hoisted(() => vi.fn());
const cancelOperationSpy = vi.hoisted(() => vi.fn());
const discardOperationSpy = vi.hoisted(() => vi.fn());
const useMachineSpy = vi.hoisted(() => vi.fn());
const onlineMachine = vi.hoisted(() => ({
    id: 'machine-1',
    active: true,
    activeAt: Date.now(),
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));
vi.mock('@/components/ui/feedback/ShimmerView', () => ({
    ShimmerView: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionOperationCancel: cancelOperationSpy,
    machineExternalSessionOperationDiscard: discardOperationSpy,
    machineExternalSessionOperationResume: resumeOperationSpy,
    machineExternalSessionOperationRetry: retryOperationSpy,
}));
vi.mock('@/sync/store/hooks', () => ({
    useMachine: (...args: unknown[]) => {
        useMachineSpy(...args);
        return onlineMachine;
    },
}));
vi.mock('@/components/sessions/external/progress/externalSessionOperationRowCapabilities', () => ({
    resolveExternalSessionOperationRowCapabilities: () => ({
        originAvailability: 'online',
        canInvokeOwnerActions: true,
    }),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-1',
}));

import { renderHook } from '@/dev/testkit';

import { TranscriptRowShell } from '@/components/sessions/transcript/ChatListRows';
import { TranscriptWindowGapRow } from '@/components/sessions/transcript/viewport/window/TranscriptWindowGapRow';
import { ExternalSessionOperationSharedCard } from '@/components/sessions/external/progress/ExternalSessionOperationSharedCard';
import { TranscriptLiveMessagesRowShell } from './TranscriptLiveMessagesRowShell';
import { useTranscriptItemRenderer, type TranscriptItemRendererDeps } from './useTranscriptRowHost';

function createRef<T>(current: T): { current: T } {
    return { current };
}

function createRendererProps(overrides?: Partial<Record<string, unknown>>): TranscriptItemRendererDeps['props'] {
    return {
        sessionId: 's1',
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
        onExternalSessionOperationActionResult: vi.fn(),
        externalSessionOperationOwnerTarget: null,
        forkCommon: { forkNoticesByMessageId: {} },
        messageDisplayCommon: {},
        toolChromeCommon: {},
        rollbackActionsByMessageId: {},
        rollbackRanges: [],
        messagesById: {},
        activeThinkingMessageId: null,
        forkedTranscriptEnabled: false,
        ...overrides,
    } as unknown as TranscriptItemRendererDeps['props'];
}

function createRendererDeps(props: TranscriptItemRendererDeps['props']): TranscriptItemRendererDeps {
    const items: readonly never[] = [];
    return {
        buildRowShellSignature: vi.fn(() => ({ kind: 'message' } as never)),
        expandedToolCallsAnchorMessageIds: new Set<string>(),
        getMessageById: vi.fn(() => null),
        getMessageRevisionById: vi.fn(() => 1),
        handleRowLayoutMutation: vi.fn(),
        handleRowShellMeasured: vi.fn(),
        itemsRef: createRef(items),
        listData: items,
        listOrientation: 'top-down' as never,
        measurementReconciler: {} as never,
        props,
        resolveKindForMessageId: vi.fn(() => null),
        resolveThinkingExpanded: vi.fn(() => false),
        returnFocusToTranscriptViewport: vi.fn(),
        resolveToolCallMessagesForIds: vi.fn(() => []),
        setThinkingExpanded: vi.fn(),
        setToolCallsGroupExpanded: vi.fn(),
        toolTimelineChromeMode: 'cards',
        toolRouteCommon: undefined as never,
    };
}

describe('useTranscriptItemRenderer identity stability', () => {
    beforeEach(() => {
        resumeOperationSpy.mockReset();
        retryOperationSpy.mockReset();
        cancelOperationSpy.mockReset();
        discardOperationSpy.mockReset();
        useMachineSpy.mockClear();
    });

    it('does not create a second machine subscription inside the row renderer', async () => {
        const hook = await renderHook(() => useTranscriptItemRenderer(
            createRendererDeps(createRendererProps()),
        ));

        expect(useMachineSpy).not.toHaveBeenCalled();
        await hook.unmount();
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
            props: { ...initial, onEditPendingMessage: vi.fn() } as TranscriptItemRendererDeps['props'],
        });
        const second = hook.getCurrent().renderItem;

        expect(second).not.toBe(first);
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
                metadata: { machineId: 'machine-1' },
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
                metadata: { machineId: 'machine-1' },
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
                metadata: { machineId: 'machine-1' },
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
                metadata: { machineId: 'machine-1' },
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
        const sharedItem = {
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
        const hydratedItem = {
            ...sharedItem,
            progress: {} as never,
        };
        const baseDeps = {
            ...createRendererDeps(createRendererProps({
                onCheckAgainExternalSessionOperation: vi.fn(),
            })),
            returnFocusToTranscriptViewport,
        } as unknown as TranscriptItemRendererDeps;
        const hook = await renderHook(
            ({ listData }: { listData: readonly typeof sharedItem[] }) => useTranscriptItemRenderer({
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

    it('leaves focus on the surviving shared card when Check Again only removes its own action', async () => {
        // The card-local action hook already knows how to advance focus to Dismiss when the
        // same SharedCard survives. The row/viewport owner is only for whole-card retirement
        // or SharedCard -> ImportProgressCard hydration; stealing focus here would discard the
        // nearer surviving control.
        const returnFocusToTranscriptViewport = vi.fn();
        const sharedItem = {
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
            onCheckAgainExternalSessionOperation: vi.fn(),
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
});
