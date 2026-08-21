import { describe, expect, it } from 'vitest';

import { isUnsafeNotificationServerUrl } from './notificationRouting';

describe('notification server URL safety', () => {
    it('rejects every loopback form that another device cannot reach', () => {
        expect(isUnsafeNotificationServerUrl('http://127.0.0.2:3005')).toBe(true);
        expect(isUnsafeNotificationServerUrl('http://relay.localhost:3005')).toBe(true);
        expect(isUnsafeNotificationServerUrl('https://machine.tailnet.ts.net')).toBe(false);
    });
});
