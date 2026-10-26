import * as React from 'react';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import {
    HorizontalSafeAreaProvider,
    NavigatorSafeAreaBleed,
    ScreenBackdropBoundary,
    ScreenSafeAreaFrame,
    useHorizontalSafeAreaContentPadding,
    useScreenSafeAreaBackdrop,
    useScreenSafeAreaBleed,
} from './HorizontalSafeArea';
import { resolveHorizontalSafeAreaRoot } from './horizontalSafeArea';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Folded iPhone Duo: the system vertical bar sits in the right 84pt.
const DUO_FOLDED_ROOT = resolveHorizontalSafeAreaRoot({ left: 0, right: 84 }).child;

function Backdrop(props: Readonly<{ color: string }>) {
    useScreenSafeAreaBackdrop(props.color);
    return null;
}

function HeaderProbe() {
    const padding = useHorizontalSafeAreaContentPadding();
    return React.createElement('HeaderProbe', padding);
}

function BleedProbe() {
    return React.createElement('BleedProbe', useScreenSafeAreaBleed());
}

function ScreenTree(props: Readonly<{ children?: React.ReactNode }>) {
    return (
        <HorizontalSafeAreaProvider value={DUO_FOLDED_ROOT}>
            <NavigatorSafeAreaBleed>
                <HeaderProbe />
                <ScreenSafeAreaFrame presentation={undefined}>
                    <HeaderProbe />
                    {props.children}
                </ScreenSafeAreaFrame>
            </NavigatorSafeAreaBleed>
        </HorizontalSafeAreaProvider>
    );
}

function flatStyle(instance: ReactTestInstance): Record<string, unknown> {
    const style = instance.props.style;
    return Array.isArray(style) ? Object.assign({}, ...style.flat()) : { ...(style ?? {}) };
}

function frameOf(tree: renderer.ReactTestRenderer): Record<string, unknown> {
    const frame = tree.root.findAll((node) => flatStyle(node).paddingRight === 84);
    expect(frame).toHaveLength(1);
    return flatStyle(frame[0]);
}

describe('ScreenSafeAreaFrame', () => {
    it('keeps stack chrome edge to edge with safe controls and screen content inside the safe area', () => {
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(<ScreenTree />);
        });
        const probes = tree.root.findAll((node) => (node.type as unknown) === 'HeaderProbe');
        expect(probes.map((probe) => probe.props)).toEqual([
            { paddingLeft: 0, paddingRight: 84 },
            { paddingLeft: 0, paddingRight: 0 },
        ]);
        // Without a declared backdrop the margin shows the stack's contentStyle background.
        expect(frameOf(tree).backgroundColor).toBeUndefined();
    });

    it('extends the declared screen backdrop under the side inset, ignoring nested surfaces', () => {
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <ScreenTree>
                    <Backdrop color="canvas" />
                    <ScreenBackdropBoundary>
                        <Backdrop color="pane" />
                    </ScreenBackdropBoundary>
                </ScreenTree>,
            );
        });
        expect(frameOf(tree).backgroundColor).toBe('canvas');

        act(() => {
            tree.update(<ScreenTree />);
        });
        expect(frameOf(tree).backgroundColor).toBeUndefined();
    });

    it('lets the full-screen surface reclaim exactly the margin its frame applied, nothing nested deeper', () => {
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <ScreenTree>
                    <BleedProbe />
                    <ScreenBackdropBoundary>
                        <BleedProbe />
                    </ScreenBackdropBoundary>
                </ScreenTree>,
            );
        });
        const probes = tree.root.findAll((node) => (node.type as unknown) === 'BleedProbe');
        expect(probes.map((probe) => probe.props)).toEqual([
            { left: 0, right: 84 },
            { left: 0, right: 0 },
        ]);
    });
});
