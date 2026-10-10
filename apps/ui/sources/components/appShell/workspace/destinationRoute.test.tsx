import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { findTestInstanceByTypeContainingText } from '@/dev/testkit/render/renderScreen';
import { DestinationInstanceHost } from './DestinationInstanceHost';
import { WorkspaceRouteOutlet } from './WorkspaceRouteOutlet';
import { Stack } from './destinationRoute';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const module = createExpoRouterMock().module;
    const { createRequire } = await import('node:module');
    const { readFileSync } = await import('node:fs');
    const { transformSync } = await import('esbuild');
    const react = await import('react');
    const require = createRequire(import.meta.url);
    const parserPath = require.resolve('expo-router/build/layouts/stack-utils/mapProtectedScreen');
    const sdkRequire = createRequire(parserPath);

    // Expo is the navigation boundary. Execute its installed declaration parser, with the
    // canonical testkit's Screen identity and inert native-header composition below it.
    const requireParserBoundary = (specifier: string): unknown => {
        if (specifier === 'react') return react;
        if (specifier === './StackScreen') return {
            StackScreen: module.Stack.Screen,
            appendScreenStackPropsToOptions: (options: unknown) => options,
        };
        if (specifier === './StackHeaderComponent') return { StackHeaderComponent: () => null };
        if (specifier === '../../views/Protected') return { Protected: () => null };
        if (specifier === '../../views/Screen') return { Screen: module.Stack.Screen };
        return sdkRequire(specifier);
    };
    const parserExports: Record<string, unknown> = {};
    const compiled = transformSync(readFileSync(parserPath, 'utf8'), {
        loader: 'jsx', jsxFactory: 'react_1.default.createElement',
    });
    new Function('require', 'exports', compiled.code)(requireParserBoundary, parserExports);
    // The installed SDK is an untyped external boundary after evaluating its published JS.
    const parse = parserExports.mapProtectedScreen as (props: { children?: React.ReactNode }) => {
        children: React.ReactElement<{ name?: string; options?: unknown }>[];
    };
    return {
        ...module,
        Stack: Object.assign((props: { children?: React.ReactNode; screenOptions?: unknown }) => {
            const parsed = parse(props);
            return react.createElement('SdkNavigator', {
                declarations: props.children, screens: parsed.children, screenOptions: props.screenOptions,
            });
        }, { Screen: module.Stack.Screen }),
    };
});

describe('destination route Stack declarations', () => {
    it('admits array declarations through the installed Expo parser, preserving keys and screen props', async () => {
        const options = { headerTitle: 'Collection' };
        const initialParams = { scope: 'home-a' };
        const getId = () => 'detail';
        const screenOptions = { headerShown: false };
        const declarations = [
            <Stack.Screen key="list-key" name="index" options={options} />,
            [null, <Stack.Screen key="detail-key" name="[id]" initialParams={initialParams} getId={getId} />],
        ] as const;
        const screen = await renderScreen(<Stack screenOptions={screenOptions}>{declarations}</Stack>);
        const navigator = screen.root.findByType('SdkNavigator');
        const admitted = navigator.props.screens as React.ReactElement<{ name: string; initialParams?: unknown; getId?: unknown }>[];
        expect(admitted.map((child) => child.props.name)).toEqual(['index', '[id]']);
        expect(admitted[1]?.props.initialParams).toBe(initialParams);
        expect(admitted[1]?.props.getId).toBe(getId);
        expect(navigator.props.screenOptions).toBe(screenOptions);
        const forwarded = navigator.props.declarations as typeof declarations;
        expect(forwarded[0]?.key).toBe('list-key');
        expect(forwarded[0]?.props.options).toBe(options);
        expect(forwarded[1]?.[1]?.key).toBe('detail-key');
    });

    it('keeps an empty unhosted Stack valid', async () => {
        const screen = await renderScreen(<Stack />);
        expect(screen.root.findByType('SdkNavigator').props.screens).toEqual([]);
    });

    it('updates a standalone Expo screen header outside a hosted destination', async () => {
        const options = { headerTitle: 'Phone title' };
        const screen = await renderScreen(<Stack.Screen options={options} />);
        expect(screen.root.findByType('StackScreen').props.options).toBe(options);
    });

    it('renders the hosted outlet without admitting declarations or writing a route-body header', async () => {
        const screen = await renderScreen(<DestinationInstanceHost tabId="settings-tab"
            ref={{ kind: 'settings', params: { pageId: 'prompts' } }}
            pathname="/settings/prompts" focused visible>
            <WorkspaceRouteOutlet.Provider value={React.createElement('HostedRouteBody')}>
                <Stack><Stack.Screen name="index" /></Stack>
                <Stack.Screen options={{ headerTitle: 'Hosted title' }} />
            </WorkspaceRouteOutlet.Provider>
        </DestinationInstanceHost>);
        expect(screen.root.findAllByType('HostedRouteBody')).toHaveLength(1);
        expect(screen.root.findAllByType('SdkNavigator')).toHaveLength(0);
        expect(screen.root.findAllByType('StackScreen')).toHaveLength(0);
    });

    it('draws a hosted phone header subtitle the same way the native stack header does', async () => {
        const options = { headerTitle: 'happier', headerSubtitle: 'happier-dev/happier' };
        const screen = await renderScreen(<DestinationInstanceHost tabId="project-tab"
            ref={{ kind: 'project', params: { workspaceRefId: 'w1' } }}
            pathname="/projects/w1/overview" focused visible phone>
            <WorkspaceRouteOutlet.Provider value={null}>
                <Stack.Screen options={options} />
            </WorkspaceRouteOutlet.Provider>
        </DestinationInstanceHost>);
        const header = screen.root.findByProps({ testID: 'workspace-destination-header' });
        expect(findTestInstanceByTypeContainingText(header, 'Text', 'happier-dev/happier')).toBeDefined();
    });
});
