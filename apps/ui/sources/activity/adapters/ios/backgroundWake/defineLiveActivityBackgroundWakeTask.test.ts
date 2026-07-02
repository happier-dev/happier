import { describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

function createMemoryStorage() {
    const values = new Map<string, string>();
    return {
        getString: (key: string) => values.get(key),
        set: (key: string, value: string) => {
            values.set(key, value);
        },
        delete: (key: string) => {
            values.delete(key);
        },
    };
}

function createContentState(overrides: Record<string, unknown> = {}) {
    return {
        version: 1,
        generatedAt: 1_000,
        staleAt: 1_801_000,
        sessionId: 'session-1',
        title: 'Session work',
        subtitle: null,
        previewText: null,
        statusText: null,
        attentionState: 'thinking',
        defaultTarget: 'open-session:session-1?serverId=server-a',
        sessionTarget: 'open-session:session-1?serverId=server-a',
        overflowCount: 0,
        totalAttentionCount: 1,
        allowActionButtons: true,
        labels: {
            title: 'Happier Focus',
            openLabel: 'Open',
            inboxLabel: 'Inbox',
            attentionLabel: 'Attention',
        },
        ...overrides,
    };
}

function createWakePayload(overrides: Record<string, unknown> = {}) {
    return {
        type: 'happier.liveActivityRemoteUpdate.v1',
        v: 1,
        requestId: 'wake-1',
        createdAt: 1_000,
        event: 'update',
        activityKey: {
            serverId: 'server-a',
            sessionId: 'session-1',
            activityName: 'HappierFocusLiveActivity',
        },
        snapshotFingerprint: 'fingerprint-new',
        contentState: createContentState(),
        ...overrides,
    };
}

async function loadModule() {
    return import('./defineLiveActivityBackgroundWakeTask').catch(() => null);
}

describe('defineLiveActivityBackgroundWakeTask', () => {
    it('does not load iOS notification task modules when evaluated on Android', async () => {
        vi.resetModules();
        vi.doMock('expo-notifications', () => {
            throw new Error('expo-notifications should not be required on Android module evaluation');
        });
        vi.doMock('expo-task-manager', () => {
            throw new Error('expo-task-manager should not be required on Android module evaluation');
        });
        const originalOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        try {
            const mod = await import('./defineLiveActivityBackgroundWakeTask');
            await expect(mod.syncLiveActivityBackgroundWakeTaskRegistration({
                fallbackEnabled: true,
                staticConfigSupportsBackgroundWake: true,
                platformOS: 'android',
            })).resolves.toEqual({ status: 'already_unregistered', reason: 'platform_unsupported' });
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
            vi.doUnmock('expo-notifications');
            vi.doUnmock('expo-task-manager');
            vi.resetModules();
        }
    });

    it('registers the notification task only when fallback mode and static background config are both enabled', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const registerTaskAsync = vi.fn(async () => null);
        const unregisterTaskAsync = vi.fn(async () => null);
        const result = await mod.syncLiveActivityBackgroundWakeTaskRegistration({
            fallbackEnabled: true,
            staticConfigSupportsBackgroundWake: true,
            platformOS: 'ios',
            notifications: {
                registerTaskAsync,
                unregisterTaskAsync,
            },
            taskManager: {
                isTaskRegisteredAsync: vi.fn(async () => false),
            },
        });

        expect(result).toEqual({ status: 'registered' });
        expect(registerTaskAsync).toHaveBeenCalledWith(mod.LIVE_ACTIVITY_BACKGROUND_WAKE_TASK_NAME);
        expect(unregisterTaskAsync).not.toHaveBeenCalled();
    });

    it('unregisters the task when fallback mode is disabled', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const registerTaskAsync = vi.fn(async () => null);
        const unregisterTaskAsync = vi.fn(async () => null);
        const result = await mod.syncLiveActivityBackgroundWakeTaskRegistration({
            fallbackEnabled: false,
            staticConfigSupportsBackgroundWake: true,
            platformOS: 'ios',
            notifications: {
                registerTaskAsync,
                unregisterTaskAsync,
            },
            taskManager: {
                isTaskRegisteredAsync: vi.fn(async () => true),
            },
        });

        expect(result).toEqual({ status: 'unregistered', reason: 'fallback_disabled' });
        expect(unregisterTaskAsync).toHaveBeenCalledWith(mod.LIVE_ACTIVITY_BACKGROUND_WAKE_TASK_NAME);
        expect(registerTaskAsync).not.toHaveBeenCalled();
    });

    it('uses persisted newer local state to reject stale background wake payloads before touching the native activity', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const storage = mod.createLiveActivityBackgroundWakeStateStore(createMemoryStorage());
        storage.remember({
            activityInstanceKey: 'server-a:HappierFocusLiveActivity:session-1',
            generatedAt: 2_000,
            snapshotFingerprint: 'fingerprint-newer-local',
        });

        const update = vi.fn(async () => undefined);
        const end = vi.fn(async () => undefined);
        const result = await mod.applyLiveActivityBackgroundWakeTaskPayload({
            payload: createWakePayload({
                contentState: createContentState({ generatedAt: 1_000 }),
            }),
            stateStore: storage,
            liveActivityFactory: {
                getInstances: () => [{ update, end }],
            },
        });

        expect(result).toEqual({ action: 'ignore', reason: 'older_than_current' });
        expect(update).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
    });

    it('does not apply a single background wake payload to multiple anonymous native activities', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const storage = mod.createLiveActivityBackgroundWakeStateStore(createMemoryStorage());
        storage.remember({
            activityInstanceKey: 'server-a:HappierFocusLiveActivity:session-1',
            generatedAt: 500,
            snapshotFingerprint: 'fingerprint-current',
        });
        const updateA = vi.fn(async () => undefined);
        const updateB = vi.fn(async () => undefined);
        const endA = vi.fn(async () => undefined);
        const endB = vi.fn(async () => undefined);

        const result = await mod.applyLiveActivityBackgroundWakeTaskPayload({
            payload: createWakePayload(),
            stateStore: storage,
            liveActivityFactory: {
                getInstances: () => [
                    { update: updateA, end: endA },
                    { update: updateB, end: endB },
                ],
            },
        });

        expect(result).toEqual({ action: 'ignore', reason: 'ambiguous_activity_instances' });
        expect(updateA).not.toHaveBeenCalled();
        expect(updateB).not.toHaveBeenCalled();
        expect(endA).not.toHaveBeenCalled();
        expect(endB).not.toHaveBeenCalled();
        expect(storage.read('server-a:HappierFocusLiveActivity:session-1')).toEqual({
            activityInstanceKey: 'server-a:HappierFocusLiveActivity:session-1',
            generatedAt: 500,
            snapshotFingerprint: 'fingerprint-current',
        });
    });

    it('does not apply a background wake payload to an anonymous native activity without persisted identity state', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const storage = mod.createLiveActivityBackgroundWakeStateStore(createMemoryStorage());
        const update = vi.fn(async () => undefined);
        const end = vi.fn(async () => undefined);

        const result = await mod.applyLiveActivityBackgroundWakeTaskPayload({
            payload: createWakePayload(),
            stateStore: storage,
            liveActivityFactory: {
                getInstances: () => [{ update, end }],
            },
        });

        expect(result).toEqual({ action: 'ignore', reason: 'activity_state_not_found' });
        expect(update).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
        expect(storage.read('server-a:HappierFocusLiveActivity:session-1')).toBeNull();
    });

    it('does not mark a background wake update applied when no native activity exists', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const storage = mod.createLiveActivityBackgroundWakeStateStore(createMemoryStorage());
        storage.remember({
            activityInstanceKey: 'server-a:HappierFocusLiveActivity:session-1',
            generatedAt: 500,
            snapshotFingerprint: 'fingerprint-current',
        });
        const result = await mod.applyLiveActivityBackgroundWakeTaskPayload({
            payload: createWakePayload(),
            stateStore: storage,
            liveActivityFactory: {
                getInstances: () => [],
            },
        });

        expect(result).toEqual({ action: 'ignore', reason: 'activity_not_found' });
        expect(storage.read('server-a:HappierFocusLiveActivity:session-1')).toEqual({
            activityInstanceKey: 'server-a:HappierFocusLiveActivity:session-1',
            generatedAt: 500,
            snapshotFingerprint: 'fingerprint-current',
        });
    });
});
