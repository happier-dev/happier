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
