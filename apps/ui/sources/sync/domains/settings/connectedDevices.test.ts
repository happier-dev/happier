import { describe, expect, it } from 'vitest';

import { CONNECTED_DEVICE_KEY_PREFIX, CONNECTED_DEVICE_WINDOW_MS, listConnectedDevices } from './connectedDevices';
import { applySettings, settingsParse } from './settings';

describe('connected devices', () => {
    it('lists valid client reports in the last fourteen days without including machine hosts', () => {
        const now = 2_000_000_000_000;
        const desktop = { name: 'Laptop', platform: 'desktop', appVersion: '0.2.19-fork.23 (rc2)', lastSeen: now - 1000 };
        const phone = { name: 'Phone', platform: 'android', appVersion: '0.2.19-fork.20', lastSeen: now - CONNECTED_DEVICE_WINDOW_MS };
        expect(listConnectedDevices({
            [`${CONNECTED_DEVICE_KEY_PREFIX}desktop`]: desktop,
            [`${CONNECTED_DEVICE_KEY_PREFIX}phone`]: phone,
            [`${CONNECTED_DEVICE_KEY_PREFIX}expired`]: { ...phone, lastSeen: now - CONNECTED_DEVICE_WINDOW_MS - 1 },
            [`${CONNECTED_DEVICE_KEY_PREFIX}invalid`]: { ...desktop, lastSeen: 'yesterday' },
            machines: [{ host: 'old-host', happyCliVersion: '0.2.17' }],
        }, now)).toEqual([desktop, phone]);
    });

    it('retains other devices when applying an independent device update', () => {
        const existing = { name: 'Phone', platform: 'android', appVersion: '0.2.19-fork.20', lastSeen: 100 };
        const updated = { name: 'Laptop', platform: 'desktop', appVersion: '0.2.19-fork.23', lastSeen: 200 };
        const settings = settingsParse({ [`${CONNECTED_DEVICE_KEY_PREFIX}phone`]: existing });
        const merged = settingsParse(applySettings(settings, { [`${CONNECTED_DEVICE_KEY_PREFIX}laptop`]: updated }));
        expect(listConnectedDevices(merged, 200)).toEqual([updated, existing]);
    });
});
