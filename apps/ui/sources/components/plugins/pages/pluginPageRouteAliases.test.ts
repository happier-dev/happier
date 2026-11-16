import { describe, expect, it, vi } from 'vitest';
import { PluginUiViewV2Schema } from '@happier-dev/protocol/plugins/contributions/ui/v2';
import { projectPluginUiDeclarationEntriesV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarationProjection';
import { normalizePluginInstalledUiDeclarations } from '@/sync/domains/plugins/ui/projection';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { workspaceRouteHref } from '@/components/appShell/workspace/workspaceRoutes';
import { resolvePluginAppPageRouteAlias } from './pluginPageRouteAliases';
import { buildPluginAppPageRoutePath, parsePluginAppPageRoutePath } from './pluginPageRoute';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

function installAliases() {
    const pluginId = 'acme.work';
    const entries = projectPluginUiDeclarationEntriesV1({ registry: {
        uiRenderersV2: [{ pluginId, identity: { pluginId, localId: 'native' }, definition: {
            id: 'native', kind: 'declarative', root: { kind: 'text', text: 'Work' },
        } }],
        uiViewsV2: [{ pluginId, identity: { pluginId, localId: 'work' }, definition: PluginUiViewV2Schema.parse({
            id: 'work', renderer: 'native', container: 'appPage', target: { kind: 'app' },
            // Dynamic first deliberately: static precedence belongs to the existing matcher.
            routeAliases: [{ pathname: '/retired/[id]', subPath: 'entry,{id}' },
                { pathname: '/retired' }, { pathname: '/retired/new' },
                { pathname: '/retired/view', subPath: 'entry,{id}' }],
        }) }],
    } });
    const projection = normalizePluginInstalledUiDeclarations(entries, 'web');
    const previousScope = storage.getState().profileScope;
    const previousApplied = getAppliedActiveServerSnapshot();
    const previouslyAvailable = isAppliedActiveServerRuntimeAvailable();
    const scope = { serverId: 'home-aliases', accountId: 'account-aliases' };
    storage.setState({ profileScope: scope });
    publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://home.example', generation: 1 });
    // Cold declarations are ready before execution-facing plugin availability.
    const dispose = publishCommittedAppShellPluginUiProjection(input => input?.declarationsOnly
        && input.scope.serverId === scope.serverId && input.scope.accountId === scope.accountId ? projection : null);
    return () => {
        dispose();
        storage.setState({ profileScope: previousScope });
        publishAppliedActiveServerSnapshot(previousApplied, previouslyAvailable);
    };
}

describe('contributed app-page aliases', () => {
    it('canonicalizes workspace links from cold app-page declarations', () => {
        const dispose = installAliases();
        try {
            const root = '/plugins/acme.work/work';
            expect(resolvePluginAppPageRouteAlias('/retired', {})).toBe(root);
            expect(resolvePluginAppPageRouteAlias('/retired/new', { id: 'ignored' })).toBe(root);
            expect(resolvePluginAppPageRouteAlias('/retired/view', {})).toBe(root);
            expect(resolvePluginAppPageRouteAlias('/retired/view', { id: '' })).toBe(root);
            const id = 'task/a,%2F Ω';
            const expected = buildPluginAppPageRoutePath({ pluginId: 'acme.work', localId: 'work', subPath: `entry,${encodeURIComponent(id)}` });
            expect(resolvePluginAppPageRouteAlias('/retired/view', { id: [id, 'ignored'] })).toBe(expected);
            expect(workspaceRouteHref(`/retired/${encodeURIComponent(id)}`, { id, other: 'discarded' })).toBe(expected);
            expect(resolvePluginAppPageRouteAlias(`/retired/${encodeURIComponent(id)}`, { id: 'wrong-query' })).toBe(expected);
            expect(parsePluginAppPageRoutePath(expected)?.subPath).toBe(`entry,${encodeURIComponent(id)}`);
            expect(resolvePluginAppPageRouteAlias('/retired/%ZZ', {})).toBeNull();
            expect(resolvePluginAppPageRouteAlias('/retired/a/extra', {})).toBeNull();
            expect(resolvePluginAppPageRouteAlias('/other', {})).toBeNull();
            expect(workspaceRouteHref('/other', { id: 'preserved' })).toBe('/other?id=preserved');
            // Once the projection is prepared, repeated navigation reads never re-sort its routes.
            const sorting = vi.spyOn(Array.prototype, 'sort');
            try {
                for (let i = 0; i < 100; i++) expect(resolvePluginAppPageRouteAlias('/retired/new', {})).toBe(root);
                expect(sorting.mock.calls).toHaveLength(0);
            } finally { sorting.mockRestore(); }
        } finally { dispose(); }
        expect(resolvePluginAppPageRouteAlias('/retired', {})).toBeNull();
    });
});
