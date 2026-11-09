/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';

// The real store, controller and hook run; only the credential, feature and transport
// boundaries are stand-ins.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        getAllKeys() {
            return [...kvStore.keys()];
        }
        clearAll() {
            kvStore.clear();
        }
        trim() {}
    }
    return { MMKV };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const scopeHarness = vi.hoisted(() => {
    type Binding = Readonly<{
        serverId: string;
        accountId: string;
        revision: number;
        scope: Readonly<{ serverId: string; accountId: string }>;
        isCurrent(): boolean;
        onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
    }>;
    const bindings = new Map<string, Binding>();
    let revision = 0;
    const bind = (serverId: string, accountId: string) => {
        bindings.set(serverId, {
            serverId,
            accountId,
            revision: ++revision,
            scope: { serverId, accountId },
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        });
    };
    return { bindings, bind };
});

const scopeMaps = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    // Stable while the bindings are, as the real memoized owner is.
    useServerCredentialAccountScopes: (serverIds: readonly string[]) => {
        const selected = [...scopeHarness.bindings].filter(([serverId]) => serverIds.includes(serverId));
        const key = selected.map(([serverId, binding]) => `${serverId}:${binding.revision}`).join('|');
        if (!scopeMaps.has(key)) scopeMaps.set(key, new Map(selected));
        return scopeMaps.get(key);
    },
}));

const featureSnapshots = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    resolveRuntimeFeatureDecisionFromSnapshot: () => ({ state: 'enabled' }),
    // Stable per selection, as the real snapshot owner is.
    useServerFeaturesMainSelectionSnapshot: (serverIds: readonly string[]) => {
        const key = serverIds.join('|');
        if (!featureSnapshots.has(key)) {
            featureSnapshots.set(key, {
                status: 'ready',
                serverIds,
                snapshotsByServerId: Object.fromEntries(serverIds.map((serverId) => [serverId, { status: 'ready' }])),
            });
        }
        return featureSnapshots.get(key);
    },
}));

const localPolicySettings = vi.hoisted(() => ({}));
vi.mock('@/hooks/server/useFeatureLocalPolicySettings', () => ({
    useFeatureLocalPolicySettings: () => localPolicySettings,
}));

const transport = vi.hoisted(() => ({
    availability: 'online' as 'online' | 'offline',
    nextPageSessionIds: [] as string[],
    requests: 0,
}));

vi.mock('./sessionListQueryRuntime', () => {
    return {
        fetchSessionListQueryPageForHome: vi.fn(async (serverId: string) => {
            // Imported lazily: the store graph itself reaches this module.
            const { storage } = await import('@/sync/domains/state/storage');
            const { buildSessionListRenderableFromCacheEntry } = await import('@/sync/domains/state/warmCacheAdapters');
            transport.requests += 1;
            const sessionIds = [...transport.nextPageSessionIds];
            storage.getState().applyServerScopedSessionListRows(
                serverId,
                sessionIds.map((sessionId) => buildSessionListRenderableFromCacheEntry({
                    sessionId,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    updatedAt: 20,
                    createdAt: 10,
                    active: false,
                    activeAt: 20,
                    archivedAt: null,
                    pendingCount: 0,
                    pendingVersion: 0,
                    accessLevel: 'edit',
                    canApprovePermissions: true,
                    name: sessionId,
                    path: `/home/u/${sessionId}`,
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: false,
                } as Parameters<typeof buildSessionListRenderableFromCacheEntry>[0])),
                { source: 'query', mode: 'replace' },
            );
            return {
                sessionIds,
                nextCursor: null,
                hasNext: false,
                attentionNextCursor: null,
                attentionHasNext: false,
                current: true,
                source: 'v2' as const,
            };
        }),
        getSessionListQueryHomeAvailability: () => transport.availability,
        isSessionListQueryHomeOnline: () => transport.availability === 'online',
        resolveOrdinarySessionListHomeOwner: () => null,
        loadNextOrdinarySessionListPage: vi.fn(async () => undefined),
        readOrdinarySessionListHomeState: vi.fn(),
        refreshOrdinarySessionList: vi.fn(async () => undefined),
        retrySessionListQueryHome: vi.fn(async () => undefined),
    };
});

import { useSessionListQuerySourceState, type SessionListQuerySourceState } from './useSessionListQuerySourceState';

const QUERY: SessionListQueryV1 = {
    v: 1,
    storage: 'active',
    includeInactive: true,
    scope: 'all_accessible',
    attention: 'any',
    audiences: [{ kind: 'team', teamId: 'team-a' }],
    tagIds: [],
    includeAttention: false,
};

function renderedSessionIds(state: SessionListQuerySourceState | null): string[] | null {
    if (!state?.source) return null;
    return state.source.flatMap((item) => (item.type === 'session' ? [item.sessionId] : []));
}

