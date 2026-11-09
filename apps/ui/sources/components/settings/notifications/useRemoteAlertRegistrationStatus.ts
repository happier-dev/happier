import * as React from 'react';
import type { AttentionDeliveryPolicyV1} from '@happier-dev/protocol/account/settings/attentionDeliveryPolicy';
import type { PushTokensRemoteAlertProjectionV2 } from '@happier-dev/protocol/push/pushTokenRegistration';
import { deriveAccountRemoteAlertPolicyV1 } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';

import { readActivityNotificationCapabilities } from '../../../../modules/happier-activity-notifications';
import { resolveDeviceRemoteAlertNativeConsumer } from '@/activity/delivery/deriveDeviceRemoteAlertPolicy';
import { readExpoPushToken } from '@/activity/notifications/permission/pushNotificationAccess';
import { fetchPushTokensRemoteAlertProjection } from '@/sync/api/session/apiPush';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { AttentionDeviceOverridesV1 } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import { getStorage, useSetting } from '@/sync/domains/state/storage';
import { serverFetch } from '@/sync/http/client';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

import type { RemoteAlertRegistrationStatus } from './NotificationRemoteAlertsSection';

type ConfirmedRegistration = Readonly<{
    scope: ServerAccountScope;
    policy: PushTokensRemoteAlertProjectionV2['accountRemoteAlerts'];
    deviceEnrolled: boolean;
}>;

function readCurrentNativeCapabilities() {
    try { return readActivityNotificationCapabilities(); } catch { return null; }
}

/** A read-only view of the incumbent settings/token owners, never a policy or enrollment writer. */
export function useRemoteAlertRegistrationStatus(input: Readonly<{
    enabled: boolean;
    serverId: string;
    accountEnabled: boolean;
    policy: AttentionDeliveryPolicyV1;
    deviceEnabled: boolean;
    deviceOverrides: AttentionDeviceOverridesV1;
}>): Readonly<{ registration: RemoteAlertRegistrationStatus; refresh: () => void }> {
    const scope = useAccountSettingsScope();
    const policyStatus = getStorage()(state => state.settingsRemoteAlertPolicyStatus);
    // Supported older servers omit the optional currentness fact. Only that
    // seam needs the incumbent exact-version re-read.
    const unmarkedSettingsVersion = getStorage()(state => state.settingsRemoteAlertPolicyStatus == null ? state.settingsVersion : null);
    const policySyncPending = getStorage()(state => {
        const status = state.accountSettingsSyncStatus;
        return (status.state === 'retrying' || status.state === 'failed')
            && (status.pendingServerKeys === undefined || status.pendingServerKeys.some(key =>
                key === 'sessionRemoteAlertsEnabled' || key === 'attentionDeliveryPolicyV1' || key === 'machineOfflineAlertsV1'));
    });
    const machineOfflineAlerts = useSetting('machineOfflineAlertsV1');
    const expectsPolicy = React.useMemo(() => deriveAccountRemoteAlertPolicyV1({
        sessionRemoteAlertsEnabled: input.accountEnabled,
        attentionDeliveryPolicyV1: input.policy,
        machineOfflineAlertsV1: machineOfflineAlerts,
    }) !== null, [input.accountEnabled, input.policy, machineOfflineAlerts]);
    const [native, setNative] = React.useState(readCurrentNativeCapabilities);
    const [confirmed, setConfirmed] = React.useState<ConfirmedRegistration | null>(null);
    const [refreshing, setRefreshing] = React.useState(false);
    const requestRef = React.useRef<AbortController | null>(null);

    const refresh = React.useCallback(() => {
        requestRef.current?.abort();
        if (!input.enabled) {
            setConfirmed(null);
            setRefreshing(false);
            return;
        }
        const controller = new AbortController();
        requestRef.current = controller;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!scope || !areServerProfileIdentifiersEquivalent(scope.serverId, input.serverId)
            || !lifetime?.isCurrent() || !areServerAccountScopesEqual(scope, lifetime.scope)) {
            setConfirmed(null);
            setRefreshing(false);
            return;
        }
        // Native support can become available after this hook mounts when the Activity
        // environment finishes preparing. Refresh is the incumbent re-probe boundary.
        setNative(readCurrentNativeCapabilities());
        const retirement = lifetime.onRetire(() => controller.abort());
        setRefreshing(true);
        void (async () => {
            try {
                const projection = await runWithServerRequestAuthorityForServerAccountScope({ scope, activeRequest: serverFetch }, async (authority) => (
                    fetchPushTokensRemoteAlertProjection({ token: authority.context.token }, (path, init) => authority.request(path, {
                        ...init, signal: controller.signal,
                    }))
                ));
                if (controller.signal.aborted || !lifetime.isCurrent()) return;
                const refreshedNative = readCurrentNativeCapabilities();
                setNative(refreshedNative);
                const token = refreshedNative && projection ? await readExpoPushToken() : null;
                if (controller.signal.aborted || !lifetime.isCurrent()) return;
                const nativeConsumer = refreshedNative ? resolveDeviceRemoteAlertNativeConsumer(refreshedNative) : null;
                const deviceEnrolled = Boolean(refreshedNative && token?.ok && projection?.tokens.some((row) => (
                    row.token === token.token && row.remoteAlerts?.enabled === true && row.remoteAlerts.nativeConsumer === nativeConsumer
                )));
                setConfirmed(projection ? { scope, policy: projection.accountRemoteAlerts, deviceEnrolled } : null);
            } catch {
                if (!controller.signal.aborted && lifetime.isCurrent()) setConfirmed(null);
            } finally {
                retirement.dispose();
                if (!controller.signal.aborted) setRefreshing(false);
            }
        })();
    }, [scope, input.enabled, input.serverId]);

    React.useEffect(() => {
        refresh();
        return () => requestRef.current?.abort();
    }, [refresh, unmarkedSettingsVersion, input.accountEnabled, input.policy, machineOfflineAlerts, input.deviceEnabled, input.deviceOverrides]);

    const current = confirmed && areServerAccountScopesEqual(confirmed.scope, scope)
        && areServerProfileIdentifiersEquivalent(confirmed.scope.serverId, input.serverId) ? confirmed : null;
    const pending = policySyncPending || Boolean(current && expectsPolicy !== ((policyStatus ?? current.policy.status) !== 'disabled'));
    const accountPolicy = !current ? (refreshing ? 'loading' : 'unavailable')
        : pending ? 'pending' : policyStatus ?? current.policy.status;
    const deviceEnrollment: RemoteAlertRegistrationStatus['deviceEnrollment'] = !native
        ? 'unavailable'
        : !current
            ? (refreshing ? 'loading' : 'unavailable')
            : input.deviceEnabled !== current.deviceEnrolled
                ? (input.deviceEnabled ? 'enrolling' : 'removing')
                : input.deviceEnabled ? 'enrolled' : 'disabled';

    return {
        registration: input.enabled ? {
            accountPolicy,
            supported: current !== null,
            nativeAvailable: native !== null,
            deviceEnrollment,
            refreshing,
        } : {
            accountPolicy: 'unavailable',
            supported: false,
            nativeAvailable: native !== null,
            deviceEnrollment: 'unavailable',
            refreshing: false,
        },
        refresh,
    };
}
