import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Theme } from '@/theme';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from './navigationTestHelpers';

const appearance = vi.hoisted(() => ({ surfaces: undefined as Theme['surfaces'] }));

installNavigationCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
        { platformOS: 'ios' },
        { View: 'View', Pressable: React.forwardRef((props, ref) => React.createElement('Pressable', { ...props, ref })) },
    ),
    unistyles: async () => {
        const boundary = await (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock();
        // The real surface compiler feeds the native theme; only Unistyles is substituted.
        Object.defineProperty(boundary.useUnistyles().theme, 'surfaces', { get: () => appearance.surfaces });
        return boundary;
    },
});

const { SegmentedTabBar } = await import('./SegmentedTabBar');
const { prepareThemeCss } = await import('@/theme/css/prepareThemeCss');
const { HappierThemeSurfaceScope } = await import('@happier-dev/plugin-ui/presentation');

afterEach(() => {
    standardCleanup();
    appearance.surfaces = undefined;
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

it.each([false, true])('keeps authored native tab paint visible over selected material before/after measurement (measured=%s)', async (measured) => {
    const tabs = [{ id: 'chat', label: 'Chat', icon: <React.Fragment>chat</React.Fragment> }, { id: 'files', label: 'Files', icon: <React.Fragment>files</React.Fragment>, disabled: true }];
    async function mount() {
        const screen = await renderScreen(<SegmentedTabBar tabs={tabs} activeTabId="chat" onSelectTab={() => {}} iconPlacement="leading" testIDPrefix="native-tabs" />);
        if (measured) await act(async () => {
            screen.findHostByTestId('native-tabs:chat')!.props.onLayout({
                nativeEvent: { layout: { x: 0, width: 64, y: 0, height: 28 } },
            });
        });
        return screen;
    }
    const control = await mount();
    expect(control.root.findAllByType('Rect' as never).length).toBeGreaterThan(0);
    await control.unmount();

    appearance.surfaces = prepareThemeCss('[data-surface="tab-bar"][data-part="tab"] { background-color: rgba(120, 20, 80, 0.5); }').light;
    const styled = await mount();
    const selected = styled.findHostByTestId('native-tabs:chat')!;
    const surface = selected.findAllByType('View' as never).find(node => node.props.dataSet?.part === 'tab');
    expect(flattenStyle(surface?.props.style).backgroundColor).toBe(appearance.surfaces?.['tab-bar']?.tab?.base.backgroundColor);
    expect(styled.root.findAllByType('Rect' as never)).toHaveLength(0);
    for (const part of ['tab', 'label', 'icon']) {
        const matching = selected.findAll(node => node.props.dataSet?.surface === 'tab-bar' && node.props.dataSet?.part === part);
        expect(matching.length).toBeGreaterThan(0);
        expect(matching.every(node => node.props.dataSet.state === 'selected')).toBe(true);
    }
    const unavailable = styled.findHostByTestId('native-tabs:files')!;
    expect(unavailable.findAll(node => node.props.dataSet?.surface === 'tab-bar').every(node => node.props.dataSet.state === 'disabled')).toBe(true);
    if (measured) expect(flattenStyle(styled.findByTestId('native-tabs:thumb')!.props.style).backgroundColor).toBe('transparent');
    await styled.unmount();
});

it('keeps native recovery controls in their ordinary material despite authored tab paint', async () => {
    appearance.surfaces = prepareThemeCss('[data-surface="tab-bar"][data-part="tab"] { background-color: rgba(120, 20, 80, 0.5); }').light;
    const recovery = await renderScreen(<HappierThemeSurfaceScope enabled={false}>
        <SegmentedTabBar tabs={[{ id: 'theme', label: 'Theme' }]} activeTabId="theme" onSelectTab={() => {}} testIDPrefix="recovery-tabs" />
    </HappierThemeSurfaceScope>);
    const selected = recovery.findHostByTestId('recovery-tabs:theme')!;
    const surface = selected.findAllByType('View' as never).find(node => node.props.dataSet?.part === 'tab');
    expect(flattenStyle(surface?.props.style).backgroundColor).not.toBe(appearance.surfaces?.['tab-bar']?.tab?.base.backgroundColor);
    expect(recovery.root.findAllByType('Rect' as never).length).toBeGreaterThan(0);
    await recovery.unmount();
});

it('keeps the selected value semantic during focus, with disabled taking priority', async () => {
    const screen = await renderScreen(<SegmentedTabBar role="radiogroup"
        tabs={[{ id: 'fast', label: 'Fast' }, { id: 'careful', label: 'Careful', disabled: true }]}
        activeTabId="fast" onSelectTab={() => {}} testIDPrefix="value-tabs" />);
    const state = (id: string) => screen.findHostByTestId(`value-tabs:${id}`)!
        .findAllByType('View' as never).find(node => node.props.dataSet?.part === 'tab')?.props.dataSet.state;
    expect(state('fast')).toBe('selected');
    await act(async () => {
        screen.findHostByTestId('value-tabs:fast')!.props.onFocus({ target: { matches: () => true } });
    });
    expect(state('fast')).toBe('selected');
    await act(async () => {
        screen.findHostByTestId('value-tabs:careful')!.props.onFocus({ target: { matches: () => true } });
    });
    expect(state('careful')).toBe('disabled');
    await screen.unmount();
});

it('keeps a measured bar mounted when its selected tab leaves the catalog', async () => {
    const props = { activeTabId: 'chat', onSelectTab: () => {}, testIDPrefix: 'changing-tabs' };
    const screen = await renderScreen(<SegmentedTabBar {...props} tabs={[{ id: 'chat', label: 'Chat' }, { id: 'files', label: 'Files' }]} />);
    await act(async () => screen.findHostByTestId('changing-tabs:chat')!.props.onLayout({
        nativeEvent: { layout: { x: 0, width: 64, y: 0, height: 28 } },
    }));
    await screen.update(<SegmentedTabBar {...props} tabs={[{ id: 'files', label: 'Files' }]} />);
    expect(screen.findHostByTestId('changing-tabs:files')).not.toBeNull();
    await screen.unmount();
});
