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
                update: vi.fn(async (input: Readonly<{ supported?: boolean | null }>) => {
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

const EMPTY_QUERY_MEMBERSHIP = vi.hoisted(() => ({}));

vi.mock('@/sync/domains/state/storage', () => ({
    useMachineListByServerId: () => ({}),
    useMachineListStatusByServerId: () => ({}),
    useOrdinarySessionListMembershipByServerId: () => ({}),
    useSessionListQueryMembershipByKey: () => EMPTY_QUERY_MEMBERSHIP,
    useSessionListRowsByServerId: () => ({}),
    useSetting: (key: 'sessionListActiveGroupingV1' | 'sessionListInactiveGroupingV1' | 'sessionListSectionModeV1') => ({
        sessionListActiveGroupingV1: 'project',
        sessionListInactiveGroupingV1: 'project',
        sessionListSectionModeV1: 'single',
    })[key],
    useSocketStatus: () => 'connected',
}));

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
    type SessionListQuerySourceState,
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

const FOLLOWING_QUERY: SessionListQueryV1 = { ...QUERY, scope: 'following' };

function homes(...serverIds: string[]): SessionListQueryHomeInput[] {
    return serverIds.map((serverId) => ({ serverId, query: QUERY }));
}

describe('useSessionListQuerySourceState committed controller lifecycle', () => {
    afterEach(() => {
        controllerHarness.controllers.length = 0;
        queryRuntimeHarness.retryHome.mockReset();
        for (const key of Object.keys(featureHarness.decisions)) delete featureHarness.decisions[key];
        for (const binding of scopeHarness.bindings.values()) binding.retire();
        scopeHarness.bindings.clear();
    });

    it('does not dispose committed Home state from an abandoned StrictMode transition', async () => {
        const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        const never = new Promise<never>(() => undefined);
        let suspendedRenderAttempts = 0;

        function Harness(props: Readonly<{
            selectedHomes: SessionListQueryHomeInput[];
            suspend: boolean;
        }>) {
            useSessionListQuerySourceState({ enabled: true, homes: props.selectedHomes });
            if (props.suspend) {
                suspendedRenderAttempts += 1;
                throw never;
            }
            return null;
        }

        const render = (selectedHomes: SessionListQueryHomeInput[], suspend: boolean) => (
            <React.StrictMode>
                <React.Suspense fallback={null}>
                    <Harness selectedHomes={selectedHomes} suspend={suspend} />
                </React.Suspense>
            </React.StrictMode>
        );

        try {
            await act(async () => {
                root.render(render(homes('home-a', 'home-b'), false));
            });
            const committedHomeA = [...controllerHarness.controllers].reverse().find((controller) => (
                controller.serverId === 'home-a' && controller.disposeSpy.mock.calls.length === 0
            ));
            const committedHomeB = [...controllerHarness.controllers].reverse().find((controller) => (
                controller.serverId === 'home-b' && controller.disposeSpy.mock.calls.length === 0
            ));
            expect(committedHomeA).toBeDefined();
            expect(committedHomeB).toBeDefined();
            expect(committedHomeB?.getSnapshot().nextCursor).toBe('cursor:home-b');

            await act(async () => {
                React.startTransition(() => {
                    root.render(render(homes('home-a', 'home-c'), true));
                });
                await Promise.resolve();
            });

            expect(suspendedRenderAttempts).toBeGreaterThan(0);
            expect(committedHomeB?.disposeSpy).not.toHaveBeenCalled();
            expect(committedHomeB?.getSnapshot().nextCursor).toBe('cursor:home-b');
            expect(controllerHarness.controllers.some((controller) => controller.serverId === 'home-c')).toBe(false);

            await act(async () => {
                root.render(render(homes('home-a', 'home-b'), false));
            });
            expect(committedHomeB?.disposeSpy).not.toHaveBeenCalled();

            await act(async () => {
                root.render(render(homes('home-a', 'home-c'), false));
            });
            expect(committedHomeA?.disposeSpy).not.toHaveBeenCalled();
            expect(committedHomeA?.getSnapshot().nextCursor).toBe('cursor:home-a');
            expect(committedHomeB?.disposeSpy).toHaveBeenCalledOnce();
            expect(controllerHarness.controllers.some((controller) => (
                controller.serverId === 'home-c' && controller.disposeSpy.mock.calls.length === 0
            ))).toBe(true);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
            actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        }
    });

    it('disposes every committed StrictMode controller exactly once on unmount', async () => {
        const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root: Root = createRoot(container);

        try {
            await act(async () => {
                root.render(
                    <React.StrictMode>
                        <HarnessForUnmount />
                    </React.StrictMode>,
                );
            });
            await act(async () => {
                root.unmount();
            });

            expect(controllerHarness.controllers.length).toBeGreaterThan(0);
            for (const controller of controllerHarness.controllers) {
                expect(controller.disposeSpy).toHaveBeenCalledOnce();
            }
        } finally {
            container.remove();
            actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        }
    });

    it('advances one page on every selected Home without changing the focused Home', async () => {
        const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        let sourceState: SessionListQuerySourceState | null = null;

        function Harness() {
            sourceState = useSessionListQuerySourceState({
                enabled: true,
                homes: homes('home-a', 'home-b'),
            });
            return null;
        }

        try {
            await act(async () => {
                root.render(<Harness />);
            });
            expect(sourceState).not.toBeNull();
            const homeA = controllerHarness.controllers.find((controller) => controller.serverId === 'home-a');
            const homeB = controllerHarness.controllers.find((controller) => controller.serverId === 'home-b');
            expect(homeA).toBeDefined();
            expect(homeB).toBeDefined();

            await act(async () => {
                await sourceState?.loadNext();
            });

            expect(homeA?.loadNext).toHaveBeenCalledOnce();
            expect(homeB?.loadNext).toHaveBeenCalledOnce();
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
            actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        }
    });

    it('retries every offline Home before refreshing the selected query controllers', async () => {
        const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        let sourceState: SessionListQuerySourceState | null = null;

        function Harness() {
            sourceState = useSessionListQuerySourceState({
                enabled: true,
                homes: homes('home-a', 'home-b'),
            });
            return null;
        }

        try {
            await act(async () => {
                root.render(<Harness />);
            });
            const homeA = controllerHarness.controllers.find((controller) => controller.serverId === 'home-a');
            const homeB = controllerHarness.controllers.find((controller) => controller.serverId === 'home-b');
            expect(homeA).toBeDefined();
            expect(homeB).toBeDefined();
            await act(async () => {
                homeB?.publishOffline();
            });

            await act(async () => {
                await sourceState?.refresh();
            });

            expect(queryRuntimeHarness.retryHome).toHaveBeenCalledWith('home-b');
            expect(queryRuntimeHarness.retryHome).not.toHaveBeenCalledWith('home-a');
            expect(homeA?.refresh).toHaveBeenCalledOnce();
            expect(homeB?.refresh).toHaveBeenCalledOnce();
            expect(queryRuntimeHarness.retryHome.mock.invocationCallOrder[0])
                .toBeLessThan((homeA ? vi.mocked(homeA.refresh).mock.invocationCallOrder[0] : undefined) ?? Number.POSITIVE_INFINITY);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
            actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        }
    });

    it('keeps selected Following Homes in coverage while admitting requests per exact Home', async () => {
        featureHarness.decisions['sessions.following:home-a'] = false;
        featureHarness.decisions['sessions.following:home-b'] = true;
        const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        const sourceStateRef: { current: SessionListQuerySourceState | null } = { current: null };

        function Harness() {
            sourceStateRef.current = useSessionListQuerySourceState({
                enabled: true,
                homes: ['home-a', 'home-b'].map((serverId) => ({ serverId, query: FOLLOWING_QUERY })),
            });
            return null;
        }

        try {
            await act(async () => {
                root.render(<Harness />);
            });
            const homeA = controllerHarness.controllers.find((controller) => controller.serverId === 'home-a');
            const homeB = controllerHarness.controllers.find((controller) => controller.serverId === 'home-b');

            expect(homeA?.update).toHaveBeenLastCalledWith(expect.objectContaining({ supported: false }));
            expect(homeB?.update).toHaveBeenLastCalledWith(expect.objectContaining({ supported: true }));
            expect(sourceStateRef.current?.statesByServerId['home-a']).toMatchObject({
                phase: 'error',
                failureReason: 'unsupported',
            });
            expect(sourceStateRef.current?.statesByServerId['home-b']).toMatchObject({
                phase: 'ready',
                addresses: [{ serverId: 'home-b', sessionId: 'home-b-row' }],
            });
            expect(Object.keys(sourceStateRef.current?.statesByServerId ?? {})).toEqual(['home-a', 'home-b']);

            featureHarness.decisions['sessions.following:home-a'] = true;
            await act(async () => {
                root.render(<Harness />);
            });
            expect(homeA?.update).toHaveBeenLastCalledWith(expect.objectContaining({ supported: true }));
            expect(sourceStateRef.current?.statesByServerId['home-a']).toMatchObject({
                phase: 'ready',
                addresses: [{ serverId: 'home-a', sessionId: 'home-a-row' }],
            });
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
            actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        }
    });

    it('retires same-Home query membership with Account A before Account B can publish', async () => {
        const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        const sourceStateRef: { current: SessionListQuerySourceState | null } = { current: null };

        function Harness() {
            sourceStateRef.current = useSessionListQuerySourceState({ enabled: true, homes: homes('home-a', 'home-b') });
            return null;
        }

        try {
            await act(async () => {
                root.render(<Harness />);
            });
            const accountAController = controllerHarness.controllers.find((controller) => controller.serverId === 'home-a')!;
            const unrelatedHomeController = controllerHarness.controllers.find((controller) => controller.serverId === 'home-b')!;
            await act(async () => {
                accountAController.publishLate('account-a-settled');
            });
            const accountACursor = accountAController.getSnapshot().nextCursor;
            const accountABinding = scopeHarness.bindings.get('home-a');
            expect(accountABinding).toBeDefined();

            await act(async () => {
                accountABinding!.retire();
            });
            expect(accountAController.disposeSpy).toHaveBeenCalledOnce();
            expect(unrelatedHomeController.disposeSpy).not.toHaveBeenCalled();

            scopeHarness.bindings.set('home-a', scopeHarness.createBinding('home-a', 'account-b'));
            await act(async () => {
                root.render(<Harness />);
            });

            const accountBController = [...controllerHarness.controllers].reverse().find((controller) => (
                controller.serverId === 'home-a' && controller.disposeSpy.mock.calls.length === 0
            ));
            expect(accountBController).toBeDefined();
            expect(accountBController).not.toBe(accountAController);
            expect(accountBController?.getSnapshot().nextCursor).toBe('cursor:account-b');
            expect(accountBController?.getSnapshot().nextCursor).not.toBe(accountACursor);

            accountAController.publishLate('account-a-late');
            expect(sourceStateRef.current?.statesByServerId['home-a']?.addresses).toEqual([
                { serverId: 'home-a', sessionId: 'account-b-row' },
            ]);
            expect(sourceStateRef.current?.statesByServerId['home-b']?.addresses).toEqual([
                { serverId: 'home-b', sessionId: 'home-b-row' },
            ]);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
            actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        }
    });
});

function HarnessForUnmount() {
    useSessionListQuerySourceState({ enabled: true, homes: homes('home-a', 'home-b') });
    return null;
}
