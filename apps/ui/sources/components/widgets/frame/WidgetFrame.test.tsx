import * as React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import * as Unistyles from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { WidgetFrame } from './WidgetFrame';
import { renderWidgetSizeMenuSection } from './WidgetSizeControl';
import { darkTheme, lightTheme } from '@/theme';
import { SessionBoardDeclarativeContent } from '@/components/sessions/board/SessionBoardDeclarativeContent';
import { WidgetGroupFrame } from '@/components/widgets/group/WidgetGroupFrame';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { UsageBodyInsufficient } from '@/components/settings/usage/widgets/usageBodyKit';
import { HappierSurfaceState } from '@happier-dev/plugin-ui/presentation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// The window class is the platform boundary: a phone stacks cards in one column.
const device = vi.hoisted(() => ({ type: undefined as 'phone' | 'tablet' | undefined }));
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return { ...actual, useDeviceType: () => { const measured = actual.useDeviceType(); return device.type ?? measured; } };
});

afterEach(() => {
    device.type = undefined;
    standardCleanup();
});

async function renderFrame(props: Partial<React.ComponentProps<typeof WidgetFrame>> = {}) {
    const screen = await renderScreen(
        <WidgetFrame
            testID="frame"
            frameStyle="card"
            placement="home"
            mark="timer"
            title="Latest runs"
            source="Automations"
            body={{ kind: 'content', children: 'rows:here' }}
            {...props}
        />,
    );
    await flushHookEffects({ cycles: 2 });
    return screen;
}

