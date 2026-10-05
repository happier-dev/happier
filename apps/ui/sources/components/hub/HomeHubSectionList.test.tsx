import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

afterEach(() => standardCleanup());

const builtin = (id: string) => ({ kind: 'builtin' as const, id, hidden: false, hideable: true });
const widget = (id: string, width: 'half' | 'full' = 'half') => ({
    kind: 'widget' as const, id, hidden: false as const, hideable: true as const, width,
    instance: { v: 1 as const, id, definition: { kind: 'installed' as const, surface: { pluginId: 'happier.widget.checks', localId: 'latest' } }, bindings: {} },
});

async function renderList(sections: ReadonlyArray<ReturnType<typeof builtin> | ReturnType<typeof widget>>) {
    const { HomeHubSectionList } = await import('./HomeHubSectionList');
    return renderScreen(
        <HomeHubSectionList
            sections={sections}
            renderSection={(section) => `block:${section.id}`}
        />,
    );
}

function cellSpans(screen: Awaited<ReturnType<typeof renderList>>, gridTestID: string): unknown[] {
    const grid = screen.findByTestId(gridTestID);
    expect(grid).toBeTruthy();
    return grid!.findAll((node) => 'span' in (node.props ?? {})).map((node) => node.props.span);
}

describe('HomeHubSectionList (the column contract)', () => {
    it('lays two consecutive cards out as one two-up row, and every other block on its own', async () => {
        const screen = await renderList([builtin('start'), widget('widget:a/latest'), builtin('automations'), builtin('usage')]);
        expect(screen.getTextContent()).toBe('block:start block:widget:a/latest block:automations block:usage');
        // The card row asks its grid for two columns (the grid measures how many fit).
        const requested = screen.findAll((node) => node.props?.testID === 'home-hub.cards:widget:a/latest' && 'columns' in node.props);
        expect(requested.map((node) => node.props.columns)).toEqual([2]);
        expect(cellSpans(screen, 'home-hub.cards:widget:a/latest').every((span) => span === undefined)).toBe(true);
    });

    it('lets a card that is alone in its row take the whole row instead of leaving a hole', async () => {
        const screen = await renderList([builtin('start'), builtin('automations'), builtin('usage')]);
        expect(cellSpans(screen, 'home-hub.cards:automations')).toContain('row');
    });

    it('preserves a configured full-width copy between independently sized half-width copies', async () => {
        const screen = await renderList([widget('first'), widget('wide', 'full'), widget('last')]);
        expect(screen.getTextContent()).toBe('block:first block:wide block:last');
        const grid = screen.findByTestId('home-hub.cards:first');
        const full = grid?.findAll((node) => node.props?.span === 'row');
        expect(full).toHaveLength(1);
        expect(full?.[0]?.props.children).toBe('block:wide');
    });
});
