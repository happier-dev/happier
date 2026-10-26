import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { useSettings, useActiveServerAccountScope, useMachineListByServerId } from '@/sync/domains/state/storage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { isExpoPushNotificationChannelEnabled, PushNotificationTestResultSchema } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { parseToken } from '@/utils/auth/parseToken';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { deletePushToken, fetchPushTokens, type PushToken } from '@/sync/api/session/apiPush';
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

/**
 * The status rows must distinguish "still checking", "the notification runtime could not answer",
 * and "the OS or this device says no". Collapsing those into one message is what made this screen
 * undiagnosable: an unreachable runtime looked identical to a denied permission.
 */
function resolvePermissionDetail(outcome: PushPermissionOutcome | null): string {
    if (!outcome) return t('settingsNotifications.pushTroubleshooting.permission.loading');
    if (!outcome.ok) return t('settingsNotifications.pushTroubleshooting.permission.runtimeUnavailable');
    const permission = outcome.permission;
    if (permission.status === 'unsupported') return t('settingsNotifications.pushTroubleshooting.permission.unsupported');
    if (permission.granted) return t('settingsNotifications.pushTroubleshooting.permission.allowed');
    if (permission.status === 'denied') return t('settingsNotifications.pushTroubleshooting.permission.denied');
    return t('settingsNotifications.pushTroubleshooting.permission.notRequested');
}

function resolvePermissionSubtitle(outcome: PushPermissionOutcome | null): string {
    if (!outcome) return t('settingsNotifications.pushTroubleshooting.permission.loadingSubtitle');
    if (!outcome.ok) {
        return outcome.reason === 'runtime_timeout'
            ? t('settingsNotifications.pushTroubleshooting.permission.runtimeTimeoutSubtitle')
            : t('settingsNotifications.pushTroubleshooting.permission.runtimeUnavailableSubtitle');
    }
    const permission = outcome.permission;
    if (permission.status === 'unsupported') return t('settingsNotifications.pushTroubleshooting.permission.unsupportedSubtitle');
    if (permission.granted) return t('settingsNotifications.pushTroubleshooting.permission.allowedSubtitle');
    if (permission.canAskAgain) return t('settingsNotifications.pushTroubleshooting.permission.canAskAgainSubtitle');
    return t('settingsNotifications.pushTroubleshooting.permission.openSettingsSubtitle');
}

function resolveTokenSubtitle(outcome: ExpoPushTokenOutcome | null, fingerprint: string | null): string {
    if (!outcome) return t('settingsNotifications.pushTroubleshooting.token.checkingSubtitle');
    if (outcome.ok && fingerprint) {
        return t('settingsNotifications.pushTroubleshooting.token.subtitle', { fingerprint });
    }
    if (!outcome.ok) {
        if (outcome.reason === 'runtime_timeout') {
            return t('settingsNotifications.pushTroubleshooting.token.runtimeTimeoutSubtitle');
        }
        if (outcome.reason === 'runtime_unavailable') {
            return t('settingsNotifications.pushTroubleshooting.token.runtimeUnavailableSubtitle');
        }
        const subtitle = t('settingsNotifications.pushTroubleshooting.token.deviceUnavailableSubtitle');
        return outcome.reason === 'token_unavailable' && outcome.message
            ? `${subtitle}\n${outcome.message}`
            : subtitle;
    }
    return t('settingsNotifications.pushTroubleshooting.token.unavailableSubtitle');
}

export const PushNotificationTroubleshootingView = React.memo(function PushNotificationTroubleshootingView() {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const settings = useSettings();

    const activeServer = useActiveServerSnapshot();
    const accountScope = useActiveServerAccountScope();
    const machinesByServerId = useMachineListByServerId();

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

    // Canonical account-level truth, shared with push-token registration, so this row cannot report
    // a state that the registration path disagrees with.
    const pushEnabled = isExpoPushNotificationChannelEnabled(isRecord(settings) ? settings : {});

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

    const testRemotePush = async () => {
        const notify = (message: string) => Modal.alert(t('settingsNotifications.pushTroubleshooting.remoteTest.title'), message);
        if (!currentToken || !tokens.some((row) => row.token === currentToken)) {
            await notify(t('settingsNotifications.pushTroubleshooting.remoteTest.notRegistered'));
            return;
        }
        // Capture the user's target before the first await. A Home/Account switch while
        // fetching registrations must not redirect this external side effect.
        const credentials = auth.credentials;
        const scope = accountScope;
        const serverUrl = activeServer.serverUrl;
        const deviceToken = currentToken;
        let authenticatedAccountId: string | null = null;
        try { authenticatedAccountId = credentials ? parseToken(credentials.token) : null; } catch { /* reported below */ }
        if (!credentials || !scope || authenticatedAccountId !== scope.accountId
            || !areServerProfileIdentifiersEquivalent(scope.serverId, activeServer.serverId)) {
            await notify(t('settingsNotifications.pushTroubleshooting.authRequired'));
            return;
        }
        const machine = (machinesByServerId[scope.serverId] ?? []).find((candidate) => isMachineOnline(candidate));
        if (!machine) {
            await notify(t('settingsNotifications.pushTroubleshooting.remoteTest.noMachine'));
            return;
        }
        try {
            const registrations = await fetchPushTokens(credentials, { apiEndpoint: serverUrl });
            const registration = registrations.find((row) => row.token === deviceToken);
            if (!registration) {
                await notify(t('settingsNotifications.pushTroubleshooting.remoteTest.notRegistered'));
                return;
            }
            const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
            const raw = await machineRpcWithServerScope<unknown, { tokenId: string }>({
                machineId: machine.id,
                serverId: scope.serverId,
                accountId: scope.accountId,
                method: RPC_METHODS.DAEMON_NOTIFICATIONS_TEST_PUSH,
                payload: { tokenId: registration.id },
                // This is an outward write: never retry automatically after emission.
                onIssued: () => {},
            });
            const result = PushNotificationTestResultSchema.safeParse(raw);
            if (!result.success) throw raw;
            const messages = {
                accepted: t('settingsNotifications.pushTroubleshooting.remoteTest.accepted'),
                not_registered: t('settingsNotifications.pushTroubleshooting.remoteTest.notRegistered'),
                rejected: t('settingsNotifications.pushTroubleshooting.remoteTest.rejected'),
                invalid_credentials: t('settingsNotifications.pushTroubleshooting.remoteTest.invalidCredentials'),
            };
            await notify(messages[result.data.status]);
        } catch (error) {
            const code = readRpcErrorCode(error);
            await notify(code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE || code === RPC_ERROR_CODES.METHOD_NOT_FOUND
                ? t('settingsNotifications.pushTroubleshooting.remoteTest.unsupported')
                : t('settingsNotifications.pushTroubleshooting.remoteTest.unconfirmed'));
        }
    };

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
                    title={t('settingsNotifications.pushTroubleshooting.remoteTest.title')}
                    subtitle={t('settingsNotifications.pushTroubleshooting.remoteTest.subtitle')}
                    subtitleLines={0}
                    icon={<Icon name="paper-plane-tilt" size={29} color={theme.colors.accent.blue} />}
                    rightElement={<RoundButton
                        testID="settings-notifications-push-troubleshooting-test-remote"
                        title={t('common.send')}
                        size="small"
                        display="inverted"
                        disabled={!isPushNotificationRuntimeSupported()}
                        action={testRemotePush}
                    />}
                    showChevron={false}
                />
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
