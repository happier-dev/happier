import { describe, expect, it, vi } from 'vitest';
import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol';

// No HTTP is used by revision reconciliation; retain the real client and all domain logic.
vi.mock('@/sync/http/client', () => ({ serverFetch: vi.fn() }));

import { isQualifiedConnectedAccountGroupRevisionCurrent, type QualifiedConnectedAccountUiGroup } from './qualifiedConnectedAccountUiSource';

const group: QualifiedConnectedAccountUiGroup = {
    ref: { service: { pluginId: 'acme.accounts', localId: 'a' }, groupId: 'team' },
    displayName: 'Team', policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}),
    activeAccountId: null, revision: { protocol: 'v4', incarnation: 'original', generation: 1, runtimeStateRevision: 2 },
    state: {}, members: [],
};

describe('qualified pool response reconciliation', () => {
    it('settles confirmed deletion absence without admitting a replacement, another Account or a missing mutation target', () => {
        const basis = {};
        const deleted = { state: { basis, groups: [] }, basis, group, allowAbsent: true };
        expect(isQualifiedConnectedAccountGroupRevisionCurrent(deleted)).toBe(true);
        expect(isQualifiedConnectedAccountGroupRevisionCurrent({ ...deleted, allowAbsent: false })).toBe(false);
        expect(isQualifiedConnectedAccountGroupRevisionCurrent({ ...deleted, basis: {} })).toBe(false);
        expect(isQualifiedConnectedAccountGroupRevisionCurrent({ ...deleted, state: { basis, groups: [group] } })).toBe(true);
        for (const replacement of [
            { ...group, revision: { ...group.revision, incarnation: 'replacement' } },
            { ...group, revision: { ...group.revision, generation: 2 } },
            { ...group, revision: { ...group.revision, runtimeStateRevision: 3 } },
        ]) expect(isQualifiedConnectedAccountGroupRevisionCurrent({ ...deleted, state: { basis, groups: [replacement] } })).toBe(false);
    });
});
