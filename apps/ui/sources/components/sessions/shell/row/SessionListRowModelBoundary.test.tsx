import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createStorageModuleMock } from '@/dev/testkit/mocks/storage';
import type { StorageState } from '@/sync/store/types';
import { installSessionShellCommonModuleMocks } from '../sessionShellTestHelpers';
import type { UseSessionInlineDragResolvedDrop } from '../useSessionInlineDrag';
import type { SessionListRowStoreState } from './sessionListRowModelTypes';

type StorageHook = typeof import('@/sync/domains/state/storage')['storage'];
type TestStorageState = StorageState & SessionListRowStoreState;

const reactiveStorageHarness = vi.hoisted(() => {
    let state = {} as TestStorageState;
    const listeners = new Set<() => void>();
    return {
        getState: () => state,
        reset(next: SessionListRowStoreState) {
            state = next as TestStorageState;
            listeners.clear();
        },
        setState(next: SessionListRowStoreState) {
            state = next as TestStorageState;
            for (const listener of listeners) {
                listener();
            }
        },
        listenerCount: () => listeners.size,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
});

const rowRenderProps = vi.hoisted(() => [] as any[]);
const rowLifecycleEvents = vi.hoisted(() => [] as string[]);
const draftRepositoryHarness = vi.hoisted(() => {
    let projection: Readonly<{ preview: string }> | null = null;
    const listeners = new Set<() => void>();
    return {
        deleteDraft: vi.fn(async () => undefined),
        getProjection: () => projection,
        reset() {
            projection = null;
            listeners.clear();
            this.deleteDraft.mockClear();
        },
        setProjection(next: Readonly<{ preview: string }> | null) {
            projection = next;
            for (const listener of listeners) listener();
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
});

installSessionShellCommonModuleMocks({
    storage: async (importOriginal) => {
        const ReactModule = await import('react');
        const storage = Object.assign((
            <TSelected = TestStorageState>(selector?: (state: StorageState) => TSelected) => ReactModule.useSyncExternalStore(
                reactiveStorageHarness.subscribe,
                () => selector ? selector(reactiveStorageHarness.getState()) : reactiveStorageHarness.getState(),
                () => selector ? selector(reactiveStorageHarness.getState()) : reactiveStorageHarness.getState(),
            )
        ) as StorageHook,
            {
                getState: reactiveStorageHarness.getState,
                getInitialState: reactiveStorageHarness.getState,
                setState: (next: SessionListRowStoreState) => reactiveStorageHarness.setState(next),
                subscribe: reactiveStorageHarness.subscribe,
                destroy: () => undefined,
            },
        );
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                storage,
                useActiveServerAccountScope: () => ({ serverId: 'server_a', accountId: 'account_a' }),
            },
        });
    },
});

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', () => ({
    deleteSessionDraft: draftRepositoryHarness.deleteDraft,
    getExistingSessionDraftProjection: () => draftRepositoryHarness.getProjection(),
    subscribeSessionDraft: (_scope: unknown, _address: unknown, listener: () => void) => draftRepositoryHarness.subscribe(listener),
}));

vi.mock('@/hooks/session/sessionListRuntimeClock', () => ({
    useSessionListRelativeTimeNowMs: () => 2_000,
    useSessionListRuntimeNowMs: () => 2_000,
    useSessionListRuntimeWake: () => undefined,
}));

vi.mock('./SessionListRow', () => ({
    SessionListRow: (props: any) => {
        rowRenderProps.push(props);
        const sessionId = String(props.session?.id ?? 'unknown');
        React.useEffect(() => {
            rowLifecycleEvents.push(`mount:${sessionId}`);
            return () => {
                rowLifecycleEvents.push(`unmount:${sessionId}`);
            };
        }, [sessionId]);
        return React.createElement('SessionListRow', {
            ...props,
            testID: `session-list-row-boundary:${String(props.session?.id ?? 'unknown')}`,
        });
    },
}));

const baseSession = {
    id: 'sess_a',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: false,
    activeAt: 0,
    metadata: {
        machineId: 'machine-a',
        path: '/Users/test/repo',
        homeDir: '/Users/test',
        host: 'host-a.local',
    },
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    presence: 'offline',
} as any;

const baseItem = {
    type: 'session',
    session: baseSession,
    groupKey: 'day:today',
    groupKind: 'date',
    serverId: 'server_a',
    serverName: 'Server A',
} as const;

