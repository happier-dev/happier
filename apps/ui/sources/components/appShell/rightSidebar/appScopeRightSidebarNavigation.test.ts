import { describe, expect, it, vi } from 'vitest';

import {
    APP_PANE_SCOPE_ID,
    openAppRightSidebarTab,
} from './appScopeRightSidebarNavigation';

const INSPECTOR = Object.freeze({ pluginId: 'happier.inspector', localId: 'inspector-panel' });

function harness(overrides: Partial<Parameters<typeof openAppRightSidebarTab>[0]> = {}) {
    const selected: Array<[string, unknown]> = [];
    const navigate = vi.fn();
    openAppRightSidebarTab({
        destination: INSPECTOR,
        activeScopeId: 'session:abc',
        sidePanesAvailable: true,
        pathname: '/session/abc',
        select: (scopeId, destination) => { selected.push([scopeId, destination]); },
        navigate,
        ...overrides,
    });
    return { selected, navigate };
}

describe('openAppRightSidebarTab', () => {
    it('selects the actual reopened App page scope after its navigation is admitted', () => {
        let opened: ((scopeId: string) => void) | undefined;
        const result = harness({ activeScopeId: null, openAppPage: (_href, onOpened) => { opened = onOpened; } });
        expect(result.selected).toEqual([]);
        opened?.('workspace:pane:existing-panels:app');
        expect(result.selected).toEqual([['workspace:pane:existing-panels:app', { kind: 'plugin', destination: INSPECTOR }]]);
        expect(result.navigate).not.toHaveBeenCalled();
    });
    it("opens an App panel in the right sidebar of the page on screen, without navigating", () => {
        const onSession = harness();
        expect(onSession.selected).toEqual([['session:abc', { kind: 'plugin', destination: INSPECTOR }]]);
        expect(onSession.navigate).not.toHaveBeenCalled();

        const onPlugins = harness({ activeScopeId: APP_PANE_SCOPE_ID, pathname: '/plugins' });
        expect(onPlugins.selected).toEqual([[APP_PANE_SCOPE_ID, { kind: 'plugin', destination: INSPECTOR }]]);
        expect(onPlugins.navigate).not.toHaveBeenCalled();
    });

    it('pushes the panel as its own page under Plugins on a phone, or where the page has no right sidebar', () => {
        const route = '/plugins/panels?pluginId=happier.inspector&destinationId=inspector-panel';
        const phone = harness({ sidePanesAvailable: false });
        expect(phone.selected).toEqual([[APP_PANE_SCOPE_ID, { kind: 'plugin', destination: INSPECTOR }]]);
        expect(phone.navigate).toHaveBeenCalledWith(route);

        const noSidebar = harness({ activeScopeId: null, pathname: '/settings/appearance' });
        expect(noSidebar.navigate).toHaveBeenCalledWith(route);

        // Already on that page: the selection moves, history does not grow.
        const already = harness({ sidePanesAvailable: false, pathname: '/plugins/panels' });
        expect(already.navigate).not.toHaveBeenCalled();
    });
});
