import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceRefV1 } from './workspaceRefModel';

import {
    createWorkspaceRefScopeFinder,
    findWorkspaceRefByScope,
    resolveWorkspaceRefById,
    resolveWorkspaceRefRemoval,
    upsertWorkspaceRefByScope,
    sameWorkspaceProject,
    resolveProjectCheckoutWorkspaceRef,
} from './workspaceRefs';

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'workspace-ref-id',
}));

describe('workspaceRefs', () => {
    it('resolves the actual accepted checkout only within the qualified Project anchor', () => {
        const project: WorkspaceRefV1 = { id: 'project', serverId: 'home', machineId: 'machine', rootPath: '/base', createdAtMs: 1 };
        const checkout: WorkspaceRefV1 = { ...project, id: 'checkout', projectKey: 'project', rootPath: '/feature' };
        expect(resolveProjectCheckoutWorkspaceRef([project, checkout], project, '/feature')).toBe(checkout);
        expect(resolveProjectCheckoutWorkspaceRef([project, checkout], project, '/missing')).toBeNull();
        expect(resolveProjectCheckoutWorkspaceRef([project, { ...checkout, projectKey: 'other-project' }], project, '/feature')).toBeNull();
        expect(resolveProjectCheckoutWorkspaceRef([project, { ...checkout, serverId: 'other-home' }], project, '/feature')).toBeNull();
        expect(resolveProjectCheckoutWorkspaceRef([checkout, { ...checkout, id: 'duplicate' }], project, '/feature')).toBeNull();
    });
    it('lists another checkout only by its accepted Home and stable Project anchor, not shared enrichment', () => {
        const first: WorkspaceRefV1 = { id: 'first', serverId: 'home', machineId: 'm1', rootPath: '/first', createdAtMs: 1,
            source: { sourceId: 'same-source', revision: 1 },
            repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' } };
        expect(sameWorkspaceProject(first, { ...first, id: 'second', machineId: 'm2', rootPath: '/second', projectKey: 'first' })).toBe(true);
        expect(sameWorkspaceProject(first, { ...first, id: 'second' })).toBe(false);
        expect(sameWorkspaceProject(first, { ...first, serverId: 'other-home' })).toBe(false);
    });
    it('refuses an ambiguous qualified id without discarding either checkout', () => {
        const refs = ['/first', '/second'].map(rootPath => ({ id: 'same', serverId: 'home', machineId: 'machine', rootPath, createdAtMs: 1 }));
        expect(resolveWorkspaceRefById(refs, 'same', 'home').kind).toBe('ambiguous');
        expect(resolveWorkspaceRefRemoval(refs, { serverId: 'home', workspaceRefId: 'same', relationships: [] }))
            .toEqual({ ok: false, code: 'workspace_ref_ambiguous' });
        expect(refs.map(ref => ref.rootPath)).toEqual(['/first', '/second']);
    });
    it('keeps independent accepted anchors stable when both acquire the same Source facts', () => {
        const source = { sourceId: 'source', revision: 1 };
        let refs: WorkspaceRefV1[] = ['/first', '/second'].map((rootPath, index) => ({ id: `ref-${index}`, serverId: 'home', machineId: 'machine', rootPath, createdAtMs: 1 }));
        for (const rootPath of ['/first', '/second']) {
            refs = upsertWorkspaceRefByScope(refs, { scope: { serverId: 'home', machineId: 'machine', rootPath }, nowMs: 2, patch: { source } });
        }
        expect(refs.map(ref => ref.projectKey)).toEqual(['ref-0', 'ref-1']);
        const additional = upsertWorkspaceRefByScope(refs, { scope: { serverId: 'home', machineId: 'machine', rootPath: '/third' }, nowMs: 3, patch: { source } });
        // A new checkout joins the earliest-added member's Project, even when anchors compete (owner 11-08).
        expect(additional.map(ref => ref.projectKey)).toEqual(['ref-0', 'ref-1', 'ref-0']);
    });

    it('groups an accepted checkout into its repository\'s Project when its identity first arrives (owner 11-08)', () => {
        const repositoryIdentity = { kind: 'github' as const, deployment: 'https://github.com', repository: 'acme/app' };
        const refs: WorkspaceRefV1[] = [
            { id: 'first', serverId: 'home', machineId: 'nldw3', rootPath: '/app', projectKey: 'first', createdAtMs: 1, repositoryIdentity },
            { id: 'second', serverId: 'home', machineId: 'nldw6', rootPath: '/app', projectKey: 'second', createdAtMs: 5 },
        ];
        const next = upsertWorkspaceRefByScope(refs, { scope: { serverId: 'home', machineId: 'nldw6', rootPath: '/app' }, nowMs: 9, patch: { repositoryIdentity } });
        expect(next.map(ref => [ref.id, ref.projectKey])).toEqual([['first', 'first'], ['second', 'first']]);
    });
    it('preserves every candidate and refuses mutation of an ambiguous exact scope', () => {
        const refs = ['one', 'two'].map(id => ({ id, serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 }));
        expect(findWorkspaceRefByScope(refs, { serverId: 'home', machineId: 'machine', rootPath: '/repo' })).toBeNull();
        expect(() => upsertWorkspaceRefByScope(refs, {
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, nowMs: 2, patch: { label: 'Changed' },
        })).toThrowError(expect.objectContaining({ code: 'workspace_ref_ambiguous' }));
        expect(refs.map(ref => ref.id)).toEqual(['one', 'two']);
    });
    it('upserts by normalized scope and preserves id', () => {
        const refs = [
            {
                id: 'id-1',
                serverId: 'server',
                machineId: 'm1',
                rootPath: '/tmp/repo/',
                label: null,
                createdAtMs: 1,
                lastOpenedAtMs: null,
            },
        ];

        const next = upsertWorkspaceRefByScope(refs, {
            scope: { serverId: 'server', machineId: 'm1', rootPath: '/tmp/repo' },
            nowMs: 10,
            patch: { label: 'My Repo' },
        });

        expect(next).toHaveLength(1);
        expect(next[0]!.id).toBe('id-1');
        expect(next[0]!.label).toBe('My Repo');
    });

    it('creates a new ref when missing', () => {
        const next = upsertWorkspaceRefByScope([], {
            scope: { serverId: 'server', machineId: 'm1', rootPath: '/tmp/repo' },
            nowMs: 10,
            patch: { label: 'Repo' },
        });

        expect(next).toHaveLength(1);
        expect(next[0]!.id).toBe('workspace-ref-id');
        expect(next[0]!.rootPath).toBe('/tmp/repo');
    });

    it('answers many scopes over one census exactly as the single-scope resolver does', () => {
        const refs: WorkspaceRefV1[] = [
            { id: 'win', serverId: 'server', machineId: 'm1', rootPath: 'C:\\Repo\\', createdAtMs: 1 },
            { id: 'dup-a', serverId: 'server', machineId: 'm1', rootPath: '/shared' , createdAtMs: 1 },
            { id: 'dup-b', serverId: 'server', machineId: 'm1', rootPath: '/shared/', createdAtMs: 1 },
            { id: 'other-machine', serverId: 'server', machineId: 'm2', rootPath: '/repo', createdAtMs: 1 },
            { id: 'other-home', serverId: 'other', machineId: 'm1', rootPath: '/repo', createdAtMs: 1 },
            { id: 'padded', serverId: ' server ', machineId: ' m3 ', rootPath: '/padded', createdAtMs: 1 },
        ];
        const find = createWorkspaceRefScopeFinder(refs);
        const scopes = [
            { serverId: 'server', machineId: 'm1', rootPath: 'c:/repo' },
            { serverId: 'server', machineId: 'm1', rootPath: '/shared' },
            { serverId: 'server', machineId: 'm2', rootPath: '/repo/' },
            { serverId: 'other', machineId: 'm1', rootPath: '/repo' },
            { serverId: 'server', machineId: 'm3', rootPath: '/padded' },
            { serverId: 'server', machineId: 'm1', rootPath: '/missing' },
            { serverId: 'server', machineId: '', rootPath: '/repo' },
        ];
        expect(scopes.map(scope => find(scope)?.id ?? null))
            .toEqual(scopes.map(scope => findWorkspaceRefByScope(refs, scope)?.id ?? null));
        expect(scopes.map(scope => find(scope)?.id ?? null)).toEqual(['win', null, 'other-machine', 'other-home', 'padded', null, null]);
    });

    it('finds ref by normalized scope', () => {
        const refs = [
            {
                id: 'id-1',
                serverId: 'server',
                machineId: 'm1',
                rootPath: 'C:\\\\Repo\\\\',
                label: 'X',
                createdAtMs: 1,
                lastOpenedAtMs: null,
            },
        ];

        const found = findWorkspaceRefByScope(refs, { serverId: 'server', machineId: 'm1', rootPath: 'c:/repo' });
        expect(found?.id).toBe('id-1');
    });

    describe('resolveWorkspaceRefRemoval', () => {
        const refs = [
            { id: 'source-ref', serverId: 'server', machineId: 'm1', rootPath: '/source', label: null, createdAtMs: 1, lastOpenedAtMs: null },
            { id: 'target-ref', serverId: 'server', machineId: 'm2', rootPath: '/target', label: null, createdAtMs: 1, lastOpenedAtMs: null },
        ];
        const relationship = {
            relationshipId: 'relationship-1',
            alphaWorkspaceRefId: 'source-ref',
            betaWorkspaceRefId: 'target-ref',
        };

        it('refuses to remove a ref any workspace-sync relationship still references', () => {
            expect(resolveWorkspaceRefRemoval(refs, {
                serverId: 'server',
                workspaceRefId: 'target-ref',
                relationships: [relationship],
            })).toEqual({ ok: false, code: 'workspace_ref_in_use', relationshipIds: ['relationship-1'] });
        });

        it('removes the ref once no relationship references it', () => {
            const removal = resolveWorkspaceRefRemoval(refs, {
                serverId: 'server',
                workspaceRefId: 'target-ref',
                relationships: [],
            });

            expect(removal.ok).toBe(true);
            expect(removal.ok && removal.workspaceRefs.map((ref) => ref.id)).toEqual(['source-ref']);
        });

        it('leaves refs owned by another server untouched', () => {
            const removal = resolveWorkspaceRefRemoval(refs, {
                serverId: 'other-server',
                workspaceRefId: 'target-ref',
                relationships: [],
            });

            expect(removal.ok && removal.workspaceRefs.map((ref) => ref.id)).toEqual(['source-ref', 'target-ref']);
        });
    });

});
