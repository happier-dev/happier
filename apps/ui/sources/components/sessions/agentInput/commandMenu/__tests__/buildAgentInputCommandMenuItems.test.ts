import { describe, expect, it, vi } from 'vitest';

import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const { buildAgentInputCommandMenuItems } = await import('../buildAgentInputCommandMenuItems');

describe('buildAgentInputCommandMenuItems', () => {
    it('maps a label-based suggestion to a CommandMenuItem with id, label, description, and rowHeight', () => {
        const suggestions: readonly AutocompleteSuggestion[] = [
            { kind: 'slashCommand', key: 'cmd-goal', text: '/goal', label: 'goal', description: 'Set a goal', rowHeight: 52 },
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

    it('maps a suggestion without description to a CommandMenuItem with undefined description', () => {
        const suggestions: readonly AutocompleteSuggestion[] = [
            { kind: 'slashCommand', key: 'cmd-help', text: '/help', label: 'help' },
        ];

        const items = buildAgentInputCommandMenuItems(suggestions);

        expect(items).toHaveLength(1);
        expect(items[0]!.description).toBeUndefined();
    });

    it('maps multiple suggestions preserving order', () => {
        const suggestions: readonly AutocompleteSuggestion[] = [
            { kind: 'slashCommand', key: 'a', text: '/a', label: 'Alpha' },
            { kind: 'slashCommand', key: 'b', text: '/b', label: 'Beta' },
            { kind: 'slashCommand', key: 'c', text: '/c', label: 'Charlie' },
        ];

        const items = buildAgentInputCommandMenuItems(suggestions);

        expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    });

    it('returns an empty array for empty suggestions', () => {
        const items = buildAgentInputCommandMenuItems([]);
        expect(items).toEqual([]);
    });

    it('provides a renderRow function for component-based suggestions', () => {
        const MockComponent = (() => null) as React.ElementType;
        const suggestions: readonly AutocompleteSuggestion[] = [
            { kind: 'file', key: 'file-1', text: '@file.ts', component: MockComponent, rowHeight: 40 },
        ];

        const items = buildAgentInputCommandMenuItems(suggestions);

        expect(items).toHaveLength(1);
        expect(items[0]!.renderRow).toBeDefined();
        expect(typeof items[0]!.renderRow).toBe('function');
    });

    it('uses suggestion.text as the label when suggestion.label is undefined and component is present', () => {
        const suggestions: readonly AutocompleteSuggestion[] = [
            { kind: 'file', key: 'file-2', text: '@something.ts', component: (() => null) as React.ElementType },
        ];

        const items = buildAgentInputCommandMenuItems(suggestions);

        expect(items[0]!.label).toBe('@something.ts');
    });

    it('preserves the original suggestion as meta for host-side retrieval', () => {
        const suggestion: AutocompleteSuggestion = {
            kind: 'slashCommand',
            key: 'my-key',
            text: '/test',
            label: 'test',
            description: 'desc',
        };

        const items = buildAgentInputCommandMenuItems([suggestion]);

        expect(items[0]!.meta).toBe(suggestion);
    });

    // R-1 / D-17 — the picker's sections come from the registry, and CommandMenu
    // folds consecutive equal `group` values into SelectionList static sections.
    it('labels each row with its kind section, so consecutive kinds fold into sections', () => {
        const suggestions: readonly AutocompleteSuggestion[] = [
            { kind: 'file', key: 'file-a', text: '@a.ts', component: (() => null) as React.ElementType },
            { kind: 'file', key: 'file-b', text: '@b.ts', component: (() => null) as React.ElementType },
            { kind: 'vendorPlugin', key: 'plugin-a', text: '@gmail', label: 'Gmail' },
        ];

        const items = buildAgentInputCommandMenuItems(suggestions);

        expect(items.map((item) => item.group)).toEqual([
            'agentInput.suggestionGroups.files',
            'agentInput.suggestionGroups.files',
            'agentInput.suggestionGroups.plugins',
        ]);
    });

    it('renders plugin and skill rows through the primitive with a registry icon, not a bespoke row', () => {
        const suggestions: readonly AutocompleteSuggestion[] = [
            { kind: 'vendorPlugin', key: 'plugin-a', text: '@gmail', label: 'Gmail', description: 'openai-curated' },
            { kind: 'skill', key: 'skill-review', text: '$review', label: 'Review', description: 'Review a diff' },
        ];

        const items = buildAgentInputCommandMenuItems(suggestions);

        for (const item of items) {
            expect(item.renderRow).toBeUndefined();
            expect(item.icon).toBeDefined();
        }
        expect(items.map((item) => item.label)).toEqual(['Gmail', 'Review']);
        expect(items.map((item) => item.description)).toEqual(['openai-curated', 'Review a diff']);
    });

    it('does not add an icon to a row that renders itself', () => {
        const items = buildAgentInputCommandMenuItems([
            { kind: 'file', key: 'file-a', text: '@a.ts', component: (() => null) as React.ElementType },
        ]);

        expect(items[0]!.icon).toBeUndefined();
        expect(items[0]!.renderRow).toBeDefined();
    });
});
