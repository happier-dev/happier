/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionListQueryV1 } from '@happier-dev/protocol';

import type {
    SessionListQueryHomeController,
    SessionListQueryHomeState,
} from './sessionListQueryController';

type HarnessController = SessionListQueryHomeController & Readonly<{
    serverId: string;
    disposeSpy: ReturnType<typeof vi.fn>;
    publishLate(sessionId: string): void;
    publishOffline(): void;
}>;

const controllerHarness = vi.hoisted(() => {
    const controllers: HarnessController[] = [];
    return { controllers };
});

const featureHarness = vi.hoisted(() => {
    const decisions: Record<string, boolean> = {};
    return { decisions };
});

const queryRuntimeHarness = vi.hoisted(() => ({
    retryHome: vi.fn(async (_serverId: string) => undefined),
}));

type ScopeBindingHarness = Readonly<{
    serverId: string;
    accountId: string;
    revision: number;
    scope: Readonly<{ serverId: string; accountId: string }>;
    isCurrent(): boolean;
    onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
    retire(): void;
}>;

const scopeHarness = vi.hoisted(() => {
    const bindings = new Map<string, ScopeBindingHarness>();
    let revision = 0;
    const createBinding = (serverId: string, accountId: string): ScopeBindingHarness => {
        let current = true;
        const retirements = new Set<() => void>();
        const binding: ScopeBindingHarness = {
            serverId,
            accountId,
            revision: ++revision,
            scope: { serverId, accountId },
            isCurrent: () => current,
            onRetire: (cancel) => {
                if (!current) {
                    cancel();
                    return { dispose: () => undefined };
                }
                retirements.add(cancel);
                return { dispose: () => retirements.delete(cancel) };
            },
            retire: () => {
                if (!current) return;
                current = false;
                for (const retire of [...retirements]) retire();
                retirements.clear();
            },
        };
        return binding;
    };
    return { bindings, createBinding };
});

vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopes: (serverIds: readonly string[]) => {
        for (const serverId of serverIds) {
            if (!scopeHarness.bindings.has(serverId)) {
                scopeHarness.bindings.set(serverId, scopeHarness.createBinding(serverId, serverId));
            }
        }
        return new Map([...scopeHarness.bindings].filter(([serverId]) => serverIds.includes(serverId)));
    },
}));

vi.mock('./sessionListQueryController', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./sessionListQueryController')>();
    return {
        ...actual,
        createSessionListQueryHomeController: ({ serverId }: { serverId: string }) => {
            const accountId = scopeHarness.bindings.get(serverId)?.accountId ?? serverId;
            const listeners = new Set<() => void>();
            let disposed = false;
            const disposeSpy = vi.fn(() => {
                disposed = true;
                listeners.clear();
            });
            let lastSupport: boolean | null | undefined | 'unset' = 'unset';
            let state: SessionListQueryHomeState = {
                requestedQueryKey: `query:${serverId}`,
                appliedQueryKey: `query:${serverId}`,
                addresses: [],
                nextCursor: `cursor:${accountId}`,
                hasNext: true,
                attentionNextCursor: null,
                attentionHasNext: false,
                phase: 'ready',
                freshnessAt: 1,
                failureReason: null,
                failureCode: null,
                appliedSourceKind: 'query',
            };
            const controller = {
                serverId,
                disposeSpy,
                publishLate: (sessionId: string) => {
                    if (disposed) return;
                    state = {
                        ...state,
                        addresses: [{ serverId, sessionId }],
                        nextCursor: `late:${sessionId}`,
                        phase: 'ready',
                    };
                    for (const listener of listeners) listener();
                },
                publishOffline: () => {
                    if (disposed) return;
                    state = { ...state, phase: 'offline', failureReason: null, failureCode: null };
                    for (const listener of listeners) listener();
                },
                getSnapshot: () => state,
                subscribe: (listener: () => void) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
                update: vi.fn(async (input: Readonly<{ supported?: boolean | null; query?: SessionListQueryV1 }>) => {
                    // This harness applies the real query key, so a ready corpus reaches the index.
                    if (input.query && input.supported === true) {
                        const { buildSessionListQueryKey } = await import('./sessionListQueryKey');
                        const appliedQueryKey = buildSessionListQueryKey(serverId, input.query);
                        if (state.appliedQueryKey !== appliedQueryKey) {
                            state = { ...state, requestedQueryKey: appliedQueryKey, appliedQueryKey, addresses: [{ serverId, sessionId: `${accountId}-row` }], phase: 'ready', failureReason: null, failureCode: null };
                            lastSupport = true;
                            for (const listener of listeners) listener();
                        }
                        return;
                    }
                    if (input.supported === lastSupport) return;
                    lastSupport = input.supported;
                    if (input.supported === false) {
                        state = {
                            ...state,
                            appliedQueryKey: null,
                            addresses: [],
                            phase: 'error',
                            failureReason: 'unsupported',
                            failureCode: 'filtered_session_listing_unavailable',
                        };
                    } else if (input.supported === null || input.supported === undefined) {
                        state = { ...state, appliedQueryKey: null, addresses: [], phase: 'idle' };
                    } else {
                        state = {
                            ...state,
                            appliedQueryKey: `query:${serverId}`,
                            addresses: [{ serverId, sessionId: `${accountId}-row` }],
                            phase: 'ready',
                            failureReason: null,
                            failureCode: null,
                        };
                    }
                    for (const listener of listeners) listener();
                }),
                refresh: vi.fn(async () => undefined),
                invalidate: vi.fn(),
                retire: vi.fn(),
                loadNext: vi.fn(async () => undefined),
                dispose: disposeSpy,
            } satisfies HarnessController;
            controllerHarness.controllers.push(controller);
            return controller;
        },
    };
});

