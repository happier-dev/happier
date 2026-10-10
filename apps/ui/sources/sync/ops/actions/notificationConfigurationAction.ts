import { BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID } from '@happier-dev/protocol/account/settings/notificationChannels';
import { NotificationChannelCatalogRecordV1Schema, NotificationChannelRecordV1Schema, WebhookNotificationChannelRecordV1Schema,
    type NotificationChannelRecordV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { NotificationConfigurationActionInputSchemas,
    type NotificationChannelConfigurationPatch } from '@happier-dev/protocol/actions/notificationConfigurationActionFamily';
import { SavedSecretSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { addWebhookNotificationChannelRecord } from '@/components/settings/notifications/notificationChannels';
import { applyNotificationChannelPreferencePatchToRawSettings } from '@/components/settings/notifications/notificationPreferences';
import { readNotificationChannelCatalogProjectionInContext, writeNotificationChannelCatalogInContext,
    requireUpdatedNotificationChannelCatalog, publishAcknowledgedNotificationChannelCatalog,
    NotificationChannelCatalogOperationError } from '@/sync/api/account/apiNotificationChannelCatalog';
import { syncSettings } from '@/sync/engine/settings/syncSettings';
import { resolveSettingsSecretsKeySet } from '@/sync/encryption/resolveSettingsSecretsKeySet';
import { randomUUID } from '@/platform/randomUUID';
import type { LazyActionAccountContext } from './actionAccountContext';

function patchChannel(channel: NotificationChannelRecordV1, patch: NotificationChannelConfigurationPatch): NotificationChannelRecordV1 {
    const topics = { ...channel.topics };
    for (const topic of ['ready', 'permissionRequest', 'userActionRequest', 'connectedServiceAccountSwitch',
        'connectedServiceQuotaBlocked', 'connectedServiceQuotaRecovered'] as const) {
        const value = patch.topics?.[topic];
        if (value !== undefined) topics[topic] = value;
    }
    return NotificationChannelRecordV1Schema.parse({ ...channel, topics,
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.readyIncludeMessageText === undefined ? {} : { readyIncludeMessageText: patch.readyIncludeMessageText }),
        ...(patch.requestIncludeMessageText === undefined ? {} : { requestIncludeMessageText: patch.requestIncludeMessageText }),
    });
}

async function updateBuiltin(account: LazyActionAccountContext, channels: readonly NotificationChannelRecordV1[], revision: number,
    patch: NotificationChannelConfigurationPatch, signal?: AbortSignal): Promise<void> {
    const builtin = requireBuiltin(channels);
    const record = NotificationChannelCatalogRecordV1Schema.parse({ v: 1,
        channels: channels.map(channel => channel === builtin ? patchChannel(channel, patch) : channel) });
    const baseline = await account.readRawSettingsSnapshot();
    const { accountMode, encryption } = await account.resolveAccountEncryption();
    const keys = await resolveSettingsSecretsKeySet({ credentials: account.credentials, scope: account.accountLifetime.scope });
    account.assertCurrent();
    const result = await syncSettings({ credentials: account.credentials, encryption, signal,
        settingsScope: account.accountLifetime.scope, settingsSecretsKey: keys?.writeKey ?? null, settingsSecretsReadKeys: keys?.readKeys ?? [],
        requestContext: { scope: account.accountLifetime.scope, endpointUrl: account.endpointUrl, request: account.request },
        pendingSettings: {}, clearPendingSettings: () => {}, oneShotServerSettingsMutation: {
            expectedSettingsVersion: baseline.version, rebaseOnConflict: false,
            mutate: raw => {
                account.assertCurrent();
                return { settings: applyNotificationChannelPreferencePatchToRawSettings(raw, patch), value: undefined };
            },
            commitPrepared: async prepared => {
                account.assertCurrent();
                if (prepared.accountMode !== accountMode) return { status: 'rejected', error: new NotificationChannelCatalogOperationError('account-mode-mismatch') };
                const receipt = await writeNotificationChannelCatalogInContext(account, { record, expectedRevision: revision,
                    expectedMode: accountMode, settingsMutation: { expectedSettingsVersion: prepared.expectedSettingsVersion,
                        content: prepared.content, ...(prepared.remoteAlertPolicy === undefined ? {} : { remoteAlertPolicy: prepared.remoteAlertPolicy }) } }, signal);
                if (receipt.status === 'settings-conflict' || receipt.status === 'conflict') return { status: 'conflict' };
                if (receipt.status !== 'updated') return { status: 'rejected', error: new NotificationChannelCatalogOperationError(receipt.status, receipt) };
                return receipt.settingsVersion === undefined ? { status: 'outcomeUnknown' }
                    : { status: 'applied', settingsVersion: receipt.settingsVersion };
            },
        } });
    if (result?.status !== 'applied') throw new NotificationChannelCatalogOperationError(
        result?.status === 'conflict' ? 'settings-conflict' : 'outcome_unknown', result);
    await publishAcknowledgedNotificationChannelCatalog(account);
}

function requireBuiltin(channels: readonly NotificationChannelRecordV1[]) {
    const builtin = channels.find(channel => channel.id === BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID && channel.kind === 'expo_push');
    if (!builtin) throw new NotificationChannelCatalogOperationError('notification_channel_not_found');
    return builtin;
}

/** Endpoint Actions share the complete catalog CAS; only built-in controls pair finite Settings. */
export function createNotificationConfigurationAction(account: LazyActionAccountContext | null): NonNullable<ActionExecutorDeps['notificationConfigurationAction']> {
    return async ({ actionId, input, context }) => {
        context.signal?.throwIfAborted();
        if (actionId === 'notifications.desktop.permission.read' || actionId === 'notifications.desktop.permission.request') {
            NotificationConfigurationActionInputSchemas[actionId].parse(input);
            if (actionId === 'notifications.desktop.permission.request' && context.authority !== 'present_user') {
                return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
            }
            const { isDesktopHost } = await import('@/utils/platform/desktopHost');
            if (!isDesktopHost()) return { ok: false, errorCode: 'desktop_host_required', error: 'desktop_host_required' };
            const { isPermissionGranted, requestPermission } = await import('@/activity/notifications/channels/tauriNotificationPlugin');
            if (actionId === 'notifications.desktop.permission.request') await requestPermission();
            context.signal?.throwIfAborted();
            return { status: await isPermissionGranted() ? 'granted' : 'notGranted' };
        }
        if (!account) return { ok: false, errorCode: 'action_account_scope_unavailable', error: 'action_account_scope_unavailable' };
        account.assertCurrent();
        const { catalog } = await readNotificationChannelCatalogProjectionInContext(account, context.signal, undefined,
            actionId === 'notifications.expoPush.update' ? record => { requireBuiltin(record.channels); } : undefined);
        if (catalog.status !== 'ready') throw new NotificationChannelCatalogOperationError(
            catalog.status === 'unavailable' ? catalog.reason : 'invalid-stored-content');
        const channels = catalog.channels;
        if (actionId === 'notifications.webhooks.list') {
            account.assertCurrent();
            return { items: channels.flatMap(channel => channel.kind !== 'webhook' ? [] : [{
                channelId: channel.id, url: channel.url, enabled: channel.enabled, signingSecretConfigured: channel.signingSecretRef !== null,
                topics: { ready: channel.topics.ready, permissionRequest: channel.topics.permissionRequest,
                    userActionRequest: channel.topics.userActionRequest },
                readyIncludeMessageText: channel.readyIncludeMessageText, requestIncludeMessageText: channel.requestIncludeMessageText,
            }]) };
        }
        if (actionId === 'notifications.expoPush.update') {
            const { patch } = NotificationConfigurationActionInputSchemas[actionId].parse(input);
            await updateBuiltin(account, channels, catalog.revision, patch, context.signal);
            return { channelId: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID };
        }
        let next: readonly NotificationChannelRecordV1[];
        let channelId: string;
        if (actionId === 'notifications.webhooks.add') {
            const { url } = NotificationConfigurationActionInputSchemas[actionId].parse(input);
            next = addWebhookNotificationChannelRecord({ channels, url });
            const added = next.find(channel => !channels.some(old => old.id === channel.id));
            if (!added) throw new NotificationChannelCatalogOperationError('invalid-stored-content');
            channelId = added.id;
        } else {
            const target = NotificationConfigurationActionInputSchemas[actionId].parse(input);
            channelId = target.channelId;
            const channel = channels.find(row => row.id === channelId && row.kind === 'webhook');
            if (!channel || channel.kind !== 'webhook') return { ok: false, errorCode: 'notification_webhook_not_found', error: 'notification_webhook_not_found' };
            if (actionId === 'notifications.webhooks.signingSecret.set') {
                const { secret } = NotificationConfigurationActionInputSchemas[actionId].parse(input);
                const resource = SavedSecretSchema.parse({ id: randomUUID(), name: 'Webhook signing secret', kind: 'other',
                    encryptedValue: { _isSecretValue: true, value: secret } });
                const { createSavedSecretResourcesWithCatalogMutationInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
                const created = await createSavedSecretResourcesWithCatalogMutationInContext(account, {
                    scope: account.accountLifetime.scope, resources: [resource], referenceScope: 'full',
                    mutateCatalogs: captured => {
                        if (!sameStrictJsonValue(captured.catalogs.notificationChannels, { v: 1, channels })) return { ok: false, reason: 'changed' };
                        const ref = captured.resourceRefs.get(resource.id);
                        if (!ref) return { ok: false, reason: 'unavailable' };
                        return { settings: captured.rawSettings, catalogs: { ...captured.catalogs,
                            notificationChannels: { v: 1, channels: channels.map(row => row === channel ? { ...channel, signingSecretRef: ref } : row) } } };
                    },
                });
                if (!created.ok) throw new NotificationChannelCatalogOperationError(created.reason, created);
                await publishAcknowledgedNotificationChannelCatalog(account);
                return { channelId };
            }
            if (actionId === 'notifications.webhooks.remove') next = channels.filter(row => row !== channel);
            else if (actionId === 'notifications.webhooks.signingSecret.clear') next = channels.map(row => row === channel ? { ...channel, signingSecretRef: null } : row);
            else {
                const { patch } = NotificationConfigurationActionInputSchemas[actionId].parse(input);
                const edited = WebhookNotificationChannelRecordV1Schema.parse({ ...patchChannel(channel, patch),
                    ...(patch.url === undefined ? {} : { url: patch.url }) });
                next = channels.map(row => row === channel ? edited : row);
            }
        }
        const receipt = await writeNotificationChannelCatalogInContext(account, { record: { v: 1, channels: [...next] },
            expectedRevision: catalog.revision }, context.signal);
        requireUpdatedNotificationChannelCatalog(receipt);
        await publishAcknowledgedNotificationChannelCatalog(account);
        return { channelId };
    };
}
