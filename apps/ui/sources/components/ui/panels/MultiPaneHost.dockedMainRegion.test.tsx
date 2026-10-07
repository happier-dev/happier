import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { MultiPaneHost } from './MultiPaneHost';
import type { ResolvedPaneLayout } from './paneBreakpoints';


declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('MultiPaneHost (docked main region)', () => {
    it('allows the main region to shrink beside a docked right pane on web', async () => {
        const screen = await renderScreen(
            <MultiPaneHost
                main={<Main />}
                rightPane={<Right />}
                detailsPane={null}
                layout={{ kind: 'twoPane', right: 'docked', details: 'hidden' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />,
        );

        const mainNode = screen.tree.root.findByType('Main');
        const mainRegion = findAncestorWithStyle(mainNode, (style) => {
            return style != null && typeof style === 'object' && 'flex' in style;
        });
        expect(mainRegion?.props?.style).toEqual(
            expect.objectContaining({
                flex: 1,
                minWidth: 0,
            }),
        );
    });

    it('keeps the main region mounted when a docked right pane opens and closes', async () => {
        const tracker = createMountTracker();
        const main = <Tracked tracker={tracker} name="main" />;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(
            <MultiPaneHost
                main={main}
                rightPane={null}
                detailsPane={null}
                layout={{ kind: 'single', right: 'hidden', details: 'hidden' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />,
        )).tree;

        expect(tracker.mounts.main).toBe(1);
        expect(tracker.unmounts.main ?? 0).toBe(0);

        act(() => {
            tree!.update(
                <MultiPaneHost
                    main={main}
                    rightPane={<Right />}
                    detailsPane={null}
                    layout={{ kind: 'twoPane', right: 'docked', details: 'hidden' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                />,
            );
        });

        expect(tracker.mounts.main).toBe(1);
        expect(tracker.unmounts.main ?? 0).toBe(0);

        act(() => {
            tree!.update(
                <MultiPaneHost
                    main={main}
                    rightPane={null}
                    detailsPane={null}
                    layout={{ kind: 'single', right: 'hidden', details: 'hidden' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                />,
            );
        });

        expect(tracker.mounts.main).toBe(1);
        expect(tracker.unmounts.main ?? 0).toBe(0);
    });

    it.each(['details', 'right'] as const)('preserves the %s editor draft and mount while its pane docks, overlays, and docks again', async (pane) => {
        const tracker = createMountTracker();
        const editor = <DraftEditor tracker={tracker} name={pane} />;
        const tree = (overlay: boolean) => {
            const layout: ResolvedPaneLayout = {
                kind: overlay ? 'overlayStack' : 'twoPane',
                right: pane === 'right' ? (overlay ? 'overlay' : 'docked') : 'hidden',
                details: pane === 'details' ? (overlay ? 'overlay' : 'docked') : 'hidden',
            };
            return <MultiPaneHost
                main={<Tracked tracker={tracker} name="main" />}
                rightPane={pane === 'right' ? editor : null}
                detailsPane={pane === 'details' ? editor : null}
                layout={layout}
                rightDockWidthPx={390}
                detailsDockWidthPx={390}
                onCloseRight={() => {}}
                onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />;
        };
        const screen = await renderScreen(tree(false));
        await act(async () => { screen.root.findByType('DraftEditor').props.onChangeText('Unsubmitted work'); });
        expect(screen.root.findByType('DraftEditor').props.value).toBe('Unsubmitted work');
        expect(tracker.mounts[pane]).toBe(1);
        for (const overlay of [true, false]) {
            await screen.update(tree(overlay));
            expect(screen.root.findByType('DraftEditor').props.value).toBe('Unsubmitted work');
            expect(tracker.mounts[pane]).toBe(1);
            expect(tracker.unmounts[pane] ?? 0).toBe(0);
            expect(tracker.mounts.main).toBe(1);
        }
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
        const screen = await renderScreen(tree({ kind: 'threePane', right: 'docked', details: 'docked' }));
        const editor = (name: string) => screen.root.findAllByType('DraftEditor').find((node) => node.props.name === name)!;
        for (const pane of ['right', 'details']) {
            await act(async () => { editor(pane).props.onChangeText(`${pane} draft`); });
        }
        for (const layout of [
            { kind: 'twoPane', right: 'docked', details: 'overlay' },
            { kind: 'overlayStack', right: 'hidden', details: 'overlay' },
            { kind: 'overlayStack', right: 'overlay', details: 'hidden' },
            { kind: 'threePane', right: 'docked', details: 'docked' },
        ] satisfies ResolvedPaneLayout[]) {
            await screen.update(tree(layout));
            for (const pane of ['right', 'details'] as const) {
                expect(editor(pane).props.value).toBe(`${pane} draft`);
                expect(tracker.mounts[pane]).toBe(1);
                expect(tracker.unmounts[pane] ?? 0).toBe(0);
                if (layout[pane] === 'hidden') {
                    expect(screen.findByTestId(`multi-pane-${pane}-parked`)?.props.pointerEvents).toBe('none');
                }
            }
            expect(tracker.mounts.main).toBe(1);
        }
    });
});

function Main() {
    return React.createElement('Main');
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
    React.useEffect(() => {
        props.tracker.mounts[props.name] = (props.tracker.mounts[props.name] ?? 0) + 1;
        return () => {
            props.tracker.unmounts[props.name] = (props.tracker.unmounts[props.name] ?? 0) + 1;
        };
    }, [props.name, props.tracker]);
    return React.createElement('DraftEditor', { name: props.name, value, onChangeText });
}

function findAncestorWithStyle(
    node: { parent?: { parent?: unknown; props?: { style?: unknown } } | null } | null | undefined,
    predicate: (style: unknown) => boolean,
) {
    let current = node?.parent ?? null;
    while (current) {
        if (predicate(current.props?.style)) return current;
        current = current.parent ?? null;
    }
    return null;
}
