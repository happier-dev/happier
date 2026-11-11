import { expect, it } from 'vitest';
import { WorkspaceRefV1Schema } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveWorkspaceRefDisplayName, resolveWorkspaceRefDisplayNames } from './resolveWorkspaceRefDisplayName';

it('distinguishes duplicate folder names by their parent across path separator styles', () => {
    const refs = ['/work/customer/happier', 'C:\\work\\personal\\happier', '/work/unique'].map((rootPath, index) =>
        WorkspaceRefV1Schema.parse({ id: String(index), serverId: 'home', machineId: 'machine', rootPath, createdAtMs: 0 }));
    expect(refs.map(ref => resolveWorkspaceRefDisplayName(ref, refs))).toEqual(['happier · customer', 'happier · personal', 'unique']);
});

it('names a set of workspaces shown together, telling same-named folders apart (Machine page Project work row)', () => {
    const refs = ['/home/ana/work/happier', '/home/ana/oss/happier', '/home/ana/site'].map((rootPath, index) =>
        WorkspaceRefV1Schema.parse({ id: String(index), serverId: 'home', machineId: 'machine', rootPath, createdAtMs: 0 }));
    expect(resolveWorkspaceRefDisplayNames(refs)).toEqual(['happier · work', 'happier · oss', 'site']);
});

it('distinguishes Project anchors whose named folders also share the same parent name', () => {
    const refs = ['/work/customer/apps/happier', '/work/personal/apps/happier'].map((rootPath, index) =>
        WorkspaceRefV1Schema.parse({ id: `anchor-${index}`, projectKey: `anchor-${index}`, serverId: 'home', machineId: 'machine', rootPath, createdAtMs: 0 }));
    const names = resolveWorkspaceRefDisplayNames(refs);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toContain('customer');
    expect(names[1]).toContain('personal');
});

it('keeps root-folder Project labels human without substituting anchor keys (R137)', () => {
    const refs = ['a'.repeat(64), 'b'.repeat(64)].map((projectKey, index) =>
        WorkspaceRefV1Schema.parse({ id: `root-${index}`, projectKey, serverId: 'home', machineId: `machine-${index}`, rootPath: '/', createdAtMs: 0 }));
    expect(resolveWorkspaceRefDisplayNames(refs)).toEqual(['/', '/']);
});

it('does path work proportional to the workspaces when naming colliding folders together', () => {
    const reads = [16, 32].map(count => {
        let pathReads = 0;
        const refs = Array.from({ length: count }, (_, index) => {
            const ref = WorkspaceRefV1Schema.parse({ id: String(index), serverId: 'home', machineId: 'machine',
                rootPath: `/work/parent-${index}/happier`, createdAtMs: 0 });
            return { ...ref, get rootPath() { pathReads += 1; return ref.rootPath; } };
        });
        expect(resolveWorkspaceRefDisplayNames(refs)).toEqual(refs.map((_, index) => `happier · parent-${index}`));
        return pathReads;
    });
    expect(reads[0]).toBeGreaterThan(0);
    expect(reads[1], 'doubling the collection doubles path work instead of rescanning every sibling').toBeLessThanOrEqual(reads[0]! * 2);
});

it('keeps duplicate identities unqualified and preserves explicit labels when disambiguating a set', () => {
    const ref = (id: string, rootPath: string, label?: string) => WorkspaceRefV1Schema.parse({
        id, rootPath, label, serverId: 'home', machineId: 'machine', createdAtMs: 0,
    });
    const duplicate = ref('duplicate', '/work/solo/happier');
    expect(resolveWorkspaceRefDisplayNames([duplicate, { ...duplicate, label: ' happier ' }])).toEqual(['happier', 'happier']);
    expect(resolveWorkspaceRefDisplayName(duplicate, [{ ...duplicate, label: 'Another name' }])).toBe('happier');
    const refs = [ref('first', '/work/customer/apps/one/', ' Shared '),
        ref('second', 'C:\\work\\personal\\apps\\two\\', 'Shared'), ref('unique', '/work/unique', 'Different')];
    expect(resolveWorkspaceRefDisplayNames(refs)).toEqual([
        'Shared · /work/customer/apps/one', 'Shared · C:\\work\\personal\\apps\\two', 'Different',
    ]);
    expect(refs.map(ref => resolveWorkspaceRefDisplayName(ref, refs))).toEqual(resolveWorkspaceRefDisplayNames(refs));
    expect(resolveWorkspaceRefDisplayName(refs[0]!, refs.slice(1))).toBe('Shared · /work/customer/apps/one');
    expect(resolveWorkspaceRefDisplayNames([duplicate, { ...duplicate, rootPath: `${duplicate.rootPath}/` }])).toEqual([
        'happier · /work/solo/happier', 'happier · /work/solo/happier',
    ]);
});
