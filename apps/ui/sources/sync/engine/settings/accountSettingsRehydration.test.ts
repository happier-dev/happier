import { describe, expect, it } from 'vitest';

import { assertAccountSettingsRehydratedVersion } from './accountSettingsRehydration';

describe('account settings canonical rehydration', () => {
    it('accepts the daemon-acknowledged version or a newer concurrent winner', () => {
        expect(() => assertAccountSettingsRehydratedVersion({ currentVersion: 8, minimumVersion: 8 })).not.toThrow();
        expect(() => assertAccountSettingsRehydratedVersion({ currentVersion: 9, minimumVersion: 8 })).not.toThrow();
    });

    it('rejects missing or stale state instead of letting the UI replay pre-migration settings', () => {
        expect(() => assertAccountSettingsRehydratedVersion({ currentVersion: null, minimumVersion: 8 })).toThrow();
        expect(() => assertAccountSettingsRehydratedVersion({ currentVersion: 7, minimumVersion: 8 })).toThrow();
    });
});