describe('WidgetFrame', () => {
    it('puts a plugin body\'s header content (its live fact and its plus) in its frame\'s header, as a tab puts it in its pane header', async () => {
        const { WidgetFrameBodyMetaContext } = await import('./widgetFrameBodyCaption');
        const { useWidgetFrameHeaderBinding } = await import('./widgetFrameHeaderBinding');
        // What `PaneHeaderContent` calls from inside a plugin widget body.
        function PluginBody() {
            const binding = useWidgetFrameHeaderBinding();
            return <>{binding === null ? 'no-binding' : binding.renderPaneHeader({
                line: [{ text: '3 in progress', attention: true }],
                actions: <Pressable testID="plugin-plus" accessibilityLabel="New task" onPress={() => {}} />,
            })}rows:here</>;
        }
        function Placement() {
            const [meta, setMeta] = React.useState<React.ReactNode>(null);
            return (
                <WidgetFrameBodyMetaContext.Provider value={setMeta}>
                    <WidgetFrame testID="frame" frameStyle="card" placement="home" mark="list" title="My tasks"
                        meta={meta} body={{ kind: 'content', children: <PluginBody /> }} />
                </WidgetFrameBodyMetaContext.Provider>
            );
        }
        const screen = await renderScreen(<Placement />);
        await flushHookEffects({ cycles: 3 });
        expect(screen.getTextContent()).toContain('3 in progress');
        expect(screen.findByTestId('plugin-plus')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('no-binding');
        // Outside a frame that lends its header, the body draws nothing in its place.
        const bare = await renderScreen(<PluginBody />);
        expect(bare.getTextContent()).toContain('no-binding');
    });

    it('names a plugin body\'s source by the caption it lends, in place of its plugin, and the plugin again once it stops', async () => {
        const { WidgetFrameBodyCaptionContext, WidgetFrameBodyMetaContext } = await import('./widgetFrameBodyCaption');
        const { useWidgetFrameHeaderBinding } = await import('./widgetFrameHeaderBinding');
        // What `PaneHeaderContent caption="Tasks"` calls from inside a plugin widget body.
        function PluginBody(props: Readonly<{ caption: string | null }>) {
            const binding = useWidgetFrameHeaderBinding();
            return <>{binding?.renderPaneHeader({ line: null, actions: null, caption: props.caption })}rows:here</>;
        }
        let setCaptionProp: (caption: string | null) => void = () => {};
        function Placement() {
            const [caption, setCaption] = React.useState<string | null>('Tasks');
            setCaptionProp = setCaption;
            const [bodyCaption, setBodyCaption] = React.useState<string | null>(null);
            const [meta, setMeta] = React.useState<React.ReactNode>(null);
            return (
                <WidgetFrameBodyCaptionContext.Provider value={setBodyCaption}>
                <WidgetFrameBodyMetaContext.Provider value={setMeta}>
                    <WidgetFrame testID="frame" frameStyle="card" placement="home" mark="check-square" title="Due this week"
                        source={bodyCaption ?? 'PRs, Issues & Tasks'} meta={meta}
                        body={{ kind: 'content', children: <PluginBody caption={caption} /> }} />
                </WidgetFrameBodyMetaContext.Provider>
                </WidgetFrameBodyCaptionContext.Provider>
            );
        }
        const screen = await renderScreen(<Placement />);
        await flushHookEffects({ cycles: 3 });
        expect(screen.getTextContent()).toContain('Tasks');
        expect(screen.getTextContent()).not.toContain('PRs, Issues & Tasks');
        await act(async () => { setCaptionProp(null); });
        await flushHookEffects({ cycles: 3 });
        expect(screen.getTextContent()).toContain('PRs, Issues & Tasks');
    });

    it('leads a capped plugin body to the page it names from the frame\'s one footer link, over the placement\'s generic Open, never over a failed refresh', async () => {
        const { WidgetFrameBodyMetaContext } = await import('./widgetFrameBodyCaption');
        const { useWidgetFrameHeaderBinding } = await import('./widgetFrameHeaderBinding');
        const openTasks = vi.fn();
        const openPlugin = vi.fn();
        // What `PaneHeaderContent caption="Tasks" onOpen={…}` calls from inside a plugin widget body.
        function PluginBody() {
            const binding = useWidgetFrameHeaderBinding();
            return <>{binding?.renderPaneHeader({ line: null, actions: null, caption: 'Tasks', open: openTasks })}rows:here</>;
        }
        function Placement(props: Readonly<{ footer: React.ComponentProps<typeof WidgetFrame>['footer'] }>) {
            const [meta, setMeta] = React.useState<React.ReactNode>(null);
            return (
                <WidgetFrameBodyMetaContext.Provider value={setMeta}>
                    <WidgetFrame testID="frame" frameStyle="card" placement="home" mark="check-square" title="My tasks"
                        meta={meta} footer={props.footer} body={{ kind: 'content', children: <PluginBody /> }} />
                </WidgetFrameBodyMetaContext.Provider>
            );
        }
        const screen = await renderScreen(<Placement footer={{ kind: 'open', label: 'Open PRs, Issues & Tasks', onPress: openPlugin }} />);
        await flushHookEffects({ cycles: 3 });
        // The text runtime renders the key with its parameters: the link names the body's page.
        expect(screen.getTextContent()).toContain('homeWidgets.open(destination=Tasks)');
        expect(screen.getTextContent()).not.toContain('Open PRs, Issues & Tasks');
        screen.pressByTestId('frame.open');
        expect(openTasks).toHaveBeenCalledTimes(1);
        expect(openPlugin).not.toHaveBeenCalled();

        // A failed refresh says why with Retry in that one row instead.
        const stale = await renderScreen(<Placement footer={{ kind: 'refreshFailed', reason: 'Couldn\'t refresh', onRetry: () => {} }} />);
        await flushHookEffects({ cycles: 3 });
        expect(stale.getTextContent()).toContain('Couldn\'t refresh');
        expect(stale.findByTestId('frame.open')).toBeNull();
    });

    it('draws a widget body\'s own empty state at the frame\'s step: centred in a card with room, one line in a compact one', async () => {
        const stateOf = (screen: Awaited<ReturnType<typeof renderFrame>>) => {
            const state = screen.root.findAllByType(SurfaceStateCard).find(card => card.props.testID === 'usage-empty')!;
            return state.findByType(HappierSurfaceState).props as { size?: string; layout?: string };
        };
        const body = { kind: 'content' as const, children: <UsageBodyInsufficient testID="usage-empty" title="No usage in this period"
            reason="Usage shows here once your agents run." /> };
        const card = await renderFrame({ body });
        expect(stateOf(card)).toMatchObject({ size: 'pane' });
        expect(stateOf(card).layout).toBeUndefined();
        standardCleanup();
        const compact = await renderFrame({ body, widgetPresentation: { size: 'wide',
            footprint: { columns: 2, columnSpan: 2, rowSpan: 1, height: 'compact', width: 'full' } } });
        expect(stateOf(compact)).toMatchObject({ size: 'line' });
        standardCleanup();
        // A card spanning the whole band reads its state at the wider measure, so a reason never wraps in a narrow column.
        const full = await renderFrame({ body, widgetPresentation: { size: 'full',
            footprint: { columns: 2, columnSpan: 2, rowSpan: 2, height: 'regular', width: 'full' } } });
        expect(stateOf(full)).toMatchObject({ size: 'details' });
    });

    it('draws every state action in a card quiet, so no card competes with the page\'s one primary', async () => {
        const buttonOf = (screen: Awaited<ReturnType<typeof renderFrame>>, testID: string) =>
            // The core button (a memo) is found by its props: the one node with this testID that takes the press.
            screen.root.findAll(node => node.props.testID === testID && typeof node.props.action === 'function')[0]!.props as { display?: string };
        const own = await renderFrame({ body: { kind: 'empty', title: 'No runs yet', reason: 'Runs show here.',
            action: { label: 'New workflow', onPress: vi.fn() } } });
        expect(buttonOf(own, 'frame.empty-action').display).toBe('secondary');
        standardCleanup();
        // A body's own state (Capacity's connect) takes the frame's decision too, even one that says it invites.
        const body = await renderFrame({ body: { kind: 'content', children: <SurfaceStateCard testID="usage-empty" kind="empty"
            title="No subscription connected" action={{ label: 'Connect a subscription', onPress: vi.fn(), invitation: true }} /> } });
        expect(buttonOf(body, 'usage-empty-action').display).toBe('secondary');
        standardCleanup();
        // Outside a card (a page or pane's one state) the invitation stays the filled primary.
        const page = await renderScreen(<SurfaceStateCard testID="page-empty" kind="empty" size="pane"
            title="No runs yet" action={{ label: 'New workflow', onPress: vi.fn() }} />);
        expect(buttonOf(page, 'page-empty-action').display).toBeUndefined();
    });

    it('compacts an empty grouped half body and restores its declared room when content arrives', async () => {
        const presentation = { size: 'tall' as const,
            footprint: { columns: 2, columnSpan: 1, rowSpan: 4, height: 'tall' as const, width: 'half' as const } };
        let observed: ReturnType<typeof useWidgetPresentation>;
        let mounts = 0;
        function Body(props: { empty: boolean; supplemental: boolean }) {
            observed = useWidgetPresentation();
            React.useEffect(() => { mounts += 1; }, []);
            return <>{!props.empty ? <Text testID="retained-facts">42 tokens</Text> : null}
                {props.empty ? <UsageBodyInsufficient testID="insufficient" title="Nothing recorded" /> : props.supplemental
                    ? <SurfaceStateCard kind="empty" size="line" title="No outcome recorded" /> : null}</>;
        }
        const render = (empty: boolean, supplemental = false) => <WidgetGroupFrame testID="group"
            group={{ id: 'group', frameStyle: 'card', dividers: 'hairline' }} placement="home" columns={2}
            cells={[{ id: 'one', columnSpan: 1, rowSpan: 4 }, { id: 'two', columnSpan: 1, rowSpan: 2 }]}
            customizing={false} title={null} accessibilityLabel="Group" renderChild={(id) =>
                <WidgetFrame testID={id} frameStyle="plain" placement="home" grouped title={id}
                    widgetPresentation={presentation} body={{ kind: 'content', children: id === 'one'
                        ? <Body empty={empty} supplemental={supplemental} /> : <Text>Other facts</Text> }} />} />;
        const screen = await renderScreen(render(false));
        const height = () => StyleSheet.flatten(screen.findByTestId('one.viewport')!.props.style).minHeight as number;
        const declaredHeight = height();
        await screen.update(render(true));
        await flushHookEffects({ cycles: 2 });
        expect(height()).toBe(declaredHeight / 4);
        expect(observed?.size).toBe('tall');
        expect(observed?.footprint.rowSpan).toBe(4);
        await screen.update(render(false, true));
        await flushHookEffects({ cycles: 2 });
        expect(height()).toBe(declaredHeight);
        expect(screen.findByTestId('retained-facts')).not.toBeNull();
        expect(mounts).toBe(1);
    });
    it('projects native body states through their enclosing grouped frame while loading and standalone frames keep their room', async () => {
        const widgetPresentation = { size: 'tall' as const,
            footprint: { columns: 2, columnSpan: 1, rowSpan: 4, height: 'tall' as const, width: 'half' as const } };
        const render = (empty: boolean, grouped = true) => <WidgetFrame testID="native" frameStyle="plain" placement="home"
            grouped={grouped} title="Native" widgetPresentation={widgetPresentation} body={{ kind: 'content', children:
                <WidgetFrame testID="native-body" frameStyle="plain" placement="home" presentation="body" title={null}
                    body={empty ? { kind: 'empty', title: 'No runs', reason: 'Runs will appear here' }
                        : { kind: 'loading', accessibilityLabel: 'Loading runs' }} /> }} />;
        const screen = await renderScreen(render(false));
        const height = () => {
            const style = StyleSheet.flatten(screen.findByTestId('native.viewport')!.props.style);
            return style.minHeight ?? style.height;
        };
        const reserved = height();
        await screen.update(render(true));
        await flushHookEffects({ cycles: 2 });
        expect(height()).toBe(reserved / 4);
        expect(screen.root.findByType(SurfaceStateCard).props.replacesContent).toBe(true);
        await screen.update(render(false));
        await flushHookEffects({ cycles: 2 });
        expect(height()).toBe(reserved);
        await screen.update(render(true, false));
        await flushHookEffects({ cycles: 2 });
        expect(height()).toBe(reserved);
    });
    it.each([['light', lightTheme], ['dark', darkTheme]] as const)('renders the size menu heading in the %s theme primary ink', async (_name, theme) => {
        const runtime = Unistyles.useUnistyles();
        const themedRuntime = vi.spyOn(Unistyles, 'useUnistyles').mockReturnValue({ ...runtime, theme });
        try {
            const screen = await renderScreen(<>{renderWidgetSizeMenuSection({
                surface: 'home', sizes: ['small', 'medium'], size: 'small', onSet: () => {},
            }, 'size', 'frame.size')}</>);
            const label = screen.root.findAll(node => typeof node.type === 'string' && node.props.children === 'widgetAdd.size')[0];
            expect(label).toBeDefined();
            // Accessibility regression: an unset host ink paints black on the dark floating surface.
            expect(StyleSheet.flatten(label!.props.style)?.color).toBe(theme.colors.text.primary);
        } finally {
            themedRuntime.mockRestore();
        }
    });
    it('retains domain body input and header actions across controlled disclosure', async () => {
        let mounts = 0;
        const about = vi.fn();
        function Body() {
            const [draft, setDraft] = React.useState('initial');
            React.useEffect(() => { mounts += 1; }, []);
            return <Pressable testID="domain-edit" onPress={() => setDraft('edited')}><Text>{draft}</Text></Pressable>;
        }
        function Frame() {
            const [collapsed, setCollapsed] = React.useState(false);
            return <WidgetFrame testID="controlled" frameStyle="plain" placement="companion" title="Notes"
                disclosure={{ collapsed, onCollapsedChange: setCollapsed, expandLabel: 'Expand notes', collapseLabel: 'Collapse notes' }}
                menu={<Pressable testID="domain-about" onPress={about}><Text>About</Text></Pressable>}
                body={{ kind: 'content', children: <Body /> }} />;
        }
        const screen = await renderScreen(<Frame />);
        await screen.pressByTestIdAsync('domain-edit');
        await screen.pressByTestIdAsync('controlled.disclosure');
        await screen.pressByTestIdAsync('domain-about');
        expect(about).toHaveBeenCalledOnce();
        expect(screen.findByTestId('controlled.disclosure')?.props.accessibilityState.expanded).toBe(false);
        await screen.pressByTestIdAsync('controlled.disclosure');
        expect(screen.getTextContent()).toContain('edited');
        expect(mounts).toBe(1);
    });
    it('recomposes a retained declarative chart from the measured frame viewport without dropping points', async () => {
        const document = { version: 1, root: { kind: 'chart', label: 'Checks', style: 'bar', rows: [],
            data: { kind: 'value', value: [{ x: 'Mon', y: 2 }, { x: 'Tue', y: 4 }, { x: 'Wed', y: 3 }] },
            x: { path: ['x'], type: 'string' }, y: { path: ['y'], type: 'number' } } };
        const screen = await renderScreen(<WidgetFrame testID="declarative" frameStyle="card" placement="home" title="Checks"
            widgetPresentation={{ size: 'tall', footprint: { columns: 2, columnSpan: 1, rowSpan: 4, width: 'half', height: 'tall' } }}
            body={{ kind: 'content', children: <SessionBoardDeclarativeContent document={document} /> }} />);
        const viewport = screen.findByTestId('declarative.viewport')!;
        const plotHeight = () => {
            const heights = screen.findByTestId('plugin-declarative-chart-bar-1-0')!.findAll(node =>
                typeof node.type === 'string' && typeof node.props.style?.height === 'number').map(node => node.props.style.height as number);
            return Math.max(...heights);
        };
        await act(async () => { viewport.props.onLayout({ nativeEvent: { layout: { width: 350, height: 96 } } }); });
        const compactHeight = plotHeight();
        const chart = screen.findByTestId('plugin-declarative-chart');
        await act(async () => { viewport.props.onLayout({ nativeEvent: { layout: { width: 350, height: 384 } } }); });
        expect(plotHeight()).toBeGreaterThan(compactHeight);
        expect(screen.findByTestId('plugin-declarative-chart')).toBe(chart);
        expect(chart?.props.accessibilityLabel).toContain('Mon: Checks 2; Tue: Checks 4; Wed: Checks 3');
        expect(screen.findByTestId('plugin-declarative-chart-bar-2-0')).not.toBeNull();
    });
    it('delivers the measured viewport to its retained body while preserving the chosen aspect footprint', async () => {
        let mounts = 0;
        let observed: ReturnType<typeof useWidgetPresentation>;
        function Body() {
            observed = useWidgetPresentation();
            React.useEffect(() => { mounts += 1; }, []);
            return <>all retained rows</>;
        }
        const widgetPresentation = { size: 'wide' as const,
            footprint: { columns: 2, columnSpan: 2, rowSpan: 1, height: 'compact' as const, width: 'full' as const } };
        const render = () => <WidgetFrame testID="measured" frameStyle="card" placement="home" title="Rows"
            {...{ widgetPresentation }} body={{ kind: 'content', children: <Body /> }} />;
        const screen = await renderScreen(render());
        const viewport = screen.findByTestId('measured.viewport');
        expect(viewport).not.toBeNull();
        await act(async () => { viewport!.props.onLayout({ nativeEvent: { layout: { width: 620, height: 160 } } }); });
        expect(observed).toMatchObject({ size: 'wide', footprint: { columnSpan: 2, rowSpan: 1 }, geometry: { width: 620, height: 160 } });
        await act(async () => { viewport!.props.onLayout({ nativeEvent: { layout: { width: 350, height: 160 } } }); });
        expect(observed).toMatchObject({ size: 'wide', geometry: { width: 350, height: 160 } });
        expect(mounts).toBe(1);
        expect(screen.getTextContent()).toContain('all retained rows');
    });
    it('lets a grouped widget grow with its rows instead of scrolling inside a fixed box, still telling the body its measured room', async () => {
        const { HappierScrollArea } = await import('@happier-dev/plugin-ui/presentation');
        let observed: ReturnType<typeof useWidgetPresentation>;
        function Body() { observed = useWidgetPresentation(); return <>every row</>; }
        const screen = await renderScreen(<WidgetFrame testID="grouped" frameStyle="plain" grouped placement="home" title="Period summary"
            widgetPresentation={{ size: 'small', footprint: { columns: 2, columnSpan: 1, rowSpan: 1, height: 'compact', width: 'half' } }}
            body={{ kind: 'content', children: <Body /> }} />);
        expect(screen.root.findAllByType(HappierScrollArea)).toHaveLength(0);
        await act(async () => { screen.findByTestId('grouped.viewportBody')!.props.onLayout({ nativeEvent: { layout: { width: 330, height: 240 } } }); });
        expect(observed).toMatchObject({ size: 'small', geometry: { width: 330, height: 240 } });
    });
    it('keeps a background refresh to the glyph, and says Refreshing in words only for the refresh the person started with Retry', async () => {
        const { useWidgetFrameResourceActivity } = await import('./widgetFrameResourceActivity');
        function Refreshing() { useWidgetFrameResourceActivity(true); return <>rows</>; }
        let finishRetry: () => void = () => undefined;
        const retry = vi.fn(() => new Promise<void>(resolve => { finishRetry = resolve; }));
        const frame = (testID: string, footer?: React.ComponentProps<typeof WidgetFrame>['footer']) => <WidgetFrame testID={testID}
            frameStyle="card" placement="home" title="Period summary" source="Account"
            widgetPresentation={{ size: 'medium', footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular', width: 'half' } }}
            body={{ kind: 'content', children: <Refreshing /> }} {...(footer ? { footer } : {})} />;
        // A half-width cell with room: the dot-matrix glyph alone would read as one more grip beside the card's own.
        const roomy = await renderScreen(frame('roomy', { kind: 'refreshFailed', reason: 'Couldn\'t refresh', onRetry: retry }));
        await flushHookEffects({ cycles: 2 });
        await act(async () => { roomy.findByTestId('roomy')!.props.onLayout({ nativeEvent: { layout: { width: 400, height: 280 } } }); });
        // W9b: a refresh nobody asked for is quiet work, however long it runs: the named glyph, never the sentence.
        expect(roomy.findByTestId('roomy.refreshing')?.props.accessibilityLabel).toBe('widgetDefinition.refreshing');
        expect(roomy.getTextContent()).not.toContain('widgetDefinition.refreshing');
        await act(async () => { roomy.pressByTestId('roomy.stale-action'); });
        expect(roomy.getTextContent()).toContain('widgetDefinition.refreshing');
        await act(async () => { finishRetry(); });
        expect(roomy.getTextContent()).not.toContain('widgetDefinition.refreshing');
        // Below the frame's narrowing width the title keeps its room and the glyph stays, named for assistive technology.
        const tight = await renderScreen(frame('tight'));
        await flushHookEffects({ cycles: 2 });
        await act(async () => { tight.findByTestId('tight')!.props.onLayout({ nativeEvent: { layout: { width: 280, height: 280 } } }); });
        expect(tight.findByTestId('tight.refreshing')?.props.accessibilityLabel).toBe('widgetDefinition.refreshing');
        expect(tight.getTextContent()).not.toContain('widgetDefinition.refreshing');
    });
    it('fades the foot of a fixed body whose rows run past it, so no line reads as cut off', async () => {
        const frame = await renderScreen(<WidgetFrame testID="fixed" frameStyle="card" placement="home" title="Period summary"
            widgetPresentation={{ size: 'small', footprint: { columns: 2, columnSpan: 1, rowSpan: 1, height: 'compact', width: 'half' } }}
            body={{ kind: 'content', children: <>many rows</> }} />);
        const masked = () => StyleSheet.flatten(frame.findByTestId('fixed.viewport')!.props.style) as Record<string, unknown>;
        await act(async () => { frame.findByTestId('fixed.viewport')!.props.onLayout({ nativeEvent: { layout: { width: 330, height: 96 } } }); });
        await act(async () => { frame.findByTestId('fixed.viewportContent')!.props.onLayout({ nativeEvent: { layout: { width: 330, height: 96 } } }); });
        expect(masked().maskImage).toBeUndefined();
        await act(async () => { frame.findByTestId('fixed.viewportContent')!.props.onLayout({ nativeEvent: { layout: { width: 330, height: 240 } } }); });
        expect(String(masked().maskImage)).toContain('transparent 100%');
    });
    it('takes its content height on a content-height surface (a core page), keeping the body its size and measured width', async () => {
        const { HappierScrollArea } = await import('@happier-dev/plugin-ui/presentation');
        let observed: ReturnType<typeof useWidgetPresentation>;
        function Body() { observed = useWidgetPresentation(); return <>every row</>; }
        const screen = await renderScreen(<WidgetFrame testID="core" frameStyle="card" placement="home" title="Daily usage" bodyHeight="content"
            widgetPresentation={{ size: 'wide', footprint: { columns: 2, columnSpan: 2, rowSpan: 2, height: 'regular', width: 'full' } }}
            body={{ kind: 'content', children: <Body /> }} />);
        // No fixed-height scroll viewport: the row is as tall as what it shows.
        expect(screen.root.findAllByType(HappierScrollArea)).toHaveLength(0);
        await act(async () => { screen.findByTestId('core.viewportBody')!.props.onLayout({ nativeEvent: { layout: { width: 900, height: 412 } } }); });
        expect(observed).toMatchObject({ size: 'wide', footprint: { columnSpan: 2 }, geometry: { width: 900, height: 412 } });
    });
    it('keeps a headerless frame headerless while its body refreshes: no empty header row, no lone spinner above the body', async () => {
        const { useWidgetFrameResourceActivity } = await import('./widgetFrameResourceActivity');
        function Refreshing() { useWidgetFrameResourceActivity(true); return <>capacity</>; }
        const screen = await renderScreen(<WidgetFrame testID="embed" frameStyle="plain" grouped placement="home" title={null} bodyHeight="content"
            widgetPresentation={{ size: 'medium', footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular', width: 'half' } }}
            body={{ kind: 'content', children: <Refreshing /> }} />);
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('embed.refreshing')).toBeNull();
        expect(screen.getTextContent()).toContain('capacity');
    });
    it('tells a body stretched by its band its own height, never the band\'s, so a chart keeps its height and the cell keeps the space', async () => {
        let observed: ReturnType<typeof useWidgetPresentation>;
        function Body() { observed = useWidgetPresentation(); return <>a sized plot</>; }
        const screen = await renderScreen(<WidgetFrame testID="daily" frameStyle="plain" grouped placement="home" title="Daily usage" bodyHeight="content"
            widgetPresentation={{ size: 'medium', footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular', width: 'half' } }}
            body={{ kind: 'content', children: <Body /> }} />);
        // The body lays out at its own height first; then the taller partner column stretches the viewport.
        await act(async () => { screen.findByTestId('daily.viewportBody')?.props.onLayout({ nativeEvent: { layout: { width: 560, height: 300 } } }); });
        await act(async () => { screen.findByTestId('daily.viewport')!.props.onLayout?.({ nativeEvent: { layout: { width: 560, height: 700 } } }); });
        expect(observed?.geometry).toEqual({ width: 560, height: 300 });
        // A refresh that briefly grows the partner never ratchets the body's room up with it.
        await act(async () => { screen.findByTestId('daily.viewport')!.props.onLayout?.({ nativeEvent: { layout: { width: 560, height: 888 } } }); });
        expect(observed?.geometry).toEqual({ width: 560, height: 300 });
    });
    it('tells a content-height body at least the room its footprint declares, so a chart in a tall cell is not sized from its own first frame', async () => {
        let observed: ReturnType<typeof useWidgetPresentation>;
        function Body() { observed = useWidgetPresentation(); return <>a sized plot</>; }
        const screen = await renderScreen(<WidgetFrame testID="daily" frameStyle="plain" grouped placement="home" title="Daily usage" bodyHeight="content"
            widgetPresentation={{ size: 'tall', footprint: { columns: 2, columnSpan: 1, rowSpan: 4, height: 'tall', width: 'half' } }}
            body={{ kind: 'content', children: <Body /> }} />);
        // The body first draws small (a skeleton, a floor-height plot); its declared room is what a chart reads.
        await act(async () => { screen.findByTestId('daily.viewportBody')?.props.onLayout({ nativeEvent: { layout: { width: 560, height: 120 } } }); });
        expect(observed?.geometry?.width).toBe(560);
        expect(observed?.geometry?.height).toBeGreaterThan(300);
        // The room is declared, not applied: the body itself is not stretched to it.
        expect(screen.findByTestId('daily.viewportBody')!.props.style).not.toHaveProperty('minHeight');
    });
    it('does not say the source again when the title already names it', async () => {
        const named = await renderFrame({ title: 'New in PRs & Issues', source: 'PRs & Issues' });
        // One mention in the header; the accessible name still carries the source.
        expect(named.getTextContent().split('PRs & Issues')).toHaveLength(2);
        expect(named.findByTestId('frame')?.props.accessibilityLabel).toBe('New in PRs & Issues, PRs & Issues');
        const distinct = await renderFrame({ title: 'Latest runs', source: 'Automations' });
        expect(distinct.getTextContent()).toContain('Automations');
    });
    it('ends the header with the ⋯ menu, then the move grip, the one order on every card', async () => {
        const screen = await renderFrame({ menu: <Text testID="frame-menu">menu</Text>, grip: <Text testID="frame-grip">grip</Text> });
        const order = screen.tree.findAllByType(Text).map((node) => node.props.testID).filter((id: unknown) => id === 'frame-menu' || id === 'frame-grip');
        expect(order).toEqual(['frame-menu', 'frame-grip']);
    });
    it('keeps the suffix that tells near-identical machines apart when a bound source is too long for its header', async () => {
        const screen = await renderFrame({ source: 'Following group · NLDW6-3-11-20 · 0371' });
        const runs = screen.tree.findAllByType(Text).map((node) => node.props.children).filter((child: unknown) => typeof child === 'string');
        // The head gives up its end; the suffix stays a whole run of its own.
        expect(runs).toContain('Following group · NLDW6-3-11-20');
        expect(runs).toContain('\u00a0· 0371');
    });
        it('draws the header at once — title, source, freshness and the section menu — around the body', async () => {
        const screen = await renderFrame({ meta: 'As of 10:42', menu: 'menu:here' });
        const text = screen.getTextContent();
        expect(text).toContain('Latest runs');
        expect(text).toContain('Automations');
        expect(text).toContain('As of 10:42');
        expect(text).toContain('menu:here');
        expect(text).toContain('rows:here');
    });

    it('reserves skeleton rows while the first read is pending, and shows no content', async () => {
        const screen = await renderFrame({ body: { kind: 'loading', accessibilityLabel: 'Loading latest runs' } });
        expect(screen.findByTestId('frame.loading')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('rows:here');
        // The header is not waiting on the data.
        expect(screen.getTextContent()).toContain('Latest runs');
    });

    it('explains an empty widget with what will appear there', async () => {
        const screen = await renderFrame({
            body: { kind: 'empty', title: 'No runs yet', reason: 'Runs of your automations show up here.' },
        });
        expect(screen.findByTestId('frame.empty')).toBeTruthy();
        expect(screen.getTextContent()).toContain('No runs yet');
        expect(screen.getTextContent()).toContain('Runs of your automations show up here.');
    });

    it.each([true, false])('keeps a credential reader mounted when a phone widget settles to an empty body (footprint: %s)', async (withFootprint) => {
        device.type = 'phone';
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { upsertServerProfile, removeServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const home = await upsertServerProfile({ serverUrl: 'https://home-widget-continuity.example.test' });
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'widget-continuity-account' })).toString('base64url')}.signature`;
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token })).toBe(true);
        let mounts = 0;
        let boundCommits = 0;
        function Body() {
            const { binding } = useServerCredentialAccountScopeBinding(home.id);
            React.useLayoutEffect(() => {
                mounts += 1;
                // Fail at the first unintended remount instead of letting the feedback loop run.
                expect(mounts).toBe(1);
            }, []);
            React.useLayoutEffect(() => { if (binding) boundCommits += 1; }, [binding]);
            return <SurfaceStateCard testID="credential-body" replacesContent
                kind={binding ? 'empty' : 'loading'} title="No rows" />;
        }
        try {
            const screen = await renderFrame({ ...(withFootprint ? { widgetPresentation: { size: 'medium' as const,
                footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular' as const, width: 'half' as const } } } : {}),
                body: { kind: 'content', children: <Body /> } });
            expect(boundCommits).toBe(1);
            expect(screen.findByTestId('credential-body')).not.toBeNull();
            expect(mounts).toBe(1);
        } finally {
            standardCleanup();
            await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
            await removeServerProfile(home.id);
        }
    });

    it('draws an empty widget as its one line on a phone, so a first-run phone Home is not a stack of scenes', async () => {
        device.type = 'phone';
        const medium = { size: 'medium' as const,
            footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular' as const, width: 'half' as const } };
        const own = await renderFrame({ widgetPresentation: medium,
            body: { kind: 'empty', title: 'No runs yet', reason: 'Runs show here.', scene: 'noAutomations' } });
        const ownState = own.findByTestId('frame.empty')!;
        expect(own.root.findAllByType(HappierSurfaceState).find(state => state.props.testID === 'frame.empty')!.props.size).toBe('line');
        expect(ownState).toBeTruthy();
        // The card is its content's height: no reserved rows under the line.
        expect(StyleSheet.flatten(own.findByTestId('frame.viewport')!.props.style).height).toBeUndefined();
        expect(StyleSheet.flatten(own.findByTestId('frame.viewport')!.props.style).minHeight).toBeUndefined();
        standardCleanup();
        const body = await renderFrame({ widgetPresentation: medium, body: { kind: 'content', children:
            <UsageBodyInsufficient testID="usage-empty" title="No subscription connected" reason="See what each plan has left." /> } });
        expect(body.root.findAllByType(SurfaceStateCard).find(card => card.props.testID === 'usage-empty')!
            .findByType(HappierSurfaceState).props.size).toBe('line');
        standardCleanup();
        // Real content on a phone keeps its declared room.
        const rows = await renderFrame({ widgetPresentation: medium });
        expect(StyleSheet.flatten(rows.findByTestId('frame.viewport')!.props.style).height).toBeGreaterThan(0);
    });

    it('names a failure in the person\'s terms and offers the one fixing action', async () => {
        const retry = vi.fn();
        const screen = await renderFrame({
            body: {
                kind: 'error',
                title: 'Couldn\'t load runs',
                reason: 'Check the connection to your Home.',
                action: { label: 'Try again', onPress: retry },
                diagnosticCode: 'automations_refresh_failed',
            },
        });
        expect(screen.getTextContent()).toContain('Couldn\'t load runs');
        await act(async () => { screen.pressByTestId('frame.error-action'); });
        await flushHookEffects({ cycles: 2 });
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it('leads to the widget\'s destination from its one footer row', async () => {
        const open = vi.fn();
        const screen = await renderFrame({ footer: { kind: 'open', label: 'Open Automations', onPress: open } });
        expect(screen.getTextContent()).toContain('Open Automations');
        screen.pressByTestId('frame.open');
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('keeps last-known rows when a refresh fails, and says why in the footer with Retry instead of Open', async () => {
        const retry = vi.fn();
        const screen = await renderFrame({
            footer: { kind: 'refreshFailed', reason: 'Couldn\'t refresh', onRetry: retry },
        });
        expect(screen.getTextContent()).toContain('rows:here');
        expect(screen.getTextContent()).toContain('Couldn\'t refresh');
        expect(screen.findByTestId('frame.open')).toBeNull();
        screen.pressByTestId('frame.stale-action');
        expect(retry).toHaveBeenCalledTimes(1);
    });
    it('rings a widget that just arrived, and draws no ring otherwise', async () => {
        const fresh = await renderFrame({ placement: 'board', fresh: true });
        expect(fresh.findByTestId('widget-frame.arrival-ring')).toBeTruthy();
        standardCleanup();
        const settled = await renderFrame({ placement: 'board' });
        expect(settled.findByTestId('widget-frame.arrival-ring')).toBeNull();
    });

    it('keeps the same header, body and footer when drawn plain', async () => {
        const open = vi.fn();
        const screen = await renderFrame({
            frameStyle: 'plain',
            placement: 'companion',
            meta: '2 running',
            footer: { kind: 'open', label: 'Review changes', onPress: open },
        });
        const text = screen.getTextContent();
        for (const part of ['Latest runs', 'Automations', '2 running', 'rows:here', 'Review changes']) {
            expect(text).toContain(part);
        }
        screen.pressByTestId('frame.open');
        expect(open).toHaveBeenCalledTimes(1);
    });
});
