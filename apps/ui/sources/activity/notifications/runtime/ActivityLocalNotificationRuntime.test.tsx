import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { createDeferred, createSessionAccessFixture, createSessionFixture, renderScreen as renderTestScreen } from '@/dev/testkit';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { ConcurrentSessionListCacheByServerId } from '@/sync/domains/session/listing/concurrentSessionListCache';
import { getActiveServerSnapshot, removeServerProfile, setActiveServerId, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { markSessionSurfaceVisible, resetSessionSurfaceVisibilityForTests } from '@/sync/domains/session/sessionSurfaceVisibility';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { settingsParse } from '@/sync/domains/settings/settings';


type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const reactNativeRuntime = vi.hoisted(() => ({
    platformOs: 'ios' as 'web' | 'ios' | 'android',
}));

let isDesktopHostValue = false;
let visibleSessionIdsValue: string[] = [];
let visibleSessionAddressesValue: string[] = [];
let localSettingsValue: Record<string, unknown> = {
    localNotificationsEnabled: true,
    localNotificationsShowReady: true,
    localNotificationsShowReadyMessageText: true,
    localNotificationsShowPendingPermissionRequests: true,
    localNotificationsShowPendingUserActionRequests: true,
};
let accountSettingsValue = settingsParse({});
type NotificationSessionFixture = Partial<Omit<Session, 'metadata'>> & {
    metadata?: Partial<NonNullable<Session['metadata']>>;
};
const initialState = storage.getInitialState();
let savedProfileIds: string[] = [];
let sessionsByIdValue: Record<string, NotificationSessionFixture> = {
    'session-1': {
        id: 'session-1',
        serverId: 'srv_home_a',
        encryptionMode: 'plain',
        access: createSessionAccessFixture(),
        active: true,
        metadata: {
            summary: {
                text: 'Ready session',
                updatedAt: 1,
            },
        },
    },
};
let concurrentSessionListCacheByServerIdValue: ConcurrentSessionListCacheByServerId = {
    'srv_home_a': { serverName: 'Home A', listObservation: { phase: 'ready', lastSuccessAt: 1 } },
    'srv_home_b': { serverName: 'Home B', listObservation: { phase: 'ready', lastSuccessAt: 1 } },
};

type ExpoLocalNotificationParams =
    Parameters<typeof import('../channels/sendExpoLocalNotification')['sendExpoLocalNotification']>[0];

const sendExpoLocalNotification = vi.hoisted(() => vi.fn(async (_params: ExpoLocalNotificationParams) => 'notif-1'));
const sendTauriLocalNotification = vi.hoisted(() => vi.fn(async () => true));

async function setActiveAccountSettings(raw: Record<string, unknown>): Promise<void> {
    accountSettingsValue = settingsParse(raw);
    const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
    const serverId = getActiveServerSnapshot().serverId;
    const accountId = serverId === 'srv_home_b' ? 'account-b' : 'account-a';
    saveAccountSettings({ serverId, accountId }, accountSettingsValue, 3);
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return reactNativeRuntime.platformOs; } } });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    const translations: Record<string, string> = {
        'notifications.activity.defaultSessionTitle': 'Session',
        'notifications.activity.readyFallbackBody': 'Turn finished. Open the session to continue.',
        'notifications.activity.requestLabels.command': 'Command',
        'notifications.activity.requestLabels.file': 'File',
        'notifications.activity.requestLabels.selectOne': 'Select one',
        'notifications.activity.requestLabels.selectMultiple': 'Select multiple',
        'notifications.activity.requestLabels.customAnswer': 'Custom answer allowed',
        'notifications.activity.permissionFallbackBody': 'Approval required.',
        'notifications.activity.userActionFallbackBody': 'This session needs your input.',
        'session.access.pending': 'Encrypted access pending',
    };
    return createTextModuleMock({ translate: (key: string) => translations[key] ?? key });
});

