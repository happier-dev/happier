import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { renderHook, renderScreen, flushHookEffects, createSessionAccessFixture } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

let fail = false;
let sessionIds = ['own'];
let requests = 0;
const sessionRecord = (id: string) => V2SessionRecordSchema.parse({
        id, seq: 1, createdAt: 1, updatedAt: 2, active: false, activeAt: 2,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        // A definite non-match belongs to another admitted checkout. A conflicting
        // Project id on this checkout is unavailable, not evidence of exclusion.
        metadata: JSON.stringify({ path: id === 'other' ? '/other' : '/repo', machineId: 'machine',
            workspaceId: id === 'other' ? 'other-checkout' : 'checkout', projectId: id === 'other' ? 'other-project' : 'anchor' }),
        metadataVersion: 1, agentState: null, agentStateVersion: 1, share: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
        responsibleAccountId: null, responsibleAccount: null,
    viewer: {
        latestFailureSeq: null,
        readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
        relevance: { relevant: true, reasons: ['owned_by_me'] },
        attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
        follow: { follows: false, notificationLevel: null }, notification: { level: 'important', source: 'owner' },
    } });
const runtime = installSessionPaneRuntimeTestHarness({
    // The 0.3 Home advertises the Project selector the roster sends.
    features: () => createRootLayoutFeaturesResponse({ features: { sessions: { filteredListing: { enabled: true, projectSelectorVersion: 1 } } } }),
    configureSocket: socket => {
        vi.spyOn(socket, 'emit').mockReturnValue(socket);
        vi.mocked(socket.connect).mockImplementation(() => {
            socket.connected = true;
            for (const listener of socket.listeners('connect')) listener();
            return socket;
        });
}, request: async url => {
    const path = new URL(String(url)).pathname;
    const id = path.startsWith('/v2/sessions/') ? decodeURIComponent(path.slice('/v2/sessions/'.length)) : null;
    if (id && sessionIds.includes(id)) return Response.json({ session: sessionRecord(id) });
    if (path !== '/v2/sessions' && path !== '/v2/sessions/query') return null;
    requests += 1;
    if (fail) return new Response('{}', { status: 503 });
    const page = { sessions: sessionIds.map(sessionRecord), nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false };
    return Response.json(createSessionListSourceFixture(page));
} });

const { useProjectSessionsWidgetBody } = await import('./useProjectSessionsWidgetBody');
const { storage } = await import('@/sync/domains/state/storageStore');
const { retireSessionListQueryAddress } = await import('@/sync/domains/session/listing/sessionListQueryInvalidation');

