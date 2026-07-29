import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const motionState = vi.hoisted(() => ({
    level: 'full' as 'full' | 'subtle' | 'minimal',
}));

vi.mock('../motion/useMotionPreferences', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../motion/useMotionPreferences')>();
    return {
        ...actual,
        useMotionPreferences: () => actual.resolveMotionPreferences({
            visualEffectsLevel: motionState.level,
            animatedNumbers: true,
            contextGaugeStyle: 'gauge',
            osReduceMotion: false,
            isWeb: false,
        }),
    };
});

import { RippleGrid, rippleDelayMs } from './RippleGrid';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(element: React.ReactElement): ReactTestRenderer {
    let tree: ReactTestRenderer | null = null;
    act(() => {
        tree = create(element);
    });
    if (tree === null) throw new Error('RippleGrid test renderer did not mount');
    return tree;
}

describe('rippleDelayMs', () => {
    it('ripples radially from the top-left in 40ms ring steps', () => {
        const columns = 7;
        expect(rippleDelayMs(0, columns)).toBe(0);       // (0,0)
        expect(rippleDelayMs(1, columns)).toBe(40);      // (0,1) ring 1
        expect(rippleDelayMs(7, columns)).toBe(40);      // (1,0) ring 1
        expect(rippleDelayMs(8, columns)).toBe(40);      // (1,1) ring 1
        expect(rippleDelayMs(2, columns)).toBe(80);      // (0,2) ring 2
        expect(rippleDelayMs(16, columns)).toBe(80);     // (2,2) ring 2
    });

    it('caps the wavefront at the shared stagger budget (8 rings)', () => {
        const columns = 30;
        expect(rippleDelayMs(29, columns)).toBe(7 * 40); // ring 29 → capped at 7
        expect(rippleDelayMs(299, columns)).toBe(7 * 40);
    });
});

describe('RippleGrid', () => {
    beforeEach(() => {
        motionState.level = 'full';
    });

    it('renders each child inside a sized cell', () => {
        const tree = render(
            <RippleGrid columns={2} cellSize={10} testID="grid">
                {[<React.Fragment key="a">A</React.Fragment>, <React.Fragment key="b">B</React.Fragment>, <React.Fragment key="c">C</React.Fragment>]}
            </RippleGrid>,
        );
        const cells = tree.root.findAll((node) => String(node.type) === 'Animated.View');
        expect(cells).toHaveLength(3);
    });

    it('animateOnMount={false} renders cells in their final state (no ripple entrance)', () => {
        const tree = render(
            <RippleGrid columns={2} cellSize={10} testID="grid" animateOnMount={false}>
                {[<React.Fragment key="a">A</React.Fragment>]}
            </RippleGrid>,
        );
        const cell = tree.root.findAll((node) => String(node.type) === 'Animated.View')[0]!;
        const styles = Array.isArray(cell.props.style) ? cell.props.style : [cell.props.style];
        const animated = styles.find((s: any) => s && typeof s === 'object' && 'opacity' in s);
        expect(animated?.opacity).toBe(1);
        expect(animated?.transform).toEqual([{ scale: 1 }]);
    });

    it('minimal level renders without scale travel (crossfade only)', () => {
        motionState.level = 'minimal';
        const tree = render(
            <RippleGrid columns={2} cellSize={10} testID="grid">
                {[<React.Fragment key="a">A</React.Fragment>]}
            </RippleGrid>,
        );
        const cell = tree.root.findAll((node) => String(node.type) === 'Animated.View')[0]!;
        // The animated style factory (identity-mocked) bakes scale 1 when travel is off.
        const styles = Array.isArray(cell.props.style) ? cell.props.style : [cell.props.style];
        const animated = styles.find((s: any) => s && typeof s === 'object' && 'transform' in s);
        expect(animated?.transform).toEqual([{ scale: 1 }]);
    });
});
