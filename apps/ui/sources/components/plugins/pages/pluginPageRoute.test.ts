import { describe, expect, it } from 'vitest';
import { appendPluginPageRouteSubPath, buildPluginAppPageRoutePath, buildPluginProjectPageRoutePath } from './pluginPageRoute';

describe('host plugin page route generation', () => {
    it('keeps the existing app path grammar and qualifies the Project checkout without private builtin selections', () => {
        expect(buildPluginAppPageRoutePath({ pluginId: 'acme.notes', localId: 'notes', subPath: 'runs/one two' }))
            .toBe('/plugins/acme.notes/notes/runs/one%20two');
        // A declared view a lens apart rides in the query; the page's own view leaves the path as it was.
        expect(buildPluginAppPageRoutePath({ pluginId: 'acme.notes', localId: 'notes', subPath: 'tasks,mine', view: 'tasks' }))
            .toBe('/plugins/acme.notes/notes/tasks%2Cmine?view=tasks');
        expect(buildPluginAppPageRoutePath({ pluginId: 'acme.notes', localId: 'notes', subPath: 'runs', view: 'notes' }))
            .toBe('/plugins/acme.notes/notes/runs');
        const root = buildPluginProjectPageRoutePath({ workspaceRefId: 'ref/one', pluginId: 'acme.notes', localId: 'notes',
            serverId: 'home-one', rawWorktreeId: 'tree-one', rawActiveRootPath: '/ignored' });
        expect(root).toBe('/projects/ref%2Fone/plugins/acme.notes/notes?serverId=home-one&worktreeId=tree-one');
        expect(appendPluginPageRouteSubPath(root, 'runs/one two/page'))
            .toBe('/projects/ref%2Fone/plugins/acme.notes/notes/runs/one%20two/page?serverId=home-one&worktreeId=tree-one');
        expect(() => appendPluginPageRouteSubPath(root, '../another')).toThrow();
    });
});
