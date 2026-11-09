import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { measureMountedCollections, pressTestInstance, renderScreen } from '@/dev/testkit';
import { installAppPaneScopeHostCommonModuleMocks } from '../appPaneScopeHostTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    lastHostProps: null as any,
    deviceType: 'tablet' as 'phone' | 'tablet',
    pageRenders: 0,
    detailMounts: 0,
    deviceListeners: new Set<() => void>(),
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

vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/responsive')>(),
    useDeviceType: () => React.useSyncExternalStore((listener) => {
        state.deviceListeners.add(listener);
        return () => { state.deviceListeners.delete(listener); };
    }, () => state.deviceType),
    useHeaderHeight: () => 56,
}));

afterEach(() => {
    state.lastHostProps = null;
    state.deviceType = 'tablet';
    state.pageRenders = 0;
    state.detailMounts = 0;
});

const { AppPaneProvider } = await import('../AppPaneProvider');
const { DetailsPaneSlotHost, useDetailsPaneSlotBinding } = await import('./DetailsPaneSlot');
const { AppPaneScopeHost } = await import('../AppPaneScopeHost');
const { useAppPaneScope } = await import('../hooks/useAppPaneScope');

async function mountPluginPage(renderHost?: React.ComponentProps<typeof DetailsPaneSlotHost>['renderHost'], initiallyOpen = true) {
    const { DetailsPane, Text, defineUiSurface, usePluginTheme, useSurfaceContext } = await import('@happier-dev/plugin-ui');
    const { createSurfaceContextFixture } = await import('@happier-dev/plugin-sdk/testing');
    const { createPluginUiPrivatePresentationHost } = await import('@/components/plugins/surfaces/pluginUiPrivatePresentationHost');
    const { DetailsPaneSlotHost, useDetailsPaneSlotBinding } = await import('./DetailsPaneSlot');

    const context = createSurfaceContextFixture({ platform: 'ios',
        mount: { kind: 'destination', destination: { pluginId: 'happier.test', localId: 'page' }, container: 'appPage' },
        target: renderHost ? { kind: 'project', projectKey: 'test' } : { kind: 'app' },
    });
    // The Host API is the plugin boundary; this page calls none of it.
    const hostApi = {
        context: async () => context,
        watchContext: async () => ({ dispose() {} }),
        readResource: async () => { throw new Error('not read by this page'); },
    } as unknown as import('@happier-dev/plugin-sdk/ui').PluginUiHostApi;

    function Probe() {
        const theme = usePluginTheme();
        const surface = useSurfaceContext();
        const [instance] = React.useState(() => ++state.detailMounts);
        return (
            <>
                {React.createElement('ProbeFacts', { text: theme.colors.text, instance, target: surface.target })}
                <Text testID="probe-public-text" value="Plugin text" />
            </>
        );
    }

    let setDetailText: (value: string) => void = () => {};
    let setDetailOpen: (value: boolean) => void = () => {};
    function PluginPage() {
        state.pageRenders += 1;
        const [open, setOpen] = React.useState(initiallyOpen);
        setDetailOpen = setOpen;
        const [detailText, setText] = React.useState('first');
        setDetailText = setText;
        return (
            <DetailsPane open={open} title="Entry #2481" onClose={() => setOpen(false)} testID="entry-pane"
                footer={<Text testID="detail-primary" value="Run operation" />}>
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
        <AppPaneProvider><DetailsPaneSlotHost testID="page-details" renderHost={renderHost}><Mount /></DetailsPaneSlotHost></AppPaneProvider>,
    );
    return { screen, context, setDetailText: (value: string) => act(() => setDetailText(value)),
        setDetailOpen: (value: boolean) => act(() => setDetailOpen(value)) };
}

describe('DetailsPaneSlotHost (the page details pane a plugin DetailsPane renders in)', () => {
    it('runs the public Project author Collection through host pane, shared page action, and return', async () => {
        const { renderSurface } = await import('../../../../../../../packages/plugin-sdk/examples/public-authoring/ui/reviewPanelPortable');
        const { createSurfaceContextFixture } = await import('@happier-dev/plugin-sdk/testing');
        const { createPluginUiPrivatePresentationHost } = await import('@/components/plugins/surfaces/pluginUiPrivatePresentationHost');
        const context = createSurfaceContextFixture({
            mount: { kind: 'destination', destination: { pluginId: 'com.acme.review', localId: 'review-project-page' }, container: 'appPage' },
            target: { kind: 'project', projectKey: 'accepted-project' },
        });
        const replacePageLocation = vi.fn(async (subPath: string) => ({ subPath }));
        const readResource = vi.fn(async () => { throw new Error('The identity example needs no Resource or Machine'); });
        // Host API calls are the authored plugin's external boundary.
        const hostApi = { context: async () => context, watchContext: async () => ({ dispose() {} }),
            replacePageLocation, readResource } as unknown as import('@happier-dev/plugin-sdk/ui').PluginUiHostApi;
        function Mount() {
            const binding = useDetailsPaneSlotBinding();
            const presentationHost = React.useMemo(() => createPluginUiPrivatePresentationHost(undefined,
                binding ? { detailsPane: binding } : {}), [binding]);
            return React.cloneElement(renderSurface({ plugin: { id: 'com.acme.review', version: '1.0.0' },
                surface: context, hostApi, signal: new AbortController().signal, subPath: '' }) as React.ReactElement<Record<string, unknown>>,
            { presentationHost });
        }
        const screen = await renderScreen(<AppPaneProvider><DetailsPaneSlotHost renderHost={({ main, details, onCloseDetails }) => (
            <AppPaneScopeHost scopeId="project:external-example" main={main}
                destinationDetails={details ? { pane: details.content, onClose: onCloseDetails } : undefined} />
        )}><Mount /></DetailsPaneSlotHost></AppPaneProvider>);
        expect(screen.root.findAllByType('DetailsColumn' as never)).toHaveLength(0);
        await measureMountedCollections(screen, { width: 1000, height: 700 });
        await screen.pressByTestIdAsync('review.project.identity');
        expect(screen.root.findByType('DetailsColumn' as never).findAll(node => node.props.testID === 'review.project.key').length).toBeGreaterThan(0);
        const { TextField } = await import('@happier-dev/plugin-ui');
        await act(async () => { screen.root.findByType(TextField).props.onChange('Retain this review note'); });
        replacePageLocation.mockResolvedValueOnce({ subPath: 'identity' });
        await screen.pressByTestIdAsync('review.project.openAsPage');
        expect(screen.root.findAllByType('DetailsColumn' as never)).toHaveLength(1);
        expect(screen.findByTestId('review.project.return')).toBeNull();
        await screen.pressByTestIdAsync('review.project.openAsPage');
        expect(replacePageLocation).toHaveBeenLastCalledWith('identity/page', { backLocation: 'identity' });
        expect(screen.root.findAllByType('DetailsColumn' as never)).toHaveLength(0);
        expect(screen.root.findByType(TextField).props.value).toBe('Retain this review note');
        await screen.pressByTestIdAsync('review.project.return');
        expect(replacePageLocation).toHaveBeenLastCalledWith('identity', { backLocation: '' });
        expect(screen.root.findAllByType('DetailsColumn' as never)).toHaveLength(1);
        expect(screen.root.findByType(TextField).props.value).toBe('Retain this review note');
        expect(readResource).not.toHaveBeenCalled();
    });
    it('does not mount a closed external detail, then mounts only that detail on demand', async () => {
        const { screen, setDetailOpen } = await mountPluginPage(undefined, false);
        expect(state.detailMounts).toBe(0);
        expect(screen.root.findAllByType('DetailsColumn' as never)).toHaveLength(0);
        setDetailOpen(true);
        expect(state.detailMounts).toBe(1);
        setDetailOpen(false);
        expect(screen.root.findAllByType('ProbeFacts' as never)).toHaveLength(0);
    });
    it('keeps equal publications local: thirty relevant refreshes cause zero frame renders or detail remounts', async () => {
        let frames = 0;
        let mounts = 0;
        let refresh: () => void = () => {};
        function Detail() {
            React.useEffect(() => { mounts += 1; }, []);
            return React.createElement('StableDetail');
        }
        const body = <Detail />;
        const onClose = () => {};
        function Publisher() {
            const [, setRevision] = React.useState(0);
            refresh = () => setRevision(value => value + 1);
            const binding = useDetailsPaneSlotBinding();
            return <>{binding?.renderDetailsPane({ open: true, title: 'Stable detail', children: body, onClose })}</>;
        }
        const screen = await renderScreen(<AppPaneProvider><DetailsPaneSlotHost renderHost={({ main, details, onCloseDetails }) => {
            frames += 1;
            return <AppPaneScopeHost scopeId="project:stable" main={main}
                destinationDetails={details ? { pane: details.content, onClose: onCloseDetails } : undefined} />;
        }}><Publisher /></DetailsPaneSlotHost></AppPaneProvider>);
        const settledFrames = frames;
        expect(settledFrames).toBeGreaterThan(0);
        const settledHost = state.lastHostProps;
        for (let index = 0; index < 30; index += 1) await act(async () => refresh());
        expect(frames - settledFrames).toBe(0);
        expect(state.lastHostProps).toBe(settledHost);
        expect(mounts).toBe(1);
        expect(screen.root.findAllByType('StableDetail' as never)).toHaveLength(1);
    });
    it('composes an external detail into one existing Project host without the default App host', async () => {
        const renderHost: NonNullable<React.ComponentProps<typeof DetailsPaneSlotHost>['renderHost']> = ({ main, details, onCloseDetails }) => (
            <AppPaneScopeHost scopeId="project:test" main={main}
                detailsPaneEnabled detailsPaneBuiltinAdapter={{ destinationIds: ['details'], defaultDestinationId: 'details', render: () => 'Builtin details' }}
                destinationDetails={details ? { pane: details.content, onClose: onCloseDetails } : undefined} />
        );
        const { screen, setDetailText, setDetailOpen } = await mountPluginPage(renderHost);
        expect(screen.findAllByType(AppPaneScopeHost)).toHaveLength(1);
        expect(screen.findByType(AppPaneScopeHost).props.scopeId).toBe('project:test');
        expect(screen.root.findByType('DetailsColumn' as never).findAllByType('ProbeFacts' as never)).toHaveLength(1);
        expect(screen.root.findByType('ProbeFacts' as never).props.target).toEqual({ kind: 'project', projectKey: 'test' });
        const hostBefore = state.lastHostProps;
        setDetailText('updated without reopening');
        expect(state.lastHostProps).toBe(hostBefore);
        expect(screen.root.findByType('DetailText' as never).props.text).toBe('updated without reopening');
        setDetailOpen(false);
        expect(screen.findByType(AppPaneScopeHost).props.destinationDetails).toBeUndefined();
        expect(screen.root.findAllByType('DetailsColumn' as never)).toHaveLength(0);
    });
    it('retracts a page publication to the saved builtin details selection in the same Project scope', async () => {
        let pane: ReturnType<typeof useAppPaneScope> | null = null;
        function SavedSelection() {
            pane = useAppPaneScope('project:saved');
            return null;
        }
        const renderHost: NonNullable<React.ComponentProps<typeof DetailsPaneSlotHost>['renderHost']> = ({ main, details, onCloseDetails }) => (
            <AppPaneScopeHost scopeId="project:saved" main={<>{main}<SavedSelection /></>}
                detailsPaneEnabled detailsPaneBuiltinAdapter={{ destinationIds: ['details'], defaultDestinationId: 'details', render: () => React.createElement('SavedBuiltin') }}
                destinationDetails={details ? { pane: details.content, onClose: onCloseDetails } : undefined} />
        );
        const { screen, setDetailOpen } = await mountPluginPage(renderHost);
        await act(async () => { pane!.openDetailsTab({ key: 'file:retained', kind: 'file', title: 'Retained file', resource: {} }, { intent: 'pinned' }); });
        expect(screen.root.findAllByType('SavedBuiltin' as never)).toHaveLength(0);
        setDetailOpen(false);
        expect(screen.root.findAllByType('SavedBuiltin' as never)).toHaveLength(1);
        expect(pane!.scopeState?.details.activeTabKey).toBe('file:retained');
        expect(pane!.scopeState?.details.tabs.map(tab => tab.key)).toContain('file:retained');
        setDetailOpen(true);
        expect(screen.root.findAllByType('SavedBuiltin' as never)).toHaveLength(0);
        await act(async () => { state.lastHostProps.onCloseDetails(); });
        expect(screen.root.findAllByType('SavedBuiltin' as never)).toHaveLength(1);
        expect(pane!.scopeState?.details.activeTabKey).toBe('file:retained');
    });
    it.each(['tablet', 'phone'] as const)('preserves an external plugin detail across viewport changes (opened on %s)', async (openedOn) => {
        state.deviceType = openedOn;
        const { screen, setDetailOpen } = await mountPluginPage();
        const original = screen.root.findByType('ProbeFacts' as never).props.instance;
        for (const next of [openedOn === 'tablet' ? 'phone' : 'tablet', openedOn] as const) {
            await act(async () => {
                state.deviceType = next;
                state.deviceListeners.forEach((listener) => listener());
            });
            expect(screen.root.findAllByType('ProbeFacts' as never)).toHaveLength(1);
            expect(screen.root.findByType('ProbeFacts' as never).props.instance).toBe(original);
            if (openedOn === 'tablet') expect(state.lastHostProps.layout.details).not.toBe('hidden');
            else expect(screen.findByTestId('entry-pane:back')).toBeTruthy();
            expect(screen.findAllByTestId('detail-primary').length > 0).toBe(openedOn === 'phone' || next === 'phone');
        }
        expect(state.detailMounts).toBe(1);
        await act(async () => {
            state.deviceType = openedOn === 'tablet' ? 'phone' : 'tablet';
            state.deviceListeners.forEach((listener) => listener());
        });
        setDetailOpen(false);
        setDetailOpen(true);
        expect(screen.root.findAllByType('DetailsColumn' as never)).toHaveLength(openedOn === 'tablet' ? 0 : 1);
    });
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

    it('draws the identity mark beside the title and the mark leading the line in the pane header band', async () => {
        function Publisher() {
            const binding = useDetailsPaneSlotBinding();
            return <>{binding?.renderDetailsPane({
                open: true,
                title: 'Move cart totals to server-side rounding',
                subtitle: 'tidewater/checkout-web #2476 · You opened 42m ago',
                leading: React.createElement('KindMark'),
                subtitleLeading: React.createElement('SourceMark'),
                children: 'Detail',
                onClose() {},
                testID: 'entry',
            })}</>;
        }
        const screen = await renderScreen(<AppPaneProvider><DetailsPaneSlotHost><Publisher /></DetailsPaneSlotHost></AppPaneProvider>);
        const header = screen.root.find((node) => node.props.testID === 'entry.header' && typeof node.type !== 'string');
        expect(header.findAllByType('KindMark' as any)).toHaveLength(1);
        expect(header.findAllByType('SourceMark' as any)).toHaveLength(1);
        expect(screen.getTextContent()).toContain('tidewater/checkout-web #2476 · You opened 42m ago');
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

describe('DetailCompanionPane (a host page\'s companion in the same page details pane)', () => {
    async function mountHostCompanion(onClose: () => void) {
        const { DetailCompanionPane } = await import('./DetailsPaneSlot');
        const captured: { companion?: boolean | undefined } = {};
        function EnvironmentPage() {
            return <>
                {React.createElement('EnvironmentBody')}
                <DetailCompanionPane open title="Logs" onClose={onClose} testID="environment-logs">
                    {React.createElement('LogsBody')}
                </DetailCompanionPane>
            </>;
        }
        const screen = await renderScreen(<AppPaneProvider><DetailsPaneSlotHost renderHost={({ main, details, onCloseDetails }) => {
            captured.companion = details?.companion;
            return <AppPaneScopeHost scopeId="project:companion" main={main}
                destinationDetails={details ? { pane: details.content, onClose: onCloseDetails, ...(details.companion ? { companion: true as const } : {}) } : undefined} />;
        }}><EnvironmentPage /></DetailsPaneSlotHost></AppPaneProvider>);
        return { screen, captured };
    }

    it('docks the companion beside the page it was opened from, under a pane header (not an item title)', async () => {
        const onClose = vi.fn();
        const { screen, captured } = await mountHostCompanion(onClose);
        const details = screen.root.findByType('DetailsColumn' as never);
        expect(details.findAllByType('LogsBody' as never)).toHaveLength(1);
        expect(screen.root.findByType('MainColumn' as never).findAllByType('EnvironmentBody' as never)).toHaveLength(1);
        expect(captured.companion).toBe(true);
        // A companion beside its page: the page never steps aside for it.
        expect(state.lastHostProps.mainOwnsDetails).not.toBe(true);
        const header = details.findAll(node => node.props.testID === 'environment-logs.header' && typeof node.props.onClose === 'function')[0]!;
        expect(header.props.title).toBe('Logs');
        expect(header.props.size).toBeUndefined();
        await act(async () => header.props.onClose());
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('pushes the companion inside the page on a phone, with its way back', async () => {
        state.deviceType = 'phone';
        const onClose = vi.fn();
        const { screen } = await mountHostCompanion(onClose);
        expect(state.lastHostProps?.detailsPane ?? null).toBeNull();
        const main = screen.root.findByType('MainColumn' as never);
        expect(main.findAllByType('LogsBody' as never)).toHaveLength(1);
        const header = main.findAll(node => node.props.testID === 'environment-logs.header' && typeof node.props.onClose === 'function')[0]!;
        await act(async () => header.props.onClose());
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
