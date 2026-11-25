import { describe, expect, it } from 'vitest';

import { buildIdentityConnectionGroupMappingCommand } from './identityConnectionGroupMapping';

describe('identity connection Group mapping', () => {
    it('binds a normalized external Group through the exact connection owner', () => {
        expect(buildIdentityConnectionGroupMappingCommand({
            teamId: 'team-1', connectionId: 'connection-1', externalGroupId: '  Engineering  ',
            target: { kind: 'native_target', teamGroupId: 'group-1' },
        })).toEqual({
            v: 1, teamId: 'team-1',
            owner: { kind: 'identity_connection', teamIdentityConnectionId: 'connection-1' },
            externalGroupId: 'Engineering', target: { kind: 'native_target', teamGroupId: 'group-1' },
        });
    });

    it('rejects an empty external Group', () => {
        expect(buildIdentityConnectionGroupMappingCommand({
            teamId: 'team-1', connectionId: 'connection-1', externalGroupId: ' ',
            target: { kind: 'native_target', teamGroupId: 'group-1' },
        })).toBeNull();
    });
});