// Publish fixtures at the same real state boundary the notification source reads.
// No activity selector, Account scope, policy, or profile decision is stubbed.
async function renderScreen(element: React.ReactElement) {
    const sessions = Object.fromEntries(Object.entries(sessionsByIdValue).map(([id, fixture]) => {
        return [id, createSessionFixture({
            active: true,
            ...fixture,
            id,
            encryptedContentAvailability: fixture.encryptedContentAvailability,
            metadata: fixture.metadata ? { path: '', host: '', ...fixture.metadata } : null,
        })];
    }));
    storage.setState({ sessions, settings: accountSettingsValue,
        localSettings: localSettingsParse(localSettingsValue),
        concurrentSessionListCacheByServerId: concurrentSessionListCacheByServerIdValue });
    for (const sessionId of visibleSessionIdsValue) {
        const address = visibleSessionAddressesValue.find((value) => value.endsWith(`:${sessionId}`));
        markSessionSurfaceVisible(sessionId, address?.slice(0, -sessionId.length - 1) ?? 'srv_home_a');
    }
    const screen = await renderTestScreen(element);
    // Credential binding retires unowned retained list observations. The list
    // producer publishes this Home's current observation after that binding.
    await act(async () => {
        storage.setState({ concurrentSessionListCacheByServerId: concurrentSessionListCacheByServerIdValue });
    });
    return screen;
}

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: async (serverUrl: string) => ({
                token: createAccountTokenForTests(serverUrl.includes('secondary') ? 'account-b' : 'account-a'),
            }),
        },
    });
});


vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => isDesktopHostValue,
}));

vi.mock('../channels/sendExpoLocalNotification', () => ({
    sendExpoLocalNotification,
}));

vi.mock('../channels/sendTauriLocalNotification', () => ({
    sendTauriLocalNotification,
}));

