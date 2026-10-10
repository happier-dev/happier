import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, AttentionDeliveryPolicyV1Schema } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveAttentionDeliveryPolicyDecision } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicyDecision';
import { prepareLegacyNotificationChannelCatalogV1 } from '@happier-dev/protocol/account/settings/notificationChannelCatalogV1';
import { NotificationChannelCatalogRecordV1Schema, WebhookNotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID } from '@happier-dev/protocol/account/settings/notificationChannels';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { readAccountNotificationPreference } from './notificationPreferences';
import { loadNotificationsSettingsActionExecutorForTests, restoreNotificationsSettingsCatalog } from './notificationsSettingsCatalogTestHarness';
import { clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

// Rendering, dialogs and Socket.IO are external SDK boundaries. The store,
// Settings writer, catalog loader and typed Action executor remain real.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Notifications settings do not render Markdown'); },
}));
// The detail route is focused through the canonical navigator SDK boundary.
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installDisconnectedServerSocketBoundary();
installSettingsViewCommonModuleMocks({
    storage: 'real',
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'web' } }),
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        confirmResult: true, renderCustomModals: true, spies: { alert: modalAlert },
    }).module,
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: routerPush } }).module,
});
const modalAlert = vi.fn();
const routerPush = vi.fn();
let storage: typeof import('@/sync/domains/state/storage').storage;
let disposeActionBridge: (() => void) | undefined;
beforeAll(async () => {
    // The common harness must unmock the store before any consumer binds it.
    storage = (await import('@/sync/domains/state/storage')).storage;
    await loadSyncSingletonForTests();
    disposeActionBridge = (await loadNotificationsSettingsActionExecutorForTests()).dispose;
});
afterAll(() => { disposeActionBridge?.(); });

let disposeHome: (() => Promise<void>) | undefined;
let disposeScreen: (() => Promise<void>) | undefined;
afterEach(async () => {
    modalAlert.mockReset();
    routerPush.mockReset();
    clearActiveUnsavedChangesGuard();
    await disposeScreen?.();
    disposeScreen = undefined;
    await disposeHome?.();
    disposeHome = undefined;
    storage?.getState().clearSettingsScope();
    storage?.getState().clearProfileScope();
});

type Membership = 'builtin' | 'empty' | 'deleted' | 'absent';
async function openCatalogScreen(membership: Membership, independentlyEnabledPreferences = false) {
    const accountId = `notification-controls-${membership}`;
    const legacyNotifications = {
        v: 1, pushEnabled: false, ready: false, permissionRequest: false, userActionRequest: false,
        connectedServiceAccountSwitch: false, connectedServiceQuotaBlocked: false, connectedServiceQuotaRecovered: false,
        readyIncludeMessageText: false, requestIncludeMessageText: false, foregroundBehavior: 'full',
    };
    const source = prepareLegacyNotificationChannelCatalogV1({ accountId,
        raw: { notificationsSettingsV1: legacyNotifications }, settingsSecretsReadKeys: [] });
    if (source.status !== 'ready') throw new Error('Expected the genuine unsigned predecessor source');
    const record = NotificationChannelCatalogRecordV1Schema.parse({ v: 1,
        channels: membership === 'builtin' ? source.record.channels : [] });
    const finitePreferences = independentlyEnabledPreferences ? { ...legacyNotifications,
        pushEnabled: true, ready: true, permissionRequest: true, userActionRequest: true,
        connectedServiceAccountSwitch: true, connectedServiceQuotaBlocked: true, connectedServiceQuotaRecovered: true,
        readyIncludeMessageText: true, requestIncludeMessageText: true,
    } : legacyNotifications;
    const derived = accountSettingsParse({ notificationsSettingsV1: finitePreferences }).attentionDeliveryPolicyV1;
    const policy = AttentionDeliveryPolicyV1Schema.parse({ ...derived,
        events: { ...derived.events, ready: { ...derived.events.ready, previewBehavior: 'status_only' } },
        channels: { ...derived.channels, webhook: { ...derived.channels.webhook, enabled: false } },
        mutePhoneWhenComputerFocused: true,
    });
    const raw: Record<string, unknown> = { notificationsSettingsV1: legacyNotifications, attentionDeliveryPolicyV1: policy,
        sessionRemoteAlertsEnabled: true, futurePreference: { retained: 'opaque sibling' },
        ...(membership === 'absent' ? { notificationChannelsV1: [] } : {}),
    };
    const fixture = await restoreNotificationsSettingsCatalog({
        accountId, serverUrl: `https://notification-controls-${membership}.example.test`, rawSettings: raw,
        catalog: membership === 'deleted' || membership === 'absent' ? { status: membership } : { status: 'present', record },
    });
    disposeHome = fixture.dispose;
    const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
    const screen = await renderSettingsView(<NotificationsSettingsView />);
    disposeScreen = screen.unmount;
    // Retrieve callbacks only after their real scoped source is ready/current.
    const { refreshNotificationChannelCatalog } = await import('@/sync/engine/settings/notificationChannelCatalogEngine');
    await act(async () => { await refreshNotificationChannelCatalog(fixture.scope); });
    const { getNotificationChannelCatalogValue } = await import('@/sync/store/settings/notificationChannelCatalogSnapshot');
    expect(getNotificationChannelCatalogValue(fixture.scope)).toMatchObject({ status: 'ready', stale: false });
    return { ...fixture, screen, policy };
}

