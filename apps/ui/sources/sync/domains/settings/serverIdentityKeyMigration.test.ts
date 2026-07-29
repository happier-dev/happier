import { describe, expect, it } from 'vitest';

import { migrateAccountSettingsServerIdentityKeys } from './serverIdentityKeyMigration';

describe('migrateAccountSettingsServerIdentityKeys', () => {
    it('does not migrate local collapsed group keys through account server identity migration', () => {
        const migrated = migrateAccountSettingsServerIdentityKeys({
            settings: {
                collapsedGroupKeysV1: {
                    'server:srv_current:active': false,
                    'server:localhost-18829:active': true,
                    'server:localhost-18829:inactive': true,
                },
            },
            currentServerId: 'srv_current',
            legacyServerIds: ['localhost-18829'],
        });

        expect(migrated.changed).toBe(false);
        expect(migrated.changedKeys).not.toContain('collapsedGroupKeysV1');
        expect(migrated.settings.collapsedGroupKeysV1).toEqual({
            'server:srv_current:active': false,
            'server:localhost-18829:active': true,
            'server:localhost-18829:inactive': true,
        });
    });
});
