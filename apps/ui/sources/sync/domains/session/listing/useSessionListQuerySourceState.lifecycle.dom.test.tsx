/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';

import { createSessionListQuerySourceHarness, waitForSessionListQueryState, type SessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { publishHomeAccountChange, subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { useSessionListQuerySourceState, type SessionListQueryHomeInput, type SessionListQuerySourceState } from './useSessionListQuerySourceState';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const QUERY: SessionListQueryV1 = {
    v: 1, storage: 'active', includeInactive: false, scope: 'all_accessible',
    attention: 'any', audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, includeAttention: true, limit: 1,
};
const FOLLOWING_QUERY: SessionListQueryV1 = { ...QUERY, scope: 'following' };

let boundary: SessionListQuerySourceHarness;
beforeEach(async () => { boundary = await createSessionListQuerySourceHarness(); });
afterEach(async () => { await boundary.dispose(); });

function homes(...serverIds: string[]): SessionListQueryHomeInput[] {
    return serverIds.map(serverId => ({ serverId, query: QUERY }));
}

async function mount(initialHomes: SessionListQueryHomeInput[], options: Readonly<{ strict?: boolean }> = {}) {
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const never = new Promise<never>(() => undefined);
    const state: { current: SessionListQuerySourceState | null } = { current: null };
    let suspendedRenderAttempts = 0;
    let unmounted = false;
    function Host(props: Readonly<{ selectedHomes: SessionListQueryHomeInput[]; suspend: boolean; enabled: boolean }>) {
        state.current = useSessionListQuerySourceState({ enabled: props.enabled, homes: props.selectedHomes });
        if (props.suspend) {
            suspendedRenderAttempts += 1;
            throw never;
        }
        return null;
    }
    const render = (selectedHomes: SessionListQueryHomeInput[], suspend: boolean, enabled = true) => {
        const content = <React.Suspense fallback={null}><Host selectedHomes={selectedHomes} suspend={suspend} enabled={enabled} /></React.Suspense>;
        root.render(options.strict ? <React.StrictMode>{content}</React.StrictMode> : content);
    };
    await act(async () => render(initialHomes, false));
    return {
        state,
        suspendedRenderAttempts: () => suspendedRenderAttempts,
        async ready(...serverIds: string[]) {
            await waitForSessionListQueryState(() => {
                for (const serverId of serverIds) expect(state.current?.statesByServerId[serverId]?.phase).toBe('ready');
            });
        },
        async render(selectedHomes: SessionListQueryHomeInput[], enabled = true) {
            await act(async () => render(selectedHomes, false, enabled));
        },
        async suspend(selectedHomes: SessionListQueryHomeInput[]) {
            await act(async () => {
                React.startTransition(() => render(selectedHomes, true));
                await Promise.resolve();
            });
        },
        async unmount() {
            if (unmounted) return;
            unmounted = true;
            await act(async () => root.unmount());
            container.remove();
            environment.IS_REACT_ACT_ENVIRONMENT = previous;
        },
    };
}

/** Several surfaces of one app asking for the same corpus: each is its own consumer of the hook. */
async function mountConsumers(selectedHomes: SessionListQueryHomeInput[], initialCount: number, memberships: ReadonlyArray<'query' | 'rowOnly'> = []) {
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const states: Array<{ current: SessionListQuerySourceState | null }> = [];
    function Consumer(props: Readonly<{ index: number }>) {
        states[props.index] ??= { current: null };
        const consumerHomes = React.useMemo(
            () => selectedHomes.map(home => ({ ...home, queryMembership: memberships[props.index] ?? 'query' })), [props.index]);
        states[props.index]!.current = useSessionListQuerySourceState({ enabled: true, homes: consumerHomes });
        return null;
    }
    const render = (count: number) => root.render(<>{Array.from({ length: count }, (_, index) => <Consumer key={index} index={index} />)}</>);
    await act(async () => render(initialCount));
    let unmounted = false;
    return {
        states,
        async show(count: number) { await act(async () => render(count)); },
        async unmount() {
            if (unmounted) return;
            unmounted = true;
            await act(async () => root.unmount());
            container.remove();
            environment.IS_REACT_ACT_ENVIRONMENT = previous;
        },
    };
}

describe('useSessionListQuerySourceState committed controller lifecycle', () => {
    it('reuses a covered Session corpus until that Home announces a change', async () => {
        const home = boundary.serverIds[0]!;
        const selection = homes(home);
        const screen = await mount(selection);
        const queries = () => boundary.queryRequests.filter(request => request.serverId === home);
        try {
            await screen.ready(home);
            const settled = screen.state.current?.statesByServerId[home];
            const before = queries().length;
            for (let index = 0; index < 3; index++) {
                await screen.render(selection, false);
                await screen.render(selection);
                await screen.ready(home);
            }
            expect(queries().length - before, 'requests on three unchanged returns').toBe(0);
            expect(screen.state.current?.statesByServerId[home]?.addresses).toBe(settled?.addresses);

            await screen.render(selection, false);
            boundary.setRows(home, ['changed-while-covered']);
            await act(async () => publishHomeAccountChange(home));
            expect(queries()).toHaveLength(before);
            await screen.render(selection);
            await screen.ready(home);
            expect(queries()).toHaveLength(before + 1);
            expect(screen.state.current?.statesByServerId[home]?.addresses).toEqual([
                { serverId: home, sessionId: 'changed-while-covered' },
            ]);
        } finally {
            await screen.unmount();
        }
    });

    it('makes zero idle Session queries after the first page fails and reads once on a Home change', async () => {
        const home = boundary.serverIds[0]!;
        boundary.failQueries(home, 'all');
        const screen = await mount(homes(home));
        const readCount = () => boundary.queryRequests.filter(request => request.serverId === home).length;
        try {
            await waitForSessionListQueryState(() => {
                expect(screen.state.current?.statesByServerId[home]?.phase).toBe('error');
            });
            const afterFirstAttempt = readCount();
            expect(afterFirstAttempt).toBeGreaterThan(0);

            vi.useFakeTimers();
            try {
                // Unrelated shell renders reapply the same mounted list inputs.
                for (let elapsed = 0; elapsed < 60_000; elapsed += 15_000) {
                    await screen.render(homes(home));
                    await act(async () => vi.advanceTimersByTimeAsync(15_000));
                }
            } finally {
                vi.useRealTimers();
            }
            expect(readCount() - afterFirstAttempt, 'Home Session queries in the idle minute').toBe(0);

            boundary.failQueries(home, null);
            boundary.setRows(home, ['newly-accessible-session']);
            await act(async () => publishHomeAccountChange(home));
            await screen.ready(home);
            expect(screen.state.current?.statesByServerId[home]?.addresses).toEqual([
                { serverId: home, sessionId: 'newly-accessible-session' },
            ]);
            expect(readCount() - afterFirstAttempt).toBe(1);
        } finally {
            await screen.unmount();
        }
    });

    it('keeps paged Session membership through Artifact socket receipts but re-reads for an unknown Account change', async () => {
        const [homeA, homeB] = boundary.serverIds as [string, string, string];
        const screen = await mount(homes(homeA, homeB));
        const artifactReceipts: string[] = [];
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (event.serverId === homeA && event.source === 'socket' && event.changeKinds?.includes('artifact')) {
                artifactReceipts.push(...event.entityIds ?? []);
            }
        });
        try {
            await screen.ready(homeA, homeB);
            await act(async () => { await screen.state.current?.loadNext(); });
            const retainedA = screen.state.current!.statesByServerId[homeA]!;
            const retainedB = screen.state.current!.statesByServerId[homeB]!;
            const requestsBefore = boundary.queryRequests.length;
            const trustReads = () => boundary.http.requests.filter(request =>
                request.path === '/v1/account/encryption/currentness').length;
            const trustBefore = trustReads();
            await act(async () => {
                for (let index = 0; index < 4; index += 1) {
                    const update = UpdateContainerSchema.parse({
                        id: `artifact-receipt-${index}`, seq: index + 1, createdAt: Date.now(),
                        body: { t: 'delete-artifact', artifactId: `unrelated-artifact-${index}` },
                    });
                    const socket = boundary.socket(homeA);
                    // The SDK transport forwards through onAny; deliver the external
                    // packet to both public listener families as Socket.IO does.
                    for (const listener of socket.listenersAny()) listener('update', update);
                    for (const listener of socket.listeners('update')) listener(update);
                }
            });
            await waitForSessionListQueryState(() => expect(artifactReceipts).toHaveLength(4));
            expect(boundary.queryRequests).toHaveLength(requestsBefore);
            expect(trustReads()).toBe(trustBefore);
            expect(screen.state.current!.statesByServerId[homeA]).toBe(retainedA);
            expect(screen.state.current!.statesByServerId[homeB]).toBe(retainedB);

            boundary.setRows(homeA, ['newly-accessible-session']);
            await act(async () => publishHomeAccountChange(homeA));
            await waitForSessionListQueryState(() => expect(screen.state.current?.statesByServerId[homeA]?.addresses)
                .toEqual([{ serverId: homeA, sessionId: 'newly-accessible-session' }]));
            expect(boundary.queryRequests.slice(requestsBefore).map(request => request.serverId)).toEqual([homeA]);
            // The finite re-read borrows the live socket's admitted encryption
            // identity; an unrelated Account wake does not withdraw that identity.
            expect(trustReads()).toBe(trustBefore);
            expect(screen.state.current!.statesByServerId[homeB]).toBe(retainedB);
        } finally {
            unsubscribe();
            await screen.unmount();
        }
    });

    it('does not dispose committed Home state from an abandoned StrictMode transition', async () => {
        const [homeA, homeB, homeC] = boundary.serverIds as [string, string, string];
        const screen = await mount(homes(homeA, homeB), { strict: true });
        let pending: Promise<void> | undefined;
        try {
            await screen.ready(homeA, homeB);
            expect(screen.state.current?.statesByServerId[homeB]?.nextCursor).toBe('cursor:' + boundary.accountId(homeB));
            boundary.holdQueries(homeB);
            await act(async () => {
                pending = screen.state.current?.loadNext();
                await waitForHomeGovernance(() => expect(boundary.queryRequests.some(request => request.serverId === homeB && request.cursor !== null)).toBe(true));
            });
            const pendingHomeB = boundary.queryRequests.find(request => request.serverId === homeB && request.cursor !== null)!;
            await waitForSessionListQueryState(() => expect(screen.state.current?.statesByServerId[homeA]?.addresses.map(address => address.sessionId))
                .toEqual([boundary.accountId(homeA) + '-row', boundary.accountId(homeA) + '-page-2']));
            await screen.suspend(homes(homeA, homeC));
            expect(screen.suspendedRenderAttempts()).toBeGreaterThan(0);
            expect(pendingHomeB.signal?.aborted).toBe(false);
            expect(boundary.queryRequests.some(request => request.serverId === homeC)).toBe(false);
            await screen.render(homes(homeA, homeB));
            expect(pendingHomeB.signal?.aborted).toBe(false);
            expect(screen.state.current?.statesByServerId[homeB]?.nextCursor).toBe('cursor:' + boundary.accountId(homeB));
            await screen.render(homes(homeA, homeC));
            await screen.ready(homeA, homeC);
            expect(pendingHomeB.signal?.aborted).toBe(true);
            expect(pendingHomeB.aborts.count).toBe(1);
            expect(screen.state.current?.statesByServerId[homeA]?.addresses.map(address => address.sessionId))
                .toEqual([boundary.accountId(homeA) + '-row', boundary.accountId(homeA) + '-page-2']);
            expect(screen.state.current?.statesByServerId[homeB]).toBeUndefined();
        } finally {
            boundary.releaseQueries(homeB);
            await pending;
            await screen.unmount();
        }
    });

    it('retires every committed StrictMode request exactly once on unmount', async () => {
        const [homeA, homeB] = boundary.serverIds as [string, string, string];
        boundary.holdQueries(homeA);
        boundary.holdQueries(homeB);
        const screen = await mount(homes(homeA, homeB), { strict: true });
        try {
            await waitForSessionListQueryState(() => {
                for (const serverId of [homeA, homeB]) {
                    expect(boundary.queryRequests.some(request => request.serverId === serverId && request.signal?.aborted === false)).toBe(true);
                }
            });
            await screen.unmount();
            expect(boundary.queryRequests.length).toBeGreaterThan(0);
            for (const request of boundary.queryRequests) {
                expect(request.signal?.aborted).toBe(true);
                expect(request.aborts.count).toBe(1);
            }
            for (const serverId of [homeA, homeB]) {
                expect(storage.getState().sessionListRowsByServerId[serverId]?.[boundary.accountId(serverId) + '-row']).toBeUndefined();
            }
        } finally { await screen.unmount(); }
    });

    it('advances one page on every selected Home without changing the focused Home', async () => {
        const [homeA, homeB] = boundary.serverIds as [string, string, string];
        const focusedHome = boundary.focusedHome();
        const screen = await mount(homes(homeA, homeB));
        try {
            await screen.ready(homeA, homeB);
            await act(async () => { await screen.state.current?.loadNext(); });
            for (const serverId of [homeA, homeB]) {
                expect(boundary.queryRequests.filter(request => request.serverId === serverId).map(request => request.cursor))
                    .toEqual([null, 'cursor:' + boundary.accountId(serverId)]);
                expect(screen.state.current?.statesByServerId[serverId]?.addresses.map(address => address.sessionId))
                    .toEqual([boundary.accountId(serverId) + '-row', boundary.accountId(serverId) + '-page-2']);
            }
            expect(boundary.focusedHome()).toBe(focusedHome);
        } finally { await screen.unmount(); }
    });

    it('retries every offline Home before refreshing the selected query controllers', async () => {
        const [homeA, homeB] = boundary.serverIds as [string, string, string];
        const screen = await mount(homes(homeA, homeB));
        try {
            await screen.ready(homeA, homeB);
            boundary.setReachable(homeB, false);
            await act(async () => {
                boundary.loseTransport(homeB);
                // HTTP reachability owns query availability independently of the
                // realtime socket. Let an actual read observe the unreachable Home.
                await screen.state.current?.refresh();
            });
            await waitForSessionListQueryState(() => expect(screen.state.current?.statesByServerId[homeB]?.phase).toBe('offline'));
            // A later user retry is distinct from the coalesced transport-loss revalidation.
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(Date.now() + 1_000);
            const start = boundary.events.length;
            boundary.setReachable(homeB, true);
            await act(async () => { await screen.state.current?.refresh(); });
            await screen.ready(homeA, homeB);
            const events = boundary.events.slice(start);
            const reconnect = events.findIndex(event => event.kind === 'connected' && event.origin === boundary.origin(homeB));
            const retryProbe = events.findIndex(event => event.kind === 'probe' && event.serverId === homeB);
            const firstRefresh = events.findIndex(event => event.kind === 'query');
            expect(reconnect).toBeGreaterThanOrEqual(0);
            expect(retryProbe).toBeGreaterThanOrEqual(0);
            expect(firstRefresh).toBeGreaterThan(retryProbe);
            expect(events.filter(event => event.kind === 'connected' && event.origin === boundary.origin(homeA))).toEqual([]);
            for (const serverId of [homeA, homeB]) {
                expect(events.some(event => event.kind === 'query' && event.serverId === serverId)).toBe(true);
            }
        } finally {
            vi.useRealTimers();
            await screen.unmount();
        }
    });

    it('keeps selected Following Homes in coverage while admitting requests per exact Home', async () => {
        const [homeA, homeB] = boundary.serverIds as [string, string, string];
        await boundary.setFollowingEnabled(homeA, false);
        const selectedHomes = [homeA, homeB].map(serverId => ({ serverId, query: FOLLOWING_QUERY }));
        const screen = await mount(selectedHomes);
        try {
            await screen.ready(homeB);
            await waitForSessionListQueryState(() => expect(screen.state.current?.statesByServerId[homeA])
                .toMatchObject({ phase: 'error', failureReason: 'unsupported' }));
            expect(boundary.queryRequests.some(request => request.serverId === homeA)).toBe(false);
            expect(screen.state.current?.statesByServerId[homeB]?.addresses)
                .toEqual([{ serverId: homeB, sessionId: boundary.accountId(homeB) + '-row' }]);
            expect(Object.keys(screen.state.current?.statesByServerId ?? {})).toEqual([homeA, homeB]);
            await act(async () => { await boundary.setFollowingEnabled(homeA, true); });
            await screen.ready(homeA, homeB);
            expect(screen.state.current?.statesByServerId[homeA]?.addresses)
                .toEqual([{ serverId: homeA, sessionId: boundary.accountId(homeA) + '-row' }]);
        } finally { await screen.unmount(); }
    });

    it('retires same-Home query membership with Account A before Account B can publish', async () => {
        const [otherHome, replacedHome] = boundary.serverIds as [string, string, string];
        const oldAccountId = boundary.accountId(replacedHome);
        const screen = await mount(homes(otherHome, replacedHome));
        let pending: Promise<void> | undefined;
        try {
            await screen.ready(otherHome, replacedHome);
            const oldCursor = screen.state.current?.statesByServerId[replacedHome]?.nextCursor;
            boundary.holdQueries(replacedHome);
            const before = boundary.queryRequests.length;
            await act(async () => {
                pending = screen.state.current?.refresh();
                await waitForHomeGovernance(() => expect(boundary.queryRequests.slice(before).some(request => request.serverId === replacedHome)).toBe(true));
            });
            const oldRequest = boundary.queryRequests.slice(before).find(request => request.serverId === replacedHome)!;
            await act(async () => { await boundary.switchAccount(replacedHome, 'replacement-account'); });
            await waitForSessionListQueryState(() => expect(oldRequest.signal?.aborted).toBe(true));
            expect(oldRequest.aborts.count).toBe(1);
            expect(Object.values(storage.getState().sessionListQueryMembershipByKey)
                .some(membership => membership?.serverId === replacedHome && membership.accountId === oldAccountId)).toBe(false);
            boundary.releaseQueries(replacedHome);
            await screen.ready(otherHome, replacedHome);
            expect(screen.state.current?.statesByServerId[replacedHome]?.nextCursor).toBe('cursor:replacement-account');
            expect(screen.state.current?.statesByServerId[replacedHome]?.nextCursor).not.toBe(oldCursor);
            expect(screen.state.current?.statesByServerId[replacedHome]?.addresses)
                .toEqual([{ serverId: replacedHome, sessionId: 'replacement-account-row' }]);
            expect(screen.state.current?.statesByServerId[otherHome]?.addresses)
                .toEqual([{ serverId: otherHome, sessionId: boundary.accountId(otherHome) + '-row' }]);
        } finally {
            boundary.releaseQueries(replacedHome);
            await pending;
            await screen.unmount();
        }
    });
});

