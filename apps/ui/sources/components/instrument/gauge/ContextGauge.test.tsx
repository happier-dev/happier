import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';

const themeBoundary = vi.hoisted(() => ({ warningForeground: '#C47F00' }));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ theme: { colors: { state: { warning: { foreground: themeBoundary.warningForeground } } } } });
});

vi.mock('react-native-svg', () => ({
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
}));

import { ContextGauge } from './ContextGauge';
import { ringGeometry } from './gaugeMath';
import { GAUGE_RING_STROKE_WIDTH } from './GaugeRing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = storage.getState();

function setMotionLevel(visualEffectsLevel: 'subtle' | 'minimal') {
    storage.setState({ settings: { ...storage.getState().settings, visualEffectsLevel, animatedNumbers: true, contextGaugeStyle: 'gauge' } });
}

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
    return (await renderScreen(element)).tree;
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
        storage.setState(initialStorageState, true);
        setMotionLevel('subtle');
    });
    afterEach(async () => {
        await standardCleanup();
        storage.setState(initialStorageState, true);
    });

    it('renders an empty sweep at 0% with the calm accent tone', async () => {
        const tree = await render(<ContextGauge usedPct={0} size={20} testID="cg" />);
        const { circumference } = ringGeometry(20, GAUGE_RING_STROKE_WIDTH);
        const sweep = findSweepProps(tree);
        expect(sweep.strokeDashoffset).toBeCloseTo(circumference);
        expect(sweep.stroke).toBe('#2BACCC');
        expect(tree.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'cg')[0]!.props.accessibilityLabel)
            .toBe('Context 0% used');
    });

    it('renders a half sweep at 50%', async () => {
        const tree = await render(<ContextGauge usedPct={50} size={20} testID="cg" />);
        const { circumference } = ringGeometry(20, GAUGE_RING_STROKE_WIDTH);
        expect(findSweepProps(tree).strokeDashoffset).toBeCloseTo(circumference / 2);
    });

    it('shifts to the danger tone at 95%', async () => {
        const tree = await render(<ContextGauge usedPct={95} size={20} testID="cg" />);
        expect(findSweepProps(tree).stroke).toBe('#FF3B30');
    });

    it('honors an explicit tone override instead of the low-usage accent', async () => {
        const tree = await render(<ContextGauge usedPct={10} tone="warn" size={20} testID="cg" />);
        expect(findSweepProps(tree).stroke).toBe(themeBoundary.warningForeground);
    });

    it('stale: renders track + dot, no sweep, and the unavailable label', async () => {
        const tree = await render(<ContextGauge usedPct={42} stale size={20} testID="cg" />);
        expect(tree.root.findAll((node) => String(node.type) === 'Circle' && node.props.animatedProps != null)).toHaveLength(0);
        // Track circle + the small filled dot.
        const dots = tree.root.findAll((node) => String(node.type) === 'Circle' && node.props.fill && node.props.fill !== 'none');
        expect(dots).toHaveLength(1);
        const host = tree.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'cg')[0]!;
        expect(host.props.accessibilityLabel).toBe('Context usage unavailable after model change');
    });

    it('press: wraps in a pressable with an expanded hit area and fires onPress', async () => {
        const onPress = vi.fn();
        const tree = await render(<ContextGauge usedPct={30} size={20} onPress={onPress} testID="cg" />);
        const pressable = tree.root.findAll((node) => String(node.type) === 'Pressable')[0]!;
        expect(pressable.props.hitSlop).toBe(10);
        expect(pressable.props.accessibilityRole).toBe('button');
        act(() => {
            pressable.props.onPress();
        });
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('press: minimal motion acknowledges with opacity only, never a scale', async () => {
        setMotionLevel('minimal');
        const element = () => <ContextGauge usedPct={30} size={20} onPress={() => {}} testID="cg" />;
        const tree = await render(element());
        const pressable = () => tree.root.findAll((node) => String(node.type) === 'Pressable')[0]!;
        act(() => {
            pressable().props.onPressIn();
        });
        act(() => {
            tree.update(element());
        });
        // The outermost animated frame is the press frame; the ring animates inside it.
        const frames = pressable().findAll((node) => String(node.type) === 'Animated.View');
        const style = [frames[0]!.props.style].flat(Infinity).reduce<Record<string, unknown>>(
            (result, entry) => Object.assign(result, entry ?? {}),
            {},
        );
        expect(style.opacity).toBeCloseTo(0.7);
        expect(style.transform).toBeUndefined();
    });

    it('minimal level still renders the ring statically (no liquid tier)', async () => {
        setMotionLevel('minimal');
        const tree = await render(<ContextGauge usedPct={50} size={20} testID="cg" />);
        const { circumference } = ringGeometry(20, GAUGE_RING_STROKE_WIDTH);
        expect(findSweepProps(tree).strokeDashoffset).toBeCloseTo(circumference / 2);
    });
});
