import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import PluginSettingsPageRoute from '@/app/(app)/settings/plugins/[pluginId]/[pageId]';
import PluginAppPageRootRoute from '@/app/(app)/plugins/[pluginId]/[localId]/index';
import PluginAppPageDeepLinkRoute from '@/app/(app)/plugins/[pluginId]/[localId]/[...subPath]';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { WorkspaceRouteEntry } from './createWorkspaceRouteEntry';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { createWorkspaceState } from './workspaceState';
import { NavigationTitleChromeProvider, PageHeader } from '@/components/ui/layout/PageHeader';
import { WorkspaceWindowTitle } from './WorkspaceWindowTitle';

const platform = vi.hoisted(() => ({ os: 'web' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return platform.os; }, select: (values: Record<string, unknown>) => values[platform.os] ?? values.default } });
});
// Expo's current native scene/module identity is an SDK boundary, independent of its global URL.
vi.mock('expo-router/build/Route', () => ({ useRouteNode: () => ({ contextKey: './(app)/workflows/index.tsx' }) }));

const windowTitle = vi.hoisted(() => ({ options: null as Readonly<Record<string, unknown>> | null }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ stackOptionsCapture: {
        record: options => { windowTitle.options = typeof options === 'function' ? options() : options; },
        reset: () => { windowTitle.options = null; },
        getRaw: () => windowTitle.options, getResolved: () => windowTitle.options,
    } }).module;
});

function workspace(active: boolean): WorkspaceNavigationContextValue {
    return {
        active, ownsRoute: true,
        state: createWorkspaceState({ id: 'settings', target: { kind: 'settings', params: {} }, pinned: false, preview: true }),
        canGoBack: false, canGoForward: false, openHref: () => true,
        activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
        navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
        registerBackStep: () => () => {}, back: () => {}, forward: () => {},
    };
}

describe('WorkspaceRouteEntry', () => {
    it('keeps native library identity and creation visible when the root declaration hides its header', async () => {
        platform.os = 'ios';
        function Body() {
            return <PageHeader title="Workflows"
                primaryAction={{ title: 'Create', onPress: () => {}, testID: 'workflow-create' }} />;
        }
        try {
            const screen = await renderScreen(<WorkspaceNavigationProvider value={{ ...workspace(false), ownsRoute: false }}>
                <NavigationTitleChromeProvider showsTitle showsBack><WorkspaceRouteEntry Body={Body} /></NavigationTitleChromeProvider>
            </WorkspaceNavigationProvider>);
            expect(screen.findByTestId('workflow-create')).not.toBeNull();
            expect(screen.getTextContent()).toContain('Workflows');
        } finally { platform.os = 'web'; }
    });
    it('updates the window title without republishing hidden Expo options while a retained page is renamed', async () => {
        const ref = { kind: 'workflow', params: { id: 'deploy' } };
        const base = { ...workspace(true), state: createWorkspaceState({ id: 'workflow-tab', target: ref, pinned: false, preview: false }) };
        const element = (title: string) => <WorkspaceNavigationProvider value={base}
            destinationTitles={{ 'workflow-tab': { ref, title } }}><WorkspaceWindowTitle /><WorkspaceRouteEntry Body={() => { throw new Error('Expo must not mount the workspace body'); }} /></WorkspaceNavigationProvider>;
        // The browser document is a platform boundary; title selection and route ownership stay real.
        const browserDocument = { title: '' };
        vi.stubGlobal('document', browserDocument);
        try {
            const screen = await renderScreen(element('Deploy Lumen'));
            const mirrorOptions = windowTitle.options;
            expect(browserDocument.title).toBe('Deploy Lumen');
            expect(mirrorOptions?.headerShown).toBe(false);
            await screen.update(element('Deploy renamed'));
            expect(browserDocument.title).toBe('Deploy renamed');
            expect(windowTitle.options).toBe(mirrorOptions);
        } finally { vi.unstubAllGlobals(); }
    });
    it.each([
        { route: 'Settings', RouteEntry: PluginSettingsPageRoute, testID: 'plugin-settings-page-hydrating' },
        { route: 'App root', RouteEntry: PluginAppPageRootRoute, testID: 'plugin-app-page-hydrating' },
        { route: 'App deep link', RouteEntry: PluginAppPageDeepLinkRoute, testID: 'plugin-app-page-hydrating' },
    ])('uses the plugin $route skeleton before Account/workspace hydration admits its body', async ({ RouteEntry, testID }) => {
        const screen = await renderScreen(<WorkspaceNavigationProvider value={workspace(false)}>
            <RouteEntry />
        </WorkspaceNavigationProvider>);
        expect(screen.findByTestId(`${testID}-loading-skeleton`)).not.toBeNull();
        expect(screen.getTextContent()).toBe('');
    });
    it('keeps the page-shaped loading fallback until the retained route owns the body, without mounting a temporary editable page', async () => {
        let mountedBodies = 0;
        function Body() { mountedBodies += 1; return React.createElement('EditablePage'); }
        const page = (active: boolean) => <WorkspaceNavigationProvider value={workspace(active)}>
            <WorkspaceRouteEntry Body={Body} loadingFallback={<PluginSurfaceFallback testID="cold-plugin-page" state="loading" />} />
        </WorkspaceNavigationProvider>;
        const screen = await renderScreen(page(false));
        expect(screen.findByTestId('cold-plugin-page-loading-skeleton')).not.toBeNull();
        expect(screen.getTextContent()).toBe('');
        expect(mountedBodies).toBe(0);
        await screen.update(page(true));
        expect(screen.findByTestId('cold-plugin-page-loading-skeleton')).toBeNull();
        expect(mountedBodies).toBe(0);
    });
});
