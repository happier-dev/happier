import { t } from '@/text';

import type {
    ExpoPushTokenOutcome,
    PushPermissionOutcome,
} from '@/activity/notifications/permission/pushNotificationAccess';

export function formatPushTokenFingerprint(token: string): string {
    const raw = token.replace(/^ExponentPushToken\[/, '').replace(/\]$/, '');
    if (raw.length <= 10) return raw;
    return `${raw.slice(0, 5)}…${raw.slice(-5)}`;
}

export function formatPushTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
}

/**
 * The status rows must distinguish "still checking", "the notification runtime could not answer",
 * and "the OS or this device says no". Collapsing those into one message made this screen
 * undiagnosable: an unreachable runtime looked identical to a denied permission.
 *
 * Reading the runtime itself belongs to `@/activity/notifications/permission/pushNotificationAccess`,
 * which is shared with push-token registration so both sides agree on permission and token state.
 */
export function resolvePermissionDetail(outcome: PushPermissionOutcome | null): string {
    if (!outcome) return t('settingsNotifications.pushTroubleshooting.permission.loading');
    if (!outcome.ok) return t('settingsNotifications.pushTroubleshooting.permission.runtimeUnavailable');
    const permission = outcome.permission;
    if (permission.status === 'unsupported') return t('settingsNotifications.pushTroubleshooting.permission.unsupported');
    if (permission.granted) return t('settingsNotifications.pushTroubleshooting.permission.allowed');
    if (permission.status === 'denied') return t('settingsNotifications.pushTroubleshooting.permission.denied');
    return t('settingsNotifications.pushTroubleshooting.permission.notRequested');
}

export function resolvePermissionSubtitle(outcome: PushPermissionOutcome | null): string {
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

export function resolveTokenSubtitle(outcome: ExpoPushTokenOutcome | null, fingerprint: string | null): string {
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
        return t('settingsNotifications.pushTroubleshooting.token.deviceUnavailableSubtitle');
    }
    return t('settingsNotifications.pushTroubleshooting.token.unavailableSubtitle');
}
