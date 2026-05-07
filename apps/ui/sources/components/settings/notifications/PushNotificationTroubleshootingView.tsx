import * as React from 'react';
import { Linking, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
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
import {
    DEFAULT_NOTIFICATIONS_SETTINGS_V1,
    NotificationsSettingsV1Schema,
    type NotificationsSettingsV1,
} from '@happier-dev/protocol';
import { deletePushToken, fetchPushTokens, type PushToken } from '@/sync/api/session/apiPush';
import { registerPushTokenIfAvailable } from '@/sync/engine/account/syncAccount';
import { loadLastRegisteredExpoPushToken } from '@/sync/domains/state/pushTokenRegistration';

type PushPermissionStatus = 'unsupported' | 'granted' | 'denied' | 'undetermined';
type PushPermissionInfo = Readonly<{
    status: PushPermissionStatus;
    granted: boolean;
    canAskAgain: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatPushTokenFingerprint(token: string): string {
    const raw = token.replace(/^ExponentPushToken\[/, '').replace(/\]$/, '');
    if (raw.length <= 10) return raw;
    return `${raw.slice(0, 5)}…${raw.slice(-5)}`;
}

function formatPushTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
}

function resolveExpoProjectId(): string | null {
    const constants = Constants as unknown;
    if (!isRecord(constants)) return null;

    const expoConfig = isRecord(constants.expoConfig) ? constants.expoConfig : null;
    const extra = expoConfig && isRecord(expoConfig.extra) ? expoConfig.extra : null;
    const easExtra = extra && isRecord(extra.eas) ? extra.eas : null;
    const projectIdFromExpoConfig = easExtra?.projectId;

    const easConfig = isRecord(constants.easConfig) ? constants.easConfig : null;
    const projectIdFromEasConfig = easConfig?.projectId;

    const candidate =
        typeof projectIdFromExpoConfig === 'string'
            ? projectIdFromExpoConfig
            : typeof projectIdFromEasConfig === 'string'
                ? projectIdFromEasConfig
                : null;
    const trimmed = candidate?.trim() ?? '';
    return trimmed ? trimmed : null;
}

async function getPushPermissionInfo(): Promise<PushPermissionInfo> {
    if (Platform.OS === 'web') {
        return { status: 'unsupported', granted: false, canAskAgain: false };
    }

    try {
        const result = await Notifications.getPermissionsAsync();
        const status: PushPermissionStatus =
            result.status === 'granted' || result.status === 'denied' || result.status === 'undetermined'
                ? result.status
                : 'undetermined';
        return {
            status,
            granted: result.granted === true || status === 'granted',
            canAskAgain: result.canAskAgain === true,
        };
    } catch {
        return { status: 'undetermined', granted: false, canAskAgain: false };
    }
}

async function getCurrentExpoPushToken(): Promise<string | null> {
    if (Platform.OS === 'web') return null;

    const projectId = resolveExpoProjectId();
    try {
        const res = projectId
            ? await Notifications.getExpoPushTokenAsync({ projectId })
            : await Notifications.getExpoPushTokenAsync();
        const token = typeof res.data === 'string' ? res.data.trim() : '';
        const cached = loadLastRegisteredExpoPushToken()?.trim() ?? '';
        return token || cached || null;
    } catch {
        const cached = loadLastRegisteredExpoPushToken()?.trim() ?? '';
        return cached || null;
    }
}

function resolvePermissionDetail(permission: PushPermissionInfo | null): string {
    if (!permission) return t('settingsNotifications.pushTroubleshooting.permission.loading');
    if (permission.status === 'unsupported') return t('settingsNotifications.pushTroubleshooting.permission.unsupported');
    if (permission.granted) return t('settingsNotifications.pushTroubleshooting.permission.allowed');
    if (permission.status === 'denied') return t('settingsNotifications.pushTroubleshooting.permission.denied');
    return t('settingsNotifications.pushTroubleshooting.permission.notRequested');
}

function resolvePermissionSubtitle(permission: PushPermissionInfo | null): string {
    if (!permission) return t('settingsNotifications.pushTroubleshooting.permission.loadingSubtitle');
    if (permission.status === 'unsupported') return t('settingsNotifications.pushTroubleshooting.permission.unsupportedSubtitle');
    if (permission.granted) return t('settingsNotifications.pushTroubleshooting.permission.allowedSubtitle');
    if (permission.canAskAgain) return t('settingsNotifications.pushTroubleshooting.permission.canAskAgainSubtitle');
    return t('settingsNotifications.pushTroubleshooting.permission.openSettingsSubtitle');
}

export const PushNotificationTroubleshootingView = React.memo(function PushNotificationTroubleshootingView() {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const settings = useSettings();
    const notificationsRaw = isRecord(settings) ? settings.notificationsSettingsV1 : undefined;
    const notifications: NotificationsSettingsV1 = React.useMemo(() => {
        try {
            return NotificationsSettingsV1Schema.parse(notificationsRaw);
        } catch {
            return DEFAULT_NOTIFICATIONS_SETTINGS_V1;
        }
    }, [notificationsRaw]);

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

    const pushEnabled = notifications.pushEnabled !== false;

    const loadTroubleshootingState = React.useCallback(async (opts?: { showErrors?: boolean }) => {
        const showErrors = opts?.showErrors === true;
        const credentials = auth.credentials;
        if (isMountedRef.current) {
            setLoading(true);
        }
        try {
            const [nextPermission, nextToken] = await Promise.all([
                getPushPermissionInfo(),
                getCurrentExpoPushToken(),
            ]);
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
                    icon={<Ionicons name="options-outline" size={29} color={theme.colors.textSecondary} />}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    title={t('settingsNotifications.pushTroubleshooting.permission.title')}
                    subtitle={permissionSubtitle}
                    detail={permissionDetail}
                    icon={<Ionicons name="notifications-outline" size={29} color={theme.colors.textSecondary} />}
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
                    icon={<Ionicons name="key-outline" size={29} color={theme.colors.textSecondary} />}
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
                    icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.warning} />}
                    onPress={() => { void reregister(); }}
                    disabled={!auth.credentials}
                    showChevron={false}
                />
                <Item
                    testID="settings-notifications-push-troubleshooting-refresh"
                    title={t('settingsNotifications.pushTroubleshooting.actions.refreshTitle')}
                    subtitle={t('settingsNotifications.pushTroubleshooting.actions.refreshSubtitle')}
                    icon={<Ionicons name="cloud-download-outline" size={29} color={theme.colors.textSecondary} />}
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
                        icon={<Ionicons name="phone-portrait-outline" size={29} color={theme.colors.textSecondary} />}
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
                                icon={<Ionicons name="phone-portrait-outline" size={29} color={theme.colors.textSecondary} />}
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
