import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } from '@happier-dev/protocol/sessions/follow/changes';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { waitForTestEvent } from '@/dev/testkit/hooks/waitForTestEvent';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

// Only HTTP, Socket.IO and device credential storage are substituted by this testkit.
const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { setServerReachabilityNetworkAllowed } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { useAccountSessionFollowController } = await import('./useAccountSessionFollowController');
const before = storage.getState();

beforeEach(() => network.resetRequests());
afterEach(async () => {
    await standardCleanup();
    storage.setState(before, true);
    setServerReachabilityNetworkAllowed(true);
});
afterAll(() => network.dispose());

function enableFollow(serverId: string) {
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features:
        createRootLayoutFeaturesResponse({ features: { sessions: { following: { enabled: true } } } }) } });
}

it('keeps an inactive-Home editor across focused Home changes but retires its own Account', async () => {
    const focused = await network.addHome('https://follow-focused-lifetime.test', 'focused-account');
    const addressed = await network.addHome('https://follow-addressed-lifetime.test', 'addressed-account');
    enableFollow(addressed.id);
    const focus = (home: typeof focused, generation: number) => {
        publishAppliedActiveServerRuntimeAvailability(false);
        setActiveServerId(home.id);
        storage.getState().activateProfileScope({ serverId: home.id, accountId: home.accountId });
        publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation });
    };
    focus(focused, 1);
    const path = '/v2/sessions/shown-session/follow';
    network.setHttpResponder(async input => new URL(String(input)).pathname === path ? Response.json({
        follow: { sessionId: 'shown-session', following: true, notificationLevel: 'important', includeInVoice: false },
        isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false,
    }) : null);
    const retired = vi.fn();
    const hook = await renderHook(() => useAccountSessionFollowController({ serverId: addressed.id, sessionId: 'shown-session' }, true, retired));
    await act(async () => { await waitForTestEvent(hook.getCurrent().controller.subscribe,
        hook.getCurrent().controller.getSnapshot, state => !state.loading && (state.projection !== null || state.error !== null)); });
    expect(hook.getCurrent().state).toMatchObject({ projection: { follow: { notificationLevel: 'important' } }, error: null });
    await act(async () => { focus(addressed, 2); });
    await flushHookEffects();
    expect(retired).not.toHaveBeenCalled();
    expect(hook.getCurrent().state.projection?.follow?.notificationLevel).toBe('important');
    await act(async () => { focus(focused, 3); });
    await act(async () => { await network.setAccount(addressed.serverUrl, 'replacement-account'); });
    expect(retired).toHaveBeenCalled();
    await hook.unmount();
});

it('keeps one personal Follow read across 1,000 unrelated changes while refreshing exact and private Follow facts', async () => {
    const home = await network.addHome('https://personal-follow-demand.test', 'follow-account');
    enableFollow(home.id);
    publishAppliedActiveServerRuntimeAvailability(false);
    setActiveServerId(home.id);
    storage.getState().activateProfileScope({ serverId: home.id, accountId: home.accountId });
    publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 });
    setServerReachabilityNetworkAllowed(true);
    const sessionId = 'shown-session';
    const path = `/v2/sessions/${sessionId}/follow`;
    let notificationLevel: 'important' | 'none' = 'important';
    network.setHttpResponder(async input => new URL(String(input)).pathname === path ? Response.json({
        follow: { sessionId, following: true, notificationLevel, includeInVoice: false },
        isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false,
    }) : null);
    const hook = await renderHook(() => useAccountSessionFollowController({ serverId: home.id, sessionId }, true));
    await act(async () => { await waitForTestEvent(hook.getCurrent().controller.subscribe,
        hook.getCurrent().controller.getSnapshot, state => !state.loading && (state.projection !== null || state.error !== null)); });
    expect(hook.getCurrent().state).toMatchObject({ projection: { follow: { notificationLevel: 'important' } }, error: null });
    const reads = () => network.httpRequests.filter(request => new URL(request.url).pathname === path).length;
    expect(reads()).toBe(1);
    await act(async () => {
        for (let index = 0; index < 1_000; index += 1) {
            publishHomeAccountChange(home.id, [`other-${index}`], { changeKinds: [index % 2 ? 'session' : 'artifact'] });
        }
        publishHomeAccountChange('another-home', [sessionId], { changeKinds: ['session'] });
    });
    await flushHookEffects();
    expect(reads()).toBe(1);

    notificationLevel = 'none';
    const relevant = [
        { entityIds: [sessionId], changeKinds: ['session'] as const },
        // A manager/access change for this source still invalidates its current Follow facts.
        { entityIds: [sessionId], changeKinds: ['share'] as const },
        { entityIds: [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], changeKinds: ['account'] as const },
        { entityIds: ['self'], changeKinds: ['account'] as const },
        {}, // Reconnect/unknown wakes remain conservative.
    ];
    for (const [index, event] of relevant.entries()) {
        await act(async () => { publishHomeAccountChange(home.id, event.entityIds, event); });
        await vi.waitFor(() => expect(reads()).toBe(index + 2));
        await flushHookEffects();
    }
    expect(hook.getCurrent().state.projection?.follow?.notificationLevel).toBe('none');
    await hook.unmount();
    publishHomeAccountChange(home.id);
    await flushHookEffects();
    expect(reads()).toBe(6);
});

it('finishes a personal Follow write when its Info editor unmounts before the reply', async () => {
    const home = await network.addHome('https://personal-follow-write-lifetime.test', 'follow-account');
    enableFollow(home.id);
    publishAppliedActiveServerRuntimeAvailability(false);
    setActiveServerId(home.id);
    storage.getState().activateProfileScope({ serverId: home.id, accountId: home.accountId });
    publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 });
    setServerReachabilityNetworkAllowed(true);
    const sessionId = 'shown-session';
    const path = `/v2/sessions/${sessionId}/follow`;
    const issued = createDeferred<AbortSignal | null | undefined>();
    const response = createDeferred<void>();
    let level: 'important' | 'none' = 'important';
    let writes = 0;
    network.setHttpResponder(async (input, init) => {
        if (new URL(String(input)).pathname !== path) return null;
        if (init?.method === 'PUT') {
            writes++;
            issued.resolve(init.signal);
            await response.promise;
            init.signal?.throwIfAborted();
            level = 'none';
        }
        return Response.json({ follow: { sessionId, following: true, notificationLevel: level, includeInVoice: false },
            isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false });
    });
    const hook = await renderHook(() => useAccountSessionFollowController({ serverId: home.id, sessionId }, true));
    await act(async () => { await waitForTestEvent(hook.getCurrent().controller.subscribe,
        hook.getCurrent().controller.getSnapshot, state => !state.loading && state.projection !== null); });
    let saving: Promise<void> | undefined;
    try {
        await act(async () => { saving = hook.getCurrent().controller.set({ policy: { preset: 'quiet' } }); });
        const signal = await Promise.race([issued.promise, saving!.then(() => {
            throw new Error(`Follow settled before its write: ${JSON.stringify(hook.getCurrent().controller.getSnapshot())}`);
        })]);
        await hook.unmount();
        const abortedOnNavigation = signal?.aborted;
        response.resolve();
        await saving;
        expect({ abortedOnNavigation, level }).toEqual({ abortedOnNavigation: false, level: 'none' });
        expect(writes).toBe(1);
    } finally { response.resolve(); await saving; }
});