const rowsHarness = vi.hoisted(() => {
    let rows: Record<string, Record<string, unknown>> = {};
    const listeners = new Set<() => void>();
    return {
        get: () => rows,
        set: (next: Record<string, Record<string, unknown>>) => {
            rows = next;
            for (const listener of listeners) listener();
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
});

// The row store is the boundary: a reactive stand-in for the app store's session-row slice, read the
// way the app reads it, so the query owner's own subscription and reconciliation stay real.
const EMPTY_QUERY_MEMBERSHIP = vi.hoisted(() => ({}));

vi.mock('@/sync/domains/state/storage', async () => {
    const ReactModule = await import('react');
    return {
        useMachineListByServerId: () => ({}),
        useMachineListStatusByServerId: () => ({}),
        useOrdinarySessionListMembershipByServerId: () => ({}),
        useSessionListQueryMembershipByKey: () => EMPTY_QUERY_MEMBERSHIP,
        // Mirrors the real selector: with `serverIds` it follows only those Homes' row maps.
        useSessionListRowsByServerId: (serverIds?: readonly string[]) => {
            const cache = ReactModule.useRef<Record<string, Record<string, unknown>> | null>(null);
            const getSnapshot = () => {
                const all = rowsHarness.get();
                if (!serverIds) return all;
                const next = Object.fromEntries(serverIds.filter((id) => all[id]).map((id) => [id, all[id]]));
                const previous = cache.current;
                if (previous && Object.keys(previous).length === Object.keys(next).length
                    && Object.keys(next).every((key) => previous[key] === next[key])) return previous;
                cache.current = next;
                return next;
            };
            return ReactModule.useSyncExternalStore(rowsHarness.subscribe, getSnapshot, getSnapshot);
        },
        useSetting: (key: keyof typeof SETTINGS) => SETTINGS[key],
        useSocketStatus: () => 'connected',
    };
});

const SETTINGS = {
    sessionListActiveGroupingV1: 'project',
    sessionListInactiveGroupingV1: 'project',
    sessionListSectionModeV1: 'single',
} as const;

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getServerProfileById: () => null,
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    resolveRuntimeFeatureDecisionFromSnapshot: (input: Readonly<{
        featureId: string;
        scope: Readonly<{ serverId: string }>;
    }>) => ({
        state: featureHarness.decisions[`${input.featureId}:${input.scope.serverId}`] === false
            ? 'disabled'
            : 'enabled',
    }),
    useServerFeaturesMainSelectionSnapshot: (serverIds: readonly string[]) => ({
        status: 'ready',
        serverIds,
        snapshotsByServerId: Object.fromEntries(serverIds.map((serverId) => [serverId, { status: 'ready' }])),
    }),
}));

vi.mock('@/hooks/server/useFeatureLocalPolicySettings', () => ({
    useFeatureLocalPolicySettings: () => ({}),
}));

vi.mock('./sessionListQueryRuntime', () => ({
    fetchSessionListQueryPageForHome: vi.fn(),
    getSessionListQueryHomeAvailability: () => 'online',
    isSessionListQueryHomeOnline: () => true,
    // No incumbent runtime owns these Homes' ordinary corpus, so every corpus
    // keeps its controller.
    resolveOrdinarySessionListHomeOwner: () => null,
    loadNextOrdinarySessionListPage: vi.fn(async () => undefined),
    readOrdinarySessionListHomeState: vi.fn(),
    refreshOrdinarySessionList: vi.fn(async () => undefined),
    retrySessionListQueryHome: queryRuntimeHarness.retryHome,
}));