describe('binder-admitted Project Session body model', () => {
    it('does not render the Project roster for five content arrivals in another Project, but follows a move into this Project', async () => {
        fail = false;
        sessionIds = ['own', 'other'];
        const checkout = { id: 'checkout', serverId: runtime.serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout,
            { ...checkout, id: 'other-checkout', rootPath: '/other', projectKey: 'other-project' }] });
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useProjectSessionsWidgetBody(checkout); }, { wrapper: runtime.Wrapper });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().presentation.kind).toBe('ready'));
            const before = hook.getCurrent().items;
            renders = 0;
            for (let arrival = 0; arrival < 5; arrival++) {
                await act(async () => storage.setState(state => {
                    const rows = state.sessionListRowsByServerId[runtime.serverId]!;
                    return { sessionListRowsByServerId: { ...state.sessionListRowsByServerId,
                        [runtime.serverId]: { ...rows, other: { ...rows.other!, seq: rows.other!.seq + 1 } } } };
                }));
            }
            expect({ renders, sameItems: hook.getCurrent().items === before }).toEqual({ renders: 0, sameItems: true });
            await act(async () => storage.setState(state => {
                const rows = state.sessionListRowsByServerId[runtime.serverId]!;
                return { sessionListRowsByServerId: { ...state.sessionListRowsByServerId,
                    [runtime.serverId]: { ...rows, other: { ...rows.other!, projectKey: 'anchor', metadata: rows.own!.metadata } } } };
            }));
            expect(hook.getCurrent().items.map(item => item.sessionId).sort()).toEqual(['other', 'own']);
            expect(renders).toBeGreaterThan(0);
            await act(async () => storage.setState(state => {
                const rows = state.sessionListRowsByServerId[runtime.serverId]!;
                return { sessionListRowsByServerId: { ...state.sessionListRowsByServerId,
                    [runtime.serverId]: { ...rows, other: { ...rows.other!, projectKey: undefined,
                        metadata: { ...rows.own!.metadata!, projectId: 'other-project' } } } } };
            }));
            expect(hook.getCurrent().items.map(item => item.sessionId)).toEqual(['own']);
            expect(hook.getCurrent().unavailableCount).toBe(1);
            expect(hook.getCurrent().presentation).toMatchObject({ kind: 'ready', complete: false });
        } finally { await hook.unmount(); }
    });
    it('retains an admitted archiving row until settlement, then excludes its cache-only row', async () => {
        fail = false;
        sessionIds = ['own'];
        const checkout = { id: 'checkout', serverId: runtime.serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout] });
        const hook = await renderHook(() => useProjectSessionsWidgetBody(checkout), { wrapper: runtime.Wrapper });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().presentation.kind).toBe('ready'));
            const operation = storage.getState().beginSessionArchive({ serverId: runtime.serverId, sessionId: 'own' });
            expect(operation).not.toBeNull();
            await act(async () => retireSessionListQueryAddress(runtime.serverId, 'own'));
            expect(hook.getCurrent().items.map(item => item.sessionId)).toEqual(['own']);
            await act(async () => { storage.getState().finishSessionArchive(operation!); });
            expect(storage.getState().sessionListRowsByServerId[runtime.serverId]?.own).toBeDefined();
            expect(hook.getCurrent().items).toEqual([]);
        } finally { await hook.unmount(); }
    });
    it('PF4 retains the Project roster identity on equal refreshes and changes it on membership changes', async () => {
        fail = false;
        sessionIds = ['own', 'other'];
        const checkout = { id: 'checkout', serverId: runtime.serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout,
            { ...checkout, id: 'other-checkout', rootPath: '/other', projectKey: 'other-project' }] });
        let current!: ReturnType<typeof useProjectSessionsWidgetBody>;
        let renders = 0;
        const Roster = React.memo(({ items }: { items: typeof current.items }) => { renders++; return null; });
        function Probe() { current = useProjectSessionsWidgetBody(checkout); return <Roster items={current.items} />; }
        const screen = await renderScreen(<runtime.Wrapper><Probe /></runtime.Wrapper>);
        try {
            await vi.waitFor(() => expect(current.presentation.kind).toBe('ready'));
            const before = current.items;
            expect(before.map(item => item.sessionId)).toEqual(['own']);
            renders = 0;
            await act(async () => { await current.query.refresh(); });
            await vi.waitFor(() => expect(current.presentation.kind).toBe('ready'));
            expect({ sameItems: current.items === before, renders }).toEqual({ sameItems: true, renders: 0 });
            sessionIds = ['own', 'added'];
            await act(async () => { await current.query.refresh(); });
            await vi.waitFor(() => expect(current.items.map(item => item.sessionId).sort()).toEqual(['added', 'own']));
            expect(current.items).not.toBe(before);
            expect(current.items.find(item => item.sessionId === 'own')).toBe(before[0]);
        } finally { await screen.unmount(); }
    });
    it('uses real list acquisition, retains rows on refresh failure, recovers to acknowledged empty and withdraws on Account retirement', async () => {
        fail = false;
        sessionIds = ['own', 'other'];
        requests = 0;
        const checkout = { id: 'checkout', serverId: runtime.serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout,
            { ...checkout, id: 'other-checkout', rootPath: '/other', projectKey: 'other-project' }] });
        const hook = await renderHook(() => useProjectSessionsWidgetBody(checkout), { wrapper: runtime.Wrapper });
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect({ ids: hook.getCurrent().items.map(item => item.sessionId), requests, access: hook.getCurrent().access,
                presentation: hook.getCurrent().presentation.kind,
                failures: Object.values(hook.getCurrent().query.statesByServerId).map(state => state?.failureCode ?? state?.failureReason) })
                .toEqual({ ids: ['own'], requests: expect.any(Number), access: 'available', presentation: 'ready', failures: [null] });
            expect(hook.getCurrent().presentation).toMatchObject({ kind: 'ready', complete: true });
        });
        expect(requests).toBeGreaterThan(0);
        fail = true;
        await act(async () => { await hook.getCurrent().query.refresh(); });
        expect(hook.getCurrent().items.map(item => item.sessionId)).toEqual(['own']);
        expect(hook.getCurrent().presentation.kind).not.toBe('ready');
        fail = false;
        sessionIds = [];
        await act(async () => { await hook.getCurrent().query.refresh(); });
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().items).toEqual([]);
            expect(hook.getCurrent().presentation).toMatchObject({ kind: 'ready', complete: true });
        });
        await act(async () => { storage.setState({ profileScope: { serverId: runtime.serverId, accountId: 'different-account' } }); });
        expect(hook.getCurrent().items).toEqual([]);
        await hook.unmount();
    });
});
