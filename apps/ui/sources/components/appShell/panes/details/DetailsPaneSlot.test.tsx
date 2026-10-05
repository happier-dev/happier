import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { pressTestInstance, renderScreen } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from '../appPaneScopeHostTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    lastHostProps: null as any,
    deviceType: 'tablet' as 'phone' | 'tablet',
    pageRenders: 0,
}));

installAppPaneScopeHostCommonModuleMocks({
    getDimensions: () => ({ width: 1400, height: 900 }),
    getLocalSetting: (key) => (key === 'uiMultiPanePanelsEnabled' ? true : null),
    onSetLocalSetting: () => {},
});

// The column host is the presentational boundary: it draws `main` and the details pane as SIBLING columns, so the
// pane's content renders outside the plugin surface's own React tree, exactly as on device.
vi.mock('@/components/ui/panels/MultiPaneHostWithBottom', () => ({
    MultiPaneHostWithBottom: (props: any) => {
        state.lastHostProps = props;
        return React.createElement('Columns', null,
            React.createElement('MainColumn', null, props.mainPane ?? props.main),
            props.detailsPane ? React.createElement('DetailsColumn', null, props.detailsPane) : null,
        );
    },
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => state.deviceType,
    useHeaderHeight: () => 56,
}));

afterEach(() => {
    state.lastHostProps = null;
    state.deviceType = 'tablet';
    state.pageRenders = 0;
});

const { AppPaneProvider } = await import('../AppPaneProvider');
const { DetailsPaneSlotHost, useDetailsPaneSlotBinding } = await import('./DetailsPaneSlot');

async function mountPluginPage() {
    const { DetailsPane, Text, defineUiSurface, usePluginTheme } = await import('@happier-dev/plugin-ui');
    const { createSurfaceContextFixture } = await import('@happier-dev/plugin-sdk/testing');
    const { createPluginUiPrivatePresentationHost } = await import('@/components/plugins/surfaces/pluginUiPrivatePresentationHost');
    const { DetailsPaneSlotHost, useDetailsPaneSlotBinding } = await import('./DetailsPaneSlot');

    const context = createSurfaceContextFixture({ platform: 'ios' });
    // The Host API is the plugin boundary; this page calls none of it.
    const hostApi = {
        context: async () => context,
        watchContext: async () => ({ dispose() {} }),
        readResource: async () => { throw new Error('not read by this page'); },
    } as unknown as import('@happier-dev/plugin-sdk/ui').PluginUiHostApi;

    function Probe() {
        const theme = usePluginTheme();
        return (
            <>
                {React.createElement('ProbeFacts', { text: theme.colors.text })}
                <Text testID="probe-public-text" value="Plugin text" />
            </>
        );
    }

    let setDetailText: (value: string) => void = () => {};
    function PluginPage() {
        state.pageRenders += 1;
        const [open, setOpen] = React.useState(true);
        const [detailText, setText] = React.useState('first');
        setDetailText = setText;
        return (
            <DetailsPane open={open} title="Entry #2481" onClose={() => setOpen(false)} testID="entry-pane">
                <Probe />
                {React.createElement('DetailText', { text: detailText })}
            </DetailsPane>
        );
    }

    // The production mount path: the artifact's surface entry, with the host's private presentation bindings
    // applied to the entry element it returns (as `PluginSurfaceHost` does).
    const renderPage = defineUiSurface(PluginPage);
    const renderContext = { plugin: { id: 'happier.test', version: '1.0.0' }, surface: context, hostApi };
    function Mount() {
        const binding = useDetailsPaneSlotBinding();
        const presentationHost = React.useMemo(
            () => createPluginUiPrivatePresentationHost(undefined, binding === null ? {} : { detailsPane: binding }),
            [binding],
        );
        return React.useMemo(() => React.cloneElement(
            // A test boundary fixture: the fields this page's entry reads.
            renderPage(renderContext as unknown as import('@happier-dev/plugin-sdk/ui').RenderContext) as React.ReactElement<Record<string, unknown>>,
            { presentationHost },
        ), [presentationHost]);
    }

    // The details pane stands in the App's pane host, whose state is the app-lifetime pane provider's.
    const { AppPaneProvider } = await import('../AppPaneProvider');
    const screen = await renderScreen(
        <AppPaneProvider><DetailsPaneSlotHost testID="page-details"><Mount /></DetailsPaneSlotHost></AppPaneProvider>,
    );
    return { screen, context, setDetailText: (value: string) => act(() => setDetailText(value)) };
}

