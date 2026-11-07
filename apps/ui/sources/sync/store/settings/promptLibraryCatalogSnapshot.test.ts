import { afterEach, describe, expect, it } from 'vitest';
import { applyPromptLibraryCatalogSnapshot, applyPromptLibraryCatalogAcknowledgedRecord, beginPromptLibraryCatalogLoad, getPromptLibraryCatalogValue, getPromptLibraryCatalogSnapshot,
    publishPromptLibrarySkillRulesDraft, resetPromptLibraryCatalogSnapshotsForTests, beginPromptLibraryCatalogRowsLoad,
    subscribePromptLibraryCatalogSnapshots, applyPromptLibraryCatalogRowsSnapshot } from './promptLibraryCatalogSnapshot';
afterEach(resetPromptLibraryCatalogSnapshotsForTests);
const scope = { serverId: 'home', accountId: 'account' };
const catalog = { status: 'ready' as const, rows: [{ record: { key: 'folders' as const,
    value: { v: 1 as const, folders: [{ id: 'folder', name: 'Folder' }] } }, revision: 3 }], tombstones: [], diagnostics: [] };
describe('Prompt library scoped publications', () => {
    it('admits targeted rules during a full refresh without replacing sibling facts or claiming cold siblings', () => {
        const projection = { catalog: { ...catalog, rows: [...catalog.rows, { revision: 4, record: {
            key: 'registry-sources' as const, value: { v: 2 as const, sources: [], disabledSourceIds: [] },
        } }] }, rawSettings: {}, sourceSettingsVersion: 7 };
        const rules = { catalog: { ...catalog, rows: [{ revision: 2, record: {
            key: 'skill-rules' as const, value: { v: 1 as const, rules: [] },
        } }] }, rawSettings: {}, sourceSettingsVersion: 0 };
        applyPromptLibraryCatalogSnapshot(scope, projection, true);
        for (const reason of ['loading', 'unreachable', 'encryption-material-unavailable'] as const) {
            beginPromptLibraryCatalogLoad(scope);
            if (reason !== 'loading') applyPromptLibraryCatalogSnapshot(scope, { ...projection,
                catalog: { status: 'unavailable', reason } }, true);
            const folders = getPromptLibraryCatalogValue(scope, 'folders');
            const sources = getPromptLibraryCatalogValue(scope, 'registry-sources');
            if (reason === 'encryption-material-unavailable') {
                expect(folders).toMatchObject({ status: 'unavailable', reason, value: null });
                expect(sources).toMatchObject({ status: 'unavailable', reason, value: null });
            }
            applyPromptLibraryCatalogRowsSnapshot(scope, ['skill-rules'], rules, true);
            expect(getPromptLibraryCatalogValue(scope, 'folders')).toBe(folders);
            expect(getPromptLibraryCatalogValue(scope, 'registry-sources')).toBe(sources);
            expect(getPromptLibraryCatalogValue(scope, 'skill-rules')).toMatchObject({ status: 'ready', revision: 2 });
        }
        const cold = { ...scope, accountId: 'cold' };
        applyPromptLibraryCatalogRowsSnapshot(cold, ['skill-rules'], rules, true);
        expect(getPromptLibraryCatalogValue(cold, 'folders')).toMatchObject({ status: 'loading', value: null, sourceSettingsVersion: null });
        // A real full response remains exhaustive, and a targeted tombstone deletes only its row.
        applyPromptLibraryCatalogSnapshot(scope, projection, true);
        const sources = getPromptLibraryCatalogValue(scope, 'registry-sources');
        applyPromptLibraryCatalogRowsSnapshot(scope, ['folders'], { ...rules, catalog: { status: 'ready', rows: [],
            tombstones: [{ key: 'folders', revision: 5 }], diagnostics: [] } }, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ revision: 5, value: { v: 1, folders: [] } });
        expect(getPromptLibraryCatalogValue(scope, 'registry-sources')).toBe(sources);
        applyPromptLibraryCatalogSnapshot(scope, { ...projection, catalog: { ...catalog, rows: [],
            tombstones: [{ key: 'registry-sources', revision: 6 }] } }, true);
        expect(getPromptLibraryCatalogValue(scope, 'registry-sources')).toMatchObject({ revision: 6, value: { sources: [] } });
        applyPromptLibraryCatalogRowsSnapshot(scope, ['skill-rules'], { ...rules,
            catalog: { status: 'unavailable', reason: 'unauthorized' } }, true);
        expect(getPromptLibraryCatalogValue(scope, 'registry-sources').value).toBeNull();
    });
    it('does not replace an unchanged row source-version carrier during repeated catalog wakes', () => {
        const sourceCatalog = { ...catalog, rows: [{ record: { key: 'registry-sources' as const,
            value: { v: 2 as const, sources: [], disabledSourceIds: [] } }, revision: 3 }] };
        const projection = { catalog: sourceCatalog, rawSettings: {}, sourceSettingsVersion: 7 };
        applyPromptLibraryCatalogSnapshot(scope, projection, true);
        let previous = getPromptLibraryCatalogValue(scope, 'registry-sources').sourceSettingsVersion;
        let versionChanges = 0;
        const off = subscribePromptLibraryCatalogSnapshots(() => {
            const next = getPromptLibraryCatalogValue(scope, 'registry-sources').sourceSettingsVersion;
            if (next !== previous) versionChanges++;
            previous = next;
        });
        try {
            for (let i = 0; i < 5; i++) {
                beginPromptLibraryCatalogLoad(scope);
                applyPromptLibraryCatalogSnapshot(scope, { ...projection,
                    catalog: { status: 'unavailable', reason: 'unreachable' } }, true);
                applyPromptLibraryCatalogSnapshot(scope, projection, true);
            }
            expect(versionChanges).toBe(0);
            expect(getPromptLibraryCatalogValue(scope, 'registry-sources')).toMatchObject({ revision: 3, stale: false });
            const inactiveScope = { ...scope, serverId: 'inactive-home' };
            const inactive = { ...projection, catalog: { ...sourceCatalog, rows: [] } };
            applyPromptLibraryCatalogSnapshot(inactiveScope, inactive, true);
            beginPromptLibraryCatalogLoad(inactiveScope);
            applyPromptLibraryCatalogSnapshot(inactiveScope, { ...inactive, sourceSettingsVersion: 8 }, true);
            expect(getPromptLibraryCatalogValue(inactiveScope, 'registry-sources'))
                .toMatchObject({ revision: 'absent', sourceSettingsVersion: 8, stale: false });
        } finally { off(); }
    });
    it('retains drafted rule values when only their read authority enters loading', () => {
        const projection = { catalog: { ...catalog, rows: [{ revision: 1, record: { key: 'skill-rules' as const,
            value: { v: 1 as const, rules: [] } } }] }, rawSettings: {}, sourceSettingsVersion: 1 };
        applyPromptLibraryCatalogSnapshot(scope, projection, true);
        publishPromptLibrarySkillRulesDraft(scope, 'skill', [{ id: 'pending-rule', target: { t: 'allMachines' },
            enabled: true, createdAt: 1, updatedAt: 1 }]);
        const before = getPromptLibraryCatalogValue(scope, 'skill-rules').value;
        beginPromptLibraryCatalogRowsLoad(scope, ['skill-rules']);
        expect(getPromptLibraryCatalogValue(scope, 'skill-rules').status).toBe('loading');
        expect(getPromptLibraryCatalogValue(scope, 'skill-rules').value).toBe(before);
    });
    it('publishes a pending row transition once while repeated wakes await that same read', () => {
        const record = { key: 'skill-rules' as const, value: { v: 1 as const,
            rules: Array.from({ length: 139 }, (_, i) => ({ id: `rule-${i}`, skillId: `skill-${i}`,
                target: { t: 'allMachines' as const }, enabled: true, createdAt: 1, updatedAt: 1 })) } };
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { ...catalog, rows: [{ record, revision: 1 }] },
            rawSettings: {}, sourceSettingsVersion: 1 }, true);
        beginPromptLibraryCatalogRowsLoad(scope, ['skill-rules']);
        const pending = getPromptLibraryCatalogValue(scope, 'skill-rules');
        let publications = 0;
        const off = subscribePromptLibraryCatalogSnapshots(() => { publications++; });
        try {
            for (let i = 0; i < 10; i++) beginPromptLibraryCatalogRowsLoad(scope, ['skill-rules']);
            expect(publications).toBe(0);
            expect(getPromptLibraryCatalogValue(scope, 'skill-rules')).toBe(pending);
        } finally { off(); }
    });
    it('keeps an acknowledged row in both projections when an older read finishes after the write', () => {
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        const record = { key: 'folders' as const, value: { v: 1 as const, folders: [{ id: 'folder', name: 'New' }] } };
        applyPromptLibraryCatalogAcknowledgedRecord(scope, record, 4, true);
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ revision: 4, value: record.value, stale: false });
        expect(getPromptLibraryCatalogSnapshot(scope)?.catalog).toMatchObject({ rows: [{ record, revision: 4 }] });
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true, undefined, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'loading', revision: 4, value: record.value, stale: true });
        expect(getPromptLibraryCatalogSnapshot(scope)?.catalog).toMatchObject({ rows: [{ record, revision: 4 }] });
    });
    it('withdraws pending display intent with lost Account admission, not merely its received row', () => {
        const skillCatalog = { status: 'ready' as const, rows: [{ record: { key: 'skill-rules' as const,
            value: { v: 1 as const, rules: [] } }, revision: 3 }], tombstones: [], diagnostics: [] };
        const projection = { catalog: skillCatalog, rawSettings: {}, sourceSettingsVersion: 1 };
        applyPromptLibraryCatalogSnapshot(scope, projection, true);
        publishPromptLibrarySkillRulesDraft(scope, 'skill', [{ id: 'draft', target: { t: 'allMachines' },
            enabled: true, createdAt: 1, updatedAt: 1 }]);
        expect(getPromptLibraryCatalogValue(scope, 'skill-rules').value?.rules).toHaveLength(1);
        applyPromptLibraryCatalogSnapshot(scope, { ...projection, catalog: { status: 'unavailable', reason: 'unauthorized' } }, true);
        expect(getPromptLibraryCatalogValue(scope, 'skill-rules').value).toBeNull();
        applyPromptLibraryCatalogSnapshot(scope, projection, true);
        expect(getPromptLibraryCatalogValue(scope, 'skill-rules').value?.rules).toEqual([]);
    });
    it('retains partial tombstone evidence through refresh and rejects lower or duplicate row receipts', () => {
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'partial', rows: [],
            tombstones: [{ key: 'folders', revision: 10 }], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        beginPromptLibraryCatalogLoad(scope);
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] },
            rawSettings: {}, sourceSettingsVersion: 1 }, true);
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'unavailable', reason: 'unreachable' },
            rawSettings: {}, sourceSettingsVersion: 1 }, true);
        const retained = getPromptLibraryCatalogValue(scope, 'folders');
        applyPromptLibraryCatalogAcknowledgedRecord(scope, catalog.rows[0]!.record, 6, true);
        applyPromptLibraryCatalogAcknowledgedRecord(scope, catalog.rows[0]!.record, 10, true);
        applyPromptLibraryCatalogAcknowledgedRecord(scope, catalog.rows[0]!.record, 11, false);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toBe(retained);
        applyPromptLibraryCatalogAcknowledgedRecord(scope, catalog.rows[0]!.record, 11, true);
        const recreated = getPromptLibraryCatalogValue(scope, 'folders');
        applyPromptLibraryCatalogAcknowledgedRecord(scope, { ...catalog.rows[0]!.record,
            value: { v: 1, folders: [] } }, 11, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toBe(recreated);
        expect(recreated).toMatchObject({ revision: 11, stale: false, value: catalog.rows[0]!.record.value });
        const otherScope = { ...scope, accountId: 'other-account' };
        applyPromptLibraryCatalogAcknowledgedRecord(otherScope, catalog.rows[0]!.record, 6, true);
        expect(getPromptLibraryCatalogValue(otherScope, 'folders').revision).toBe(6);
    });
    it('publishes an acknowledged row during refresh without replacing siblings, newer receipts, or retired Accounts', () => {
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        beginPromptLibraryCatalogLoad(scope);
        const sibling = getPromptLibraryCatalogValue(scope, 'role-overrides');
        const record = { key: 'folders' as const, value: { v: 1 as const, folders: [{ id: 'folder', name: 'Acknowledged' }] } };
        applyPromptLibraryCatalogAcknowledgedRecord(scope, record, 4, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'ready', stale: false, revision: 4, value: record.value });
        const acknowledged = getPromptLibraryCatalogValue(scope, 'folders');
        applyPromptLibraryCatalogAcknowledgedRecord(scope, catalog.rows[0]!.record, 3, true);
        applyPromptLibraryCatalogAcknowledgedRecord(scope, catalog.rows[0]!.record, 5, false);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toBe(acknowledged);
        expect(getPromptLibraryCatalogValue(scope, 'role-overrides')).toBe(sibling);
    });
    it('keeps unchanged active domains stable across preference revisions and sibling catalog edits', () => {
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        const first = getPromptLibraryCatalogValue(scope, 'folders');
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 2 }, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toBe(first);
        applyPromptLibraryCatalogSnapshot({ serverId: 'other', accountId: 'account' }, { catalog, rawSettings: {}, sourceSettingsVersion: 3 }, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toBe(first);
    });
    it('retains display content while refreshing, rejects retired results, and withdraws private data on lost admission', () => {
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        const value = getPromptLibraryCatalogValue(scope, 'folders').value;
        beginPromptLibraryCatalogLoad(scope);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'loading', stale: true, value });
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, false);
        expect(getPromptLibraryCatalogValue(scope, 'folders').status).toBe('loading');
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'unavailable', reason: 'encryption-material-unavailable' },
            rawSettings: {}, sourceSettingsVersion: 1 }, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'unavailable', value: null });
    });
});
