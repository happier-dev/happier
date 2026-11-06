import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { useActiveServerAccountScope, useSettingsSelector } from '@/sync/domains/state/storage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { isExpoPushNotificationChannelEnabled } from '@happier-dev/protocol/account/settings/accountSettings';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { NotificationConfigurationActionOutputSchemas, type PushTokenRegistrationDiagnostics } from '@happier-dev/protocol/actions/notificationConfigurationActionFamily';
import {
    formatPushTimestamp,
    formatPushTokenFingerprint,
    resolvePermissionDetail,
    resolvePermissionSubtitle,
    resolveTokenSubtitle,
    resolveTroubleshootingDeviceToken,
} from './pushNotificationTroubleshootingRuntime';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    isPushNotificationRuntimeSupported,
    readExpoPushToken,
    readPushPermission,
    type ExpoPushTokenOutcome,
    type PushPermissionOutcome,
} from '@/activity/notifications/permission/pushNotificationAccess';
import { Icon } from '@/components/ui/icons/Icon';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { NOTIFICATIONS_PUSH_SETTINGS } from '@/components/settings/notifications/notificationsPushSettings';

export const PushNotificationTroubleshootingView = React.memo(function PushNotificationTroubleshootingView() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const auth = useAuth();
    const scope = useActiveServerAccountScope();
    const execution = useMountedActionExecution(scope);
    const settings = useSettingsSelector((settings) => ({
        attentionDeliveryPolicyV1: settings.attentionDeliveryPolicyV1,
        notificationsSettingsV1: settings.notificationsSettingsV1,
    }), ["attentionDeliveryPolicyV1","notificationsSettingsV1"]);

    const activeServer = useActiveServerSnapshot();

    const [permission, setPermission] = React.useState<PushPermissionOutcome | null>(null);
    const [tokenOutcome, setTokenOutcome] = React.useState<ExpoPushTokenOutcome | null>(null);
    const [currentToken, setCurrentToken] = React.useState<string | null>(null);
    const [tokens, setTokens] = React.useState<PushTokenRegistrationDiagnostics[]>([]);
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
        if (isMountedRef.current) {
            setLoading(true);
        }
        try {
            // Each of these is individually bounded, so this screen always reaches a terminal,
            // actionable state even when the notification runtime never answers.
            // Observe failures immediately even if Home retirement makes this result irrelevant;
            // native diagnostics still appear without waiting for the Home's HTTP response.
            const tokenList = auth.credentials ? execution.execute('notifications.push.tokens.list', {}).then(
                response => ({ response }), (error: unknown) => ({ error }),
            ) : null;
            const [nextPermission, nextTokenOutcome] = await Promise.all([readPushPermission(), readExpoPushToken()]);
            if (!isMountedRef.current || !execution.isCurrent()) return;
            setPermission(nextPermission);
            setTokenOutcome(nextTokenOutcome);
            // Fall back to the last registered token so the caller can still identify this device
            // in the registered list while reporting why a live read failed.
            setCurrentToken(resolveTroubleshootingDeviceToken(nextTokenOutcome));

            if (tokenList) {
                const outcome = await tokenList;
                if (!isMountedRef.current || !execution.isCurrent()) return;
                if ('error' in outcome) throw outcome.error;
                if (!outcome.response.ok) throw new Error(outcome.response.error);
                setTokens(NotificationConfigurationActionOutputSchemas['notifications.push.tokens.list'].parse(outcome.response.result).tokens);
            } else {
                setTokens([]);
            }
        } catch {
            if (showErrors && isMountedRef.current && execution.isCurrent()) {
                await Modal.alert(t('common.error'), t('settingsNotifications.pushTroubleshooting.loadError'));
            }
        } finally {
            if (isMountedRef.current && execution.isCurrent()) {
                setLoading(false);
            }
        }
    }, [auth.credentials, execution.execute, execution.isCurrent]);

    React.useEffect(() => { setTokens([]); setDeletingToken(null); }, [scope?.serverId, scope?.accountId]);

    React.useEffect(() => {
        void loadTroubleshootingState();
    }, [loadTroubleshootingState]);

    const requestPermission = React.useCallback(async () => {
        try {
            const result = await execution.execute('notifications.push.permission.request', {});
            if (!result.ok) throw new Error(result.error);
            NotificationConfigurationActionOutputSchemas['notifications.push.permission.request'].parse(result.result);
            if (execution.isCurrent()) await loadTroubleshootingState({ showErrors: true });
        } catch {
            if (execution.isCurrent()) await Modal.alert(t('common.error'), t('settingsNotifications.pushTroubleshooting.loadError'));
        }
    }, [execution.execute, execution.isCurrent, loadTroubleshootingState]);

    const reregister = React.useCallback(async () => {
        if (!auth.credentials) {
            await Modal.alert(t('common.error'), t('settingsNotifications.pushTroubleshooting.authRequired'));
            return;
        }
        try {
            const result = await execution.execute('notifications.push.register', {});
            if (!result.ok) throw new Error(result.error);
            NotificationConfigurationActionOutputSchemas['notifications.push.register'].parse(result.result);
        } catch {
            if (execution.isCurrent()) await Modal.alert(t('common.error'), t('settingsNotifications.pushTroubleshooting.loadError'));
            return;
        }
        if (execution.isCurrent()) await loadTroubleshootingState({ showErrors: true });
    }, [auth.credentials, execution.execute, execution.isCurrent, loadTroubleshootingState]);

    const handleDeleteToken = React.useCallback(async (token: PushTokenRegistrationDiagnostics) => {
        if (!auth.credentials) {
            await Modal.alert(t('common.error'), t('settingsNotifications.pushTroubleshooting.authRequired'));
            return;
        }
        setDeletingToken(token.tokenId);
        try {
            const result = await execution.execute('notifications.push.tokens.remove', { tokenId: token.tokenId });
            if (!result.ok) throw new Error(result.error);
            NotificationConfigurationActionOutputSchemas['notifications.push.tokens.remove'].parse(result.result);
            if (execution.isCurrent()) await loadTroubleshootingState();
        } catch {
            if (execution.isCurrent()) await Modal.alert(t('common.error'), t('settingsNotifications.pushTroubleshooting.remove.error'));
        } finally {
            if (execution.isCurrent()) setDeletingToken(null);
        }
    }, [auth.credentials, execution.execute, execution.isCurrent, loadTroubleshootingState]);

    const tokenFingerprint = currentToken ? formatPushTokenFingerprint(currentToken) : null;
    const currentTokenPresentOnServer = tokens.some(row => row.isCurrentDevice);
    const permissionDetail = resolvePermissionDetail(permission);
    const permissionSubtitle = resolvePermissionSubtitle(permission);
    const permissionState = permission?.ok ? permission.permission : null;
    const permissionGranted = permissionState?.granted === true;
    // The OS will not ask again: the only way forward is system settings.
    const permissionBlocked = Boolean(permissionState && !permissionState.granted && permissionState.status !== 'unsupported' && !permissionState.canAskAgain);

    const devicesFooter = t('settingsNotifications.pushTroubleshooting.devices.footer', {
        count: String(tokens.length),
        serverUrl: scope ? (getServerProfileById(scope.serverId)?.serverUrl ?? '') : activeServer.serverUrl,
    });

    return (
        <ItemList testID="settings-notifications-push-troubleshooting">
            <SettingsPageHeader description={t('settingsNotifications.pushTroubleshooting.pageDescription')} />
            {execution.approval.approvalPending && execution.approval.approvalId && scope ? <ActionApprovalPendingNotice
                message={t('approvals.title')} onOpenApproval={() => router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(execution.approval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} /> : null}
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
                        const isCurrent = row.isCurrentDevice;
                        const fingerprint = row.fingerprint;
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
                                                inlineTestID: `settings-notifications-push-troubleshooting-device-${row.tokenId}-remove`,
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
                                key={row.tokenId}
                                testID={`settings-notifications-push-troubleshooting-device-${row.tokenId}`}
                                title={fingerprint}
                                subtitle={subtitle}
                                subtitleLines={0}
                                detail={isCurrent ? t('settingsNotifications.pushTroubleshooting.devices.thisDevice') : undefined}
                                icon={<Icon name="device-mobile" size={29} color={theme.colors.text.secondary} />}
                                rightElement={removeAction}
                                loading={deletingToken === row.tokenId}
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