describe('strict-query membership continuity', () => {
    const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let previousActEnvironment: boolean | undefined;
    const stateRef: { current: SessionListQuerySourceState | null } = { current: null };

    let hostServerId = 'home-a';
    function Host(props: Readonly<{ revision: number }>) {
        const homes = React.useMemo(
            () => [{ serverId: hostServerId, query: QUERY }],
            // A new array per revision re-applies the controller input, as a reconnect does.
            // eslint-disable-next-line react-hooks/exhaustive-deps
            [props.revision],
        );
        stateRef.current = useSessionListQuerySourceState({ enabled: true, homes });
        return null;
    }

    async function mount(revision = 0): Promise<Readonly<{ root: Root; container: HTMLElement }>> {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(<Host revision={revision} />);
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        return { root, container };
    }

    async function unmount(screen: Readonly<{ root: Root; container: HTMLElement }>): Promise<void> {
        await act(async () => {
            screen.root.unmount();
        });
        screen.container.remove();
    }

    beforeEach(() => {
        previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
        kvStore.clear();
        scopeHarness.bindings.clear();
        transport.availability = 'online';
        transport.nextPageSessionIds = [];
        transport.requests = 0;
        stateRef.current = null;
        hostServerId = 'home-a';
    });

    afterEach(() => {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    });

    it('keeps the last-known rows through a cold controller while offline, then reconciles, never across Accounts', async () => {
        scopeHarness.bind('home-a', 'account-a');
        transport.nextPageSessionIds = ['s1'];
        const first = await mount();
        expect(renderedSessionIds(stateRef.current)).toEqual(['s1']);
        await unmount(first);

        // A new mount builds a new controller. The Home is unreachable, so no page can
        // answer: the last-known membership for this exact Account/Home/query stays.
        transport.availability = 'offline';
        const offline = await mount(1);
        expect(renderedSessionIds(stateRef.current)).toEqual(['s1']);
        expect(stateRef.current?.coverageComplete).toBe(false);

        // Reachable again: the authoritative page replaces the last-known membership.
        transport.availability = 'online';
        transport.nextPageSessionIds = ['s2'];
        await act(async () => {
            offline.root.render(<Host revision={2} />);
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(renderedSessionIds(stateRef.current)).toEqual(['s2']);
        await unmount(offline);

        // The same Home under another Account never sees Account A's membership.
        scopeHarness.bind('home-a', 'account-b');
        transport.availability = 'offline';
        const otherAccount = await mount(3);
        expect(renderedSessionIds(stateRef.current) ?? []).toEqual([]);
        await unmount(otherAccount);
    });

    it('restores the exact Account/Home/query last-known membership across a reload, never as complete coverage', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { buildSessionListRenderableFromCacheEntry } = await import('@/sync/domains/state/warmCacheAdapters');
        const { loadSessionListWarmCacheEntries, setWarmCacheAccountScope } = await import('@/sync/domains/state/warmCachePersistence');
        // The focused Home: the warm cache is written and restored for it.
        const home = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(home).not.toBe('');
        hostServerId = home;
        setWarmCacheAccountScope('account-a');
        scopeHarness.bind(home, 'account-a');
        const ordinaryRow = (sessionId: string) => buildSessionListRenderableFromCacheEntry({
            sessionId,
            metadataVersion: 1,
            agentStateVersion: 1,
            updatedAt: 20,
            createdAt: 10,
            active: false,
            activeAt: 20,
            archivedAt: null,
            accessLevel: 'edit',
            canApprovePermissions: true,
            name: sessionId,
            path: `/home/u/${sessionId}`,
        } as Parameters<typeof buildSessionListRenderableFromCacheEntry>[0]);
        // Sync's ordinary corpus (persisted by its own warm-cache owner) holds the rows.
        storage.getState().applyServerScopedSessionListRows(
            home,
            ['s1', 's2', 's3'].map(ordinaryRow),
            { source: 'ordinary', mode: 'replace' },
        );
        transport.nextPageSessionIds = ['s1', 's3'];
        const online = await mount();
        expect(renderedSessionIds(stateRef.current)).toEqual(['s1', 's3']);
        await unmount(online);

        const reload = (accountId: string, options: Readonly<{ withRows: boolean }> = { withRows: true }) => {
            // A new process: the in-memory store is empty, only the device cache remains.
            storage.setState({
                sessionListRowsByServerId: {},
                ordinarySessionListMembershipByServerId: {},
                sessionListIndexByServerId: {},
                sessionListQueryMembershipByKey: {},
            });
            // Rows stay Account A's so only membership qualification decides what renders.
            const rows = Object.values(loadSessionListWarmCacheEntries(home, 'account-a')).map(buildSessionListRenderableFromCacheEntry);
            setWarmCacheAccountScope(accountId);
            if (options.withRows && rows.length > 0) {
                storage.getState().applyServerScopedSessionListRows(home, rows, { source: 'ordinary', mode: 'replace' });
            }
            storage.getState().restoreSessionListQueryMemberships(home, accountId);
        };

        // Offline reload with support still unknown: the filter shows its last-known rows.
        reload('account-a');
        transport.availability = 'offline';
        const offline = await mount(1);
        expect(renderedSessionIds(stateRef.current)).toEqual(['s1', 's3']);
        expect(stateRef.current?.coverageComplete).toBe(false);
        await unmount(offline);

        // Last-known ids whose rows this device no longer holds are not an answer: the
        // filter stays loading instead of claiming an empty result.
        reload('account-a', { withRows: false });
        const rowless = await mount(4);
        expect(stateRef.current?.source ?? null).toBeNull();
        await unmount(rowless);

        // Another Account on the same Home restores nothing of Account A's membership.
        reload('account-b');
        scopeHarness.bind(home, 'account-b');
        const otherAccount = await mount(2);
        expect(renderedSessionIds(stateRef.current) ?? []).toEqual([]);
        await unmount(otherAccount);
    });
});