type CatalogScreenFixture = Awaited<ReturnType<typeof restoreNotificationsSettingsCatalog>> & Readonly<{
    screen: Awaited<ReturnType<typeof renderSettingsView>>;
}>;

/** Ask-first is an open durable request, an actual Detail decision, then the original mounted result. */
async function approveCatalogMutation(fixture: CatalogScreenFixture, actionId: ActionId,
    start: () => unknown, terminalStatus: 'executed' | 'failed' = 'executed') {
    const existingIds = new Set(fixture.artifacts.list().map(artifact => artifact.id));
    const recordBefore = structuredClone(fixture.readRecord());
    const rawBefore = structuredClone(fixture.readRaw());
    const pairedBefore = fixture.pairedWrites.length;
    const settingsBefore = fixture.settingsWrites.length;
    let operation: Promise<unknown> | undefined;
    await act(async () => { operation = Promise.resolve(start()); });
    let artifactId = '';
    await vi.waitFor(() => {
        const artifact = fixture.artifacts.list().find(row => !existingIds.has(row.id));
        expect(artifact).toBeTruthy();
        if (!artifact) return;
        const request = StoredApprovalRequestSchema.parse(JSON.parse(fixture.artifacts.readPlainBody(artifact.id)!));
        expect(request).toMatchObject({ status: 'open', actionId });
        if (request.v === 2) expect(request.executionOriginV1).toMatchObject({
            serverId: fixture.scope.serverId,
        });
        artifactId = artifact.id;
    });
    expect(fixture.readRecord()).toEqual(recordBefore);
    expect(fixture.readRaw()).toEqual(rawBefore);
    expect(fixture.pairedWrites).toHaveLength(pairedBefore);
    expect(fixture.settingsWrites).toHaveLength(settingsBefore);
    expect(modalAlert.mock.calls).toEqual([]);
    expect(fixture.screen.findHostByTestId('settings-notifications-approval-pending')).toBeTruthy();
    const notice = fixture.screen.findAll(node => node.props.testID === 'settings-notifications-approval-pending'
        && typeof node.props.onOpenApproval === 'function')[0];
    if (!notice) throw new Error('The originating notification operation did not retain its approval');
    await act(async () => { notice.props.onOpenApproval(); });
    expect(routerPush).toHaveBeenLastCalledWith(`/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(fixture.scope.serverId)}`);
    const { ApprovalDetailScreen } = await import('@/components/approvals/ApprovalDetailScreen');
    const detail = await renderSettingsView(<ApprovalDetailScreen artifactId={artifactId} serverId={fixture.scope.serverId} />);
    try {
        await vi.waitFor(() => { expect(detail.findByTestId('approvals.approve')?.props.disabled).toBe(false); });
        await detail.pressByTestIdAsync('approvals.approve');
        await vi.waitFor(() => {
            const request = StoredApprovalRequestSchema.parse(JSON.parse(fixture.artifacts.readPlainBody(artifactId)!));
            expect(request.status).toBe(terminalStatus);
        });
        await act(async () => { await operation; });
        expect(fixture.screen.findHostByTestId('settings-notifications-approval-pending')).toBeNull();
    } finally { await detail.unmount(); }
}

