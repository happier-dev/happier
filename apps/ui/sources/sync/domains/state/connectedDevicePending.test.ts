import { describe, expect, it } from 'vitest';

import { parsePendingSettings } from './persistence';

describe('connected-device pending settings', () => {
    it('preserves a device report across a pending-settings reload', () => {
        const report = { name: 'Laptop', platform: 'desktop', appVersion: '0.2.19-fork.23 (rc2)', lastSeen: 123456789 };
        const key = 'connectedDeviceV1_test-device';
        expect(parsePendingSettings({ [key]: report })).toEqual({ [key]: report });
    });
});
