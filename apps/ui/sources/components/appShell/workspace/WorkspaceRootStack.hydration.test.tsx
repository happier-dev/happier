import * as React from 'react';
import { BaseNavigationContainer, createNavigationContainerRef, createNavigatorFactory, StackRouter, useNavigationBuilder } from '@react-navigation/core';
import { afterEach, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { loadInstalledExpoPathSerializer } from '@/dev/testkit/runtime/installedExpoPathSerializer';

// These are real installed navigators. A lazy app layout has no child getState
// listener during boot, exactly when the live export discarded its parsed leaf.
function LazyLayoutNavigator(props: Readonly<{ children: React.ReactNode }>) {
    const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, { children: props.children });
    return <NavigationContent>{descriptors[state.routes[state.index].key].render()}</NavigationContent>;
}
const Root = createNavigatorFactory(LazyLayoutNavigator)();
const PendingLayout = () => null;

afterEach(standardCleanup);

it.each([
    ['session/[id]', '/session/session-a/info?serverId=home-a', { id: 'session-a' }, {
        routes: [{ name: 'info', params: { id: 'session-a', serverId: 'home-a' } }],
    }],
    ['machine/[id]/index', '/machine/machine-a?serverId=home-a', { id: 'machine-a', serverId: 'home-a' }, undefined],
    ['machine/[id]/installables', '/machine/machine-a/installables?serverId=home-a', { id: 'machine-a', serverId: 'home-a' }, undefined],
] as const)('preserves the cold parsed %s leaf and Home before its lazy navigator registers', async (name, href, params, state) => {
    const navigation = createNavigationContainerRef();
    const serializer = await loadInstalledExpoPathSerializer();
    const getPathFromState = serializer.getPathFromState;
    if (typeof getPathFromState !== 'function') throw new Error('Installed Expo path serializer unavailable');
    await renderScreen(<BaseNavigationContainer ref={navigation} initialState={{ routes: [{
        name: 'App', params: { id: params.id }, state: { routes: [{ name, params, ...(state ? { state } : {}), path: href }] },
    }] }}>
        <Root.Navigator><Root.Screen name="App" component={PendingLayout} /></Root.Navigator>
    </BaseNavigationContainer>);
    const projected = getPathFromState(navigation.getRootState(), { screens: { App: { path: '', screens: {
        'session/[id]': { path: 'session/:id', screens: { info: 'info' } },
        'machine/[id]/index': 'machine/:id',
        'machine/[id]/installables': 'machine/:id/installables',
    } } } });
    expect(projected).toBe(href);
});
