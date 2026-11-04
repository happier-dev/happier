import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { readSessionRecordingVisibility, subscribeSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';
import { setActiveServerId, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { useSessionRecordingVisibility } from './useSessionListRecordingPrivacy';

// Native event registration is the OS boundary; capture classification and demand remain real.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const previous = storage.getState();
afterEach(async () => {
    await standardCleanup();
    setScreenSharingPrivacyActive(false);
    storage.setState(previous, true);
    vi.unstubAllGlobals();
});

describe('shared Session recording visibility', () => {
    it('hides and restores Home-local identities on capture, settings and tag pushes without unrelated renders', async () => {
        storage.setState({ settings: { ...previous.settings, sessionListHiddenTagIdsWhileRecording: { 'home-a': ['secret'] } },
            sessionOrganizationTagAssignmentsBySessionKey: {
                [buildSessionOrganizationSessionKey('home-a', 'same')]: { sessionId: 'same', tagIds: ['secret'] },
                [buildSessionOrganizationSessionKey('home-b', 'same')]: { sessionId: 'same', tagIds: ['secret'] },
            } });
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useSessionRecordingVisibility(); });
        const a = { serverId: 'home-a', sessionId: 'same' };
        const b = { serverId: 'home-b', sessionId: 'same' };
        expect(hook.getCurrent()(a)).toBe(true);
        const visibleCacheKey = hook.getCurrent().cacheKey;
        await act(async () => setScreenSharingPrivacyActive(true));
        expect(hook.getCurrent()(a)).toBe(false);
        expect(hook.getCurrent().cacheKey).not.toBe(visibleCacheKey);
        expect(hook.getCurrent()(b)).toBe(true);
        const stable = hook.getCurrent();
        const before = renders;
        await act(async () => storage.setState({ settings: { ...storage.getState().settings,
            hideInactiveSessions: !storage.getState().settings.hideInactiveSessions }, settingsVersion: 125 }));
        expect(renders).toBe(before);
        expect(hook.getCurrent()).toBe(stable);
        await act(async () => storage.setState({ sessionOrganizationTagAssignmentsBySessionKey: {} }));
        expect(hook.getCurrent()(a)).toBe(true);
        await act(async () => storage.setState({ sessionOrganizationTagAssignmentsBySessionKey: {
            [buildSessionOrganizationSessionKey('home-a', 'same')]: { sessionId: 'same', tagIds: ['secret'] },
        } }));
        expect(hook.getCurrent()(a)).toBe(false);
        await act(async () => storage.setState({ settings: { ...storage.getState().settings,
            sessionListHiddenTagIdsWhileRecording: {} } }));
        expect(hook.getCurrent()(a)).toBe(true);
        expect(hook.getCurrent().cacheKey).toBe(visibleCacheKey);
        await act(async () => setScreenSharingPrivacyActive(false));
        expect(hook.getCurrent()(a)).toBe(true);
    });

    it('uses the active Home for unqualified identities and canonicalizes profile aliases', async () => {
        const profile = await upsertServerProfile({ serverUrl: 'https://recording-privacy-alias.test' });
        await setServerProfileIdentityForUrl(profile.serverUrl, 'srv_recording_privacy');
        await setActiveServerId(profile.id);
        storage.setState({ settings: { ...previous.settings,
            sessionListHiddenTagIdsWhileRecording: { [profile.id]: ['secret'] } },
            sessionOrganizationTagAssignmentsBySessionKey: {
                [buildSessionOrganizationSessionKey(profile.id, 'private')]: { sessionId: 'private', tagIds: ['secret'] },
            } });
        setScreenSharingPrivacyActive(true);
        const visible = readSessionRecordingVisibility();
        expect(visible({ serverId: profile.id, sessionId: 'private' })).toBe(false);
        expect(visible({ serverId: 'srv_recording_privacy', sessionId: 'private' })).toBe(false);
        expect(visible({ serverId: 'other-home', sessionId: 'private' })).toBe(true);
        expect(visible({ sessionId: 'private' })).toBe(false);
        storage.setState({ sessionOrganizationTagAssignmentsBySessionKey: {
            ...storage.getState().sessionOrganizationTagAssignmentsBySessionKey,
            [buildSessionOrganizationSessionKey('srv_recording_privacy', 'private')]: { sessionId: 'private', tagIds: [] },
        } });
        expect(readSessionRecordingVisibility()({ serverId: profile.id, sessionId: 'private' })).toBe(true);
    });

    it('keeps imperative native consumers private while unknown and restores on the initial idle snapshot', async () => {
        let resolveSnapshot!: (value: { status: 'idle' }) => void;
        const snapshot = new Promise<{ status: 'idle' }>(resolve => { resolveSnapshot = resolve; });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn(() => snapshot) });
        storage.setState({ settings: { ...previous.settings, sessionListHiddenTagIdsWhileRecording: { native: ['secret'] } },
            sessionOrganizationTagAssignmentsBySessionKey: {
                [buildSessionOrganizationSessionKey('native', 'private')]: { sessionId: 'private', tagIds: ['secret'] },
            } });
        const address = { serverId: 'native', sessionId: 'private' };
        expect(readSessionRecordingVisibility()(address)).toBe(false);
        let notify!: () => void;
        const settled = new Promise<void>(resolve => { notify = resolve; });
        const stop = subscribeSessionRecordingVisibility(notify);
        try {
            resolveSnapshot({ status: 'idle' });
            await settled;
            expect(readSessionRecordingVisibility()(address)).toBe(true);
        } finally { stop(); }
    });

    it('does no native work for inactive consumers or when no tags are selected', async () => {
        const invoke = vi.fn();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        storage.setState({ settings: { ...previous.settings, sessionListHiddenTagIdsWhileRecording: { native: ['secret'] } } });
        const inactive = await renderHook(() => useSessionRecordingVisibility(false));
        expect(inactive.getCurrent()({ serverId: 'native', sessionId: 'private' })).toBe(true);
        await inactive.unmount();
        storage.setState({ settings: { ...previous.settings, sessionListHiddenTagIdsWhileRecording: {} } });
        const noTags = await renderHook(() => useSessionRecordingVisibility());
        expect(noTags.getCurrent()({ serverId: 'native', sessionId: 'private' })).toBe(true);
        expect(invoke).not.toHaveBeenCalled();
    });
});
