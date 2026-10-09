import { describe, expect, it } from 'vitest';

import { buildRequesterSessionCreationContext, resolveRequesterSessionSpawnDisposition } from './requesterSessionSpawnPreparation';
import { encodeBase64 } from '@/encryption/base64';

describe('requester Session spawn credential disposition', () => {
    it('uses persisted Account mode for private key serialization and preserves the canonical legacy bytes', () => {
        const secret = new Uint8Array(32).fill(255);
        const credentials = { token: 'bob-token', secret: encodeBase64(secret, 'base64url') };
        expect(buildRequesterSessionCreationContext('plain', credentials)).toEqual({
            v: 1, disposition: 'ordinary_requester', credentials: { token: 'bob-token' },
        });
        expect(buildRequesterSessionCreationContext('e2ee', credentials)).toEqual({
            v: 1, disposition: 'ordinary_requester', credentials: { token: 'bob-token', secret: encodeBase64(secret, 'base64') },
        });
    });
    it('uses current addressed access for cold Homes and never treats pending, refused or substituted access as custodian execution', () => {
        const custodian = { accountId: 'alice', displayName: 'Alice' };
        const access = { machineId: 'machine', custodian,
            access: { custodian, role: 'use', resourceMode: 'plain', accessState: 'ready' },
            canManage: false, grants: [], ownDirectGrant: true, ownAccessSources: [] };
        expect(resolveRequesterSessionSpawnDisposition({ accountId: 'bob', machineId: 'machine', access })).toMatchObject({ kind: 'requester' });
        expect(resolveRequesterSessionSpawnDisposition({ accountId: 'alice', machineId: 'machine', access })).toEqual({ kind: 'own' });
        for (const unavailable of [
            { kind: 'refused', code: 'access_denied' },
            { ...access, machineId: 'substituted-machine' },
            { ...access, access: { ...access.access, accessState: 'key_pending' } },
        ]) expect(resolveRequesterSessionSpawnDisposition({ accountId: 'bob', machineId: 'machine', access: unavailable })).toMatchObject({ kind: 'refused' });
    });
});
