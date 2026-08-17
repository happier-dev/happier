import { describe, expect, expectTypeOf, it } from 'vitest';
import { RETIRED_ACCOUNT_SETTINGS_SESSION_ORGANIZATION_KEYS } from '@happier-dev/protocol';

import type { Settings } from './settings';
import { migrateAccountSettingsServerIdentityKeys } from './serverIdentityKeyMigration';

describe('migrateAccountSettingsServerIdentityKeys', () => {
    it('migrates compatibility-only organization keys without exposing them through Settings', () => {
        expectTypeOf<Extract<
            (typeof RETIRED_ACCOUNT_SETTINGS_SESSION_ORGANIZATION_KEYS)[number],
            keyof Settings
        >>().toEqualTypeOf<never>();

        const migrated = migrateAccountSettingsServerIdentityKeys({
            settings: {
                pinnedSessionKeysV1: ['localhost-18829:session-a'],
                serverSelectionGroups: [{
                    id: 'group-a',
                    serverIds: ['localhost-18829'],
                }],
            },
            currentServerId: 'srv_current',
            legacyServerIds: ['localhost-18829'],
        });

        expect(migrated.settings).toMatchObject({
            pinnedSessionKeysV1: ['srv_current:session-a'],
            serverSelectionGroups: [{
                id: 'group-a',
                serverIds: ['srv_current'],
            }],
        });
    });

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
