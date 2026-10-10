import { afterEach, describe, expect, it } from 'vitest';
import { storage } from '@/sync/domains/state/storage';
import { applyProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import { listSpawnProfilesForActions } from './listSpawnProfiles';

const original = storage.getState().settingsScope;
const scope = { serverId: 'spawn-profile-home', accountId: 'spawn-profile-account' };
const profile = { v: 2 as const, id: 'entity', name: 'Entity', extraEnvironmentVariables: [],
    defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
    createdAt: 1, updatedAt: 1 };
function publish(status: 'ready' | 'partial', authority: 'active' | 'inactive' = 'active') {
    storage.setState({ settingsScope: scope });
    applyProfileCatalogSnapshot(scope, { status, authority, source: authority === 'active' ? 'destination' : 'legacy', control: null, controlRevision: 1,
        referenceGuardRevision: 1, diagnostics: status === 'partial' ? [{ id: 'future', revision: 1, reason: 'unreadable-content' }] : [],
        records: [{ revision: 7, record: { v: 1, id: profile.id, enabled: true, promptStack: [], secretBindings: {},
            definition: { kind: 'inline', profile } } }] }, true);
}
afterEach(() => { resetProfileCatalogSnapshotsForTests(); storage.setState({ settingsScope: original }); });

describe('listSpawnProfilesForActions', () => {
    it('does not admit a missing or inactive entity inventory', () => {
        expect(listSpawnProfilesForActions({})).toMatchObject({ items: [], coverage: 'unavailable' });
        publish('ready', 'inactive');
        expect(listSpawnProfilesForActions({})).toMatchObject({ items: [], coverage: 'unavailable' });
    });
    it('lists the canonical row inventory with bundled Agent compatibility', () => {
        publish('ready');
        expect(listSpawnProfilesForActions({ agentId: 'claude' })).toMatchObject({ coverage: 'complete',
            items: [expect.objectContaining({ id: 'entity', supportedAgentIds: expect.arrayContaining(['claude']) })] });
    });
    it('does not authorize listing from an incomplete entity inventory', () => {
        publish('partial');
        expect(listSpawnProfilesForActions({})).toMatchObject({ coverage: 'unavailable', items: [] });
    });
});
