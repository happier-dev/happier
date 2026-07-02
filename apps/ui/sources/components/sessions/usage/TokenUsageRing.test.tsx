import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { TokenUsageRing } from './TokenUsageRing';

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
    if (tree === null) {
        throw new Error('TokenUsageRing test renderer did not mount');
    }
    return tree;
}

describe('TokenUsageRing', () => {
    it('renders caller-provided label and value for goal budget progress', () => {
        const tree = renderRing(
            <TokenUsageRing
                used={125_000}
                limit={500_000}
                label="Goal budget"
                value="125k / 500k"
                testID="goal-budget-token-usage"
                ringTestID="goal-budget-token-usage-ring"
                valueTestID="goal-budget-token-usage-value"
                size={48}
            />,
        );

        expect(tree.root.findByProps({ accessibilityLabel: 'Goal budget' })).toBeTruthy();
        expect(tree.root.findByProps({ testID: 'goal-budget-token-usage-value' }).props.children).toBe('125k / 500k');
    });

    it('clamps visual progress to the ring circumference', () => {
        const tree = renderRing(
            <TokenUsageRing
                used={125}
                limit={100}
                label="Goal budget"
                value="125%"
                ringTestID="goal-budget-token-usage-ring"
                progressTestID="goal-budget-token-usage-progress"
            />,
        );

        expect(tree.root.findByProps({ testID: 'goal-budget-token-usage-progress' }).props.strokeDashoffset).toBe(0);
    });
});
