import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { GoalUsageMetadata } from './GoalUsageMetadata';
import type { SessionWorkStateItem } from '@/sync/domains/session/workState/sessionWorkStateTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).installTextModuleMock({
    translate: (key, params) => {
        if (key === 'session.workState.goal.budgetProgress' && params?.used && params?.budget) {
            return `${params.used} / ${params.budget}`;
        }
        if (key === 'session.workState.goal.tokensSuffix' && params?.count != null) {
            return `${params.count} tokens`;
        }
        if (key === 'session.workState.goal.budgetCaption' && params?.budget != null) {
            return `of ${params.budget} budget`;
        }
        return key;
    },
})());

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props, null),
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).installReactNativeWebMock({
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
})());

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).installUnistylesMock()());

function collectText(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value)) return value.map(collectText).join(' ');
    const record = value as { children?: unknown };
    return collectText(record.children);
}

const base: SessionWorkStateItem = {
    id: 'goal',
    kind: 'goal',
    origin: 'vendor',
    status: 'active',
    title: 'Ship goals',
    updatedAt: 1,
};

function render(goal: SessionWorkStateItem): renderer.ReactTestRenderer {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
        tree = renderer.create(<GoalUsageMetadata goal={goal} />);
    });
    return tree as renderer.ReactTestRenderer;
}

describe('GoalUsageMetadata', () => {
    it('renders nothing for an ACTIVE goal with no usage yet (honest emptiness, not fake status)', () => {
        // base.status === 'active'. Providers like Claude report usage only on completion, so an
        // active goal legitimately has no usage mid-run — "No usage yet" would read as "nothing is
        // happening". The whole component must render null in that case.
        const tree = render(base);
        expect(tree.toJSON()).toBeNull();
        act(() => tree.unmount());
    });

    it('shows a muted "no usage yet" line for a NON-active goal with no tokens or time', () => {
        const tree = render({ ...base, status: 'complete' });
        expect(collectText(tree.toJSON())).toContain('session.workState.goal.noUsageYet');
        expect(() => tree.root.findByProps({ testID: 'session-goal-budget-meter' })).toThrow();
        act(() => tree.unmount());
    });

    it('renders inline time + tokens with no budget meter when no budget is set', () => {
        const tree = render({ ...base, tokensUsed: 89000, timeUsedSeconds: 190 });
        const meta = collectText(tree.root.findByProps({ testID: 'session-goal-usage-meta' }).props.children);
        expect(meta).toContain('3m 10s');
        expect(meta).toContain('89k tokens');
        expect(meta).toContain('·');
        expect(() => tree.root.findByProps({ testID: 'session-goal-budget-meter' })).toThrow();
        act(() => tree.unmount());
    });

    it('renders a consumed-fill meter (fillFraction=ratio, not inverted), percent, and caption when a budget exists', () => {
        const tree = render({ ...base, tokensUsed: 250, tokenBudget: 1000 });
        const meta = collectText(tree.root.findByProps({ testID: 'session-goal-usage-meta' }).props.children);
        expect(meta).toContain('250 / 1k');
        expect(meta).toContain('25%');
        const meter = tree.root.findByProps({ testID: 'session-goal-budget-meter' });
        // fill = consumed ratio (0.25), NOT the old remaining (0.75).
        expect(meter.props.fillFraction).toBeCloseTo(0.25, 5);
        expect(meter.props.tone).toBe('neutral');
        expect(collectText(tree.root.findByProps({ testID: 'session-goal-budget-caption' }).props.children))
            .toContain('of 1k budget');
        act(() => tree.unmount());
    });

    it('escalates the meter tone toward danger as consumed fill approaches the budget', () => {
        const belowWarning = render({ ...base, tokensUsed: 890, tokenBudget: 1000 });
        expect(belowWarning.root.findByProps({ testID: 'session-goal-budget-meter' }).props.tone).toBe('neutral');
        act(() => belowWarning.unmount());

        const warn = render({ ...base, tokensUsed: 900, tokenBudget: 1000 });
        expect(warn.root.findByProps({ testID: 'session-goal-budget-meter' }).props.tone).toBe('warning');
        act(() => warn.unmount());

        const danger = render({ ...base, tokensUsed: 1200, tokenBudget: 1000 });
        const dangerMeter = danger.root.findByProps({ testID: 'session-goal-budget-meter' });
        expect(dangerMeter.props.tone).toBe('danger');
        // Over-budget fill is clamped by MeterBar to 1; the passed fraction is >= 1.
        expect(dangerMeter.props.fillFraction).toBeGreaterThanOrEqual(1);
        act(() => danger.unmount());
    });
});
