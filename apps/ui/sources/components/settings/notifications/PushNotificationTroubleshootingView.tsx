import * as React from 'react';
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

export const PushNotificationTroubleshootingView = React.memo(function PushNotificationTroubleshootingView() {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const settings = useSettings();

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
                    icon={<Icon name="sliders-horizontal" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    title={t('settingsNotifications.pushTroubleshooting.permission.title')}
                    subtitle={permissionSubtitle}
                    detail={permissionDetail}
                    icon={<Icon name="bell" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    mode="info"
                    loading={loading && permission == null}
                />
                <Item
                    title={t('settingsNotifications.pushTroubleshooting.token.title')}
                    subtitle={resolveTokenSubtitle(tokenOutcome, tokenFingerprint)}
                    subtitleLines={0}
                    detail={currentTokenPresentOnServer ? t('settingsNotifications.pushTroubleshooting.token.registered') : undefined}
                    icon={<Icon name="key" size={29} color={theme.colors.text.secondary} />}
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
                    icon={<Icon name="shield-check" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => { void requestPermission(); }}
                    disabled={!isPushNotificationRuntimeSupported()}
                    showChevron={false}
                />
                <Item
                    testID="settings-notifications-push-troubleshooting-reregister"
                    title={t('settingsNotifications.pushTroubleshooting.actions.reregisterTitle')}
                    subtitle={t('settingsNotifications.pushTroubleshooting.actions.reregisterSubtitle')}
                    icon={<Icon name="arrow-clockwise" size={29} color={theme.colors.state.neutral.foreground} />}
                    onPress={() => { void reregister(); }}
                    disabled={!auth.credentials}
                    showChevron={false}
                />
                <Item
                    testID="settings-notifications-push-troubleshooting-refresh"
                    title={t('settingsNotifications.pushTroubleshooting.actions.refreshTitle')}
                    subtitle={t('settingsNotifications.pushTroubleshooting.actions.refreshSubtitle')}
                    icon={<Icon name="cloud-arrow-down" size={29} color={theme.colors.text.secondary} />}
                    onPress={() => { void loadTroubleshootingState({ showErrors: true }); }}
                    // Progress is shown without `loading`, which would also disable the row: the
                    // recovery action must stay reachable precisely when a load is misbehaving.
                    rightElement={loading
                        ? <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                        : undefined}
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
                        icon={<Icon name="device-mobile" size={29} color={theme.colors.text.secondary} />}
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