async function setControl(fixture: CatalogScreenFixture, idOrTitle: string, value: boolean,
    terminalStatus: 'executed' | 'failed' = 'executed') {
    const { screen } = fixture;
    const row = screen.findAllByTestId(idOrTitle)[0] ?? screen.findRowByTitle(idOrTitle);
    expect(row).toBeTruthy();
    if (!row) throw new Error('The existing notification control is missing');
    await approveCatalogMutation(fixture, 'notifications.expoPush.update', () => row.props.rightElement.props.onValueChange(value), terminalStatus);
}

describe('NotificationsSettingsView catalog control authority', () => {
    it('clears a stored signing Resource reference through the approved Action without creating material or changing raw Settings', async () => {
        const webhook = WebhookNotificationChannelRecordV1Schema.parse({ v: 1, id: 'webhook-signed', kind: 'webhook',
            enabled: true, url: 'https://hooks.example.test/signed', topics: {},
            readyIncludeMessageText: false, requestIncludeMessageText: false,
            signingSecretRef: formatSharedSavedSecretRefV1('24683d18-f5a1-4e0a-bb2c-5f0fd97b6155') });
        const raw = { futurePreference: { retained: true } };
        const fixture = await restoreNotificationsSettingsCatalog({ accountId: 'notification-clear-existing',
            serverUrl: 'https://notification-clear-existing.example.test', rawSettings: raw,
            catalog: { status: 'present', record: { v: 1, channels: [webhook] } } });
        disposeHome = fixture.dispose;
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
        const screen = await renderSettingsView(<NotificationsSettingsView />);
        disposeScreen = screen.unmount;
        const { refreshNotificationChannelCatalog } = await import('@/sync/engine/settings/notificationChannelCatalogEngine');
        await act(async () => { await refreshNotificationChannelCatalog(fixture.scope); });
        await act(async () => { screen.pressRow('settings-notifications-webhook-webhook-signed'); });
        await approveCatalogMutation({ ...fixture, screen }, 'notifications.webhooks.signingSecret.clear', () =>
            screen.findRow('settings-notifications-webhook-webhook-signed-clear-secret')?.props.onPress());
        await vi.waitFor(() => { expect(fixture.readRecord().channels).toEqual([{ ...webhook, signingSecretRef: null }]); });
        expect(screen.findRow('settings-notifications-webhook-webhook-signed-clear-secret')).toBeNull();
        expect(fixture.readRaw()).toEqual(raw);
        expect(fixture.settingsWrites).toEqual([]);
        expect(fixture.pairedWrites).toEqual([]);
        expect(fixture.requests.filter(request => request.method !== 'GET'
            && request.path.startsWith('/v1/account/saved-secrets/'))).toEqual([]);
    });

    it('keeps ordinary webhook creation, URL edits and removal on catalog authority without changing finite preferences', async () => {
        const fixture = await openCatalogScreen('builtin');
        const rawBefore = structuredClone(fixture.readRaw());
        const settingsWritesBefore = fixture.settingsWrites.length;
        await act(async () => { fixture.screen.pressRow('settings-notifications-add-webhook'); });
        await act(async () => { fixture.screen.changeTextByTestId('settings-notifications-webhook-new-url', 'ftp://hooks.example.test/notify'); });
        await act(async () => { await fixture.screen.findAllByTestId('settings-notifications-webhook-new-url-save')[0]?.props.onPress(); });
        expect(fixture.readRecord().channels).toHaveLength(1);
        expect(fixture.screen.findByTestId('settings-notifications-webhook-new-url.error')).toBeTruthy();
        await act(async () => { fixture.screen.changeTextByTestId('settings-notifications-webhook-new-url', ' https://hooks.example.test/notify '); });
        await approveCatalogMutation(fixture, 'notifications.webhooks.add', () => fixture.screen.findAllByTestId('settings-notifications-webhook-new-url-save')[0]?.props.onPress());
        const webhook = fixture.readRecord().channels.find(channel => channel.kind === 'webhook');
        expect(webhook).toBeTruthy();
        if (!webhook) throw new Error('The actual catalog did not admit the webhook');
        expect(webhook).toMatchObject({ url: 'https://hooks.example.test/notify', signingSecretRef: null });
        expect(fixture.screen.findByTestId('settings-notifications-webhook-new-url')).toBeNull();
        const editorId = `settings-notifications-webhook-${webhook.id}-url`;
        await act(async () => { fixture.screen.pressRow(`settings-notifications-webhook-${webhook.id}-edit`); });
        await act(async () => { fixture.screen.changeTextByTestId(editorId, 'https://replacement.example.test/hook'); });
        await approveCatalogMutation(fixture, 'notifications.webhooks.update', () => fixture.screen.findAllByTestId(`${editorId}-save`)[0]?.props.onPress());
        expect(fixture.readRecord().channels.find(channel => channel.id === webhook.id)).toEqual({ ...webhook, url: 'https://replacement.example.test/hook' });
        await approveCatalogMutation(fixture, 'notifications.webhooks.remove', () => fixture.screen.findRow(`settings-notifications-webhook-${webhook.id}-delete`)?.props.onPress());
        await vi.waitFor(() => { expect(fixture.readRecord().channels).toHaveLength(1); });
        expect(fixture.readRaw()).toEqual(rawBefore);
        expect(fixture.settingsWrites).toHaveLength(settingsWritesBefore);
        expect(fixture.pairedWrites).toEqual([]);
    });

    it('retires signing drafts through real Account changes and explicit cancellation without saving secret material', async () => {
        const fixture = await openCatalogScreen('builtin');
        const webhook = WebhookNotificationChannelRecordV1Schema.parse({ v: 1, id: 'webhook-primary',
            kind: 'webhook', enabled: true, url: 'https://hooks.example.test/notify', signingSecretRef: null,
            topics: { ready: true, permissionRequest: true, userActionRequest: true },
            readyIncludeMessageText: false, requestIncludeMessageText: false });
        const raw = fixture.readRaw();
        await fixture.dispose();
        const homeA = await restoreNotificationsSettingsCatalog({ accountId: 'draft-account-a',
            serverUrl: 'https://notification-draft.example.test', rawSettings: raw,
            catalog: { status: 'present', record: { v: 1, channels: [webhook] } } });
        disposeHome = homeA.dispose;
        const { refreshNotificationChannelCatalog } = await import('@/sync/engine/settings/notificationChannelCatalogEngine');
        await act(async () => { await refreshNotificationChannelCatalog(homeA.scope); });
        const inputId = 'settings-notifications-webhook-webhook-primary-secret-input';
        const openSecret = async () => {
            await act(async () => { fixture.screen.pressRow('settings-notifications-webhook-webhook-primary'); });
            await act(async () => { fixture.screen.pressRow('settings-notifications-webhook-webhook-primary-set-secret'); });
        };
        await openSecret();
        await act(async () => { fixture.screen.changeTextByTestId(inputId, 'discard-on-account-change'); });
        await act(async () => {
            await homeA.dispose();
            const homeB = await restoreNotificationsSettingsCatalog({ accountId: 'draft-account-b',
                serverUrl: 'https://notification-draft.example.test', rawSettings: raw,
                catalog: { status: 'present', record: { v: 1, channels: [webhook] } } });
            disposeHome = homeB.dispose;
            await refreshNotificationChannelCatalog(homeB.scope);
        });
        expect(fixture.screen.findByTestId(inputId)).toBeNull();
        await openSecret();
        expect(fixture.screen.findByTestId(inputId)?.props.value).toBe('');
        await act(async () => { fixture.screen.changeTextByTestId(inputId, 'discard-on-cancel'); });
        await act(async () => { fixture.screen.pressRow('settings-notifications-webhook-webhook-primary-secret-cancel'); });
        expect(fixture.screen.findByTestId(inputId)).toBeNull();
        await act(async () => { fixture.screen.pressRow('settings-notifications-webhook-webhook-primary-set-secret'); });
        expect(fixture.screen.findByTestId(inputId)?.props.value).toBe('');
        expect(homeA.readRecord().channels).toEqual([webhook]);
        expect(homeA.pairedWrites).toEqual([]);
    });

    it('displays disabled endpoint topics and disclosure despite independently enabled Account preferences', async () => {
        const fixture = await openCatalogScreen('builtin', true);
        const { refreshNotificationChannelCatalog } = await import('@/sync/engine/settings/notificationChannelCatalogEngine');
        const { getNotificationChannelCatalogValue } = await import('@/sync/store/settings/notificationChannelCatalogSnapshot');
        await act(async () => { await refreshNotificationChannelCatalog(fixture.scope); });
        expect(getNotificationChannelCatalogValue(fixture.scope)).toMatchObject({ status: 'ready', stale: false,
            channels: [{ enabled: false, topics: { permissionRequest: false, userActionRequest: false }, requestIncludeMessageText: false }] });
        expect(readAccountNotificationPreference(fixture.policy, 'permission_request')).toBe(true);
        expect(readAccountNotificationPreference(fixture.policy, 'requestPreview')).toBe(true);
        expect(fixture.readRecord().channels[0]).toMatchObject({ enabled: false,
            topics: { permissionRequest: false, userActionRequest: false }, requestIncludeMessageText: false });
        for (const title of ['settingsNotifications.types.permissionRequests.title', 'settingsNotifications.types.userActions.title',
            'settingsNotifications.types.requestPreview.title']) {
            const row = fixture.screen.findRowByTitle(title);
            expect(row?.props.rightElement.props.value).toBe(false);
        }
    });

    it('re-enables the imported disabled builtin through existing controls without loosening unrelated policy or raw siblings', async () => {
        const fixture = await openCatalogScreen('builtin');
        const originalTopics = fixture.readRecord().channels[0]?.topics;
        await setControl(fixture, 'settings-notifications-push-enabled', true);
        expect(modalAlert.mock.calls).toEqual([]);
        expect(fixture.pairedWrites).not.toHaveLength(0);
        expect(fixture.readRecord().channels[0]).toMatchObject({ enabled: true,
            topics: { ready: false, permissionRequest: false, userActionRequest: false,
                connectedServiceAccountSwitch: false, connectedServiceQuotaBlocked: false, connectedServiceQuotaRecovered: false },
            readyIncludeMessageText: false, requestIncludeMessageText: false,
        });
        expect(storage.getState().settings.attentionDeliveryPolicyV1.channels.expo_push.enabled).toBe(true);
        expect(fixture.screen.findAllByTestId('settings-notifications-push-enabled')[0]?.props.rightElement.props.value).toBe(true);
        await setControl(fixture, 'settingsNotifications.types.ready.title', true);
        await setControl(fixture, 'settingsNotifications.types.permissionRequests.title', true);
        await setControl(fixture, 'settingsNotifications.types.userActions.title', true);
        await setControl(fixture, 'settingsNotifications.types.readyPreview.title', true);
        await setControl(fixture, 'settingsNotifications.types.requestPreview.title', true);
        expect(fixture.readRecord().channels).toEqual([expect.objectContaining({ id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
            enabled: true, topics: { ...originalTopics, ready: true, permissionRequest: true, userActionRequest: true,
                connectedServiceAccountSwitch: false, connectedServiceQuotaBlocked: false, connectedServiceQuotaRecovered: false },
            readyIncludeMessageText: true, requestIncludeMessageText: true,
        })]);
        const raw = fixture.readRaw();
        const policy = accountSettingsParse(raw).attentionDeliveryPolicyV1;
        expect(policy.channels.expo_push.enabled).toBe(true);
        expect(policy.channels.webhook).toEqual(fixture.policy.channels.webhook);
        expect(policy.events.ready.previewBehavior).toBe('status_only');
        expect(policy.privacy).toEqual(fixture.policy.privacy);
        expect(resolveAttentionDeliveryPolicyDecision({ policy, event: 'ready', channel: 'expo_push', now: new Date(0) }).previewBehavior).toBe('status_only');
        expect(raw.futurePreference).toEqual({ retained: 'opaque sibling' });
        expect(raw.sessionRemoteAlertsEnabled).toBe(true);
        expect(fixture.pairedWrites).not.toHaveLength(0);
    });

    it.each(['empty', 'deleted', 'absent'] as const)('does not reseed %s membership or report a finite preference write when the builtin is not admitted', async membership => {
        const fixture = await openCatalogScreen(membership);
        await setControl(fixture, 'settings-notifications-push-enabled', true, 'failed');
        expect(fixture.readRecord().channels).toEqual([]);
        expect(accountSettingsParse(fixture.readRaw()).attentionDeliveryPolicyV1.channels.expo_push.enabled).toBe(false);
        expect(storage.getState().settings.attentionDeliveryPolicyV1.channels.expo_push.enabled).toBe(false);
        expect(fixture.pairedWrites).toEqual([]);
    });
});
