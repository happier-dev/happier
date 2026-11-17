import { describe, expect, it } from 'vitest';
import { createTriageSourceV1Fixture } from '../testing/v1/fixtures.js';
import { TriageSourceInstanceDraftV1Schema } from './instances.js';
import { TriageSourceEntrySnapshotV1Schema } from './observations.js';
import {
    TriageListScopeUnitsInputV1Schema,
    TriageListScopeUnitsResultV1Schema,
    TriageSourceScopeSelectionV1Schema,
} from './scopeSelection.js';

describe('shared source scope selection', () => {
    it('admits All or a non-empty set of opaque ids and refuses ambiguous selection', () => {
        expect(TriageSourceScopeSelectionV1Schema.parse({ kind: 'all' })).toEqual({ kind: 'all' });
        expect(TriageSourceScopeSelectionV1Schema.parse({ kind: 'selected', unitIds: ['org/app', '11'] }))
            .toEqual({ kind: 'selected', unitIds: ['org/app', '11'] });
        const retainedPath = `${'o'.repeat(100)}/${'r'.repeat(100)}`;
        expect(TriageSourceScopeSelectionV1Schema.parse({ kind: 'selected', unitIds: [retainedPath] }))
            .toEqual({ kind: 'selected', unitIds: [retainedPath] });
        expect(TriageSourceEntrySnapshotV1Schema.parse({
            ...createTriageSourceV1Fixture().getResult.snapshot, scopeUnitId: retainedPath,
        }).scopeUnitId).toBe(retainedPath);
        for (const invalid of [
            { kind: 'selected', unitIds: [] }, { kind: 'selected', unitIds: ['11', '11'] },
            { kind: 'selected', unitIds: [''] }, { kind: 'all', unitIds: ['11'] },
        ]) expect(TriageSourceScopeSelectionV1Schema.safeParse(invalid).success).toBe(false);
    });

    it('carries configured sort capability including explicit absence and rejects foreign fields', () => {
        const page = { kind: 'page', status: 'complete', selection: { kind: 'all' }, units: [] };
        for (const sortFields of [[], ['created']]) {
            expect(TriageListScopeUnitsResultV1Schema.parse({ ...page, sortFields })).toEqual({ ...page, sortFields });
        }
        expect(TriageListScopeUnitsResultV1Schema.safeParse({ ...page, sortFields: ['title'] }).success).toBe(false);
        expect(TriageListScopeUnitsResultV1Schema.safeParse({ ...page, sortFields: ['created', 'created'] }).success).toBe(false);
    });

    it('keeps configuration-only projection and paged provider discovery on the same strict source contract', () => {
        const fixture = createTriageSourceV1Fixture();
        const draft = fixture.listInstancesResult.candidates[0]!;
        expect(TriageListScopeUnitsInputV1Schema.parse({ v: 1, draft, mode: 'configured' }))
            .toMatchObject({ draft, mode: 'configured' });
        const retained = fixture.configuredInstance;
        const context = { v: 1, binding: retained.binding, localInstanceKey: retained.localInstanceKey, configuration: retained.configuration };
        expect(TriageListScopeUnitsInputV1Schema.parse({ v: 1, draft: context, mode: 'configured' }))
            .toMatchObject({ draft: context, mode: 'configured' });
        expect(TriageSourceInstanceDraftV1Schema.safeParse(context).success).toBe(false);
        const page = {
            kind: 'page', status: 'partial', selection: { kind: 'selected', unitIds: ['11'] },
            units: [{ id: '11', label: 'Selected project', secondaryText: 'Workspace', collisionScope: fixture.getInput.localRef.collisionScope }],
            nextCursor: { v: 1, token: '{"page":2}' },
        };
        expect(TriageListScopeUnitsResultV1Schema.parse(page)).toEqual(page);
        expect(TriageListScopeUnitsResultV1Schema.safeParse({ ...page, status: 'complete' }).success).toBe(false);
        expect(TriageListScopeUnitsInputV1Schema.safeParse({ v: 1, draft, mode: 'configured', token: 'foreign' }).success).toBe(false);
    });
});
