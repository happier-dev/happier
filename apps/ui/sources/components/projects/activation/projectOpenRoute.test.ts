import { describe, expect, it } from 'vitest';
import { buildProjectCheckoutOpenRoute, buildProjectOpenRoute, buildProjectSourceOpenRoute, readProjectOpenRouteDraft } from './projectOpenRoute.mjs';

describe('Project Open entrance', () => {
    it('does not build a repository Open route for a Source without a repository', () => {
        expect(buildProjectSourceOpenRoute('home', { id: 'source', revision: 1, name: 'Production', audience: [], createdByAccountId: 'account' })).toBeNull();
    });
    it('captures the exact checkout Home and branch without selecting an execution Machine', () => {
        const checkout = { serverId: 'other-home', workspaceId: 'checkout', machineId: 'machine', rootPath: '/checkout' };
        const route = buildProjectCheckoutOpenRoute(checkout, 'feature');
        // No way to open is chosen for the person: Open starts on its own default once a Machine is chosen.
        expect(readProjectOpenRouteDraft(route.params)).toEqual({ serverId: 'other-home', machineId: '',
            source: { kind: 'workspace', workspaceId: 'checkout', checkout }, ref: 'feature' });
        expect(readProjectOpenRouteDraft(buildProjectCheckoutOpenRoute(checkout).params))
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
        const admittedSource = { ...input.source, selector: { ...input.source.selector,
            provider: { ...input.source.selector.provider, id: 'happier.scm.forge.github/github' } } };
        expect(readProjectOpenRouteDraft(buildProjectOpenRoute(input).params)).toEqual({ ...input, source: admittedSource });
        const route = buildProjectSourceOpenRoute('home', { id: 'source', revision: 2, name: 'Source',
            repository: input.source.selector, defaultRef: 'main', subdir: 'app', audience: [], createdByAccountId: 'account' });
        if (!route) throw new Error('Repository Source must offer Open');
        const seeded = readProjectOpenRouteDraft(route.params);
        expect(seeded).toMatchObject({ serverId: 'home', machineId: '', source: admittedSource });
        // A saved Source never pre-chooses a fresh clone: an existing checkout on the Machine comes first.
        expect(seeded).not.toHaveProperty('materialization');
    });
});