vi.mock('./sessionListQueryInvalidation', () => ({
    subscribeSessionListQueryHomeInvalidation: () => () => undefined,
}));

import {
    type SessionListQueryHomeInput,
    useSessionListQueryHomeStates,
    useSessionListQuerySourceState,
} from './useSessionListQuerySourceState';

const QUERY: SessionListQueryV1 = {
    v: 1,
    storage: 'active',
    includeInactive: false,
    scope: 'all_accessible',
    attention: 'any',
    audiences: [],
    tagIds: [],
    includeAttention: true,
};

function homes(...serverIds: string[]): SessionListQueryHomeInput[] {
    return serverIds.map((serverId) => ({ serverId, query: QUERY }));
}

function row(sessionId: string, metadataVersion: number) {
    return {
        id: sessionId,
        active: true,
        activeAt: 100,
        createdAt: 1,
        updatedAt: 100,
        metadataVersion,
        metadata: { path: '/work/project', host: 'devbox', name: 'Session' },
        thinking: false,
    };
}

async function mount(element: React.ReactElement) {
    const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => { root.render(element); });
    return {
        unmount: async () => {
            await act(async () => root.unmount());
            container.remove();
        },
    };
}

/** One session's metadata changes and nothing else: the shape of the steady idle write. */
async function writeMetadata(serverId: string, sessionId: string, metadataVersion: number) {
    await act(async () => {
        const current = rowsHarness.get();
        rowsHarness.set({ ...current, [serverId]: { ...current[serverId], [sessionId]: row(sessionId, metadataVersion) } });
    });
}

describe('session list query source: subscription locality', () => {
    afterEach(() => {
        controllerHarness.controllers.length = 0;
        for (const binding of scopeHarness.bindings.values()) binding.retire();
        scopeHarness.bindings.clear();
        rowsHarness.set({});
    });

    it('does not re-render a disabled source (the home and summary paths) when a session row changes', async () => {
        rowsHarness.set({ 'home-a': { 'home-a-row': row('home-a-row', 1) } });
        let renders = 0;
        function DisabledSourceHost() {
            useSessionListQuerySourceState({ enabled: false, homes: [] });
            renders += 1;
            return null;
        }
        const screen = await mount(<DisabledSourceHost />);
        const settled = renders;

        await writeMetadata('home-a', 'home-a-row', 2);
        await writeMetadata('home-a', 'home-a-row', 3);

        expect(renders).toBe(settled);
        await screen.unmount();
    });

    it('does not re-render a states-only consumer (personal membership) when a session row changes', async () => {
        let renders = 0;
        let statesSeen: unknown = null;
        function MembershipHost() {
            const states = useSessionListQueryHomeStates({ enabled: true, homes: homes('home-a') });
            statesSeen = states.statesByServerId;
            renders += 1;
            return null;
        }
        const screen = await mount(<MembershipHost />);
        await act(async () => { await Promise.resolve(); });
        const settled = renders;
        const settledStates = statesSeen;
        expect(controllerHarness.controllers.some((controller) => controller.serverId === 'home-a')).toBe(true);

        await writeMetadata('home-a', 'home-a-row', 2);
        await writeMetadata('home-a', 'home-a-row', 3);

        expect(renders).toBe(settled);
        expect(statesSeen).toBe(settledStates);
        await screen.unmount();
    });

    it('keeps the index of an enabled source when only a row\'s metadata changed, and rebuilds it when the corpus changed', async () => {
        let source: unknown = null;
        let byServerId: unknown = null;
        function ListHost() {
            const state = useSessionListQuerySourceState({ enabled: true, homes: homes('home-a') });
            source = state.source;
            byServerId = state.byServerId;
            return null;
        }
        const screen = await mount(<ListHost />);
        for (let attempt = 0; attempt < 20 && !(Array.isArray(source) && source.length > 0); attempt += 1) {
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
        }
        await writeMetadata('home-a', 'home-a-row', 1);
        const settledSource = source;
        const settledByServerId = byServerId;
        expect(Array.isArray(settledSource)).toBe(true);
        expect((settledSource as unknown[]).length).toBeGreaterThan(0);

        await writeMetadata('home-a', 'home-a-row', 2);
        expect(source).toBe(settledSource);
        expect(byServerId).toBe(settledByServerId);

        await act(async () => {
            controllerHarness.controllers.find((controller) => controller.serverId === 'home-a')?.publishLate('home-a-late');
        });
        expect(source).not.toBe(settledSource);
        await screen.unmount();
    });
});
