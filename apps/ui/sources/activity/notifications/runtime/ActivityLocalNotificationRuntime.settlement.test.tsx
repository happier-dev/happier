import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storage';
import * as profiles from '@/sync/domains/server/serverProfiles';

const native = vi.hoisted(() => ({
    inventory: vi.fn<() => Promise<unknown[]>>(),
    dismiss: vi.fn<(id: string) => Promise<void>>(),
    received: null as null | (() => void),
}));
// Native presentation and receipt are the boundary; state and settlement logic stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

const initialState = storage.getState();
const serverUrl = 'https://settled-notifications.example.test';
const request = { tool: 'Bash', kind: 'permission', arguments: {}, createdAt: 1, occurrenceId: 'occurrence-a' };
function notice(identifier: string, overrides: Record<string, unknown> = {}) {
    return { request: { identifier, content: { data: {
        serverUrl, accountId: 'account-1', sessionId: 'session-1', requestId: 'request',
        occurrenceId: 'occurrence-a', kind: 'permission', ...overrides,
    } } } };
}

describe('Presented agent request settlement', () => {
    beforeEach(async () => {
        storage.setState(initialState, true);
        native.inventory.mockReset().mockResolvedValue([]);
        native.dismiss.mockReset().mockResolvedValue(undefined);
        // Bind the shared native stub used by the setup's module loader too.
        const notifications = await import('@/dev/expoNotificationsStub');
        vi.spyOn(notifications, 'getPresentedNotificationsAsync').mockImplementation(() => native.inventory());
        vi.spyOn(notifications, 'dismissNotificationAsync').mockImplementation((id) => native.dismiss(id));
        vi.spyOn(notifications, 'addNotificationReceivedListener').mockImplementation((listener) => {
            if (typeof listener !== 'function') throw new Error('Receipt listener missing');
            native.received = () => listener();
            return { remove: () => { native.received = null; } };
        });
        const profile = profiles.upsertServerProfile({ serverUrl, name: 'Test' });
        profiles.setActiveServerId(profile.id, { scope: 'device' });
        storage.setState({ profileScope: { serverId: profile.id, accountId: 'account-1' } });
        storage.getState().applyLocalSettings({ localNotificationsEnabled: false });
        storage.getState().applySessions([createSessionFixture({
            id: 'session-1', agentState: { requests: { request }, completedRequests: {} },
        })]);
    });
    afterEach(async () => {
        await act(async () => { storage.setState(initialState, true); });
        vi.restoreAllMocks();
    });

    it('dismisses only positively settled scoped occurrences, including questions, with local sending disabled', async () => {
        native.inventory.mockResolvedValue([
            notice('settled-permission'), notice('settled-question', { requestId: 'question', kind: 'user_action', occurrenceId: 'question-a' }),
            notice('newer', { occurrenceId: 'occurrence-b' }), notice('other-account', { accountId: 'account-2' }),
            notice('other-home', { serverUrl: 'https://other.example.test' }), notice('unloaded', { sessionId: 'unloaded' }),
            notice('legacy', { occurrenceId: undefined }), notice('unknown-account', { accountId: undefined }),
            notice('machine-alert', { kind: 'machine_recovery' }), notice('missing-request', { requestId: 'missing' }),
        ]);
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        await flushHookEffects();
        expect(native.dismiss).not.toHaveBeenCalled();
        const session = storage.getState().sessions['session-1'];
        await act(async () => { storage.getState().applySessions([{ ...session, agentStateVersion: 2, agentState: {
            requests: { request: { ...request, occurrenceId: 'occurrence-b' } },
            completedRequests: {
                request: { ...request, completedAt: 2, status: 'approved' },
                question: { ...request, tool: 'AskUserQuestion', kind: 'user_action', occurrenceId: 'question-a', completedAt: 2, status: 'approved' },
            },
        } }]); });
        await vi.waitFor(() => expect(native.dismiss.mock.calls.map(([id]) => id).sort()).toEqual(['settled-permission', 'settled-question']));
        await screen.unmount();
    });

    it('rechecks delayed OS inventory against the current Account', async () => {
        let release!: (notifications: unknown[]) => void;
        native.inventory.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const session = storage.getState().sessions['session-1'];
        storage.getState().applySessions([{ ...session, agentState: { requests: {}, completedRequests: { request: { ...request, status: 'denied', completedAt: 2 } } } }]);
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        await vi.waitFor(() => expect(native.inventory).toHaveBeenCalled());
        await act(async () => {
            storage.setState({ profileScope: { ...storage.getState().profileScope!, accountId: 'account-2' } });
            release([notice('old-account')]);
        });
        await flushHookEffects();
        expect(native.dismiss).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('reconciles a remote notice that arrives after its canonical completion', async () => {
        const session = storage.getState().sessions['session-1'];
        storage.getState().applySessions([{ ...session, agentState: {
            requests: {}, completedRequests: { request: { ...request, status: 'approved', completedAt: 2 } },
        } }]);
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        await vi.waitFor(() => expect(native.inventory).toHaveBeenCalled());
        expect(native.dismiss).not.toHaveBeenCalled();
        const readsBeforeUnrelatedSessions = native.inventory.mock.calls.length;
        await act(async () => { storage.getState().applySessions(Array.from({ length: 1_000 }, (_, index) =>
            createSessionFixture({ id: `unrelated-${index}`, agentState: { requests: {}, completedRequests: {} } }))); });
        await flushHookEffects();
        expect(native.inventory).toHaveBeenCalledTimes(readsBeforeUnrelatedSessions);
        native.inventory.mockResolvedValue([notice('late-notice')]);
        await act(async () => { native.received?.(); });
        await vi.waitFor(() => expect(native.dismiss).toHaveBeenCalledWith('late-notice'));
        await screen.unmount();
    });
});