const idleResolvedDrop: UseSessionInlineDragResolvedDrop = Object.freeze({
    result: Object.freeze({
        instruction: Object.freeze({ kind: 'idle' }),
        visual: Object.freeze({ kind: 'none' }),
    }),
    geometry: Object.freeze({ kind: 'none' }),
});

function createBoundaryProps() {
    return {
        activeServerId: 'server_a',
        dataActive: true,
        dataIndex: 0,
        dragEnabled: true,
        draggingSessionKey: null,
        folderViewEnabled: false,
        getRowMoveActionHandlers: vi.fn(() => ({})),
        getRowNativeContextMenuOpenChangeHandler: vi.fn(() => vi.fn()),
        getRowSetTagsHandler: vi.fn(() => vi.fn()),
        getRowTogglePinnedHandler: vi.fn(() => vi.fn()),
        groupKey: 'day:today',
        item: baseItem,
        items: [baseItem],
        nativeContextMenuSessionKey: null,
        onDragCancel: vi.fn(),
        onDragStart: vi.fn(),
        onDropResult: vi.fn(),
        onRegisterTreeRowBounds: vi.fn(),
        onUnregisterTreeRowBounds: vi.fn(),
        overlayShared: {} as any,
        prioritySessionRowKeys: new Set<string>(),
        resolveDropResult: vi.fn(() => idleResolvedDrop),
        rowStoreSubscriptionEnabled: true,
        rowStoreSubscriptionMode: 'all-rendered' as const,
        settings: {
            currentUserId: null,
            density: 'default' as const,
            compact: false,
            compactMinimal: false,
            identityDisplay: 'avatar' as const,
            activeColorMode: 'activityAndAttention' as const,
            workingIndicatorMode: 'spinner' as const,
            workingTextMode: 'static' as const,
            statusColors: {
                connected: 'connected',
                connecting: 'connecting',
                actionRequired: 'action-required',
                disconnected: 'disconnected',
                error: 'error',
                default: 'default',
            },
            hideInactiveSessions: false,
            showServerBadge: false,
            showPinnedServerBadge: false,
            agentActivityCountEnabled: false,
            tagsEnabled: true,
            sessionTagsByKey: {},
            allKnownTags: [],
            pinnedSessionKeys: [],
            attentionStandingEnabled: false,
            attentionStandingPolicy: { defaultStanding: false, overridesBySessionKey: {} },
            hasMultipleMachines: false,
            reachableSessionDisplayByKey: {},
            folderViewEnabled: false,
            relativeNowMs: 2_000,
            runtimeNowMs: 2_000,
        },
        viewableSessionRowKeys: null,
    };
}

