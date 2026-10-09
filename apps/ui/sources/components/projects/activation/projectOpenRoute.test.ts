import { describe, expect, it } from 'vitest';
import { buildProjectCheckoutOpenRoute, buildProjectOpenRoute, buildProjectSourceOpenRoute, readProjectOpenRouteDraft } from './projectOpenRoute';

describe('Project Open entrance', () => {
    it('captures the exact checkout Home and branch without selecting an execution Machine', () => {
        const route = buildProjectCheckoutOpenRoute({ serverId: 'other-home', workspaceId: 'checkout' }, 'feature');
        expect(readProjectOpenRouteDraft(route.params)).toEqual({ serverId: 'other-home', machineId: '',
            source: { kind: 'workspace', workspaceId: 'checkout' }, ref: 'feature',
            materialization: { kind: 'clone', destinationParentPath: '', destinationDirectoryName: '' } });
        expect(readProjectOpenRouteDraft(buildProjectCheckoutOpenRoute({ serverId: 'home', workspaceId: 'checkout' }).params))
            .not.toHaveProperty('ref');
    });
    it('retains the exact selected Machine, folder and branch without executing or guessing a checkout name', () => {
        const input = { serverId: 'home', machineId: 'machine', source: { kind: 'folder' as const, path: 'C:\\repo' },
            ref: 'feature', materialization: { kind: 'attach' as const } };
        const route = buildProjectOpenRoute(input, 'worktree');
        expect(route.pathname).toBe('/projects/open');
        expect(readProjectOpenRouteDraft(route.params)).toEqual({ ...input, materialization: {
            kind: 'worktree', checkout: { kind: 'git_worktree', displayName: '', baseRef: 'feature' },
        } });
        expect(readProjectOpenRouteDraft({ ...route.params, openDraft: '{"serverId":"other"}' })).toBeNull();
    });
    it('retains captured Source selection and used defaults instead of rereading a mutable Source', () => {
        const input = { serverId: 'home', machineId: 'machine', source: { kind: 'source' as const, id: 'source', revision: 2,
            selector: { provider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'owner/repo', visibility: 'private' as const }, protocol: 'https' as const }, defaultRef: 'main', subdir: 'app' },
            ref: 'feature', materialization: { kind: 'attach' as const } };
        expect(readProjectOpenRouteDraft(buildProjectOpenRoute(input).params)).toEqual(input);
        const route = buildProjectSourceOpenRoute('home', { id: 'source', revision: 2, name: 'Source',
            repository: input.source.selector, defaultRef: 'main', subdir: 'app', audience: [], createdByAccountId: 'account' });
        expect(readProjectOpenRouteDraft(route.params)).toMatchObject({ serverId: 'home', machineId: '',
            source: input.source, materialization: { kind: 'clone', destinationParentPath: '', destinationDirectoryName: '' } });
    });
});
