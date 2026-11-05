import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { MultiPaneHost } from './MultiPaneHost';
import type { ResolvedPaneLayout } from './paneBreakpoints';
import { PaneMainBodyPresentationContext } from './paneMainComposerAnchor';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';


declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('MultiPaneHost (docked main region)', () => {
    it('keeps one stateful body while main and side selections change independently', async () => {
        const tracker = createMountTracker();
        const tree = (info: 'main' | 'side' | 'hidden', files: 'side' | 'hidden', directPlugin = false, drawer = false) => <MultiPaneHost
            main={<Main />}
            detailsPane={null}
            rightPane={directPlugin ? <DraftEditor tracker={tracker} name="plugin" /> : info === 'side' || files === 'side' ? <Right /> : null}
            rightSurfaces={[
                { id: 'info', placement: info, content: <DraftEditor tracker={tracker} name="info" /> },
                { id: 'files', placement: files, content: <DraftEditor tracker={tracker} name="files" /> },
            ]}
            mirrored
            mainDrawerOpen={drawer}
            layout={{ main: drawer ? 'overlay' : 'docked', kind: 'twoPane', right: 'docked', details: 'hidden' }}
            rightDockWidthPx={360}
            detailsDockWidthPx={520}
            onCloseRight={() => {}}
            onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}}
            onCommitDetailsDockWidthPx={() => {}}
        />;
        const screen = await renderScreen(tree('main', 'side'));
        const editor = (name: string) => screen.root.findAllByType('DraftEditor').find(node => node.props.name === name)!;
        expect(screen.root.findAllByType(Right)).toHaveLength(0);
        expect(screen.root.findAllByType('DraftEditor')).toHaveLength(2);
        expect(screen.root.findByType('Main').props.bodyPresented).toBe(false);
        for (const name of ['info', 'files']) {
            expect(editor(name).props.presented).toBe(true);
            await act(async () => { editor(name).props.onChangeText(`${name} draft`); });
        }
        await screen.update(tree('main', 'side', false, true));
        for (let node = editor('info').parent; node; node = node.parent) {
            expect(node.props.pointerEvents).not.toBe('none');
            expect(node.props.accessibilityElementsHidden).not.toBe(true);
        }
        await screen.update(tree('main', 'hidden'));
        expect(editor('info').props.presented).toBe(true);
        expect(editor('files').props.presented).toBe(false);
        expect(screen.root.findByType('Main').props.bodyPresented).toBe(false);
        await screen.update(tree('side', 'hidden'));
        expect(screen.root.findByType('Main').props.bodyPresented).toBe(true);
        expect(editor('info').props.presented).toBe(true);
        await screen.update(tree('hidden', 'side'));
        expect(editor('info').props.presented).toBe(false);
        expect(editor('files').props.presented).toBe(true);
        for (const name of ['info', 'files']) {
            expect(editor(name).props.value).toBe(`${name} draft`);
            expect(tracker.mounts[name]).toBe(1);
            expect(tracker.unmounts[name] ?? 0).toBe(0);
        }
        expect(screen.root.findAllByType('DraftEditor')).toHaveLength(2);
        await screen.update(tree('main', 'hidden', true));
        expect(editor('plugin').props.presented).toBe(true);
        expect(editor('info').props.value).toBe('info draft');
        expect(editor('info').props.presented).toBe(true);
        expect(tracker.mounts.info).toBe(1);
        expect(tracker.mounts.plugin).toBe(1);
    });
    it('allows the main region to shrink beside a docked right pane on web', async () => {
        const screen = await renderScreen(
            <MultiPaneHost
                main={<Main />}
                rightPane={<Right />}
                detailsPane={null}
                layout={{ main: 'docked', kind: 'twoPane', right: 'docked', details: 'hidden' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />,
        );

        expect(screen.findByTestId('multi-pane-main-column')?.props.style).toEqual(
            expect.objectContaining({
                flex: 1,
                minWidth: 0,
            }),
        );
    });

    it('keeps the main region mounted when a docked right pane opens and closes', async () => {
        const tracker = createMountTracker();
        const main = <Tracked tracker={tracker} name="main" />;

        const screen = await renderScreen(
            <MultiPaneHost
                main={main}
                rightPane={null}
                detailsPane={null}
                layout={{ main: 'docked', kind: 'single', right: 'hidden', details: 'hidden' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />,
        );

        expect(tracker.mounts.main).toBe(1);
        expect(tracker.unmounts.main ?? 0).toBe(0);

        await screen.update(
                <MultiPaneHost
                    main={main}
                    rightPane={<Right />}
                    detailsPane={null}
                    layout={{ main: 'docked', kind: 'twoPane', right: 'docked', details: 'hidden' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                />,
        );

        expect(tracker.mounts.main).toBe(1);
        expect(tracker.unmounts.main ?? 0).toBe(0);

        await screen.update(
                <MultiPaneHost
                    main={main}
                    rightPane={null}
                    detailsPane={null}
                    layout={{ main: 'docked', kind: 'single', right: 'hidden', details: 'hidden' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                />,
        );

        expect(tracker.mounts.main).toBe(1);
        expect(tracker.unmounts.main ?? 0).toBe(0);
    });

    it('preserves both drafts when a narrow layout parks one pane behind the other', async () => {
        const tracker = createMountTracker();
        const tree = (layout: ResolvedPaneLayout) => <MultiPaneHost
            main={<Tracked tracker={tracker} name="main" />}
            rightPane={<DraftEditor tracker={tracker} name="right" />}
            detailsPane={<DraftEditor tracker={tracker} name="details" />}
            layout={layout}
            rightDockWidthPx={360}
            detailsDockWidthPx={390}
            onCloseRight={() => {}}
            onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}}
            onCommitDetailsDockWidthPx={() => {}}
        />;
        const screen = await renderScreen(tree({ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' }));
        const editor = (name: string) => screen.root.findAllByType('DraftEditor').find((node) => node.props.name === name)!;
        for (const pane of ['right', 'details']) {
            await act(async () => { editor(pane).props.onChangeText(`${pane} draft`); });
        }
        for (const layout of [
            { main: 'docked', kind: 'twoPane', right: 'docked', details: 'overlay' },
            { main: 'docked', kind: 'overlayStack', right: 'hidden', details: 'overlay' },
            { main: 'docked', kind: 'overlayStack', right: 'overlay', details: 'hidden' },
            { main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' },
        ] satisfies ResolvedPaneLayout[]) {
            await screen.update(tree(layout));
            for (const pane of ['right', 'details'] as const) {
                expect(editor(pane).props.value).toBe(`${pane} draft`);
                expect(tracker.mounts[pane]).toBe(1);
                expect(tracker.unmounts[pane] ?? 0).toBe(0);
                if (layout[pane] === 'hidden') {
                    const parked = screen.findByTestId(`multi-pane-${pane}-parked`);
                    expect(parked?.props.pointerEvents).toBe('none');
                    // The default test platform is native: a parked pane leaves the accessibility tree.
                    expect(parked?.props.accessibilityElementsHidden).toBe(true);
                    expect(parked?.props.importantForAccessibility).toBe('no-hide-descendants');
                }
            }
            expect(tracker.mounts.main).toBe(1);
        }
    });
});

function Main() {
    return React.createElement('Main', { bodyPresented: React.useContext(PaneMainBodyPresentationContext) });
}

function Right() {
    return React.createElement('Right');
}

type MountTracker = {
    mounts: Record<string, number>;
    unmounts: Record<string, number>;
};

function createMountTracker(): MountTracker {
    return { mounts: {}, unmounts: {} };
}

function Tracked(props: Readonly<{ tracker: MountTracker; name: string }>) {
    React.useEffect(() => {
        props.tracker.mounts[props.name] = (props.tracker.mounts[props.name] ?? 0) + 1;
        return () => {
            props.tracker.unmounts[props.name] = (props.tracker.unmounts[props.name] ?? 0) + 1;
        };
    }, [props.name, props.tracker]);
    return React.createElement(props.name);
}

function DraftEditor(props: Readonly<{ tracker: MountTracker; name: string }>) {
    const [value, onChangeText] = React.useState('');
    const presented = useLayoutPresentationActive();
    React.useEffect(() => {
        props.tracker.mounts[props.name] = (props.tracker.mounts[props.name] ?? 0) + 1;
        return () => {
            props.tracker.unmounts[props.name] = (props.tracker.unmounts[props.name] ?? 0) + 1;
        };
    }, [props.name, props.tracker]);
    return React.createElement('DraftEditor', { name: props.name, value, onChangeText, presented });
}
