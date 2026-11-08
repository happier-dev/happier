import { describe, expect, it } from 'vitest';
import { createSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from './sessionListRenderable';
import { createProjectSessionListMatcher, projectSessionList } from './projectSessionList';

describe('Project Session roster admission', () => {
    it('does not reopen unchanged row metadata on repeated classification, and follows a changed row relationship', () => {
        const row = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'own', owner: 'viewer', ownerAccountId: 'viewer',
            metadata: { path: '/repo', host: 'host', workspaceId: 'checkout' },
        }));
        let metadataReads = 0;
        const counted = { ...row, get metadata() { metadataReads++; return row.metadata; } };
        const matcher = createProjectSessionListMatcher({
            project: { serverId: 'home-a', projectKey: 'anchor' }, viewer: { serverId: 'home-a', accountId: 'viewer' },
            workspaceRefs: [{ id: 'checkout', projectKey: 'anchor', serverId: 'home-a', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 },
                { id: 'other-checkout', projectKey: 'other', serverId: 'home-a', machineId: 'machine', rootPath: '/other', createdAtMs: 1 }],
        });
        expect(matcher(counted, 'home-a')).toBe('match');
        metadataReads = 0;
        for (let arrival = 0; arrival < 5; arrival++) expect(matcher(counted, 'home-a')).toBe('match');
        expect(metadataReads).toBe(0);
        expect(matcher({ ...row, metadata: { ...row.metadata!, path: '/other', workspaceId: 'other-checkout' } }, 'home-a')).toBe('miss');
        expect(matcher(counted, 'home-b')).toBe('miss');
    });
    it('filters admitted list membership and never revives foreign, private, locked, or cache-only rows', () => {
        const row = (id: string, overrides: Parameters<typeof createSessionFixture>[0] = {}) => buildSessionListRenderableFromSession(createSessionFixture({
            id, owner: 'viewer', ownerAccountId: 'viewer', metadata: { path: '/repo', host: 'host', workspaceId: 'checkout' }, ...overrides,
        }));
        const rows = {
            own: row('own'), foreign: row('foreign', { owner: 'other', ownerAccountId: 'other' }),
            recipient: row('recipient', { access: createSessionAccessFixture('view'), accessLevel: 'view' }),
            locked: row('locked', { metadata: null }), cached: row('cached'),
        };
        const items = ['own', 'foreign', 'recipient', 'locked'].map(sessionId => ({ type: 'session' as const, serverId: 'home-a', sessionId }));
        const input = { project: { serverId: 'home-a', projectKey: 'anchor' }, viewer: { serverId: 'home-a', accountId: 'viewer' },
            source: items, rows, workspaceRefs: [{ id: 'checkout', projectKey: 'anchor', serverId: 'home-a',
                machineId: 'machine', rootPath: '/repo', createdAtMs: 1 }] };
        expect(projectSessionList(input).items).toEqual([items[0]]);
        expect(projectSessionList({ ...input, viewer: { serverId: 'home-a', accountId: 'other' } }).items).toEqual([items[1]]);
        expect(projectSessionList({ ...input, project: { ...input.project, serverId: 'home-b' } }).items).toEqual([]);
        expect(projectSessionList({ ...input, source: [] }).items).toEqual([]);
        expect(projectSessionList({ ...input, viewer: null }).items).toEqual([]);
    });
    it('uses the admitted public relationship without private refs and on a locked authorized recipient', () => {
        const rows = Object.fromEntries(['owner', 'recipient'].map(id => [id, buildSessionListRenderableFromSession(createSessionFixture({
            id, projectKey: 'anchor', metadata: id === 'owner' ? { path: '/repo', host: 'host' } : null,
            ...(id === 'recipient' ? { access: createSessionAccessFixture('view'), accessLevel: 'view' as const, owner: 'other' } : { owner: 'viewer' }),
        }))]));
        const source = ['owner', 'recipient'].map(sessionId => ({ type: 'session' as const, serverId: 'home-a', sessionId }));
        expect(projectSessionList({ project: { serverId: 'home-a', projectKey: 'anchor' },
            viewer: { serverId: 'home-a', accountId: 'viewer' }, rows, source }).items).toEqual(source);
    });
    it("lists a joined checkout's Sessions stamped with its own key before it joined, never a standalone checkout's", () => {
        const rows = Object.fromEntries(['anchored', 'joined', 'standalone'].map(id => [id, buildSessionListRenderableFromSession(createSessionFixture({
            id, owner: 'viewer', ownerAccountId: 'viewer', projectKey: id === 'anchored' ? 'anchor' : id, metadata: { path: `/${id}`, host: 'host' },
        }))]));
        const source = ['anchored', 'joined', 'standalone'].map(sessionId => ({ type: 'session' as const, serverId: 'home-a', sessionId }));
        const ref = (id: string, projectKey?: string) => ({ id, ...(projectKey ? { projectKey } : {}), serverId: 'home-a',
            machineId: 'machine', rootPath: `/${id}`, createdAtMs: 1 });
        expect(projectSessionList({ project: { serverId: 'home-a', projectKey: 'anchor' }, viewer: { serverId: 'home-a', accountId: 'viewer' },
            rows, source, workspaceRefs: [ref('anchor', 'anchor'), ref('joined', 'anchor'), ref('standalone')] }).items)
            .toEqual(source.slice(0, 2));
    });
    it('lists each Session once: the ordinary row, never its needs-you or working shortcut occurrence', () => {
        const rows = { busy: buildSessionListRenderableFromSession(createSessionFixture({
            id: 'busy', owner: 'viewer', ownerAccountId: 'viewer', metadata: { path: '/repo', host: 'host', workspaceId: 'checkout' },
        })) };
        const base = { type: 'session' as const, serverId: 'home-a', sessionId: 'busy' };
        const source = [{ ...base, occurrenceRole: 'needsYou' as const }, base, { ...base, occurrenceRole: 'working' as const }];
        expect(projectSessionList({ project: { serverId: 'home-a', projectKey: 'anchor' }, viewer: { serverId: 'home-a', accountId: 'viewer' },
            rows, source, workspaceRefs: [{ id: 'checkout', projectKey: 'anchor', serverId: 'home-a',
                machineId: 'machine', rootPath: '/repo', createdAtMs: 1 }] }).items).toEqual([base]);
    });
});
