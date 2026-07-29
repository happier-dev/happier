import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const motionState = vi.hoisted(() => ({
    level: 'subtle' as 'full' | 'subtle' | 'minimal',
}));

vi.mock('react-native-svg', () => ({
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Path: (props: Record<string, unknown>) => React.createElement('SvgPath', props, null),
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

import { DrawnLinePath } from './DrawnLinePath';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(element: React.ReactElement): ReactTestRenderer {
    let tree: ReactTestRenderer | null = null;
    act(() => {
        tree = create(element);
    });
    if (tree === null) throw new Error('DrawnLinePath test renderer did not mount');
    return tree;
}

describe('DrawnLinePath (tier-2 fallback path)', () => {
    beforeEach(() => {
        motionState.level = 'subtle';
    });

    it('renders the stroked SVG path via the fade fallback when Skia trim is unavailable', () => {
        // The global Skia test stub has no MakeFromSVGString → fallback branch.
        const tree = render(
            <DrawnLinePath path="M0 10 L20 0" width={20} height={10} color="#2BACCC" testID="dl" />,
        );
        const path = tree.root.findAll((node) => String(node.type) === 'SvgPath')[0]!;
        expect(path.props.d).toBe('M0 10 L20 0');
        expect(path.props.stroke).toBe('#2BACCC');
        expect(path.props.fill).toBe('none');
    });

    it('animateOnMount={false} renders the line fully visible (no draw-in entrance)', () => {
        const tree = render(
            <DrawnLinePath path="M0 0 L5 5" width={5} height={5} color="#000" testID="dl" animateOnMount={false} />,
        );
        const wrapper = tree.root.findAll((node) => String(node.type) === 'Animated.View')[0]!;
        const styles = Array.isArray(wrapper.props.style) ? wrapper.props.style : [wrapper.props.style];
        const animated = styles.find((s: any) => s && typeof s === 'object' && 'opacity' in s);
        expect(animated?.opacity).toBe(1);
    });

    it('renders statically-visible content at minimal level (opacity 1, no entrance)', () => {
        motionState.level = 'minimal';
        const tree = render(
            <DrawnLinePath path="M0 0 L5 5" width={5} height={5} color="#000" testID="dl" />,
        );
        const wrapper = tree.root.findAll((node) => String(node.type) === 'Animated.View')[0]!;
        const styles = Array.isArray(wrapper.props.style) ? wrapper.props.style : [wrapper.props.style];
        const animated = styles.find((s: any) => s && typeof s === 'object' && 'opacity' in s);
        expect(animated?.opacity).toBe(1);
    });
});
