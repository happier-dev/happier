import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/runtimePresentation';
import { useDestinationInstanceTabPresentations } from './useDestinationInstanceTabPresentations';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const entries = [{ key: 'tab', ref: { kind: 'session', params: { id: 's1', serverId: 'home-a' } } }];
let previousState: ReturnType<typeof storage.getState>;
beforeEach(() => {
    previousState = storage.getState();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
});
afterEach(async () => {
    await standardCleanup();
    storage.setState(previousState, true);
    vi.useRealTimers();
});

function seed(overrides: Parameters<typeof createSessionListRenderableSessionFixture>[0] = {}) {
    const row = createSessionListRenderableSessionFixture({ id: 's1', active: true, activeAt: Date.now(), ...overrides });
    storage.setState({ sessionListRowsByServerId: { 'home-a': { s1: row } } });
    return row;
}

describe('workspace session tab presentation', () => {
    it('labels only an explicitly stopped offline process Stopped and follows its resume', async () => {
        const metadata = { path: '/repo', lifecycleState: 'stopped' };
        seed({ active: false, presence: undefined, metadata });
        const hook = await renderHook(() => useDestinationInstanceTabPresentations(entries));
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'offline', label: 'sessionWork.states.stopped' } });
        await act(async () => { seed({ active: false, presence: undefined, metadata: { ...metadata, lifecycleState: 'running' } }); });
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'offline', label: 'status.offline' } });
        await act(async () => { seed({ metadata: { ...metadata, lifecycleState: 'running' }, latestTurnStatus: 'in_progress' }); });
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'working', label: 'status.working' } });
    });

    it('follows the canonical live, attention, failure, offline and idle states', async () => {
        seed({ latestTurnStatus: 'in_progress' });
        const hook = await renderHook(() => useDestinationInstanceTabPresentations(entries));
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'working', label: 'status.working' } });
        await act(async () => { seed({ latestTurnStatus: 'in_progress', hasPendingPermissionRequests: true, pendingRequestObservedAt: Date.now() }); });
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'attention', label: 'status.permissionRequired' } });
        await act(async () => { seed({ latestTurnStatus: 'failed' }); });
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'failed' } });
        await act(async () => { seed({ latestTurnStatus: 'in_progress', presence: 999_000 }); });
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'offline', label: 'status.offline' } });
        await act(async () => { seed({ latestTurnStatus: 'in_progress', archivedAt: Date.now() }); });
        expect(hook.getCurrent().get('tab')).toBeUndefined();
        await act(async () => { seed(); });
        expect(hook.getCurrent().get('tab')).toBeUndefined();
    });

    it('uses the exact Home summary and ignores unrelated sessions and transcript updates', async () => {
        const row = seed({ latestTurnStatus: 'in_progress' });
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useDestinationInstanceTabPresentations(entries); });
        const before = hook.getCurrent();
        const rendersBefore = renders;
        await act(async () => {
            storage.setState({ sessionListRowsByServerId: { 'home-a': { s1: row }, 'home-b': { s1: createSessionListRenderableSessionFixture({ id: 's1', presence: 0 }) } } });
            storage.setState({ sessionMessages: {} });
        });
        expect(hook.getCurrent()).toBe(before);
        expect(renders).toBe(rendersBefore);
    });

    it('does not redraw the strip when an open tab\'s Session changes a fact its status does not show', async () => {
        // Every new message or agent-state write replaces the row; the strip redrew on each one.
        const row = seed({ latestTurnStatus: 'in_progress' });
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useDestinationInstanceTabPresentations(entries); });
        const before = hook.getCurrent();
        const rendersBefore = renders;
        await act(async () => {
            for (let seq = 2; seq < 5; seq += 1) {
                storage.setState({ sessionListRowsByServerId: { 'home-a': { s1: { ...row, seq, updatedAt: row.updatedAt + seq } } } });
            }
        });
        expect(hook.getCurrent()).toBe(before);
        expect(renders - rendersBefore).toBe(0);
    });

    it('withdraws a working spinner at the canonical freshness deadline without a store update', async () => {
        seed({ latestTurnStatus: 'in_progress' });
        const hook = await renderHook(() => useDestinationInstanceTabPresentations(entries));
        expect(hook.getCurrent().get('tab')?.status?.tone).toBe('working');
        await act(async () => { await vi.advanceTimersByTimeAsync(SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 1); });
        expect(hook.getCurrent().get('tab')).toBeUndefined();
    });

    it('keeps resuming under the canonical owner until its marker clears', async () => {
        seed({ resumingAt: Date.now() });
        const hook = await renderHook(() => useDestinationInstanceTabPresentations(entries));
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'working', label: 'session.resuming' } });
        await act(async () => { seed({ resumingAt: null }); });
        expect(hook.getCurrent().get('tab')).toBeUndefined();
    });

    it('keeps unreadable and uncached sessions quiet instead of guessing work or offline', async () => {
        seed({ latestTurnStatus: 'in_progress', encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_access_pending' });
        const hook = await renderHook(() => useDestinationInstanceTabPresentations(entries));
        expect(hook.getCurrent().get('tab')).toBeUndefined();
        await act(async () => { storage.setState({ sessionListRowsByServerId: {} }); });
        expect(hook.getCurrent().get('tab')).toBeUndefined();
    });

    it('leads a Bot tab with its face from the row it already holds, stable across unrelated row writes', async () => {
        const metadata = { path: '/repo', bot: { kind: 'bot' }, botFace: { style: 'planet', body: 'crab', palette: 'moss' } };
        seed({ metadata });
        const hook = await renderHook(() => useDestinationInstanceTabPresentations(entries));
        const mark = hook.getCurrent().get('tab')?.mark as { props: { facts: { seed: string; face: unknown } } } | undefined;
        expect(mark?.props.facts).toMatchObject({ seed: 's1', face: { style: 'planet', body: 'crab', palette: 'moss' } });
        await act(async () => { seed({ metadata, latestTurnStatus: 'in_progress' }); });
        expect(hook.getCurrent().get('tab')?.mark).toBe(mark);
        await act(async () => { seed({ metadata: { path: '/repo' } }); });
        expect(hook.getCurrent().get('tab')?.mark).toBeUndefined();
    });
});