describe('DetailsPaneSlotHost (the page details pane a plugin DetailsPane renders in)', () => {
    it('transfers heading focus on an equal-title replacement with an unchanged body', async () => {
        const body = <React.Fragment>Shared detail</React.Fragment>;
        let focusedEntry: string | null = null;
        const heading = (entry: string): NonNullable<import('@happier-dev/plugin-ui/advanced').PluginUiDetailsPanePresentation['headingRef']> =>
            node => { if (node !== null) { node.focus(); focusedEntry = entry; } };
        const first = heading('first');
        const second = heading('second');
        function Publisher(props: Readonly<{ headingRef: typeof first }>) {
            const binding = useDetailsPaneSlotBinding();
            return <>{binding?.renderDetailsPane({ open: true, title: 'Entry', children: body,
                headingRef: props.headingRef, onClose() {} })}</>;
        }
        const tree = (headingRef: typeof first) => <AppPaneProvider><DetailsPaneSlotHost>
            <Publisher headingRef={headingRef} />
        </DetailsPaneSlotHost></AppPaneProvider>;
        // Native host handles are an OS boundary; the real slot and PaneHeader still bind the heading.
        const screen = await renderScreen(tree(first), { createNodeMock: () => ({ focus() {} }) });
        expect(focusedEntry).toBe('first');
        await screen.update(tree(second));
        expect(focusedEntry).toBe('second');
    });

    it('renders a plugin DetailsPane in the page details pane, beside the page, with the plugin context intact', async () => {
        const { screen, context } = await mountPluginPage();

        expect(state.lastHostProps.layout.details).toBe('docked');
        const pane = screen.root.findByType('DetailsColumn' as any);
        const main = screen.root.findByType('MainColumn' as any);
        // The detail is in the pane column and nowhere in the page.
        expect(pane.findAllByType('ProbeFacts' as any)).toHaveLength(1);
        expect(main.findAllByType('ProbeFacts' as any)).toHaveLength(0);
        // The plugin context crossed into the pane: its theme and a public component that reads the environment.
        expect(pane.findByType('ProbeFacts' as any).props.text).toBe(context.theme.colors.text);
        expect(pane.findAll((node) => node.props.testID === 'probe-public-text').length).toBeGreaterThan(0);
        // The pane's header band carries the plugin's title.
        expect(screen.findByTestId('entry-pane.header.title')?.props.children).toBe('Entry #2481');
    });

    it('updates the pane with the detail without re-rendering the page, and closes through the plugin', async () => {
        const { screen, setDetailText } = await mountPluginPage();
        const rendersBefore = state.pageRenders;
        setDetailText('second');
        expect(screen.root.findByType('DetailText' as any).props.text).toBe('second');
        // Only the plugin page itself re-rendered for its own state; the host page did not re-render it again.
        expect(state.pageRenders).toBe(rendersBefore + 1);

        await act(async () => { pressTestInstance(screen.findByTestId('entry-pane.header.close')); });
        expect(screen.root.findAllByType('ProbeFacts' as any)).toHaveLength(0);
        expect(screen.root.findAllByType('DetailsColumn' as any)).toHaveLength(0);
        expect(state.lastHostProps.layout.details).toBe('hidden');
    });

    it('pushes the detail inside the page on a phone, where there is no pane beside it', async () => {
        state.deviceType = 'phone';
        const { screen } = await mountPluginPage();
        expect(state.lastHostProps?.detailsPane ?? null).toBeNull();
        const main = screen.root.findByType('MainColumn' as any);
        expect(main.findAllByType('ProbeFacts' as any)).toHaveLength(1);
        expect(screen.findByTestId('entry-pane:back')).toBeTruthy();
    });
});
