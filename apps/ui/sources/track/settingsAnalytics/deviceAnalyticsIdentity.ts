import Constants from 'expo-constants';
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
