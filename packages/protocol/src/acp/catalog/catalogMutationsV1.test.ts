import { describe, expect, it } from 'vitest';

import {
    AcpBackendAuthoringInputV1Schema,
    AgentsAcpBackendsGetInputV1Schema,
    AgentsAcpBackendsGetOutputV1Schema,
    AgentsAcpBackendsUpsertInputV1Schema,
    AgentsAcpBackendsUpsertOutputV1Schema,
    AgentsAcpBackendsDeleteInputV1Schema,
    AgentsAcpBackendsDeleteOutputV1Schema,
    applyAcpBackendDeleteV1,
    applyAcpBackendUpsertV1,
    normalizeAcpCatalogSettingsV1,
    suggestAcpBackendIdV1,
} from './catalogMutationsV1.js';

const existing = {
    id: 'backend-1',
    name: 'backend-1',
    title: 'Backend 1',
    command: 'kiro-cli',
    args: ['acp'],
    env: {},
    capabilities: {
        supportsLoadSession: true,
        supportsModes: 'yes' as const,
        supportsModels: 'yes' as const,
        supportsConfigOptions: 'unknown' as const,
        promptImageSupport: 'yes' as const,
    },
    createdAt: 1,
    updatedAt: 1,
};
const stored = { v: 2 as const, backends: [existing] };

