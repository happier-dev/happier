import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { MachineResourcesGauge } from './MachineResourcesGauge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-svg', () => ({
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
}));

function renderGauge(element: React.ReactElement): ReactTestRenderer {
    let tree: ReactTestRenderer | null = null;
    act(() => {
        tree = create(element);
    });
    if (tree === null) {
        throw new Error('MachineResourcesGauge test renderer did not mount');
    }
    return tree;
}

function findTextContent(tree: ReactTestRenderer, text: string): number {
    return tree.root.findAll((node) => node.props?.children === text).length;
}

describe('MachineResourcesGauge', () => {
    it('passes the usage ratio and percent label through to the shared ring', () => {
        const tree = renderGauge(
            <MachineResourcesGauge
                label="Memory"
                usagePercent={25}
                detail="4 GB / 16 GB"
                tone="warning"
                testID="gauge"
                ringTestID="gauge-ring"
                progressTestID="gauge-progress"
                labelTestID="gauge-label"
                valueTestID="gauge-value"
            />,
        );

        // size 56 / strokeWidth 4 → outer radius 26; a 25% arc leaves three quarters empty.
        const circumference = 2 * Math.PI * 26;
        expect(tree.root.findByProps({ testID: 'gauge-progress' }).props.strokeDashoffset)
            .toBeCloseTo(circumference * 0.75, 5);
        expect(tree.root.findByProps({ testID: 'gauge-value' }).props.children).toBe('25%');
        expect(tree.root.findByProps({ testID: 'gauge-label' }).props.children).toBe('Memory');
        expect(findTextContent(tree, '4 GB / 16 GB')).toBeGreaterThan(0);
    });

    it('renders an unmeasured neutral gauge without a filled arc', () => {
        const tree = renderGauge(
            <MachineResourcesGauge
                label="CPU"
                usagePercent={null}
                tone="unknown"
                ringTestID="idle-ring"
                progressTestID="idle-progress"
                valueTestID="idle-value"
            />,
        );

        const circumference = 2 * Math.PI * 26;
        expect(tree.root.findByProps({ testID: 'idle-progress' }).props.strokeDashoffset)
            .toBeCloseTo(circumference, 5);
        expect(tree.root.findByProps({ testID: 'idle-value' }).props.children).toBe('—');
    });

    it('clamps an out-of-range percent into the ring', () => {
        const tree = renderGauge(
            <MachineResourcesGauge
                label="Disk"
                usagePercent={150}
                tone="danger"
                progressTestID="clamped-progress"
                valueTestID="clamped-value"
            />,
        );

        expect(tree.root.findByProps({ testID: 'clamped-progress' }).props.strokeDashoffset).toBe(0);
        expect(tree.root.findByProps({ testID: 'clamped-value' }).props.children).toBe('150%');
    });
});
