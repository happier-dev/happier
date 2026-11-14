import { describe, expect, it } from 'vitest';

import {
    CONNECTED_DEVICE_KEY_PREFIX,
    CONNECTED_DEVICE_WINDOW_MS,
    listConnectedDevices,
    planConnectedDeviceIdentityUpdate,
} from './connectedDevices';
import { applySettings, settingsParse } from './settings';

describe('connected devices', () => {
    it('lists devices seen in the last fourteen days, preferring the live last-seen time', () => {
        const now = 2_000_000_000_000;
        const desktop = { name: 'Laptop', platform: 'desktop', appVersion: '0.2.19-fork.23 (rc2)' } as const;
        const phone = { name: 'Phone', platform: 'android', appVersion: '0.2.19-fork.20' } as const;
        const settings = {
            [`${CONNECTED_DEVICE_KEY_PREFIX}desktop`]: desktop,
            // A report from an older build still carries its own last-seen time.
            [`${CONNECTED_DEVICE_KEY_PREFIX}phone`]: { ...phone, lastSeen: now - CONNECTED_DEVICE_WINDOW_MS },
            [`${CONNECTED_DEVICE_KEY_PREFIX}expired`]: { ...phone, lastSeen: now - CONNECTED_DEVICE_WINDOW_MS - 1 },
            [`${CONNECTED_DEVICE_KEY_PREFIX}unseen`]: desktop,
            [`${CONNECTED_DEVICE_KEY_PREFIX}invalid`]: { ...desktop, platform: 'toaster' },
            machines: [{ host: 'old-host', happyCliVersion: '0.2.17' }],
        };
        expect(listConnectedDevices(settings, { desktop: now - 1000 }, now)).toEqual([
            { ...desktop, lastSeen: now - 1000, id: 'desktop' },
            { ...phone, lastSeen: now - CONNECTED_DEVICE_WINDOW_MS, id: 'phone' },
        ]);
    });

    it('lists this device from its synced identity even when the relay has no presence for it', () => {
        const now = 2_000_000_000_000;
        const identity = { name: 'This laptop', platform: 'desktop', appVersion: '0.2.20-beta1.4' } as const;
        const settings = {
            [`${CONNECTED_DEVICE_KEY_PREFIX}this`]: identity,
            [`${CONNECTED_DEVICE_KEY_PREFIX}other`]: { ...identity, name: 'Other laptop' },
        };
        // Presence is unavailable (older relay, failed request): only the running device is known to be connected now.
        expect(listConnectedDevices(settings, {}, now, 'this')).toEqual([{ ...identity, lastSeen: now, id: 'this' }]);
        expect(listConnectedDevices(settings, {}, now)).toEqual([]);
    });

    it('lists devices with an unknown last-seen only when the relay presence is unavailable', () => {
        const now = 2_000_000_000_000;
        const identity = { name: 'Laptop', platform: 'desktop', appVersion: '0.2.20-beta1.4' } as const;
        const settings = {
            [`${CONNECTED_DEVICE_KEY_PREFIX}known`]: identity,
            [`${CONNECTED_DEVICE_KEY_PREFIX}unknown`]: { ...identity, name: 'Phone', platform: 'android' },
        };
        // Presence loaded and has no record for "unknown": it was not seen recently, so it stays hidden.
        expect(listConnectedDevices(settings, { known: now - 5 }, now).map((device) => device.id)).toEqual(['known']);
        // Presence unavailable (older relay, failed request): recency is unknowable, so nothing is dropped for it.
        expect(listConnectedDevices(settings, null, now)).toEqual([
            { ...identity, lastSeen: null, id: 'known' },
            { ...identity, name: 'Phone', platform: 'android', lastSeen: null, id: 'unknown' },
        ]);
    });

    it('retains other devices when applying an independent device update', () => {
        const existing = { name: 'Phone', platform: 'android', appVersion: '0.2.19-fork.20' } as const;
        const updated = { name: 'Laptop', platform: 'desktop', appVersion: '0.2.19-fork.23' } as const;
        const settings = settingsParse({ [`${CONNECTED_DEVICE_KEY_PREFIX}phone`]: existing });
        const merged = settingsParse(applySettings(settings, { [`${CONNECTED_DEVICE_KEY_PREFIX}laptop`]: updated }));
        expect(listConnectedDevices(merged, { phone: 100, laptop: 200 }, 200)).toEqual([
            { ...updated, lastSeen: 200, id: 'laptop' },
            { ...existing, lastSeen: 100, id: 'phone' },
        ]);
    });

    it('rewrites the synced device entry only when its name, platform or version changes', () => {
        const identity = { name: 'Laptop', platform: 'desktop', appVersion: '0.2.20' } as const;
        const key = `${CONNECTED_DEVICE_KEY_PREFIX}laptop`;

        expect(planConnectedDeviceIdentityUpdate({}, 'laptop', identity)).toEqual({ [key]: identity });
        expect(planConnectedDeviceIdentityUpdate({ [key]: identity }, 'laptop', identity)).toBeNull();
        // An entry written by an older build (with its own last-seen time) is replaced once, without it.
        expect(planConnectedDeviceIdentityUpdate({ [key]: { ...identity, lastSeen: 5 } }, 'laptop', identity)).toEqual({ [key]: identity });
        expect(planConnectedDeviceIdentityUpdate({ [key]: identity }, 'laptop', { ...identity, appVersion: '0.2.21' }))
            .toEqual({ [key]: { ...identity, appVersion: '0.2.21' } });
    });
});
