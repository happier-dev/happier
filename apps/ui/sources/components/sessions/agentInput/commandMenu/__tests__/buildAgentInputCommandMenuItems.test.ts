import { describe, expect, it } from 'vitest';

import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import { buildAgentInputCommandMenuItems } from '../buildAgentInputCommandMenuItems';

describe('buildAgentInputCommandMenuItems', () => {
    it('maps label-based suggestions into command-menu items', () => {
        const suggestions: readonly AutocompleteSuggestion[] = [
            { key: 'cmd-goal', text: '/goal', label: 'goal', description: 'Set a goal', rowHeight: 52 },
        ];

        const items = buildAgentInputCommandMenuItems(suggestions);

        expect(items).toHaveLength(1);
        expect(items[0]).toEqual(expect.objectContaining({
            id: 'cmd-goal',
            label: 'goal',
            description: 'Set a goal',
            rowHeight: 52,
            meta: suggestions[0],
        }));
    });

    it('delegates component-based suggestions through renderRow', () => {
        const SuggestionComponent = (() => null) as React.ElementType;
        const suggestions: readonly AutocompleteSuggestion[] = [
            { key: 'file-1', text: '@file.ts', component: SuggestionComponent, rowHeight: 40 },
        ];

        const items = buildAgentInputCommandMenuItems(suggestions);

        expect(items).toHaveLength(1);
        expect(items[0]?.label).toBe('@file.ts');
        expect(items[0]?.renderRow).toEqual(expect.any(Function));
    });

    it('preserves suggestion order and host metadata', () => {
        const suggestions: readonly AutocompleteSuggestion[] = [
            { key: 'a', text: '/a', label: 'Alpha' },
            { key: 'b', text: '/b', label: 'Beta' },
            { key: 'c', text: '/c', label: 'Charlie' },
        ];

        const items = buildAgentInputCommandMenuItems(suggestions);

        expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
        expect(items.map((item) => item.meta)).toEqual(suggestions);
    });
});

