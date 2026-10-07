import * as React from 'react';

import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useNavigation } from '@/components/appShell/workspace/destinationRoute';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import {
    hasConfiguredSecretStringValue,
    WebhookNotificationChannelV1Schema,
    type NotificationChannelV1,
    type WebhookNotificationChannelV1,
} from '@happier-dev/protocol/account/settings/notificationChannels';

import {
    addWebhookNotificationChannel,
    removeNotificationChannelById,
    updateNotificationChannelById,
} from './notificationChannels';

type NotificationWebhooksSectionProps = Readonly<{
    webhookChannels: ReadonlyArray<WebhookNotificationChannelV1>;
    setWebhookChannels: (nextChannels: ReadonlyArray<NotificationChannelV1>) => void;
}>;

export function NotificationWebhooksSection(props: NotificationWebhooksSectionProps): React.ReactElement {
    const scope = useAccountSettingsScope();
    // Draft URLs and secrets belong to the Account that opened the editor.
    return <AccountNotificationWebhooksSection key={scope ? accountSettingsScopeKeySuffix(scope) : 'unbound'} {...props} />;
}

function AccountNotificationWebhooksSection({
    webhookChannels,
    setWebhookChannels,
}: NotificationWebhooksSectionProps): React.ReactElement {
    const { theme } = useUnistyles();
    const navigation = useNavigation();
    // A webhook's settings open in place; a newly added one opens so it can be configured.
    const [expandedChannelId, setExpandedChannelId] = React.useState<string | null>(null);
    const [addingWebhook, setAddingWebhook] = React.useState(false);
    const [newUrlDirty, setNewUrlDirty] = React.useState(false);
    const [editingUrlChannelId, setEditingUrlChannelId] = React.useState<string | null>(null);
    const [editedUrlDirty, setEditedUrlDirty] = React.useState(false);
    const [editingSecretChannelId, setEditingSecretChannelId] = React.useState<string | null>(null);
    const [secretDraft, setSecretDraft] = React.useState('');
    const closeSecretEditor = () => {
        setSecretDraft('');
        setEditingSecretChannelId(null);
    };
    const closeUrlEditor = () => {
        setEditingUrlChannelId(null);
        setEditedUrlDirty(false);
    };
    const discardDrafts = () => {
        setAddingWebhook(false);
        setNewUrlDirty(false);
        closeUrlEditor();
        closeSecretEditor();
    };
    useUnsavedDraftNavigationGuard({ navigation,
        isDirty: newUrlDirty || editedUrlDirty || secretDraft !== '',
        onDiscard: discardDrafts, tag: 'notification-webhook-draft' });

    const handleAddWebhook = (url: string) => {
        const nextChannels = addWebhookNotificationChannel({
            channels: webhookChannels,
            url,
        });
        setWebhookChannels(nextChannels);
        const added = nextChannels.find((channel) => !webhookChannels.some((existing) => existing.id === channel.id));
        if (added) setExpandedChannelId(added.id);
        setAddingWebhook(false);
        setNewUrlDirty(false);
    };

    const handleEditWebhook = (channel: WebhookNotificationChannelV1, url: string) => {
        setWebhookChannels(updateNotificationChannelById({
            channels: webhookChannels,
            channelId: channel.id,
            patch: { url },
        }));
        closeUrlEditor();
    };

    const handleDeleteWebhook = React.useCallback(async (channel: WebhookNotificationChannelV1) => {
        const confirmed = await Modal.confirm(
            t('settingsNotifications.webhooks.deleteTitle'),
            t('settingsNotifications.webhooks.deleteConfirm', { url: channel.url }),
            {
                cancelText: t('common.cancel'),
                confirmText: t('common.delete'),
                destructive: true,
            },
        );
        if (!confirmed) {
            return;
        }

        setWebhookChannels(removeNotificationChannelById({
            channels: webhookChannels,
            channelId: channel.id,
        }));
    }, [setWebhookChannels, webhookChannels]);

    const handleSetWebhookSigningSecret = (channel: WebhookNotificationChannelV1) => {
        const nextSecret = secretDraft.trim();
        if (!nextSecret) return;
        setWebhookChannels(updateNotificationChannelById({
            channels: webhookChannels,
            channelId: channel.id,
            patch: { signingSecret: { _isSecretValue: true, value: nextSecret } },
        }));
        closeSecretEditor();
    };

    const handleClearWebhookSigningSecret = React.useCallback(async (channel: WebhookNotificationChannelV1) => {
        const confirmed = await Modal.confirm(
            t('settingsNotifications.webhooks.signingSecretClearAction'),
            t('settingsNotifications.webhooks.signingSecretEmptySubtitle'),
            {
                cancelText: t('common.cancel'),
                confirmText: t('settingsNotifications.webhooks.signingSecretClearAction'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        setWebhookChannels(updateNotificationChannelById({
            channels: webhookChannels,
            channelId: channel.id,
            patch: { signingSecret: null },
        }));
    }, [setWebhookChannels, webhookChannels]);

    const renderTopicSwitch = (
        channel: WebhookNotificationChannelV1,
        titleKey: 'readyTitle' | 'readyPreviewTitle' | 'requestPreviewTitle' | 'permissionRequestsTitle' | 'userActionsTitle',
        subtitleKey: 'readySubtitle' | 'readyPreviewSubtitle' | 'requestPreviewSubtitle' | 'permissionRequestsSubtitle' | 'userActionsSubtitle',
        value: boolean,
        disabled: boolean,
        patch: (enabled: boolean) => Partial<WebhookNotificationChannelV1>,
    ) => (
        <Item
            key={titleKey}
            testID={`settings-notifications-webhook-${channel.id}-${titleKey}`}
            title={t(`settingsNotifications.webhooks.${titleKey}`)}
            subtitle={t(`settingsNotifications.webhooks.${subtitleKey}`)}
            rightElement={(
                <Switch
                    value={value}
                    disabled={disabled}
                    onValueChange={(next) => setWebhookChannels(updateNotificationChannelById({
                        channels: webhookChannels,
                        channelId: channel.id,
                        patch: patch(Boolean(next)),
                    }))}
                />
            )}
            showChevron={false}
        />
    );

    return (
        <ItemGroup
            title={t('settingsNotifications.webhooks.title')}
            description={t('settingsNotifications.webhooks.footer')}
            action={(
                <SettingAnchor setting={NOTIFICATIONS_SETTINGS.settings.addWebhook}>
                    <RoundButton
                        testID="settings-notifications-add-webhook"
                        size="small"
                        display="inverted"
                        title={t(NOTIFICATIONS_SETTINGS.settings.addWebhook.titleKey)}
                        leading={<Icon name="plus" size={14} color={theme.colors.text.secondary} />}
                        disabled={addingWebhook}
                        onPress={() => setAddingWebhook(true)}
                    />
                </SettingAnchor>
            )}
        >
            {addingWebhook ? (
                <WebhookUrlEditor
                    testID="settings-notifications-webhook-new-url"
                    initialUrl=""
                    onDirtyChange={setNewUrlDirty}
                    onSave={handleAddWebhook}
                    onCancel={() => { setAddingWebhook(false); setNewUrlDirty(false); }}
                />
            ) : null}
            {webhookChannels.length === 0 && !addingWebhook ? (
                <Item
                    title={t('settingsNotifications.webhooks.emptyTitle')}
                    subtitle={t('settingsNotifications.webhooks.emptySubtitle')}
                    subtitleLines={0}
                    mode="info"
                    showChevron={false}
                />
            ) : (
                webhookChannels.map((channel) => {
                    const channelEnabled = channel.enabled !== false;
                    const secretConfigured = hasConfiguredSecretStringValue(channel.signingSecret);
                    return (
                        <ExpandableItem
                            key={channel.id}
                            testID={`settings-notifications-webhook-${channel.id}-row`}
                            expanded={expandedChannelId === channel.id}
                            onExpandedChange={(next) => {
                                void runGuardedNavigation(() => {
                                    setExpandedChannelId(next ? channel.id : null);
                                    closeUrlEditor();
                                    closeSecretEditor();
                                });
                            }}
                            header={({ headerProps }) => (
                                <Item
                                    {...headerProps}
                                    testID={`settings-notifications-webhook-${channel.id}`}
                                    title={channel.url}
                                    subtitle={channelEnabled
                                        ? t('settingsNotifications.webhooks.enabledSubtitle')
                                        : t('settingsNotifications.webhooks.disabledSubtitle')}
                                />
                            )}
                        >
                            <Item
                                testID={`settings-notifications-webhook-${channel.id}-enabled`}
                                title={t('settingsNotifications.webhooks.enabledTitle')}
                                subtitle={t('settingsNotifications.webhooks.channelEnabledSubtitle')}
                                rightElement={(
                                    <Switch
                                        value={channelEnabled}
                                        onValueChange={(value) => setWebhookChannels(updateNotificationChannelById({
                                            channels: webhookChannels,
                                            channelId: channel.id,
                                            patch: { enabled: Boolean(value) },
                                        }))}
                                    />
                                )}
                                showChevron={false}
                            />
                            {editingUrlChannelId === channel.id ? (
                                <WebhookUrlEditor
                                    testID={`settings-notifications-webhook-${channel.id}-url`}
                                    initialUrl={channel.url}
                                    onDirtyChange={setEditedUrlDirty}
                                    onSave={(url) => handleEditWebhook(channel, url)}
                                    onCancel={closeUrlEditor}
                                />
                            ) : <Item
                                title={t('settingsNotifications.webhooks.urlPromptTitle')}
                                subtitle={channel.url}
                                showChevron={false}
                                rightElement={(
                                    <RoundButton
                                        testID={`settings-notifications-webhook-${channel.id}-edit`}
                                        size="small"
                                        display="inverted"
                                        title={t('common.edit')}
                                        onPress={() => setEditingUrlChannelId(channel.id)}
                                    />
                                )}
                            />}
                            <Item
                                testID={`settings-notifications-webhook-${channel.id}-signing-secret`}
                                title={t('settingsNotifications.webhooks.signingSecretTitle')}
                                subtitle={secretConfigured
                                    ? t('settingsNotifications.webhooks.signingSecretConfiguredSubtitle')
                                    : t('settingsNotifications.webhooks.signingSecretEmptySubtitle')}
                                showChevron={false}
                                accessoryLayout="adaptive"
                                rightElement={(
                                    editingSecretChannelId === channel.id ? (
                                        <FieldTextInput
                                            testID={`settings-notifications-webhook-${channel.id}-secret-input`}
                                            accessibilityLabel={t('settingsNotifications.webhooks.signingSecretTitle')}
                                            placeholder={t('settingsNotifications.webhooks.signingSecretPromptPlaceholder')}
                                            value={secretDraft}
                                            onChangeText={setSecretDraft}
                                            onSubmitEditing={() => handleSetWebhookSigningSecret(channel)}
                                            secureTextEntry
                                            autoComplete="off"
                                            autoFocus
                                        />
                                    ) : (
                                    <View style={{ flexDirection: 'row', gap: 8 }}>
                                        {secretConfigured ? (
                                            <RoundButton
                                                testID={`settings-notifications-webhook-${channel.id}-clear-secret`}
                                                size="small"
                                                display="inverted"
                                                title={t('settingsNotifications.webhooks.signingSecretClearAction')}
                                                onPress={() => { void handleClearWebhookSigningSecret(channel); }}
                                            />
                                        ) : null}
                                        <RoundButton
                                            testID={`settings-notifications-webhook-${channel.id}-set-secret`}
                                            size="small"
                                            display="secondary"
                                            title={secretConfigured
                                                ? t('settingsNotifications.webhooks.signingSecretReplaceAction')
                                                : t('settingsNotifications.webhooks.signingSecretAddAction')}
                                            onPress={() => {
                                                setSecretDraft('');
                                                setEditingSecretChannelId(channel.id);
                                            }}
                                        />
                                    </View>
                                    )
                                )}
                            />
                            {editingSecretChannelId === channel.id ? (
                                <SectionContentRow continuesRow>
                                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
                                        <RoundButton
                                            testID={`settings-notifications-webhook-${channel.id}-secret-cancel`}
                                            size="small"
                                            display="secondary"
                                            title={t('common.cancel')}
                                            onPress={closeSecretEditor}
                                        />
                                        <RoundButton
                                            testID={`settings-notifications-webhook-${channel.id}-secret-save`}
                                            size="small"
                                            title={t('common.save')}
                                            disabled={!secretDraft.trim()}
                                            onPress={() => handleSetWebhookSigningSecret(channel)}
                                        />
                                    </View>
                                </SectionContentRow>
                            ) : null}
                            {renderTopicSwitch(channel, 'readyTitle', 'readySubtitle',
                                channel.topics.ready !== false,
                                !channelEnabled,
                                (enabled) => ({ topics: { ...channel.topics, ready: enabled } }))}
                            {renderTopicSwitch(channel, 'readyPreviewTitle', 'readyPreviewSubtitle',
                                channel.readyIncludeMessageText !== false,
                                !channelEnabled || channel.topics.ready === false,
                                (enabled) => ({ readyIncludeMessageText: enabled }))}
                            {renderTopicSwitch(channel, 'requestPreviewTitle', 'requestPreviewSubtitle',
                                channel.requestIncludeMessageText === true,
                                !channelEnabled || (channel.topics.permissionRequest === false && channel.topics.userActionRequest === false),
                                (enabled) => ({ requestIncludeMessageText: enabled }))}
                            {renderTopicSwitch(channel, 'permissionRequestsTitle', 'permissionRequestsSubtitle',
                                channel.topics.permissionRequest !== false,
                                !channelEnabled,
                                (enabled) => ({ topics: { ...channel.topics, permissionRequest: enabled } }))}
                            {renderTopicSwitch(channel, 'userActionsTitle', 'userActionsSubtitle',
                                channel.topics.userActionRequest !== false,
                                !channelEnabled,
                                (enabled) => ({ topics: { ...channel.topics, userActionRequest: enabled } }))}
                            <SectionContentRow showDivider={false}>
                                <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                                    <RoundButton
                                        testID={`settings-notifications-webhook-${channel.id}-delete`}
                                        size="small"
                                        display="destructive"
                                        title={t('settingsNotifications.webhooks.deleteTitle')}
                                        onPress={() => { void handleDeleteWebhook(channel); }}
                                    />
                                </View>
                            </SectionContentRow>
                        </ExpandableItem>
                    );
                })
            )}
        </ItemGroup>
    );
}

/** Creation and replacement share the same inline URL editor and validation. */
function WebhookUrlEditor(props: Readonly<{
    testID: string;
    initialUrl: string;
    onDirtyChange: (dirty: boolean) => void;
    onSave: (url: string) => void;
    onCancel: () => void;
}>) {
    const [draft, setDraft] = React.useState(props.initialUrl);
    const [error, setError] = React.useState<string | null>(null);
    const save = () => {
        const url = draft.trim();
        if (!url) return;
        if (!WebhookNotificationChannelV1Schema.shape.url.safeParse(url).success) {
            setError(t('settingsNotifications.webhooks.invalidUrlSubtitle'));
            return;
        }
        props.onSave(url);
    };
    return (
        <>
            <Item
                title={t('settingsNotifications.webhooks.urlPromptTitle')}
                subtitle={t('settingsNotifications.webhooks.urlPromptSubtitle')}
                showChevron={false}
                accessoryLayout="adaptive"
                rightElement={(
                    <FieldTextInput
                        testID={props.testID}
                        accessibilityLabel={t('settingsNotifications.webhooks.urlPromptTitle')}
                        placeholder={t('settingsNotifications.webhooks.urlPromptPlaceholder')}
                        value={draft}
                        onChangeText={(next) => { setDraft(next); props.onDirtyChange(next !== props.initialUrl); setError(null); }}
                        onSubmitEditing={save}
                        error={error}
                        autoFocus
                    />
                )}
            />
            <SectionContentRow continuesRow>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
                    <RoundButton testID={`${props.testID}-cancel`} size="small" display="secondary" title={t('common.cancel')} onPress={props.onCancel} />
                    <RoundButton testID={`${props.testID}-save`} size="small" title={props.initialUrl ? t('common.save') : t('common.add')} disabled={!draft.trim()} onPress={save} />
                </View>
            </SectionContentRow>
        </>
    );
}
