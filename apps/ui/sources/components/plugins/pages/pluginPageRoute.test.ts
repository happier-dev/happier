import { describe, expect, it } from 'vitest';
import { appendPluginPageRouteSubPath, buildPluginAppPageRoutePath, parsePluginAppPageRoutePath, buildPluginMachinePageRoutePath, buildPluginProjectPageRoutePath, pluginPageTargetKey } from './pluginPageRoute';

describe('host plugin page route generation', () => {
    it('round-trips a resource subpath containing slashes through the public route builder', () => {
        const resource = { kind: 'pullRequest', url: 'https://github.com/happier-dev/triage-qa-sandbox/pull/63' };
        const subPath = `resource/${encodeURIComponent(JSON.stringify(resource))}`;
        const destination = { pluginId: 'happier.triage', localId: 'triage', subPath };
        const route = buildPluginAppPageRoutePath(destination);
        const restored = parsePluginAppPageRoutePath(route);
        expect(restored).toEqual(destination);
        expect(buildPluginAppPageRoutePath(restored!)).toBe(route);
        expect(JSON.parse(decodeURIComponent(restored!.subPath.slice('resource/'.length)))).toEqual(resource);
    });
    it('addresses a Machine destination inside its existing Machine page and keeps Homes distinct', () => {
        const target = { kind: 'machine' as const, serverId: 'home/one', machineId: 'machine/one' };
        const route = buildPluginMachinePageRoutePath({ ...target, pluginId: 'acme.notes', localId: 'notes', subPath: 'runs/one two' });
        expect(route).toBe('/machines/machine%2Fone?serverId=home%2Fone&tab=plugin&pluginId=acme.notes&localId=notes&pluginPath=runs%2Fone%20two');
        expect(pluginPageTargetKey(target)).not.toBe(pluginPageTargetKey({ ...target, serverId: 'another-home' }));
        expect(pluginPageTargetKey(target)).not.toBe(pluginPageTargetKey({ ...target, machineId: 'another-machine' }));
        expect(() => buildPluginMachinePageRoutePath({ ...target, pluginId: 'acme.notes', localId: 'notes', subPath: '../other' })).toThrow();
    });
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
