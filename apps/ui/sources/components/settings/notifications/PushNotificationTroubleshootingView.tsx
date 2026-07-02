import * as React from 'react';
import { Linking, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { useSettings } from '@/sync/domains/state/storage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { accountSettingsParse } from '@happier-dev/protocol';
import { deletePushToken, fetchPushTokens, type PushToken } from '@/sync/api/session/apiPush';
import {
    formatPushTimestamp,
    formatPushTokenFingerprint,
    getCurrentExpoPushToken,
    getPushPermissionInfo,
    resolvePermissionDetail,
    resolvePermissionSubtitle,
    type PushPermissionInfo,
} from './pushNotificationTroubleshootingRuntime';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';

export const PushNotificationTroubleshootingView = React.memo(function PushNotificationTroubleshootingView() {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const settings = useSettings();
    const attentionPolicy = React.useMemo(() => {
        return accountSettingsParse(settings).attentionDeliveryPolicyV1;
    }, [settings]);

    const activeServer = useActiveServerSnapshot();

    const [permission, setPermission] = React.useState<PushPermissionInfo | null>(null);
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

    const pushEnabled = attentionPolicy.channels.expo_push.enabled !== false;

    const loadTroubleshootingState = React.useCallback(async (opts?: { showErrors?: boolean }) => {
        const showErrors = opts?.showErrors === true;
        const credentials = auth.credentials;
        if (isMountedRef.current) {
            setLoading(true);
        }
        try {
            const nextPermission = await getPushPermissionInfo();
            const nextToken = await getCurrentExpoPushToken();
            if (!isMountedRef.current) return;
            setPermission(nextPermission);
            setCurrentToken(nextToken);

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
        if (Platform.OS === 'web') {
            return;
        }
        const nextPermission = await getPushPermissionInfo();
        if (nextPermission.granted) {
            setPermission(nextPermission);
            return;
        }
        if (nextPermission.canAskAgain) {
            try {
                const Notifications = await loadExpoNotifications();
                await Notifications.requestPermissionsAsync();
            } catch {
                // ignore
            }
            await loadTroubleshootingState({ showErrors: true });
            return;
        }
        try {
            await Linking.openSettings();
        } catch {
            await Modal.alert(t('common.error'), t('settingsNotifications.pushTroubleshooting.loadError'));
        }
    }, [loadTroubleshootingState]);

    const reregister = React.useCallback(async () => {
        if (!auth.credentials) {
            await Modal.alert(t('common.error'), t('settingsNotifications.pushTroubleshooting.authRequired'));
            return;
        }
        try {
            const { registerPushTokenIfAvailable } = await import('@/sync/engine/account/syncAccount');
            await registerPushTokenIfAvailable({
                credentials: auth.credentials,
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

    const devicesFooter = t('settingsNotifications.pushTroubleshooting.devices.footer', {
        count: String(tokens.length),
        serverUrl: activeServer.serverUrl,
    });

    return (
        <ItemList testID="settings-notifications-push-troubleshooting">
            <ItemGroup
                title={t('settingsNotifications.pushTroubleshooting.status.title')}
                footer={t('settingsNotifications.pushTroubleshooting.status.footer')}
            >
                <Item
                    title={t('settingsNotifications.pushTroubleshooting.status.accountSettingTitle')}
                    subtitle={pushEnabled
                        ? t('settingsNotifications.pushTroubleshooting.status.accountSettingEnabledSubtitle')
                        : t('settingsNotifications.pushTroubleshooting.status.accountSettingDisabledSubtitle')}
                    detail={pushEnabled ? t('common.enabled') : t('common.disabled')}
                    icon={<Ionicons name="options-outline" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    title={t('settingsNotifications.pushTroubleshooting.permission.title')}
                    subtitle={permissionSubtitle}
                    detail={permissionDetail}
                    icon={<Ionicons name="notifications-outline" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    mode="info"
                    loading={loading && permission == null}
                />
                <Item
                    title={t('settingsNotifications.pushTroubleshooting.token.title')}
                    subtitle={tokenFingerprint
                        ? t('settingsNotifications.pushTroubleshooting.token.subtitle', { fingerprint: tokenFingerprint })
                        : t('settingsNotifications.pushTroubleshooting.token.unavailableSubtitle')}
                    detail={currentTokenPresentOnServer ? t('settingsNotifications.pushTroubleshooting.token.registered') : undefined}
                    icon={<Ionicons name="key-outline" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    mode="info"
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsNotifications.pushTroubleshooting.actions.title')}
                footer={t('settingsNotifications.pushTroubleshooting.actions.footer')}
            >
                <Item
                    testID="settings-notifications-push-troubleshooting-request-permission"
                    title={t('settingsNotifications.pushTroubleshooting.actions.requestPermissionTitle')}
                    subtitle={t('settingsNotifications.pushTroubleshooting.actions.requestPermissionSubtitle')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => { void requestPermission(); }}
                    disabled={Platform.OS === 'web'}
                    showChevron={false}
                />
                <Item
                    testID="settings-notifications-push-troubleshooting-reregister"
                    title={t('settingsNotifications.pushTroubleshooting.actions.reregisterTitle')}
                    subtitle={t('settingsNotifications.pushTroubleshooting.actions.reregisterSubtitle')}
                    icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.state.neutral.foreground} />}
                    onPress={() => { void reregister(); }}
                    disabled={!auth.credentials}
                    showChevron={false}
                />
                <Item
                    testID="settings-notifications-push-troubleshooting-refresh"
                    title={t('settingsNotifications.pushTroubleshooting.actions.refreshTitle')}
                    subtitle={t('settingsNotifications.pushTroubleshooting.actions.refreshSubtitle')}
                    icon={<Ionicons name="cloud-download-outline" size={29} color={theme.colors.text.secondary} />}
                    onPress={() => { void loadTroubleshootingState({ showErrors: true }); }}
                    loading={loading}
                    disabled={!auth.credentials}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsNotifications.pushTroubleshooting.devices.title')}
                footer={devicesFooter}
            >
                {tokens.length === 0 ? (
                    <Item
                        title={t('settingsNotifications.pushTroubleshooting.devices.emptyTitle')}
                        subtitle={t('settingsNotifications.pushTroubleshooting.devices.emptySubtitle')}
                        icon={<Ionicons name="phone-portrait-outline" size={29} color={theme.colors.text.secondary} />}
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
                                                icon: 'trash-outline',
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
                                icon={<Ionicons name="phone-portrait-outline" size={29} color={theme.colors.text.secondary} />}
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
