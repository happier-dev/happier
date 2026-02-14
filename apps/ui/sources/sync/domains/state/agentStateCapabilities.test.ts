import { describe, expect, it } from 'vitest';

import { getPermissionsInUiWhileLocal } from '@/sync/domains/state/agentStateCapabilities';

describe('getPermissionsInUiWhileLocal', () => {
    it('returns true when permissionsInUiWhileLocal is true', () => {
        expect(getPermissionsInUiWhileLocal({ permissionsInUiWhileLocal: true })).toBe(true);
    });

    it('returns true when the legacy localPermissionBridgeInLocalMode capability is true', () => {
        expect(getPermissionsInUiWhileLocal({ localPermissionBridgeInLocalMode: true })).toBe(true);
    });

    it('returns false when no capability is set', () => {
        expect(getPermissionsInUiWhileLocal(null)).toBe(false);
        expect(getPermissionsInUiWhileLocal(undefined)).toBe(false);
        expect(getPermissionsInUiWhileLocal({})).toBe(false);
    });
});