describe('useSessionListQuerySourceState concurrent consumers of one corpus', () => {
    it('asks each Home for one first page when several surfaces mount the same corpus together', async () => {
        const [homeA, homeB] = boundary.serverIds as [string, string, string];
        const requestsBefore = boundary.queryRequests.length;
        // The Homes answer slowly, as a loaded Home does: every surface asks while the first page is still on the wire.
        boundary.holdQueries(homeA);
        boundary.holdQueries(homeB);
        // A mounted filter and a row-only consumer (activity, bots) ask for the same corpus.
        const screen = await mountConsumers(homes(homeA, homeB), 3, ['query', 'rowOnly', 'query']);
        try {
            await waitForSessionListQueryState(() => {
                for (const serverId of [homeA, homeB]) {
                    expect(boundary.queryRequests.slice(requestsBefore).some(request => request.serverId === serverId)).toBe(true);
                }
            });
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
            boundary.releaseQueries(homeA);
            boundary.releaseQueries(homeB);
            await waitForSessionListQueryState(() => {
                for (const state of screen.states) {
                    for (const serverId of [homeA, homeB]) expect(state.current?.statesByServerId[serverId]?.phase).toBe('ready');
                }
            });
            // The applied Home is served by Sync and the other by the concurrent cache; both read one page.
            for (const serverId of [homeA, homeB]) {
                expect(boundary.queryRequests.slice(requestsBefore).filter(request => request.serverId === serverId && request.cursor === null)).toHaveLength(1);
            }
        } finally {
            boundary.releaseQueries(homeA);
            boundary.releaseQueries(homeB);
            await screen.unmount();
        }
    });

    it('keeps the shared page alive for the surfaces still showing it, and retires it with the last one', async () => {
        const homeA = boundary.serverIds[0]!;
        boundary.holdQueries(homeA);
        const requestsBefore = boundary.queryRequests.length;
        const homeRequests = () => boundary.queryRequests.slice(requestsBefore).filter(request => request.serverId === homeA);
        const screen = await mountConsumers(homes(homeA), 2);
        try {
            await waitForSessionListQueryState(() => expect(homeRequests()).toHaveLength(1));
            const shared = homeRequests()[0]!;
            await screen.show(1);
            expect(shared.signal?.aborted).toBe(false);
            // A surface that starts asking while that page is still on the wire waits for it too.
            await screen.show(2);
            expect(homeRequests()).toHaveLength(1);
            await screen.unmount();
            expect(shared.signal?.aborted).toBe(true);
            expect(shared.aborts.count).toBe(1);
        } finally {
            boundary.releaseQueries(homeA);
            await screen.unmount();
        }
    });

    it('does not answer a surface from a page that began before its Home changed', async () => {
        const homeA = boundary.serverIds[0]!;
        const requestsBefore = boundary.queryRequests.length;
        const homeRequests = () => boundary.queryRequests.slice(requestsBefore).filter(request => request.serverId === homeA);
        const first = await mountConsumers(homes(homeA), 1);
        try {
            await waitForSessionListQueryState(() => expect(first.states[0]?.current?.statesByServerId[homeA]?.phase).toBe('ready'));
            boundary.holdQueries(homeA);
            const second = await mountConsumers(homes(homeA), 1);
            try {
                await waitForSessionListQueryState(() => expect(homeRequests()).toHaveLength(2));
                const requestsBeforeChange = homeRequests().length;
                // The first surface is idle, so only the change can make it read again; the second still waits on its own page.
                await act(async () => publishHomeAccountChange(homeA));
                await waitForSessionListQueryState(() => expect(homeRequests().length).toBe(requestsBeforeChange + 1));
            } finally {
                boundary.releaseQueries(homeA);
                await second.unmount();
            }
        } finally { await first.unmount(); }
    });
});
