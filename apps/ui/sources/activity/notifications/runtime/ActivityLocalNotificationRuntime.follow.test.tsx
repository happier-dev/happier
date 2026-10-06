import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred, createSessionAccessFixture, createSessionFixture, renderScreen } from '@/dev/testkit';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { saveAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { removeServerProfile, setActiveServerId, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { handleNewMessageSocketUpdate } from '@/sync/engine/sessions/sessionSocketUpdate';
import { handleEphemeralSocketUpdate, handleUpdateContainer } from '@/sync/engine/socket/socket';
import { ActivityLocalNotificationRuntime } from './ActivityLocalNotificationRuntime';
import { notifyActivityReady, resetActivityLocalNotificationRuntimeForTests } from './activityLocalNotificationBus';
import { resetActivityAlertPresentationNotesForTests } from '../remoteAlerts/activityAlertPresentationNotes';
import { resolveForegroundNotificationBehavior } from '../resolveForegroundNotificationBehavior';

type ExpoNotificationParams = Parameters<typeof import('../channels/sendExpoLocalNotification')['sendExpoLocalNotification']>[0];

const boundary = vi.hoisted(() => ({
    desktop: false,
    active: { serverId: 'srv_home_a', serverUrl: 'https://stack.example.test', generation: 1 },
    expo: vi.fn(async (_params: ExpoNotificationParams) => 'notification-1'),
    tauri: vi.fn(async () => true),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return boundary.desktop ? 'web' : 'ios'; } } });
});
vi.mock('@/utils/platform/desktopHost', () => ({ isDesktopHost: () => boundary.desktop }));
vi.mock('../channels/sendExpoLocalNotification', () => ({ sendExpoLocalNotification: boundary.expo }));
vi.mock('../channels/sendTauriLocalNotification', () => ({ sendTauriLocalNotification: boundary.tauri }));
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: createAccountTokenForTests('account-a') }),
    } });
});

const initialState = storage.getInitialState();
const getSession = () => storage.getState().sessions['session-1'];
const applySessions: Parameters<typeof handleUpdateContainer>[0]['applySessions'] = (sessions) => storage.getState().applySessions(sessions);

