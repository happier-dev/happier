import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const motionState = vi.hoisted(() => ({
    level: 'subtle' as 'full' | 'subtle' | 'minimal',
}));

vi.mock('react-native-svg', () => ({
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
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

import { ContextGauge } from './ContextGauge';
import { ringGeometry } from './gaugeMath';
import { GAUGE_RING_STROKE_WIDTH } from './GaugeRing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(element: React.ReactElement): ReactTestRenderer {
    let tree: ReactTestRenderer | null = null;
    act(() => {
        tree = create(element);
    });
    if (tree === null) throw new Error('ContextGauge test renderer did not mount');
    return tree;
}

function findSweepProps(tree: ReactTestRenderer): Record<string, any> {
    // The animated progress circle carries `animatedProps` (identity-mocked
    // createAnimatedComponent passes it straight to the Circle host).
    const circles = tree.root.findAll((node) => String(node.type) === 'Circle' && node.props.animatedProps != null);
    expect(circles).toHaveLength(1);
    return circles[0]!.props.animatedProps;
}

describe('ContextGauge (tier 2 ring)', () => {
    beforeEach(() => {
        motionState.level = 'subtle';
    });

    it('renders an empty sweep at 0% with the calm accent tone', () => {
        const tree = render(<ContextGauge usedPct={0} size={20} testID="cg" />);
        const { circumference } = ringGeometry(20, GAUGE_RING_STROKE_WIDTH);
        const sweep = findSweepProps(tree);
        expect(sweep.strokeDashoffset).toBeCloseTo(circumference);
        expect(sweep.stroke).toBe('#2BACCC');
        expect(tree.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'cg')[0]!.props.accessibilityLabel)
            .toBe('Context 0% used');
    });

    it('renders a half sweep at 50%', () => {
        const tree = render(<ContextGauge usedPct={50} size={20} testID="cg" />);
        const { circumference } = ringGeometry(20, GAUGE_RING_STROKE_WIDTH);
        expect(findSweepProps(tree).strokeDashoffset).toBeCloseTo(circumference / 2);
    });

    it('shifts to the danger tone at 95%', () => {
        const tree = render(<ContextGauge usedPct={95} size={20} testID="cg" />);
        expect(findSweepProps(tree).stroke).toBe('#FF3B30');
    });

    it('honors an explicit tone override', () => {
        const tree = render(<ContextGauge usedPct={10} tone="warn" size={20} testID="cg" />);
        // Vitest's unistyles mock theme: state.warning.foreground = '#8E8E93'.
        expect(findSweepProps(tree).stroke).toBe('#8E8E93');
    });

    it('stale: renders track + dot, no sweep, and the unavailable label', () => {
        const tree = render(<ContextGauge usedPct={42} stale size={20} testID="cg" />);
        expect(tree.root.findAll((node) => String(node.type) === 'Circle' && node.props.animatedProps != null)).toHaveLength(0);
        // Track circle + the small filled dot.
        const dots = tree.root.findAll((node) => String(node.type) === 'Circle' && node.props.fill && node.props.fill !== 'none');
        expect(dots).toHaveLength(1);
        const host = tree.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'cg')[0]!;
        expect(host.props.accessibilityLabel).toBe('Context usage unavailable after model change');
    });

    it('press: wraps in a pressable with an expanded hit area and fires onPress', () => {
        const onPress = vi.fn();
        const tree = render(<ContextGauge usedPct={30} size={20} onPress={onPress} testID="cg" />);
        const pressable = tree.root.findAll((node) => String(node.type) === 'Pressable')[0]!;
        expect(pressable.props.hitSlop).toBe(10);
        expect(pressable.props.accessibilityRole).toBe('button');
        act(() => {
            pressable.props.onPress();
        });
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('minimal level still renders the ring statically (no liquid tier)', () => {
        motionState.level = 'minimal';
        const tree = render(<ContextGauge usedPct={50} size={20} testID="cg" />);
        const { circumference } = ringGeometry(20, GAUGE_RING_STROKE_WIDTH);
        expect(findSweepProps(tree).strokeDashoffset).toBeCloseTo(circumference / 2);
    });
});
