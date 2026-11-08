// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ setOptions: vi.fn() }));
vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ navigation }).module);

const { useNavigationHeaderActions } = await import('../NavigationHeaderActions');
const { PageHeaderMenu, PageHeaderStateSwitch } = await import('../PageHeaderEntityParts');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { ToolbarButton } = await import('@/components/ui/buttons/ToolbarButton');
const { SectionActionButton } = await import('@/components/ui/lists/SectionActionButton');
const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
// The bar is a size scope around one row of controls; its children are that row's.
function barOf(header: React.ReactElement<{ children: React.ReactNode }>): React.ReactNode {
    const row = header.props.children as React.ReactElement<{ children: React.ReactNode }>;
    return row.props.children;
}
const { Button: PluginButton } = await import('../../../../../../../packages/plugin-ui/src/components/Button');

it('folds a page\'s header operations into rows of the one phone menu, in their visible words, destructive last (DESIGN-15 R4, DESIGN-16 D7)', async () => {
    const pause = vi.fn();
    const stop = vi.fn();
    const runAgain = vi.fn();
    const remove = vi.fn();
    const actions = <View style={{ flexDirection: 'row' }}>
        <View><ToolbarButton testID="run-again" label="Run again" onPress={runAgain} /></View>
        <SectionActionButton testID="pause" title="Pause" accessibilityLabel="Pause at the next step" icon="pause-circle" onPress={pause} />
        <PluginButton testID="stop" title="Stop" variant="destructive" busy disabled onPress={stop} />
        <ToolbarButton testID="host-stop" label="Stop" destructive busy disabled onPress={vi.fn()} />
        <PluginButton testID="plugin-details" title="Plugin details" variant="secondary" onPress={vi.fn()} />
        <ItemRowActions title="More" compactThreshold={Number.POSITIVE_INFINITY} compactActionIds={[]} actions={[
            { id: 'delete', title: 'Delete history', icon: 'trash', destructive: true, onPress: remove },
            { id: 'details', title: 'Technical details', icon: 'info', selected: true, onPress: vi.fn() },
        ]} />
    </View>;
    function Publisher() {
        useNavigationHeaderActions({ enabled: true, primary: null, actions });
        return null;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
        await act(async () => root.render(<Publisher />));
        const options = navigation.setOptions.mock.calls.at(-1)?.[0] as { headerRight: () => React.ReactElement<{ children: React.ReactNode }> };
        const menu = React.Children.toArray(barOf(options.headerRight()))
            .find((child): child is React.ReactElement<React.ComponentProps<typeof PageHeaderMenu>> => React.isValidElement(child) && child.type === PageHeaderMenu);
        expect(menu).toBeDefined();
        // No strip of buttons and no second ⋯ above the rows.
        expect(menu!.props.content).toBeUndefined();
        expect(menu!.props.actions.map(action => action.title)).toEqual([
            'Run again', 'Pause', 'Plugin details', 'Technical details', 'Stop', 'Stop', 'Delete history',
        ]);
        const stopRow = menu!.props.actions.find(action => action.title === 'Stop');
        // A neutral desktop Stop is still a destructive row in the menu.
        expect(stopRow).toMatchObject({ disabled: true, loading: true, destructive: true });
        expect(menu!.props.actions.find(action => action.id === 'host-stop')).toMatchObject({ disabled: true, loading: true, destructive: true });
        expect(menu!.props.actions.at(-1)).toMatchObject({ destructive: true });
        expect(menu!.props.actions.find(action => action.title === 'Technical details')).toMatchObject({ checked: true });
        await menu!.props.actions[1]!.onSelect();
        await menu!.props.actions[0]!.onSelect();
        expect(pause).toHaveBeenCalledTimes(1);
        expect(runAgain).toHaveBeenCalledTimes(1);
    } finally {
        await act(async () => root.unmount());
    }
});

it('keeps a page\'s own menu trigger at the bar\'s trailing edge, after the folded menu, never inside it', async () => {
    const trailing = <View testID="add-menu-trigger" />;
    const actions = <ToolbarButton testID="hide" label="Hide account emails and IDs" active={false} onPress={vi.fn()} />;
    function Publisher() {
        useNavigationHeaderActions({ enabled: true, primary: null, actions, trailing });
        return null;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
        await act(async () => root.render(<Publisher />));
        const options = navigation.setOptions.mock.calls.at(-1)?.[0] as { headerRight: () => React.ReactElement<{ children: React.ReactNode }> };
        const children = React.Children.toArray(barOf(options.headerRight())).filter(React.isValidElement);
        const menu = children.find((child): child is React.ReactElement<React.ComponentProps<typeof PageHeaderMenu>> => child.type === PageHeaderMenu);
        expect(menu!.props.actions.map(action => action.title)).toEqual(['Hide account emails and IDs']);
        expect((children.at(-1) as React.ReactElement<{ testID?: string }>).props.testID).toBe('add-menu-trigger');
    } finally {
        await act(async () => root.unmount());
    }
});

it('keeps an entity\'s one state switch visible on the bar and folds its labelled buttons into the one menu', async () => {
    const test = vi.fn();
    const remove = vi.fn();
    const actions = <View style={{ flexDirection: 'row' }}>
        <RoundButton testID="test" title="Test" disabled onPress={test} />
        <PageHeaderStateSwitch testID="enabled" label="Enabled" value={false} onValueChange={vi.fn()} />
        <PageHeaderMenu actions={[{ id: 'remove', title: 'Remove gateway', destructive: true, onSelect: remove }]} />
    </View>;
    function Publisher() {
        useNavigationHeaderActions({ enabled: true, primary: null, actions });
        return null;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
        await act(async () => root.render(<Publisher />));
        const options = navigation.setOptions.mock.calls.at(-1)?.[0] as { headerRight: () => React.ReactElement<{ children: React.ReactNode }> };
        const bar = React.Children.toArray(barOf(options.headerRight())).filter(React.isValidElement);
        const switchIndex = bar.findIndex(child => child.type === PageHeaderStateSwitch);
        const menuIndex = bar.findIndex(child => child.type === PageHeaderMenu);
        expect(switchIndex).toBeGreaterThanOrEqual(0);
        expect(switchIndex).toBeLessThan(menuIndex);
        const menu = bar[menuIndex] as React.ReactElement<React.ComponentProps<typeof PageHeaderMenu>>;
        expect(menu.props.content).toBeUndefined();
        expect(menu.props.actions.map(action => action.title)).toEqual(['Test', 'Remove gateway']);
        expect(menu.props.actions[0]).toMatchObject({ disabled: true });
    } finally {
        await act(async () => root.unmount());
    }
});