async function deliverMessage(seq: number, human: boolean, recovered = false, sourceAccountId = 'other-account'): Promise<void> {
    if (!recovered) {
        await handleEphemeralSocketUpdate({ sourceServerId: 'srv_home_a',
            update: { type: 'session-personal-event', sessionId: 'session-1', eventId: `message-${seq}`,
                event: human ? 'human_message' : 'message', message: { sequenceDomain: 'session_transcript', messageSeq: seq },
                ...(human ? { sourceAccountId } : {}),
            },
            addActivityUpdate: () => undefined, addMachineActivityUpdate: () => undefined,
            getSessionEncryption: () => null, getSession, applyMessages: () => undefined,
        });
        return;
    }
    await handleNewMessageSocketUpdate({
        serverId: 'srv_home_a',
        updateData: { body: { sid: 'session-1', message: {
            id: `message-${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq,
            messageRole: human ? 'user' : 'agent',
            ...(human ? { accountActor: { v: 1, accountId: 'other-account', profile: null } } : {}),
            ...(recovered ? { transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' } } : {}),
            content: { t: 'plain', v: { role: human ? 'user' : 'agent', content: { type: 'text', text: `preview-${seq}` } } },
        } }, seq, createdAt: seq },
        getSession, getSessionEncryption: () => null, applySessions,
        fetchSessions: () => undefined, applyMessages: () => undefined,
        isMutableToolCall: () => false, invalidateScmStatus: () => undefined,
        isSessionMessagesLoaded: () => false, getSessionMaterializedMaxSeq: () => 0,
        markSessionMaterializedMaxSeq: () => undefined, onMessageGapDetected: () => undefined,
        realtimeProjectionMode: 'enabled',
    });
}

describe('live Follow socket notifications', () => {
    it('reconciles a muted Home wake without posting a local alert, then delivers an ordinary wake', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');
        const { applySessionChangedBackgroundWakePayload } = await import('../backgroundWake/defineSessionChangedBackgroundWakeTask');
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        let reconciled = 0;
        const reconcile = async () => {
            reconciled++;
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, [], undefined, undefined, 'reconciliation');
            return true;
        };
        await act(async () => {
            await applySessionChangedBackgroundWakePayload({
                payload: { type: 'session_changed', serverId: 'srv_home_a', sessionId: 'session-1', alert: 'muted' }, reconcile,
            });
        });
        expect(reconciled).toBe(1);
        expect(boundary.expo).not.toHaveBeenCalled();
        await act(async () => {
            await applySessionChangedBackgroundWakePayload({
                payload: { type: 'session_changed', serverId: 'srv_home_a', sessionId: 'session-1' }, reconcile,
            });
        });
        expect(reconciled).toBe(2);
        expect(boundary.expo).toHaveBeenCalled();
    });
    it('delivers an independent live alert while a muted wake is reconciling the same Session', async () => {
        const { applySessionChangedBackgroundWakePayload } = await import('../backgroundWake/defineSessionChangedBackgroundWakeTask');
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        const deferred = createDeferred<boolean>();
        const pending = applySessionChangedBackgroundWakePayload({
            payload: { type: 'session_changed', serverId: 'srv_home_a', sessionId: 'session-1', alert: 'muted' },
            reconcile: async () => {
                notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, [], undefined, undefined, 'reconciliation');
                return deferred.promise;
            },
        });
        try {
            expect(boundary.expo).not.toHaveBeenCalled();
            await act(async () => notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []));
            expect(boundary.expo).toHaveBeenCalledTimes(1);
        } finally {
            deferred.resolve(true);
            await act(async () => { await pending; });
        }
    });
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    let savedProfileId: string | undefined;
    beforeEach(async () => {
        const profile = await upsertServerProfile({ serverUrl: boundary.active.serverUrl, name: 'Home A' });
        savedProfileId = profile.id;
        await setServerProfileIdentityForUrl(profile.serverUrl, 'srv_home_a');
        await setActiveServerId('srv_home_a');
        storage.setState(initialState, true);
        storage.setState({ settings: settingsParse({}), localSettings: localSettingsParse({}) });
        saveAccountSettings({ serverId: 'srv_home_a', accountId: 'account-a' }, settingsParse({}), 1);
        applySessions([createSessionFixture({ id: 'session-1', serverId: 'srv_home_a', seq: 0, active: true, viewer: {
            readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
            follow: { follows: false, notificationLevel: null },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            notification: { level: 'important', source: 'owner' },
        } })]);
    });
    afterEach(async () => {
        await act(async () => { screen?.tree.unmount(); });
        screen = undefined;
        boundary.desktop = false;
        boundary.expo.mockClear(); boundary.tauri.mockClear();
        resetActivityLocalNotificationRuntimeForTests();
        resetActivityAlertPresentationNotesForTests();
        storage.setState(initialState, true);
        if (savedProfileId) await removeServerProfile(savedProfileId);
        savedProfileId = undefined;
    });

    it.each([false, true])('delivers live Follow messages on desktop=%s without remote enrollment or history replay', async (desktop) => {
        boundary.desktop = desktop;
        applySessions([{ ...getSession(), viewer: {
            readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['followed_by_me'] },
            follow: { follows: true, notificationLevel: 'important' },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            notification: { level: 'important', source: 'preference' },
        } }]);
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        const submit = desktop ? boundary.tauri : boundary.expo;
        await act(async () => { await deliverMessage(1, true); });
        expect(submit).toHaveBeenCalledTimes(1);
        await act(async () => { await deliverMessage(2, false); });
        expect(submit).toHaveBeenCalledTimes(1);
        await act(async () => { applySessions([{ ...getSession(), viewer: { ...getSession().viewer!, follow: { follows: true, notificationLevel: 'all_messages' } } }]); });
        await act(async () => { await deliverMessage(3, false); });
        expect(submit).toHaveBeenCalledTimes(2);
        await act(async () => { await handleEphemeralSocketUpdate({ sourceServerId: 'srv_home_a',
            update: { type: 'session-personal-event', sessionId: 'session-1', eventId: 'discussion-message-3', event: 'message',
                message: { sequenceDomain: 'discussion', discussionId: 'discussion-1', messageSeq: 3 } },
            addActivityUpdate: () => undefined, addMachineActivityUpdate: () => undefined,
            getSessionEncryption: () => null, getSession, applyMessages: () => undefined,
        }); });
        expect(submit).toHaveBeenCalledTimes(3);
        await act(async () => { await deliverMessage(6, true, false, 'account-a'); });
        expect(submit).toHaveBeenCalledTimes(3);
        await act(async () => { await deliverMessage(4, true, true); });
        expect(submit).toHaveBeenCalledTimes(3);
        await act(async () => { applySessions([{ ...getSession(), viewer: { ...getSession().viewer!, follow: { follows: true, notificationLevel: 'none' } } }]); });
        await act(async () => { await deliverMessage(5, true); });
        expect(submit).toHaveBeenCalledTimes(3);
    });

    it('delivers live source-unavailable only for personally tracked sessions', async () => {
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        const deliver = () => handleEphemeralSocketUpdate({ sourceServerId: 'srv_home_a',
            update: { type: 'session-personal-event', sessionId: 'session-1', eventId: 'source-occurrence-1', event: 'source_unavailable' },
            addActivityUpdate: () => undefined, addMachineActivityUpdate: () => undefined,
            getSessionEncryption: () => null, getSession, applyMessages: () => undefined,
        });
        await act(async () => { await deliver(); });
        expect(boundary.expo).toHaveBeenCalledTimes(1);
        await act(async () => { applySessions([{ ...getSession(), access: createSessionAccessFixture('view'), viewer: {
            readState: { state: 'not_started' }, relevance: { relevant: false, reasons: [] },
            follow: { follows: false, notificationLevel: null },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            notification: { level: 'none', source: 'none' },
        } }]); });
        await act(async () => { await deliver(); });
        expect(boundary.expo).toHaveBeenCalledTimes(1);
    });

    it('delivers committed failed and cancelled occurrences through the live socket', async () => {
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        const transition = (event: 'failed' | 'cancelled', turnId: string) => handleEphemeralSocketUpdate({
            sourceServerId: 'srv_home_a', update: { type: 'session-personal-event', sessionId: 'session-1', eventId: `mutation-${turnId}`, event, turnId },
            addActivityUpdate: () => undefined, addMachineActivityUpdate: () => undefined,
            getSessionEncryption: () => null, getSession, applyMessages: () => undefined,
        });
        await act(async () => { await transition('failed', 'turn-1'); });
        expect(boundary.expo).toHaveBeenCalledTimes(1);
        await act(async () => { await transition('cancelled', 'turn-2'); });
        expect(boundary.expo).toHaveBeenCalledTimes(2);
    });

    it('does not let native scheduling overwrite the foreground presentation owner', async () => {
        const settings = settingsParse({ attentionDeliveryPolicyV1: { v: 1, foregroundBehavior: 'full' } });
        storage.setState({ settings });
        saveAccountSettings({ serverId: 'srv_home_a', accountId: 'account-a' }, settings, 2);
        const accepted = createDeferred<string>();
        boundary.expo.mockImplementationOnce(() => accepted.promise);
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, [],
                { sequenceDomain: 'session_transcript', sequence: 21 }, 'ready-21');
        });
        expect(boundary.expo).toHaveBeenCalledTimes(1);
        const foreground = (content: Parameters<typeof resolveForegroundNotificationBehavior>[0]['content']) =>
            resolveForegroundNotificationBehavior({ content, localSettings: storage.getState().localSettings,
                now: new Date('2026-09-26T12:00:00Z'), isSessionVisible: () => false });

        // The rich push presents while local OS scheduling is still pending.
        await expect(foreground({ data: { sessionId: 'session-1', serverUrl: boundary.active.serverUrl,
            activityEventLocalId: 'ready-21' } })).resolves.toBe('full');
        await act(async () => { accepted.resolve('notification-accepted'); await accepted.promise; });
        // Scheduling acceptance is not a presentation and cannot overwrite the
        // rich note before the actual local foreground callback makes its decision.
        await expect(foreground(boundary.expo.mock.calls[0]![0])).resolves.toBe('off');
    });
});
