import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';

const withTimingSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const mock = createReanimatedModuleMock();
    return {
        ...mock,
        withTiming: (...args: Parameters<typeof mock.withTiming>) => {
            withTimingSpy(...args);
            return mock.withTiming(...args);
        },
    };
});

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { CapacityRing } from './CapacityRing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderRing(element: React.ReactElement): ReactTestRenderer {
    let tree: ReactTestRenderer | null = null;
    act(() => {
        tree = create(element);
    });
    if (tree === null) throw new Error('CapacityRing renderer did not mount');
    return tree;
}

function readDashOffset(tree: ReactTestRenderer, testID: string): number {
    const props = tree.root.findByProps({ testID }).props as Readonly<{
        animatedProps?: Readonly<{ strokeDashoffset?: number }>;
        dashOffset?: number;
        strokeDashoffset?: number;
    }>;
    const value = props.animatedProps?.strokeDashoffset ?? props.strokeDashoffset ?? props.dashOffset;
    if (value == null) {
        throw new Error(`Missing dash offset on ${testID}; props=${JSON.stringify(props)}`);
    }
    return Number(value);
}

describe('CapacityRing', () => {
    beforeEach(() => {
        setReducedMotionPreferenceOverride(false);
        withTimingSpy.mockClear();
    });

    afterEach(() => {
        setReducedMotionPreferenceOverride(null);
    });

    it.each([undefined, '71% capacity'])('exposes an image role only for a named ring (%s)', async accessibilityLabel => {
        const screen = await renderScreen(<CapacityRing ratio={0.71} color="#0a0" testID="semantic-ring" accessibilityLabel={accessibilityLabel} />);
        expect(screen.findByTestId('semantic-ring')?.props.accessibilityRole).toBe(accessibilityLabel ? 'image' : undefined);
        expect(screen.findByTestId('semantic-ring')?.props.accessibilityLabel).toBe(accessibilityLabel);
    });

    it('renders the centered content and accessibility label', () => {
        const tree = renderRing(
            <CapacityRing ratio={0.71} color="#0a0" testID="ring" accessibilityLabel="71% capacity">
                {React.createElement('Center', { testID: 'ring-center' }, '71')}
            </CapacityRing>,
        );

        expect(tree.root.findByProps({ accessibilityLabel: '71% capacity' })).toBeTruthy();
        expect(tree.root.findByProps({ testID: 'ring-center' }).props.children).toBe('71');
    });

    it('maps a single ratio to the progress arc dash offset and clamps out-of-range values', () => {
        const full = renderRing(<CapacityRing ratio={2} color="#0a0" progressTestID="p" />);
        // ratio clamped to 1 -> the arc is fully drawn -> zero remaining offset.
        expect(readDashOffset(full, 'p')).toBe(0);

        const empty = renderRing(<CapacityRing ratio={-1} size={40} strokeWidth={4} color="#0a0" progressTestID="q" />);
        const radius = (40 - 4) / 2;
        expect(readDashOffset(empty, 'q')).toBeCloseTo(2 * Math.PI * radius, 5);
    });

    it('renders one track + one progress arc per concentric ring (outer carries progressTestID)', () => {
        const tree = renderRing(
            <CapacityRing
                size={44}
                strokeWidth={3}
                rings={[{ ratio: 0.5, color: '#a00' }, { ratio: 0.9, color: '#0a0' }]}
                progressTestID="outer"
            />,
        );

        // 2 rings -> 2 track + 2 progress = 4 Circles.
        expect(tree.root.findAllByType('Circle' as never).length).toBe(4);

        // The outer arc (50% filled) carries the progress testID.
        const outerRadius = (44 - 3) / 2;
        expect(readDashOffset(tree, 'outer'))
            .toBeCloseTo(2 * Math.PI * outerRadius * 0.5, 4);
    });

    it('animates a changed ratio with the shared base timing and skips motion when reduced', () => {
        const tree = renderRing(<CapacityRing ratio={0.2} color="#0a0" progressTestID="p" />);
        expect(withTimingSpy).not.toHaveBeenCalled();

        act(() => {
            tree.update(<CapacityRing ratio={0.8} color="#0a0" progressTestID="p" />);
        });
        expect(withTimingSpy).toHaveBeenCalledWith(
            expect.any(Number),
            expect.objectContaining({ duration: motionTokens.durationMs.base }),
        );

        act(() => {
            setReducedMotionPreferenceOverride(true);
        });
        withTimingSpy.mockClear();
        act(() => {
            tree.update(<CapacityRing ratio={0.4} color="#0a0" progressTestID="p" />);
        });
        expect(withTimingSpy).not.toHaveBeenCalled();
    });

    it('draws the parts of one whole on one radius, end to end from the top, with a hatched part', () => {
        const size = 100;
        const strokeWidth = 10;
        const tree = renderRing(
            <CapacityRing
                size={size}
                strokeWidth={strokeWidth}
                segmentGap={0}
                segments={[
                    { fraction: 0.5, color: '#111' },
                    { fraction: 0, color: '#222' },
                    { fraction: 0.25, color: '#333' },
                    { fraction: 0.25, color: '#444', pattern: 'hatched' },
                ]}
            />,
        );
        const radius = (size - strokeWidth) / 2;
        const circumference = 2 * Math.PI * radius;
        const arcs = tree.root.findAllByType('Circle' as never)
            .map(node => node.props as Readonly<{ r: number; stroke: string; strokeDasharray?: string; strokeDashoffset?: number }>)
            .filter(props => props.strokeDasharray !== undefined);
        // An empty part draws nothing; every drawn part shares the outer radius.
        expect(arcs).toHaveLength(3);
        expect(new Set(arcs.map(arc => arc.r))).toEqual(new Set([radius]));
        const lengths = arcs.map(arc => Number(arc.strokeDasharray!.split(' ')[0]));
        expect(lengths[0]).toBeCloseTo(circumference * 0.5, 4);
        expect(lengths[1]).toBeCloseTo(circumference * 0.25, 4);
        // Each part starts where the previous one ended.
        expect(arcs.map(arc => Number(arc.strokeDashoffset))).toEqual([
            expect.closeTo(0, 4), expect.closeTo(-circumference * 0.5, 4), expect.closeTo(-circumference * 0.75, 4),
        ]);
        // The set-aside part is its colour's hatch, not a flat fill.
        const pattern = tree.root.findByType('Pattern' as never);
        expect(arcs[2]!.stroke).toBe(`url(#${String(pattern.props.id)})`);
        expect(pattern.findByType('Path' as never).props.stroke).toBe('#444');
        expect(arcs[0]!.stroke).toBe('#111');
    });
});
