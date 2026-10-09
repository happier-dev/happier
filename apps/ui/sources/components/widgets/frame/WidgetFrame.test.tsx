import * as React from 'react';
import { Pressable, Text } from 'react-native';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { WidgetFrame } from './WidgetFrame';
import { SessionBoardDeclarativeContent } from '@/components/sessions/board/SessionBoardDeclarativeContent';

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

afterEach(() => {
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
            const heights = screen.findByTestId('plugin-declarative-chart-bar-1')!.findAll(node =>
                typeof node.type === 'string' && typeof node.props.style?.height === 'number').map(node => node.props.style.height as number);
            return Math.max(...heights);
        };
        await act(async () => { viewport.props.onLayout({ nativeEvent: { layout: { width: 350, height: 96 } } }); });
        const compactHeight = plotHeight();
        const chart = screen.findByTestId('plugin-declarative-chart');
        await act(async () => { viewport.props.onLayout({ nativeEvent: { layout: { width: 350, height: 384 } } }); });
        expect(plotHeight()).toBeGreaterThan(compactHeight);
        expect(screen.findByTestId('plugin-declarative-chart')).toBe(chart);
        expect(chart?.props.accessibilityLabel).toContain('Mon 2, Tue 4, Wed 3');
        expect(screen.findByTestId('plugin-declarative-chart-bar-2')).not.toBeNull();
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
