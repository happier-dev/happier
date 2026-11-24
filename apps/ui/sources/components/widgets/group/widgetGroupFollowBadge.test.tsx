import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { HappierWidgetFrame } from '@happier-dev/plugin-ui/presentation';
import { USAGE_QUERY_INPUT_FIELDS } from '@happier-dev/protocol/inputs';
import type { WidgetInputBindingsV1, WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { useWidgetInstanceBindingLabel } from '../surface/useWidgetInstanceBindingLabel';
import type { WidgetSurfaceContext } from '../surface/widgetSurfaceSetup';
import type { WidgetCandidate } from '../widgetCatalog';
import { useWidgetGroupFollowedValue } from './widgetGroupFollowedInputs';
import { widgetGroupFollowSource } from './widgetGroupInputs';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(standardCleanup);

const definition = { kind: 'builtin', id: 'usage_period_summary' } as const;
const candidate: WidgetCandidate = {
    key: 'summary', title: 'Period summary', pluginName: 'Usage', sharedPluginName: false,
    icon: 'squares-four', homeDefault: 'available', target: 'app', definition,
    inputs: {
        fields: USAGE_QUERY_INPUT_FIELDS.filter(field => field.path === 'period' || field.path === 'costBasis'),
    },
};
const follow = (slot: string) => ({ kind: 'context', slot } as const);
const last90 = { kind: 'value', value: { relative: '90days' } } as const;

async function renderCard(bindings: WidgetInputBindingsV1, group: WidgetInputBindingsV1, context: WidgetSurfaceContext = {},
    labels: Readonly<Record<string, string | null>> = {}) {
    const instance: WidgetInstanceV1 = { v: 1, id: 'child', definition, bindings };
    function Card() {
        const pageLabel = useWidgetInstanceBindingLabel(instance, candidate, context);
        const followed = useWidgetGroupFollowedValue(instance, candidate, context, { kind: 'corePage', pageId: 'usage', area: 'main' }, group, labels);
        return <HappierWidgetFrame frameStyle="plain" placement="home" title="Period summary" testID="card"
            source={followed ? widgetGroupFollowSource(followed, true) : pageLabel ?? undefined} />;
    }
    return renderScreen(<Card />);
}

const caption = (value: string) => `widgetFrame.followingGroupValue(value=${value})`;

it('shows the label of a typed Period group pin in the card', async () => {
    const screen = await renderCard({ period: follow('period') }, { period: last90 });
    expect(screen.findByTestId('card.source')?.props.accessibilityLabel).toBe(caption('usage.last90Days'));
});

it('uses the declared Period title when its bound operand has no value yet', async () => {
    const screen = await renderCard({ period: follow('period') }, { period: follow('calendar') });
    expect(screen.findByTestId('card.source')?.props.accessibilityLabel).toBe(caption('Period'));
});

it('shows the first followed field in declaration order when the card has more than one', async () => {
    const screen = await renderCard(
        { costBasis: follow('money'), period: follow('period') },
        { money: { kind: 'value', value: 'auto' }, period: follow('calendar') },
        { slots: { calendar: { label: 'This calendar', value: { value: { relative: '30days' }, label: 'Month to date' } } } },
        { money: 'Unrelated money label' },
    );
    expect(screen.findByTestId('card.source')?.props.accessibilityLabel).toBe(caption('Month to date'));
});

it('never repeats Following group when a second input follows the page', async () => {
    const screen = await renderCard(
        { costBasis: follow('costBasis'), period: follow('period') },
        { period: last90 },
        { slots: { costBasis: { label: 'This page', value: { value: 'auto', label: 'Automatic' } } } },
        { period: null },
    );
    expect(screen.findByTestId('card.source')?.props.accessibilityLabel).toBe(caption('usage.last90Days'));
});

it('keeps the page source for a field that follows the page instead of the group', async () => {
    const screen = await renderCard(
        { period: follow('period') },
        { unrelated: last90 },
        { slots: { period: { label: 'This page', value: null } } },
    );
    expect(screen.getTextContent()).toContain('This page');
    expect(screen.findByTestId('card.source')?.props.accessibilityLabel ?? '').not.toContain('widgetFrame.followingGroupValue');
});

it('shows no group badge for a field the child pins', async () => {
    const screen = await renderCard({ period: last90 }, { period: last90 });
    expect(screen.findByTestId('card.source')?.props.accessibilityLabel ?? '').not.toContain('widgetFrame.followingGroupValue');
});