describe('SessionListRowModelBoundary', () => {
    beforeEach(() => {
        rowRenderProps.length = 0;
        rowLifecycleEvents.length = 0;
        draftRepositoryHarness.reset();
        reactiveStorageHarness.reset({
            activeServerId: 'server_a',
            sessions: {
                sess_a: baseSession,
            },
            sessionListRenderables: {},
            sessionMessages: {},
            sessionPending: {},
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('updates one row from its row-store subscription without a parent rerender', async () => {
        const { SessionListRowModelBoundary } = await import('./SessionListRowModelBoundary');
        const screen = await renderScreen(<SessionListRowModelBoundary {...createBoundaryProps()} />);

        expect(screen.findByTestId('session-list-row-boundary:sess_a')?.props.rowModel.session.thinking).toBe(false);
        expect(rowRenderProps).toHaveLength(1);

        await act(async () => {
            reactiveStorageHarness.setState({
                ...reactiveStorageHarness.getState(),
                sessionListRenderables: {
                    sess_b: {
                        ...baseSession,
                        id: 'sess_b',
                        thinking: true,
                    },
                },
            });
        });

        expect(rowRenderProps).toHaveLength(1);
        const renderCountBeforeScopedUpdate = rowRenderProps.length;

        await act(async () => {
            reactiveStorageHarness.setState({
                ...reactiveStorageHarness.getState(),
                sessionListRenderables: {
                    ...reactiveStorageHarness.getState().sessionListRenderables,
                    sess_a: {
                        ...baseSession,
                        active: true,
                        activeAt: 2_000,
                        thinking: true,
                        thinkingAt: 2_000,
                        presence: 'online',
                        latestTurnStatus: 'in_progress',
                        latestTurnStatusObservedAt: 2_000,
                    },
                },
            });
        });

        const updatedRow = screen.findByTestId('session-list-row-boundary:sess_a');
        expect(updatedRow?.props.rowModel.session.thinking).toBe(true);
        expect(updatedRow?.props.rowModel.status.state).toBe('thinking');
        expect(rowRenderProps.length).toBeGreaterThan(renderCountBeforeScopedUpdate);
    });

    it('projects canonical existing-session draft updates into the same row and deletes only the draft', async () => {
        const { SessionListRowModelBoundary } = await import('./SessionListRowModelBoundary');
        const screen = await renderScreen(<SessionListRowModelBoundary {...createBoundaryProps()} />);

        expect(screen.findByTestId('session-list-row-boundary:sess_a')?.props.rowModel.draft).toBeNull();

        await act(async () => {
            draftRepositoryHarness.setProjection({ preview: 'Resume release validation' });
        });

        const row = screen.findByTestId('session-list-row-boundary:sess_a');
        expect(row?.props.rowModel.draft).toEqual({ preview: 'Resume release validation' });

        await act(async () => {
            await row?.props.onDeleteDraft?.();
        });

        expect(draftRepositoryHarness.deleteDraft).toHaveBeenCalledWith({
            scope: { serverId: 'server_a', accountId: 'account_a' },
            address: { kind: 'session', sessionId: 'sess_a' },
        });
        expect(rowRenderProps.every((props) => props.session.id === 'sess_a')).toBe(true);
    });

    it('keeps the row subtree mounted when the row leaves the row-store subscription set', async () => {
        const { SessionListRowModelBoundary } = await import('./SessionListRowModelBoundary');
        const boundaryProps = createBoundaryProps();
        let setSubscriptionEnabled: ((enabled: boolean) => void) | null = null;

        function SubscriptionToggleHarness() {
            const [rowStoreSubscriptionEnabled, setEnabled] = React.useState(true);
            setSubscriptionEnabled = setEnabled;
            return (
                <SessionListRowModelBoundary
                    {...boundaryProps}
                    rowStoreSubscriptionEnabled={rowStoreSubscriptionEnabled}
                />
            );
        }

        await renderScreen(<SubscriptionToggleHarness />);

        expect(rowLifecycleEvents).toEqual(['mount:sess_a']);
        expect(reactiveStorageHarness.listenerCount()).toBe(1);

        await act(async () => {
            setSubscriptionEnabled?.(false);
        });

        // The row left the subscription set: the store listener must be gone,
        // but the mounted row subtree must survive (no remount).
        expect(reactiveStorageHarness.listenerCount()).toBe(0);
        expect(rowLifecycleEvents).toEqual(['mount:sess_a']);
    });

    it('does not subscribe to row-store updates when the row is outside the subscription set', async () => {
        const { SessionListRowModelBoundary } = await import('./SessionListRowModelBoundary');
        const props = {
            ...createBoundaryProps(),
            rowStoreSubscriptionEnabled: false,
        };

        const screen = await renderScreen(<SessionListRowModelBoundary {...props} />);

        expect(screen.findByTestId('session-list-row-boundary:sess_a')).toBeTruthy();
        expect(reactiveStorageHarness.listenerCount()).toBe(0);

        await screen.unmount();
    });

    it('shows real row content when the row first mounts while the surface is inactive', async () => {
        const { SessionListRowModelBoundary } = await import('./SessionListRowModelBoundary');
        await act(async () => {
            reactiveStorageHarness.setState({
                ...reactiveStorageHarness.getState(),
                sessionListRenderables: {
                    sess_a: {
                        ...baseSession,
                        active: true,
                        activeAt: 2_000,
                        thinking: true,
                        thinkingAt: 2_000,
                        presence: 'online',
                        latestTurnStatus: 'in_progress',
                        latestTurnStatusObservedAt: 2_000,
                    },
                },
            });
        });

        // Opening a session deactivates the list, and the list keeps rendering behind the pushed
        // screen. Legend can mount containers during that window, so a row's FIRST render can happen
        // while the surface is inactive - and an inactive row reads a frozen constant rather than the
        // store. A row that was never active has nothing frozen yet, so it must fall back to reading
        // the store once instead of presenting an empty snapshot.
        const screen = await renderScreen(
            <SessionListRowModelBoundary
                {...createBoundaryProps()}
                dataActive={false}
                rowStoreSubscriptionEnabled={false}
            />,
        );

        expect(screen.findByTestId('session-list-row-boundary:sess_a')?.props.rowModel.session.thinking).toBe(true);
        // Still no listener: reading once must not re-introduce the subscription this freeze avoids.
        expect(reactiveStorageHarness.listenerCount()).toBe(0);

        await screen.unmount();
    });
});
