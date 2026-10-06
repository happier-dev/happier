import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { useSettingsSelector } from '@/sync/domains/state/storage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { isExpoPushNotificationChannelEnabled } from '@happier-dev/protocol';
import { deletePushToken, fetchPushTokens, type PushToken } from '@/sync/api/session/apiPush';
import {
    formatPushTimestamp,
    formatPushTokenFingerprint,
    resolvePermissionDetail,
    resolvePermissionSubtitle,
    resolveTokenSubtitle,
} from './pushNotificationTroubleshootingRuntime';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { loadLastRegisteredExpoPushToken } from '@/sync/domains/state/pushTokenRegistration';
import {
    isPushNotificationRuntimeSupported,
    readExpoPushToken,
    readPushPermission,
    type ExpoPushTokenOutcome,
    type PushPermissionOutcome,
} from '@/activity/notifications/permission/pushNotificationAccess';
import { runPushNotificationPermissionPriming } from '@/activity/notifications/permission/pushNotificationPermissionPriming';
import { Icon } from '@/components/ui/icons/Icon';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { NOTIFICATIONS_PUSH_SETTINGS } from '@/components/settings/notifications/notificationsPushSettings';

export const PushNotificationTroubleshootingView = React.memo(function PushNotificationTroubleshootingView() {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const settings = useSettingsSelector((settings) => ({
        attentionDeliveryPolicyV1: settings.attentionDeliveryPolicyV1,
        notificationsSettingsV1: settings.notificationsSettingsV1,
        notificationChannelsV1: settings.notificationChannelsV1,
    }));

    const activeServer = useActiveServerSnapshot();

    const [permission, setPermission] = React.useState<PushPermissionOutcome | null>(null);
    const [tokenOutcome, setTokenOutcome] = React.useState<ExpoPushTokenOutcome | null>(null);
    const [currentToken, setCurrentToken] = React.useState<string | null>(null);
    const [tokens, setTokens] = React.useState<PushToken[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [deletingToken, setDeletingToken] = React.useState<string | null>(null);

    const isMountedRef = React.useRef(true);
    React.useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    // Canonical account-level truth, shared with push-token registration, so this row cannot
    // report a state that the registration path disagrees with.
    const pushEnabled = isExpoPushNotificationChannelEnabled(settings);

    const loadTroubleshootingState = React.useCallback(async (opts?: { showErrors?: boolean }) => {
        const showErrors = opts?.showErrors === true;
        const credentials = auth.credentials;
        if (isMountedRef.current) {
            setLoading(true);
        }
        try {
            // Each of these is individually bounded, so this screen always reaches a terminal,
            // actionable state even when the notification runtime never answers.
            const nextPermission = await readPushPermission();
            const nextTokenOutcome = await readExpoPushToken();
            if (!isMountedRef.current) return;
            setPermission(nextPermission);
            setTokenOutcome(nextTokenOutcome);
            // Fall back to the last registered token so the caller can still identify this device
            // in the registered list while reporting why a live read failed.
            const cachedToken = loadLastRegisteredExpoPushToken()?.trim() ?? '';
            setCurrentToken(nextTokenOutcome.ok ? nextTokenOutcome.token : (cachedToken || null));

            if (credentials?.token) {
                const nextTokens = await fetchPushTokens(credentials);
                if (!isMountedRef.current) return;
                setTokens(nextTokens);
            } else {
                setTokens([]);
            }
        } catch {
            if (showErrors && isMountedRef.current) {
                await Modal.alert(t('common.error'), t('settingsNotifications.pushTroubleshooting.loadError'));
            }
        } finally {
            if (isMountedRef.current) {
                setLoading(false);
            }
        }
    }, [auth.credentials]);

    React.useEffect(() => {
        void loadTroubleshootingState();
    }, [loadTroubleshootingState]);

    const requestPermission = React.useCallback(async () => {
        // Explicit user intent, so the primed flow may ask again even after an earlier decline and
        // may route to system settings when the OS refuses further prompts.
        await runPushNotificationPermissionPriming({ pushEnabled, trigger: 'user_action' });
        await loadTroubleshootingState({ showErrors: true });
    }, [loadTroubleshootingState, pushEnabled]);

    const reregister = React.useCallback(async () => {
        if (!auth.credentials) {
            await Modal.alert(t('common.error'), t('settingsNotifications.pushTroubleshooting.authRequired'));
            return;
        }
        try {
            const { registerPushTokenIfAvailable } = await import('@/sync/engine/account/syncAccount');
            await registerPushTokenIfAvailable({
                log: { log: () => {} },
            });
        } catch {
            await Modal.alert(t('common.error'), t('settingsNotifications.pushTroubleshooting.loadError'));
            return;
        }
        await loadTroubleshootingState({ showErrors: true });
    }, [auth.credentials, loadTroubleshootingState]);

    const handleDeleteToken = React.useCallback(async (token: PushToken) => {
        if (!auth.credentials) {
            await Modal.alert(t('common.error'), t('settingsNotifications.pushTroubleshooting.authRequired'));
            return;
        }
        const fingerprint = formatPushTokenFingerprint(token.token);
        const confirmed = await Modal.confirm(
            t('settingsNotifications.pushTroubleshooting.remove.confirmTitle'),
            t('settingsNotifications.pushTroubleshooting.remove.confirmBody', { fingerprint }),
            {
                cancelText: t('common.cancel'),
                confirmText: t('common.delete'),
                destructive: true,
            },
        );
        if (!confirmed) return;

        setDeletingToken(token.token);
        try {
            await deletePushToken(auth.credentials, token.token);
            await loadTroubleshootingState();
        } catch {
            await Modal.alert(t('common.error'), t('settingsNotifications.pushTroubleshooting.remove.error'));
        } finally {
            setDeletingToken(null);
        }
    }, [auth.credentials, loadTroubleshootingState]);

    const tokenFingerprint = currentToken ? formatPushTokenFingerprint(currentToken) : null;
    const currentTokenPresentOnServer = Boolean(currentToken && tokens.some((row) => row.token === currentToken));
    const permissionDetail = resolvePermissionDetail(permission);
    const permissionSubtitle = resolvePermissionSubtitle(permission);
    const permissionState = permission?.ok ? permission.permission : null;
    const permissionGranted = permissionState?.granted === true;
    // The OS will not ask again: the only way forward is system settings.
    const permissionBlocked = Boolean(permissionState && !permissionState.granted && permissionState.status !== 'unsupported' && !permissionState.canAskAgain);

    const devicesFooter = t('settingsNotifications.pushTroubleshooting.devices.footer', {
        count: String(tokens.length),
        serverUrl: activeServer.serverUrl,
    });

    return (
        <ItemList testID="settings-notifications-push-troubleshooting">
            <SettingsPageHeader description={t('settingsNotifications.pushTroubleshooting.pageDescription')} />
            <ItemGroup
                title={t('settingsNotifications.pushTroubleshooting.status.title')}
                description={t('settingsNotifications.pushTroubleshooting.status.footer')}
                action={(
                    <SettingAnchor setting={NOTIFICATIONS_PUSH_SETTINGS.settings.refresh}>
                        <RoundButton
                            testID="settings-notifications-push-troubleshooting-refresh"
                            size="small"
                            display="inverted"
                            title={t(NOTIFICATIONS_PUSH_SETTINGS.settings.refresh.titleKey)}
                            // Progress is shown without disabling: the recovery action must stay
                            // reachable precisely when a load is misbehaving.
                            leading={loading
                                ? <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                                : <Icon name="arrows-clockwise" size={14} color={theme.colors.text.secondary} />}
                            disabled={!auth.credentials}
                            onPress={() => { void loadTroubleshootingState({ showErrors: true }); }}
                        />
                    </SettingAnchor>
                )}
            >
                <Item
                    title={t('settingsNotifications.pushTroubleshooting.status.accountSettingTitle')}
                    subtitle={pushEnabled
                        ? t('settingsNotifications.pushTroubleshooting.status.accountSettingEnabledSubtitle')
                        : t('settingsNotifications.pushTroubleshooting.status.accountSettingDisabledSubtitle')}
                    detail={pushEnabled ? t('common.enabled') : t('common.disabled')}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    title={t('settingsNotifications.pushTroubleshooting.permission.title')}
                    subtitle={permissionSubtitle}
                    subtitleLines={0}
                    detail={permissionDetail}
                    showChevron={false}
                    loading={loading && permission == null}
                    rightElement={permissionGranted ? undefined : (
                        <RoundButton
                            testID="settings-notifications-push-troubleshooting-request-permission"
                            size="small"
                            display="secondary"
                            title={permissionBlocked
                                ? t('settingsNotifications.pushPriming.openSettings')
                                : t('settingsNotifications.pushTroubleshooting.actions.requestPermissionTitle')}
                            accessibilityHint={t('settingsNotifications.pushTroubleshooting.actions.requestPermissionSubtitle')}
                            disabled={!isPushNotificationRuntimeSupported()}
                            onPress={() => { void requestPermission(); }}
                        />
                    )}
                />
                <Item
                    title={t('settingsNotifications.pushTroubleshooting.token.title')}
                    subtitle={resolveTokenSubtitle(tokenOutcome, tokenFingerprint)}
                    subtitleLines={0}
                    detail={currentTokenPresentOnServer ? t('settingsNotifications.pushTroubleshooting.token.registered') : undefined}
                    showChevron={false}
                    rightElement={(
                        <RoundButton
                            testID="settings-notifications-push-troubleshooting-reregister"
                            size="small"
                            display="secondary"
                            title={t('settingsNotifications.pushTroubleshooting.actions.reregisterTitle')}
                            accessibilityHint={t('settingsNotifications.pushTroubleshooting.actions.reregisterSubtitle')}
                            disabled={!auth.credentials}
                            onPress={() => { void reregister(); }}
                        />
                    )}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsNotifications.pushTroubleshooting.devices.title')}
                description={devicesFooter}
            >
                {tokens.length === 0 ? (
                    <Item
                        title={t('settingsNotifications.pushTroubleshooting.devices.emptyTitle')}
                        subtitle={t('settingsNotifications.pushTroubleshooting.devices.emptySubtitle')}
                        showChevron={false}
                        mode="info"
                        loading={loading}
                    />
                ) : (
                    tokens.map((row) => {
                        const isCurrent = Boolean(currentToken && row.token === currentToken);
                        const fingerprint = formatPushTokenFingerprint(row.token);
                        const subtitle = [
                            row.clientServerUrl ? t('settingsNotifications.pushTroubleshooting.devices.clientServerUrl', { url: row.clientServerUrl }) : null,
                            t('settingsNotifications.pushTroubleshooting.devices.registeredAt', { at: formatPushTimestamp(row.createdAt) }),
                            t('settingsNotifications.pushTroubleshooting.devices.lastSeenAt', { at: formatPushTimestamp(row.updatedAt) }),
                        ].filter(Boolean).join('\n');
                        const removeAction =
                            !isCurrent
                                ? (
                                    <ItemRowActions
                                        title={fingerprint}
                                        compactActionIds={['remove']}
                                        pinnedActionIds={['remove']}
                                        actions={[
                                            {
                                                id: 'remove',
                                                inlineTestID: `settings-notifications-push-troubleshooting-device-${row.id}-remove`,
                                                title: t('common.delete'),
                                                icon: 'trash',
                                                destructive: true,
                                                disabled: deletingToken != null,
                                                onPress: () => { void handleDeleteToken(row); },
                                            },
                                        ]}
                                    />
                                )
                                : null;
                        return (
                            <Item
                                key={row.id}
                                testID={`settings-notifications-push-troubleshooting-device-${row.id}`}
                                title={fingerprint}
                                subtitle={subtitle}
                                subtitleLines={0}
                                detail={isCurrent ? t('settingsNotifications.pushTroubleshooting.devices.thisDevice') : undefined}
                                icon={<Icon name="device-mobile" size={29} color={theme.colors.text.secondary} />}
                                rightElement={removeAction}
                                loading={deletingToken === row.token}
                                disabled={deletingToken != null}
                                showChevron={false}
                            />
                        );
                    })
                )}
            </ItemGroup>
        </ItemList>
    );
});
