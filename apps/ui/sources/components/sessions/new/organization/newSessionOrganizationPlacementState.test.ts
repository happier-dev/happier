import { describe, expect, it } from 'vitest';

import {
    isNewSessionOrganizationPlacementAvailable,
    normalizeNewSessionOrganizationPlacement,
    reconcileNewSessionOrganizationPlacementForAccount,
} from './newSessionOrganizationPlacementState';

describe('newSessionOrganizationPlacementState', () => {
    it('deduplicates authored tag ids without changing their stable order', () => {
        expect(normalizeNewSessionOrganizationPlacement({
            folderId: ' folder-1 ', tagIds: ['tag-2', ' tag-1 ', 'tag-2', ''],
        })).toEqual({ folderId: 'folder-1', tagIds: ['tag-2', 'tag-1'] });
    });

    it('retains a section for its Account Home without an execution placement constraint', () => {
        const placement = { folderId: 'section-1', tagIds: ['tag-1'] };
        const folders = [{ folderId: 'section-1', serverId: 'home-1' }];
        expect(reconcileNewSessionOrganizationPlacementForAccount({ placement, folders,
            targetServerId: 'home-1' })).toBe(placement);
    });

    it('refuses a section from another Home even when its local id matches', () => {
        expect(reconcileNewSessionOrganizationPlacementForAccount({
            placement: { folderId: 'section-1', tagIds: [] },
            targetServerId: 'home-1',
            folders: [{ folderId: 'section-1', serverId: 'home-2' }],
        })).toEqual({ folderId: null, tagIds: [] });
    });

    it('fails closed for stale non-empty placement when Sessions are unavailable', () => {
        expect(isNewSessionOrganizationPlacementAvailable({ featureEnabled: false,
            placement: { folderId: 'section-1', tagIds: ['tag-1'] } })).toBe(false);
        expect(isNewSessionOrganizationPlacementAvailable({ featureEnabled: false,
            placement: { folderId: null, tagIds: [] } })).toBe(true);
    });

    it('requires re-selection after an Account or Home changes even when the new section has the same id', () => {
        const placement = { folderId: 'section-1', tagIds: [] };
        const placementScope = { serverId: 'home-1', accountId: 'account-1' };
        expect(isNewSessionOrganizationPlacementAvailable({ featureEnabled: true, placement,
            placementScope, targetScope: placementScope, sectionAvailable: true })).toBe(true);
        for (const targetScope of [
            { serverId: 'home-2', accountId: 'account-1' },
            { serverId: 'home-1', accountId: 'account-2' },
        ]) {
            expect(isNewSessionOrganizationPlacementAvailable({ featureEnabled: true, placement,
                placementScope, targetScope, sectionAvailable: true })).toBe(false);
        }
        expect(isNewSessionOrganizationPlacementAvailable({ featureEnabled: true, placement,
            placementScope, targetScope: placementScope, sectionAvailable: false })).toBe(false);
    });
});