describe('ACP catalog mutations', () => {
    it('preserves successful writes with a closed optional history cleanup outcome', () => {
        for (const { schema, output } of [
            { schema: AgentsAcpBackendsUpsertOutputV1Schema, output: { backend: existing, revision: 4 } },
            { schema: AgentsAcpBackendsDeleteOutputV1Schema, output: { backendId: existing.id, deleted: true } },
        ]) {
            expect(schema.safeParse(output).success).toBe(true);
            for (const cleanup of [
                { status: 'complete' },
                { status: 'cleanup-pending', reason: 'history-incomplete' },
            ]) {
                const result = schema.safeParse({ ...output, cleanup });
                expect(result.success).toBe(true);
                if (!result.success) throw new Error('Expected successful catalog write with cleanup outcome');
                expect(result.data).toEqual({ ...output, cleanup });
            }
            for (const cleanup of [
                { status: 'unknown' },
                { status: 'complete', reason: 'history-incomplete' },
                { status: 'cleanup-pending' },
                { status: 'cleanup-pending', reason: 'unbounded-diagnostic' },
                { status: 'cleanup-pending', reason: 'history-incomplete', secret: 'private-history' },
            ]) expect(schema.safeParse({ ...output, cleanup }).success).toBe(false);
        }
        expect(AgentsAcpBackendsUpsertOutputV1Schema.safeParse({ backend: existing }).success).toBe(false);
        for (const revision of ['absent', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
            expect(AgentsAcpBackendsUpsertOutputV1Schema.safeParse({ backend: existing, revision }).success).toBe(false);
        }
    });

    it('accepts captured row revisions and permits Settings versions only for complete absent drafts', () => {
        for (const { schema, input } of [
            { schema: AgentsAcpBackendsUpsertInputV1Schema, input: { backend: existing } },
            { schema: AgentsAcpBackendsDeleteInputV1Schema, input: { backendId: existing.id } },
        ]) {
            expect(schema.safeParse(input).success).toBe(true);
            expect(schema.safeParse({ ...input, expectedRevision: 4 }).success).toBe(true);
            expect(schema.safeParse({ ...input, expectedRevision: 'absent', sourceSettingsVersion: 7 }).success).toBe(true);
            expect(schema.safeParse({ ...input, expectedRevision: 4, sourceSettingsVersion: 7 }).success).toBe(false);
            expect(schema.safeParse({ ...input, sourceSettingsVersion: 7 }).success).toBe(false);
            expect(schema.safeParse({ ...input, expectedRevision: 'absent' }).success).toBe(false);
        }
    });

    it('keeps the full private read envelope and executable definition closed', () => {
        expect(AgentsAcpBackendsGetInputV1Schema.parse({ backendId: ' backend-1 ' })).toEqual({ backendId: 'backend-1' });
        expect(AgentsAcpBackendsGetInputV1Schema.safeParse({ backendId: 'backend-1', command: 'override' }).success).toBe(false);
        expect(AgentsAcpBackendsGetOutputV1Schema.parse({ backend: existing, revision: 4 })).toEqual({ backend: existing, revision: 4 });
        for (const output of [
            { backend: existing, revision: 4, credential: 'hidden' },
            { backend: { ...existing, arbitraryExecutionState: true }, revision: 4 },
            { backend: { ...existing, capabilities: { ...existing.capabilities, arbitraryCapability: true } }, revision: 4 },
            { backend: { ...existing, env: { TOKEN: { t: 'savedSecret', secretId: 'malformed-secret-reference' } } }, revision: 4 },
        ]) expect(AgentsAcpBackendsGetOutputV1Schema.safeParse(output).success).toBe(false);
    });

    it('admits closed authored fields and keeps retained runtime and inert status metadata when editing', () => {
        expect(AcpBackendAuthoringInputV1Schema.safeParse({ ...existing, arbitraryWriterState: true }).success).toBe(false);
        const retained = { ...existing,
            runtime: { stderrRules: { suppress: [{ includes: ['error handling notification', '_kiro.dev/', 'method not found'] }] } },
            compatibility: { source: 'acp-catalog-v2' as const, authStatus: { statusCommand: ['kiro-cli', 'whoami', '--format', 'json'], parser: 'kiroWhoamiJson' as const } },
        };
        const result = applyAcpBackendUpsertV1({ settings: { v: 2, backends: [retained] },
            backend: { id: existing.id, name: existing.name, title: 'Updated', command: existing.command }, nowMs: 2 });
        expect(result).toMatchObject({ ok: true, backend: { runtime: retained.runtime, compatibility: retained.compatibility } });
    });

    it('refuses catalog writes when a retained inventory is malformed or from an unsupported version', () => {
        for (const settings of [
            { v: 2, backends: [existing, { id: 'broken' }] },
            { v: 3, backends: [existing] },
            'unreadable',
        ]) {
            expect(applyAcpBackendUpsertV1({ settings,
                backend: { id: 'backend-2', name: 'backend-2', title: 'Second', command: 'custom-cli' }, nowMs: 2 }))
                .toMatchObject({ ok: false, code: 'acp_catalog_unavailable' });
            expect(applyAcpBackendDeleteV1({ settings, backendId: existing.id }))
                .toMatchObject({ ok: false, code: 'acp_catalog_unavailable' });
        }
    });

    it('creates in an absent catalog and preserves an explicitly empty catalog', () => {
        for (const settings of [undefined, { v: 2, backends: [] }]) {
            const result = applyAcpBackendUpsertV1({ settings, backend: existing, nowMs: 2 });
            expect(result).toMatchObject({ ok: true, settings: { backends: [existing] } });
        }
    });

    it('normalizes the stored catalog, falling back to an empty catalog for an unreadable value', () => {
        expect(normalizeAcpCatalogSettingsV1(stored)).toEqual(stored);
        expect(normalizeAcpCatalogSettingsV1('garbage')).toEqual({ v: 2, backends: [] });
        expect(normalizeAcpCatalogSettingsV1({ v: 2, backends: [{ id: 'Bad Id' }] })).toEqual({ v: 2, backends: [] });
    });

    it('trims an authored backend, stamps a new one and appends it', () => {
        const result = applyAcpBackendUpsertV1({
            settings: stored,
            backend: { id: ' backend-2 ', name: ' backend-2 ', title: ' Backend 2 ', command: ' custom-cli ', args: ['acp'], description: '  ' },
            nowMs: 50,
        });

        expect(result).toEqual({
            ok: true,
            backend: expect.objectContaining({ id: 'backend-2', name: 'backend-2', title: 'Backend 2', command: 'custom-cli', createdAt: 50, updatedAt: 50 }),
            settings: { v: 2, backends: [existing, expect.objectContaining({ id: 'backend-2' })] },
        });
        if (!result.ok) throw new Error('expected ok');
        expect(result.backend.description).toBeUndefined();
    });

    it('replaces an existing backend in place and keeps its creation time', () => {
        const result = applyAcpBackendUpsertV1({
            settings: stored,
            backend: { id: 'backend-1', name: 'backend-1', title: 'Renamed', command: 'kiro-cli' },
            nowMs: 99,
        });
        if (!result.ok) throw new Error('expected ok');
        expect(result.settings.backends).toHaveLength(1);
        expect(result.backend).toMatchObject({ title: 'Renamed', createdAt: 1, updatedAt: 99 });
    });

    it('preserves exact launch and login argv while normalizing authored command fields', () => {
        const args = ['  x  ', '', 'two  words', '\t'];
        const loginArgs = ['', ' login ', 'two\twords', '  '];
        const backend = { ...existing, title: 'Renamed', command: ' kiro-cli ', args,
            auth: { support: 'login_terminal', loginCommand: { command: ' kiro-login ', args: loginArgs } },
        };
        const result = applyAcpBackendUpsertV1({ settings: stored, backend, nowMs: 2 });
        expect(result).toMatchObject({ ok: true, backend: { command: 'kiro-cli', args,
            auth: { loginCommand: { command: 'kiro-login', args: loginArgs } } },
            settings: { backends: [{ id: existing.id, args, auth: { loginCommand: { args: loginArgs } } }] },
        });
    });

    it('keeps timestamps an author already set (the editor draft carries its own)', () => {
        const result = applyAcpBackendUpsertV1({
            settings: { v: 2, backends: [] },
            backend: { ...existing, createdAt: 7, updatedAt: 8 },
            nowMs: 99,
        });
        if (!result.ok) throw new Error('expected ok');
        expect(result.backend).toMatchObject({ createdAt: 7, updatedAt: 8 });
    });

    it('rejects an invalid backend and a duplicate name with typed codes', () => {
        expect(applyAcpBackendUpsertV1({ settings: stored, backend: { id: 'Bad Id', name: 'x', title: 't', command: 'c' }, nowMs: 1 }))
            .toMatchObject({ ok: false, code: 'acp_backend_invalid' });
        expect(applyAcpBackendUpsertV1({ settings: stored, backend: { id: 'backend-3', name: 'backend-1', title: 't', command: 'c' }, nowMs: 1 }))
            .toEqual({ ok: false, code: 'acp_backend_name_conflict', message: 'Duplicate ACP backend name: backend-1', fields: ['name'] });
    });

    it('names every invalid field so an editor can show each error beside its field', () => {
        const result = applyAcpBackendUpsertV1({
            settings: stored,
            backend: {
                id: 'Bad Id', name: 'bad-id', title: ' ', command: '',
                env: { 'lower-case': { t: 'literal', v: 'x' } },
                auth: { support: 'login_terminal', docsUrl: 'not a url' },
            },
            nowMs: 1,
        });
        expect(result).toMatchObject({ ok: false, code: 'acp_backend_invalid' });
        if (result.ok) throw new Error('expected a refusal');
        expect([...result.fields].sort()).toEqual(['auth.docsUrl', 'command', 'env', 'id', 'title']);
    });

    it('refuses to create a backend over an existing id instead of replacing it', () => {
        const created = applyAcpBackendUpsertV1({
            settings: stored,
            backend: { id: 'backend-1', name: 'another', title: 'Another', command: 'c' },
            nowMs: 1,
            mode: 'create',
        });
        expect(created).toMatchObject({ ok: false, code: 'acp_backend_id_conflict', fields: ['id'] });
        // Upsert (the action's default) still replaces by id.
        expect(applyAcpBackendUpsertV1({
            settings: stored,
            backend: { id: 'backend-1', name: 'backend-1', title: 'Again', command: 'c' },
            nowMs: 1,
        })).toMatchObject({ ok: true });
    });

    it('deletes by id and reports an unknown id', () => {
        expect(applyAcpBackendDeleteV1({ settings: stored, backendId: 'backend-1' })).toEqual({ ok: true, settings: { v: 2, backends: [] } });
        expect(applyAcpBackendDeleteV1({ settings: stored, backendId: 'missing' })).toEqual({ ok: false, code: 'acp_backend_not_found' });
    });
});

describe('suggestAcpBackendIdV1', () => {
    it('derives a valid id from a display name', () => {
        expect(suggestAcpBackendIdV1({ title: 'My Kiro Agent!', settings: { v: 2, backends: [] } })).toBe('my-kiro-agent');
        expect(suggestAcpBackendIdV1({ title: '  Élan_2.0  ', settings: { v: 2, backends: [] } })).toBe('elan_2.0');
    });

    it('avoids ids and names already in the catalog', () => {
        expect(suggestAcpBackendIdV1({ title: 'Backend 1', settings: stored })).toBe('backend-1-2');
    });

    it('returns an empty id when the name has nothing to derive from', () => {
        expect(suggestAcpBackendIdV1({ title: '  ', settings: stored })).toBe('');
        expect(suggestAcpBackendIdV1({ title: '日本', settings: stored })).toBe('');
    });
});
