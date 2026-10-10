/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { transform } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRouteHostingContext } from './WorkspaceRouteHostingContext';
import { WorkspaceRootStack } from './WorkspaceRootStack';

type DrawerProps = Readonly<{
    routeKey: string;
    options: Readonly<{ gestureEnabled?: boolean }>;
    renderScreen: () => React.ReactNode;
    onDismiss: () => void;
}>;
const boundary = vi.hoisted(() => ({ platform: 'web', renderScreen: (() => null) as () => React.ReactNode,
    Drawer: null as React.ComponentType<DrawerProps> | null, params: {} as Record<string, string | string[]>,
    options: {} as Record<string, { presentation?: string }>, dismissed: 0 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return boundary.platform; } } });
});
vi.mock('expo-router/build/fork/getPathFromState', async () => {
    const { loadInstalledExpoPathSerializer } = await import('@/dev/testkit/runtime/installedExpoPathSerializer');
    return loadInstalledExpoPathSerializer();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const module = createExpoRouterMock().module;
    // The native navigator is a system boundary. Its declared options drive the real installed
    // transparent drawer below; workspace admission is consumed through its real context.
    return { ...module, Stack: Object.assign((props: { children?: React.ReactNode }) => {
        const screens = React.Children.toArray(props.children);
        boundary.options = {};
        for (const screen of screens) {
            if (!React.isValidElement<{ name: string; options?: unknown }>(screen)) continue;
            const options = typeof screen.props.options === 'function'
                ? screen.props.options({ route: { name: screen.props.name, params: boundary.params }, navigation: {} })
                : screen.props.options;
            boundary.options[screen.props.name] = options as { presentation?: string };
        }
        const options = boundary.options['external/browse'];
        if (boundary.platform === 'web' && options?.presentation === 'transparentModal' && boundary.Drawer) {
            return <boundary.Drawer routeKey="history-route" options={options}
                renderScreen={boundary.renderScreen} onDismiss={() => { boundary.dismissed += 1; }} />;
        }
        return boundary.renderScreen();
    }, { Screen: module.Stack.Screen }) };
});

async function loadInstalledTransparentDrawer() {
    const require = createRequire(import.meta.url);
    const path = require.resolve('expo-router/build/modal/web/TransparentModalStackRouteDrawer.js');
    const { code } = await transform(await readFile(path, 'utf8'), { loader: 'jsx', jsx: 'automatic', format: 'cjs' });
    const localRequire = createRequire(path);
    // Published Expo JS is an untyped external boundary; preserve real React, Vaul and Radix.
    const module: { exports: { TransparentModalStackRouteDrawer?: React.ComponentType<DrawerProps> } } = { exports: {} };
    new Function('exports', 'require', 'module', '__filename', '__dirname', code)(module.exports,
        (id: string) => id === './modalStyles' ? {} : localRequire(id), module, path, dirname(path));
    if (!module.exports.TransparentModalStackRouteDrawer) throw new Error('Missing installed Expo transparent modal');
    return module.exports.TransparentModalStackRouteDrawer;
}

// Producer-output fixture, supplied through the real context rather than a mocked owner module.
// Provider tests separately exercise the real catalog, native/mobile-web policy and hydration.
const admittedHistory = (href: string) => href === '/external/browse';
function HistoryBody() { return <button data-testid="history-mode">Conversations</button>; }

describe('workspace root-stack modal admission', () => {
    let root: ReturnType<typeof createRoot>;
    let container: HTMLDivElement;
    beforeEach(async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        boundary.Drawer = await loadInstalledTransparentDrawer();
        boundary.platform = 'web'; boundary.params = {}; boundary.dismissed = 0;
        container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    });
    afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

    const render = (hosted: boolean, active: boolean) => {
        // The Expo sink is empty after the workspace hosts its body, or holds the URL/hydration
        // mirror beforehand. The provider integration suite exercises the real route entry.
        boundary.renderScreen = () => hosted ? active ? null : <span data-testid="hydrating" /> : <HistoryBody />;
        return <WorkspaceRouteHostingContext.Provider value={hosted ? admittedHistory : null}>
            <WorkspaceRootStack>
                <WorkspaceRootStack.Screen name="external/browse" options={() => ({ presentation: 'transparentModal', gestureEnabled: true })} />
                <WorkspaceRootStack.Screen name="new/index" options={{ presentation: 'modal' }} />
            </WorkspaceRootStack>
        </WorkspaceRouteHostingContext.Provider>;
    };

    it('does not mount an empty Vaul dialog around the workspace-owned scene, including hydration', async () => {
        await act(async () => { root.render(render(true, true)); });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.querySelector('[data-testid="history-mode"]')).toBeNull();
        await act(async () => { root.render(render(true, false)); });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.querySelector('[data-testid="hydrating"]')).not.toBeNull();
        expect(boundary.dismissed).toBe(0);
        expect(boundary.options['new/index'].presentation).toBe('modal');
    });
    it('keeps an unhosted web route in the real Vaul dialog', async () => {
        await act(async () => { root.render(render(false, false)); });
        expect(document.querySelector('[role="dialog"] [data-testid="history-mode"]')).not.toBeNull();
        expect(boundary.options['external/browse'].presentation).toBe('transparentModal');
    });
    it('passes qualified and ambiguous query shapes to the owner without flattening repeated values', async () => {
        boundary.renderScreen = () => null;
        const admitted = new Set(['/external/browse?serverId=home-a']);
        const renderQualified = () => <WorkspaceRouteHostingContext.Provider value={href => admitted.has(href)}>
            <WorkspaceRootStack><WorkspaceRootStack.Screen name="external/browse" options={{ presentation: 'transparentModal' }} /></WorkspaceRootStack>
        </WorkspaceRouteHostingContext.Provider>;
        boundary.params = { serverId: 'home-a' };
        await act(async () => { root.render(renderQualified()); });
        expect(boundary.options['external/browse'].presentation).toBe('card');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        boundary.params = { serverId: ['home-a', 'home-b'] };
        await act(async () => { root.render(renderQualified()); });
        expect(boundary.options['external/browse'].presentation).toBe('transparentModal');
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });
    it.each(['ios', 'android'])('preserves native presentation on %s even with workspace ownership', async platform => {
        boundary.platform = platform;
        await act(async () => { root.render(render(true, true)); });
        expect(boundary.options['external/browse'].presentation).toBe('transparentModal');
    });
});
