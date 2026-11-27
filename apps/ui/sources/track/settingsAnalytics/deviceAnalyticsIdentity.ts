import Constants from 'expo-constants';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { randomUUID } from '@/platform/randomUUID';
import { loadDeviceAnalyticsId, saveDeviceAnalyticsId } from '@/sync/domains/state/persistence';

export function getDeviceAnalyticsId(): string | null {
    const installationId = typeof Constants.installationId === 'string'
        ? Constants.installationId.trim()
        : '';
    if (installationId) return installationId;

    const persistedId = loadDeviceAnalyticsId();
    if (persistedId) return persistedId;

    const generatedId = randomUUID().trim();
    if (!generatedId) return null;
    saveDeviceAnalyticsId(generatedId);
    return generatedId;
}

/**
 * The PostHog `device_user` group key. The device id above is also sent to the Home by product
 * features, so analytics never carries it raw: it is keyed by the person's anonymous id, which
 * derives from the Account's secret and is unknown to the server. The result cannot be joined to
 * the device id the Home stores, and differs per person on a shared device.
 */
export function deriveDeviceUserGroupKey(anonymousUserId: string, deviceId: string): string {
    const digest = hmac(sha256, utf8ToBytes(anonymousUserId), utf8ToBytes(`device_user:${deviceId}`));
    return `${anonymousUserId}:${bytesToHex(digest).slice(0, 32)}`;
}
