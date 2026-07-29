import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CapacityRing } from './CapacityRing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-svg', () => ({
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
}));

function renderRing(element: React.ReactElement): ReactTestRenderer {
    let tree: ReactTestRenderer | null = null;
    act(() => {
        tree = create(element);
    });
    if (tree === null) throw new Error('CapacityRing renderer did not mount');
    return tree;
}

describe('CapacityRing', () => {
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
        expect(full.root.findByProps({ testID: 'p' }).props.strokeDashoffset).toBe(0);

        const empty = renderRing(<CapacityRing ratio={-1} size={40} strokeWidth={4} color="#0a0" progressTestID="q" />);
        const radius = (40 - 4) / 2;
        expect(empty.root.findByProps({ testID: 'q' }).props.strokeDashoffset).toBeCloseTo(2 * Math.PI * radius, 5);
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
        expect(tree.root.findByProps({ testID: 'outer' }).props.strokeDashoffset)
            .toBeCloseTo(2 * Math.PI * outerRadius * 0.5, 4);
    });
});
