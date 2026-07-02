import { Platform } from 'react-native';
import Constants from 'expo-constants';

import { loadLastRegisteredExpoPushToken } from '@/sync/domains/state/pushTokenRegistration';
import { t } from '@/text';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';

export type PushPermissionStatus = 'unsupported' | 'granted' | 'denied' | 'undetermined';
export type PushPermissionInfo = Readonly<{
    status: PushPermissionStatus;
    granted: boolean;
    canAskAgain: boolean;
}>;
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formatPushTokenFingerprint(token: string): string {
    const raw = token.replace(/^ExponentPushToken\[/, '').replace(/\]$/, '');
    if (raw.length <= 10) return raw;
    return `${raw.slice(0, 5)}…${raw.slice(-5)}`;
}

export function formatPushTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
}

function resolveExpoProjectId(): string | null {
    try {
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
    } catch {
        return null;
    }
}

export async function getPushPermissionInfo(): Promise<PushPermissionInfo> {
    if (Platform.OS === 'web') {
        return { status: 'unsupported', granted: false, canAskAgain: false };
    }

    try {
        const Notifications = await loadExpoNotifications();
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

export async function getCurrentExpoPushToken(): Promise<string | null> {
    if (Platform.OS === 'web') return null;

    const projectId = resolveExpoProjectId();
    try {
        const Notifications = await loadExpoNotifications();
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

export function resolvePermissionDetail(permission: PushPermissionInfo | null): string {
    if (!permission) return t('settingsNotifications.pushTroubleshooting.permission.loading');
    if (permission.status === 'unsupported') return t('settingsNotifications.pushTroubleshooting.permission.unsupported');
    if (permission.granted) return t('settingsNotifications.pushTroubleshooting.permission.allowed');
    if (permission.status === 'denied') return t('settingsNotifications.pushTroubleshooting.permission.denied');
    return t('settingsNotifications.pushTroubleshooting.permission.notRequested');
}

export function resolvePermissionSubtitle(permission: PushPermissionInfo | null): string {
    if (!permission) return t('settingsNotifications.pushTroubleshooting.permission.loadingSubtitle');
    if (permission.status === 'unsupported') return t('settingsNotifications.pushTroubleshooting.permission.unsupportedSubtitle');
    if (permission.granted) return t('settingsNotifications.pushTroubleshooting.permission.allowedSubtitle');
    if (permission.canAskAgain) return t('settingsNotifications.pushTroubleshooting.permission.canAskAgainSubtitle');
    return t('settingsNotifications.pushTroubleshooting.permission.openSettingsSubtitle');
}
