import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    constants: {
        installationId: null as string | null,
    },
    persistence: {
        loadDeviceAnalyticsId: vi.fn(() => null as string | null),
        saveDeviceAnalyticsId: vi.fn(),
    },
    randomUUID: vi.fn(() => 'generated-device-id'),
}));

vi.mock('expo-constants', () => ({
    default: mocks.constants,
}));

vi.mock('@/sync/domains/state/persistence', () => ({
    loadDeviceAnalyticsId: mocks.persistence.loadDeviceAnalyticsId,
    saveDeviceAnalyticsId: mocks.persistence.saveDeviceAnalyticsId,
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: mocks.randomUUID,
}));

import { getDeviceAnalyticsId } from './deviceAnalyticsIdentity';

describe('getDeviceAnalyticsId', () => {
    beforeEach(() => {
        mocks.constants.installationId = null;
        mocks.persistence.loadDeviceAnalyticsId.mockReset();
        mocks.persistence.saveDeviceAnalyticsId.mockReset();
        mocks.randomUUID.mockClear();
    });

    it('prefers Expo installationId when available', () => {
        mocks.constants.installationId = ' install-123 ';

        expect(getDeviceAnalyticsId()).toBe('install-123');
        expect(mocks.persistence.loadDeviceAnalyticsId).not.toHaveBeenCalled();
        expect(mocks.persistence.saveDeviceAnalyticsId).not.toHaveBeenCalled();
    });

    it('reuses the persisted device analytics id when Expo installationId is unavailable', () => {
        mocks.persistence.loadDeviceAnalyticsId.mockReturnValue('persisted-device-id');

        expect(getDeviceAnalyticsId()).toBe('persisted-device-id');
        expect(mocks.persistence.saveDeviceAnalyticsId).not.toHaveBeenCalled();
        expect(mocks.randomUUID).not.toHaveBeenCalled();
    });

    it('creates and persists a random device analytics id when no stable id exists yet', () => {
        mocks.persistence.loadDeviceAnalyticsId.mockReturnValue(null);

        expect(getDeviceAnalyticsId()).toBe('generated-device-id');
        expect(mocks.persistence.saveDeviceAnalyticsId).toHaveBeenCalledWith('generated-device-id');
    });
});