describe('ActivityLocalNotificationRuntime', () => {
    beforeEach(async () => {
        storage.setState(initialState, true);
        for (const [serverId, serverUrl, name] of [
            ['srv_home_a', 'https://stack.example.test', 'Home A'],
            ['srv_home_b', 'https://secondary.example.test', 'Home B'],
        ]) {
            const profile = await upsertServerProfile({ serverUrl, name });
            savedProfileIds.push(profile.id);
            await setServerProfileIdentityForUrl(serverUrl, serverId);
        }
        await setActiveServerId('srv_home_a');
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        saveAccountSettings({ serverId: 'srv_home_a', accountId: 'account-a' }, settingsParse({}), 1);
        saveAccountSettings({ serverId: 'srv_home_b', accountId: 'account-b' }, settingsParse({}), 1);
    });

    afterEach(async () => {
        resetSessionSurfaceVisibilityForTests();
        storage.setState(initialState, true);
        for (const id of savedProfileIds) await removeServerProfile(id);
        savedProfileIds = [];
        reactNativeRuntime.platformOs = 'ios';
        isDesktopHostValue = false;
        visibleSessionIdsValue = [];
        visibleSessionAddressesValue = [];
        localSettingsValue = {
            localNotificationsEnabled: true,
            localNotificationsShowReady: true,
            localNotificationsShowReadyMessageText: true,
            localNotificationsShowPendingPermissionRequests: true,
            localNotificationsShowPendingUserActionRequests: true,
        };
        accountSettingsValue = settingsParse({});
        sessionsByIdValue = {
            'session-1': {
                id: 'session-1',
                serverId: 'srv_home_a',
                encryptionMode: 'plain',
                access: createSessionAccessFixture(),
                active: true,
                metadata: {
                    summary: {
                        text: 'Ready session',
                        updatedAt: 1,
                    },
                },
            },
        };
        concurrentSessionListCacheByServerIdValue = {
            'srv_home_a': { serverName: 'Home A', listObservation: { phase: 'ready', lastSuccessAt: 1 } },
            'srv_home_b': { serverName: 'Home B', listObservation: { phase: 'ready', lastSuccessAt: 1 } },
        };
        sendExpoLocalNotification.mockClear();
        sendTauriLocalNotification.mockClear();

        const { resetActivityLocalNotificationRuntimeForTests } = await import('./activityLocalNotificationBus');
        resetActivityLocalNotificationRuntimeForTests();
        const { resetActivityAlertPresentationNotesForTests } = await import('../remoteAlerts/activityAlertPresentationNotes');
        resetActivityAlertPresentationNotesForTests();
    });

    it('does not notify an accessible but unfollowed Team reader', async () => {
        sessionsByIdValue['session-1'] = {
            id: 'session-1', serverId: 'srv_home_a', accessLevel: 'edit', active: true,
            viewer: {
                readState: { state: 'not_started' },
                relevance: { relevant: false, reasons: [] },
                follow: { follows: false, notificationLevel: null },
                attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                notification: { level: 'none', source: 'none' },
            },
        };
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady, notifyActivityAgentRequest } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
            notifyActivityAgentRequest({ address: { serverId: 'srv_home_a', sessionId: 'session-1' },
                requestId: 'request-1', requestKind: 'user_action', toolName: 'AskUserQuestion', toolArgs: {} });
        });
        expect(sendExpoLocalNotification).not.toHaveBeenCalled();
        await act(async () => { screen.tree.unmount(); });
    });

    it('delivers the same Home currentness the list owner observed', async () => {
        concurrentSessionListCacheByServerIdValue = {
            'srv_home_a': {
                serverName: 'Home A',
                listObservation: { phase: 'offline', lastSuccessAt: null },
            },
        };
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });

        // An alert from a Home Happier can no longer reach says so, using the one observation the
        // list owner published rather than a delivery-time clock (Lane 07.4 §2, L07-R42). This
        // harness renders translation keys, so the assertion names the shared copy owner's key;
        // the words themselves are owned by the context projector's own suite.
        expect(sendExpoLocalNotification.mock.calls[0]?.[0]?.title).toContain('homeFreshness.offline');
        await act(async () => { screen.tree.unmount(); });
    });

    it('does not call a reachable Home stale however long ago it last succeeded', async () => {
        concurrentSessionListCacheByServerIdValue = {
            'srv_home_a': { serverName: 'Home A', listObservation: { phase: 'ready', lastSuccessAt: 1 } },
        };
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });

        expect(sendExpoLocalNotification.mock.calls[0]?.[0]?.title ?? '').not.toContain('homeFreshness');
        await act(async () => { screen.tree.unmount(); });
    });

    it('suppresses one local/remote duplicate for the same V2 ready event in both arrival orders', async () => {
        sessionsByIdValue['session-1'] = {
            id: 'session-1', serverId: 'srv_home_a', accessLevel: 'view',
            // Real access on an active Session, so the assertions below turn on
            // alert dedupe rather than on event eligibility.
            access: createSessionAccessFixture(),
            active: true,
            viewer: {
                readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
                relevance: { relevant: true, reasons: ['followed_by_me'] },
                follow: { follows: true, notificationLevel: 'important' },
                attention: { needsAttention: true, reasons: ['ready_after_read'], primary: 'ready_after_read', presentation: 'full' },
                notification: { level: 'important', source: 'preference' },
            },
        };
        const { noteActivityAlertPresented, resetActivityAlertPresentationNotesForTests } =
            await import('../remoteAlerts/activityAlertPresentationNotes');
        const { resolveRemoteAlertForegroundPresentation } =
            await import('../remoteAlerts/resolveRemoteAlertForegroundPresentation');
        const remoteReady = (messageSeq: number) => ({
            type: 'activity_alert',
            v: 2,
            serverId: 'srv_home_a',
            sessionId: 'session-1',
            accountId: 'account-a',
            event: { type: 'ready', sequenceDomain: 'session_transcript', messageSeq },
            previewBehavior: 'title_only',
        });
        resetActivityAlertPresentationNotesForTests();
        const remoteFirst = resolveRemoteAlertForegroundPresentation({
            data: remoteReady(7),
            isSessionVisible: () => false,
        });
        expect(remoteFirst).toMatchObject({
            kind: 'present',
            target: { eventIdentity: 'message-seq:session_transcript:7' },
        });
        if (remoteFirst.kind !== 'present') throw new Error('Expected routable V2 ready alert');
        noteActivityAlertPresented({ accountId: 'account-a',
            address: remoteFirst.target.address,
            event: remoteFirst.target.event,
            identity: remoteFirst.target.eventIdentity!,
            source: 'home_remote_alert',
        });
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, [{
                kind: 'agent-text', id: 'ready-7', createdAt: 1, seq: 7, text: 'Ready',
            } as any, {
                // A later message in the same rich catch-up batch must not
                // replace the identity of the committed ready event.
                kind: 'agent-text', id: 'later-8', createdAt: 2, seq: 8, text: 'Later',
            } as any], {
                sequenceDomain: 'session_transcript',
                sequence: 7,
            });
        });
        expect(sendExpoLocalNotification).toHaveBeenCalledTimes(1);
        const { resolveForegroundNotificationBehavior } = await import('../resolveForegroundNotificationBehavior');
        await expect(resolveForegroundNotificationBehavior({
            content: sendExpoLocalNotification.mock.calls[0]![0],
            localSettings: localSettingsParse(localSettingsValue),
            now: new Date('2026-09-26T12:00:00Z'),
            isSessionVisible: () => false,
        })).resolves.toBe('off');

        // The consumed note suppresses one duplicate, never the next committed event.
        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, [{
                kind: 'agent-text', id: 'ready-8', createdAt: 2, seq: 8, text: 'Ready again',
            } as any]);
        });
        expect(sendExpoLocalNotification).toHaveBeenCalledTimes(2);

        resetActivityAlertPresentationNotesForTests();
        sendExpoLocalNotification.mockClear();
        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, [{
                kind: 'agent-text', id: 'ready-7-local-first', createdAt: 3, seq: 7, text: 'Ready locally',
            } as any, {
                kind: 'agent-text', id: 'later-8-local-first', createdAt: 4, seq: 8, text: 'Later locally',
            } as any], {
                sequenceDomain: 'session_transcript',
                sequence: 7,
            });
        });
        expect(sendExpoLocalNotification).toHaveBeenCalledTimes(1);
        await resolveForegroundNotificationBehavior({
            content: sendExpoLocalNotification.mock.calls[0]![0],
            localSettings: localSettingsParse(localSettingsValue),
            now: new Date('2026-09-26T12:00:00Z'),
            isSessionVisible: () => false,
        });
        await expect(resolveForegroundNotificationBehavior({
            content: { data: remoteReady(7) },
            localSettings: localSettingsParse(localSettingsValue),
            now: new Date('2026-09-26T12:00:00Z'),
            isSessionVisible: () => false,
        })).resolves.toBe('off');
        expect(resolveRemoteAlertForegroundPresentation({
            data: remoteReady(8),
            isSessionVisible: () => false,
        })).toMatchObject({ kind: 'present' });

        // Identityless local observations remain eligible and cannot consume a
        // committed V2 note merely because the Session and category match.
        noteActivityAlertPresented({ accountId: 'account-a',
            address: remoteFirst.target.address,
            event: remoteFirst.target.event,
            identity: remoteFirst.target.eventIdentity!,
            source: 'home_remote_alert',
        });
        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });
        expect(sendExpoLocalNotification).toHaveBeenCalledTimes(2);
        resetActivityAlertPresentationNotesForTests();
        await act(async () => { screen.tree.unmount(); });
    });

    it('does not conflate identityless state-derived ready observations', async () => {
        const { noteActivityAlertPresented } = await import('../remoteAlerts/activityAlertPresentationNotes');
        noteActivityAlertPresented({ accountId: 'account-a',
            address: { serverId: 'srv_home_a', sessionId: 'session-1' },
            event: 'ready',
            identity: 'message-seq:session_transcript:7',
            source: 'home_remote_alert',
        });
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledTimes(1);
        await act(async () => { screen.tree.unmount(); });
    });

    it('does not record presentation when platform acceptance fails or its response is lost', async () => {
        const response = createDeferred<string>();
        sendExpoLocalNotification.mockImplementationOnce(() => response.promise);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { consumeOtherLegActivityAlertPresentation } =
            await import('../remoteAlerts/activityAlertPresentationNotes');
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        const presentation = { accountId: 'account-a',
            address: { serverId: 'srv_home_a', sessionId: 'session-1' },
            event: 'ready' as const,
            identity: 'message-seq:session_transcript:22',
            source: 'home_remote_alert' as const,
        };

        await act(async () => {
            notifyActivityReady(presentation.address, [{
                kind: 'agent-text', id: 'ready-22', createdAt: 1, seq: 22, text: 'Ready',
            } as any], { sequenceDomain: 'session_transcript', sequence: 22 });
        });
        await act(async () => {
            response.reject(new Error('platform response lost'));
            await response.promise.catch(() => undefined);
        });

        expect(consumeOtherLegActivityAlertPresentation(presentation)).toBe(false);
        consoleError.mockRestore();
        await act(async () => { screen.tree.unmount(); });
    });

    it('does not record presentation when the desktop platform declines the notification', async () => {
        reactNativeRuntime.platformOs = 'web';
        isDesktopHostValue = true;
        sendTauriLocalNotification.mockResolvedValueOnce(false);
        const { consumeOtherLegActivityAlertPresentation } =
            await import('../remoteAlerts/activityAlertPresentationNotes');
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        const presentation = { accountId: 'account-a',
            address: { serverId: 'srv_home_a', sessionId: 'session-1' },
            event: 'ready' as const,
            identity: 'message-seq:session_transcript:23',
            source: 'home_remote_alert' as const,
        };

        await act(async () => {
            notifyActivityReady(presentation.address, [{
                kind: 'agent-text', id: 'ready-23', createdAt: 1, seq: 23, text: 'Ready',
            } as any], { sequenceDomain: 'session_transcript', sequence: 23 });
        });

        expect(sendTauriLocalNotification).toHaveBeenCalledTimes(1);
        expect(consumeOtherLegActivityAlertPresentation(presentation)).toBe(false);
        await act(async () => { screen.tree.unmount(); });
    });

    it('delivers followed ready events with status-only privacy and honors explicit notification suppression', async () => {
        const viewer: NonNullable<Session['viewer']> = {
            readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
            relevance: { relevant: true, reasons: ['followed_by_me'] },
            follow: { follows: true, notificationLevel: 'important' },
            attention: { needsAttention: true, reasons: ['ready_after_read'], primary: 'ready_after_read', presentation: 'status_only' },
            notification: { level: 'important', source: 'preference' },
        };
        sessionsByIdValue['session-1'] = {
            id: 'session-1', serverId: 'srv_home_a', accessLevel: 'view', viewer,
            metadata: { summary: { text: 'Private title', updatedAt: 1 } },
        };
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });
        // Status-only privacy withholds the private title and the message preview, not the
        // authorized structural context this viewer already sees on the row (L07-R42/L07-I37).
        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Session · Home A',
            body: 'Turn finished. Open the session to continue.',
        }));
        const statusOnly = sendExpoLocalNotification.mock.calls[0]?.[0];
        expect(`${statusOnly?.title} ${statusOnly?.body}`).not.toContain('Private title');
        sendExpoLocalNotification.mockClear();
        viewer.follow.notificationLevel = 'none';
        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });
        expect(sendExpoLocalNotification).not.toHaveBeenCalled();
        await act(async () => { screen.tree.unmount(); });
    });

    it('does not expose retained Session content when settled encrypted availability is locked', async () => {
        sessionsByIdValue['session-1'] = {
            id: 'session-1',
            serverId: 'srv_home_a',
            access: createSessionAccessFixture(),
            active: true,
            encryptedContentAvailability: 'encrypted_access_pending',
            metadata: { summary: { text: 'Private retained title', updatedAt: 1 } },
            viewer: {
                readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                follow: { follows: false, notificationLevel: null },
                attention: { needsAttention: true, reasons: ['ready_after_read'], primary: 'ready_after_read', presentation: 'full' },
                notification: { level: 'important', source: 'owner' },
            },
        };
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, [{
                kind: 'agent-text',
                id: 'private-message',
                createdAt: 1,
                text: 'Private retained response',
            } as any]);
        });

        const notification = sendExpoLocalNotification.mock.calls[0]?.[0];
        expect(notification?.title).toBe('Session · Home A · Encrypted access pending');
        expect(notification?.body).not.toContain('Private');
        await act(async () => { screen.tree.unmount(); });
    });

    it('does not expose retained Session content when E2EE availability is absent', async () => {
        sessionsByIdValue['session-1'] = {
            id: 'session-1',
            serverId: 'srv_home_a',
            access: createSessionAccessFixture(),
            active: true,
            encryptionMode: 'e2ee',
            metadata: { summary: { text: 'Private retained title', updatedAt: 1 } },
            viewer: {
                readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                follow: { follows: false, notificationLevel: null },
                attention: { needsAttention: true, reasons: ['ready_after_read'], primary: 'ready_after_read', presentation: 'full' },
                notification: { level: 'important', source: 'owner' },
            },
        };
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, [{
                kind: 'agent-text',
                id: 'private-message',
                createdAt: 1,
                text: 'Private retained response',
            } as any]);
        });

        const notification = sendExpoLocalNotification.mock.calls[0]?.[0];
        expect(notification?.title).toBe('Session · Home A');
        expect(notification?.body).not.toContain('Private');
        await act(async () => { screen.tree.unmount(); });
    });

    it.each(['permission', 'user_action'] as const)('delivers generic %s notifications when device request previews are disabled', async (requestKind) => {
        localSettingsValue = { attentionDeviceOverridesV1: { localNotifications: { requestPreviewBehavior: 'status_only' } } };
        sessionsByIdValue['session-1'] = {
            ...sessionsByIdValue['session-1'],
            metadata: { summary: { text: 'Unique private request title', updatedAt: 1 } },
        };
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityAgentRequest } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        await act(async () => { notifyActivityAgentRequest({
            address: { serverId: 'srv_home_a', sessionId: 'session-1' }, requestId: 'private-request', requestKind,
            toolName: requestKind === 'permission' ? 'Bash' : 'AskUserQuestion',
            toolArgs: requestKind === 'permission' ? { command: 'cat private.txt' }
                : { questions: [{ question: 'Private question?', options: [{ label: 'Secret option' }] }] },
        }); });
        const notification = sendExpoLocalNotification.mock.calls[0]?.[0];
        expect(notification).toEqual(expect.objectContaining({
            // The device preview override hides the private request details and Session title while
            // the authorized Home context still identifies the alert (L07-R42/L07-I37).
            title: 'Session · Home A',
            body: requestKind === 'permission' ? 'Approval required.' : 'This session needs your input.',
            data: expect.objectContaining({ requestId: 'private-request' }),
        }));
        expect(`${notification?.title} ${notification?.body}`).not.toContain('Unique private request title');
        await act(async () => { screen.tree.unmount(); });
    });

    it('keeps the Session title but omits ready message content under title-only privacy', async () => {
        await setActiveAccountSettings({
            attentionDeliveryPolicyV1: {
                v: 1,
                privacy: { defaultPreviewBehavior: 'title_only' },
            },
        });
        sessionsByIdValue['session-1'] = {
            ...sessionsByIdValue['session-1'],
            metadata: { summary: { text: 'Readable private title', updatedAt: 1 } },
        };
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, [{
                kind: 'agent-text', id: 'private-body', createdAt: 1, text: 'Private body preview',
            } as any]);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Readable private title · Home A',
            body: 'Turn finished. Open the session to continue.',
        }));
        await act(async () => { screen.tree.unmount(); });
    });

    it('uses the exact recipient Home policy before and after active-Home switches for equal Session ids', async () => {
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        saveAccountSettings({ serverId: 'srv_home_a', accountId: 'account-a' }, settingsParse({
            attentionDeliveryPolicyV1: {
                v: 1,
                privacy: { defaultPreviewBehavior: 'include_preview' },
            },
        }), 2);
        saveAccountSettings({ serverId: 'srv_home_b', accountId: 'account-b' }, settingsParse({
            attentionDeliveryPolicyV1: {
                v: 1,
                quietHours: {
                    enabled: true,
                    timezone: 'UTC',
                    windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
                },
                channels: {
                    local_notification: { quietHoursBehavior: 'silent' },
                },
                privacy: { defaultPreviewBehavior: 'status_only' },
            },
        }), 2);
        sessionsByIdValue['session-1'] = {
            id: 'session-1',
            serverId: 'srv_home_b',
            encryptionMode: 'plain',
            access: createSessionAccessFixture(),
            active: true,
            metadata: { summary: { text: 'Home B private title', updatedAt: 1 } },
        };
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);

        for (const activeServerId of ['srv_home_a', 'srv_home_b']) {
            await act(async () => { await setActiveServerId(activeServerId); });
            await act(async () => {
                notifyActivityReady({ serverId: 'srv_home_b', sessionId: 'session-1' }, [{
                    kind: 'agent-text', id: `private-${activeServerId}`, createdAt: 1,
                    text: 'Home B private body',
                } as any]);
            });
        }

        expect(sendExpoLocalNotification).toHaveBeenCalledTimes(2);
        for (const [notification] of sendExpoLocalNotification.mock.calls) {
            expect(notification).toEqual(expect.objectContaining({
                // The recipient Home's status-only policy withholds its private title and body while
                // still naming the exact Home the alert came from (L07-R42/L07-I37).
                title: 'Session · Home B',
                body: 'Turn finished. Open the session to continue.',
                sound: null,
                data: expect.objectContaining({
                    serverId: 'srv_home_b',
                    sessionId: 'session-1',
                    serverUrl: 'https://secondary.example.test',
                }),
            }));
            expect(`${notification.title} ${notification.body}`).not.toContain('Home B private');
        }

        await act(async () => {
            saveAccountSettings({ serverId: 'srv_home_b', accountId: 'account-b' }, settingsParse({
                attentionDeliveryPolicyV1: {
                    v: 1,
                    channels: { local_notification: { enabled: false } },
                },
            }), 3);
        });
        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_b', sessionId: 'session-1' }, []);
        });
        expect(sendExpoLocalNotification).toHaveBeenCalledTimes(2);
        await act(async () => { screen.tree.unmount(); });
    });

    it('sends ready events to the Expo local notification channel when enabled', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, [
                {
                    kind: 'agent-text',
                    id: 'message-1',
                    createdAt: 1,
                    text: 'Everything is ready.',
                } as any,
            ]);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Ready session · Home A',
            body: 'Everything is ready.',
            data: expect.objectContaining({ sessionId: 'session-1' }),
            sound: 'happier_soft.wav',
        }));
        expect(sendTauriLocalNotification).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('uses the captured secondary Home for lookup, context, routing, and suppression', async () => {
        visibleSessionIdsValue = ['session-1'];
        visibleSessionAddressesValue = ['srv_home_a:session-1'];
        sessionsByIdValue['session-1'] = { id: 'session-1', serverId: 'srv_home_b' };
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_b', sessionId: 'session-1' }, []);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Session · Home B',
            data: expect.objectContaining({
                sessionId: 'session-1',
                serverUrl: 'https://secondary.example.test',
            }),
        }));
        await act(async () => { screen.tree.unmount(); });
    });

    it('uses the generic ready body when rich ready previews are disabled locally', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        localSettingsValue = {
            ...localSettingsValue,
            localNotificationsShowReadyMessageText: false,
        };

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, [
                {
                    kind: 'agent-text',
                    id: 'message-1',
                    createdAt: 1,
                    text: 'Everything is ready.',
                } as any,
            ]);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Ready session · Home A',
            body: 'Turn finished. Open the session to continue.',
        }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('suppresses same-session notifications while the session is already open', async () => {
        visibleSessionIdsValue = ['session-1'];

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });

        expect(sendExpoLocalNotification).not.toHaveBeenCalled();
        expect(sendTauriLocalNotification).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('sends same-session Tauri notifications when the desktop window is not active', async () => {
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        globalWithDocument.document = {
            visibilityState: 'hidden',
            hasFocus: () => false,
        };
        reactNativeRuntime.platformOs = 'web';
        isDesktopHostValue = true;
        visibleSessionIdsValue = ['session-1'];

        try {
            const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
            const { notifyActivityReady } = await import('./activityLocalNotificationBus');

            let tree: renderer.ReactTestRenderer | null = null;
            tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

            await act(async () => {
                notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
            });

            expect(sendExpoLocalNotification).not.toHaveBeenCalled();
            expect(sendTauriLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
                title: 'Ready session · Home A',
            }));

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });

    it('suppresses reused ready notifications for the active direct-session view', async () => {
        visibleSessionIdsValue = ['session-1'];
        sessionsByIdValue = {
            'session-1': {
                id: 'session-1',
                serverId: 'srv_home_a',
                active: true,
                metadata: {
                    summary: {
                        text: 'Direct session',
                        updatedAt: 1,
                    },
                    externalSessionV1: {
                        v: 1,
                        agentId: 'claude',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-1',
                        source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: 'proj-1' },
                    },
                },
            },
        };

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });

        expect(sendExpoLocalNotification).not.toHaveBeenCalled();
        expect(sendTauriLocalNotification).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('suppresses notifications for visible background sessions even when a different leaf is focused', async () => {
        visibleSessionIdsValue = ['session-1', 'session-2'];
        sessionsByIdValue['session-2'] = { ...sessionsByIdValue['session-1'], id: 'session-2' };

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-2' }, []);
        });

        expect(sendExpoLocalNotification).not.toHaveBeenCalled();
        expect(sendTauriLocalNotification).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('respects per-topic device-local toggles and routes tauri events to the desktop channel', async () => {
        reactNativeRuntime.platformOs = 'web';
        isDesktopHostValue = true;
        localSettingsValue = {
            ...localSettingsValue,
            localNotificationsShowReady: false,
        };

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady, notifyActivityAgentRequest } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
            notifyActivityAgentRequest({
                address: { serverId: 'srv_home_a', sessionId: 'session-1' },
                requestId: 'req-7',
                requestKind: 'permission',
                toolName: 'Bash',
                toolArgs: { command: 'pwd' },
            });
        });

        expect(sendExpoLocalNotification).not.toHaveBeenCalled();
        expect(sendTauriLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Ready session · Home A',
            body: 'Command: pwd',
        }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('suppresses local notifications during account quiet hours', async () => {
        await setActiveAccountSettings({
            attentionDeliveryPolicyV1: {
                v: 1,
                quietHours: {
                    enabled: true,
                    timezone: 'UTC',
                    windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
                },
            },
        });

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });

        expect(sendExpoLocalNotification).not.toHaveBeenCalled();
        expect(sendTauriLocalNotification).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('lets a device quiet-hours override deliver local notifications during account quiet hours', async () => {
        await setActiveAccountSettings({
            attentionDeliveryPolicyV1: {
                v: 1,
                quietHours: {
                    enabled: true,
                    timezone: 'UTC',
                    windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
                },
            },
        });
        localSettingsValue = {
            ...localSettingsValue,
            attentionDeviceOverridesV1: {
                v: 1,
                quietHoursOverride: { mode: 'disabled' },
            },
        };

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ sessionId: 'session-1' }),
        }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('delivers quiet-hours silent local notifications without sound when configured by account policy', async () => {
        await setActiveAccountSettings({
            attentionDeliveryPolicyV1: {
                v: 1,
                quietHours: {
                    enabled: true,
                    timezone: 'UTC',
                    windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
                },
                channels: {
                    local_notification: {
                        quietHoursBehavior: 'silent',
                    },
                },
            },
        });

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ sessionId: 'session-1' }),
            sound: null,
        }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('suppresses account-disabled local notification events even when legacy device toggles are enabled', async () => {
        await setActiveAccountSettings({
            attentionDeliveryPolicyV1: {
                v: 1,
                channels: {
                    local_notification: {
                        events: {
                            ready: { enabled: false },
                        },
                    },
                },
            },
        });

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });

        expect(sendExpoLocalNotification).not.toHaveBeenCalled();
        expect(sendTauriLocalNotification).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('passes resolved silent sound options to Expo local notifications', async () => {
        await setActiveAccountSettings({
            attentionDeliveryPolicyV1: {
                v: 1,
                sounds: {
                    defaultSoundId: 'none',
                },
            },
        });

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ sessionId: 'session-1' }),
            sound: null,
        }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('passes bundled sound filenames and Android channel ids to Expo local notifications', async () => {
        reactNativeRuntime.platformOs = 'android';
        await setActiveAccountSettings({
            attentionDeliveryPolicyV1: {
                v: 1,
                sounds: {
                    defaultSoundId: 'soft',
                },
            },
        });

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ sessionId: 'session-1' }),
            sound: 'happier_soft.wav',
            channelId: 'happier.default.soft.v1',
        }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('does not pass unsupported custom sound ids to Expo local notifications', async () => {
        await setActiveAccountSettings({
            attentionDeliveryPolicyV1: {
                v: 1,
                sounds: {
                    defaultSoundId: 'custom:imported-tone',
                },
            },
        });

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ sessionId: 'session-1' }),
            sound: null,
        }));

        await act(async () => {
            tree?.unmount();
        });
    });
});
