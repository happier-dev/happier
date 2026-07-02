import { describe, expect, it } from 'vitest';

import { filterCommandMenuItemsBySubstring } from '../filterCommandMenuItemsBySubstring';
import type { CommandMenuItem } from '../commandMenuTypes';

function makeItem(overrides: Partial<CommandMenuItem> & { id: string; label: string }): CommandMenuItem {
    return { ...overrides };
}

const ITEMS: readonly CommandMenuItem[] = [
    makeItem({ id: 'heading1', label: 'Heading 1', aliases: ['h1'], group: 'Format' }),
    makeItem({ id: 'heading2', label: 'Heading 2', aliases: ['h2'], group: 'Format' }),
    makeItem({ id: 'bullet', label: 'Bullet list', group: 'Lists' }),
    makeItem({ id: 'code', label: 'Code block', aliases: ['fenced', 'pre'], group: 'Code' }),
    makeItem({ id: 'hr', label: 'Horizontal rule', aliases: ['divider', 'separator'] }),
];

describe('filterCommandMenuItemsBySubstring', () => {
    it('returns all items when query is empty', () => {
        expect(filterCommandMenuItemsBySubstring(ITEMS, '')).toEqual(ITEMS);
    });

    it('returns all items when query is whitespace-only', () => {
        expect(filterCommandMenuItemsBySubstring(ITEMS, '   ')).toEqual(ITEMS);
    });

    it('matches substring against label', () => {
        const result = filterCommandMenuItemsBySubstring(ITEMS, 'head');
        expect(result.map((r) => r.id)).toEqual(['heading1', 'heading2']);
    });

    it('matches against aliases', () => {
        const result = filterCommandMenuItemsBySubstring(ITEMS, 'fenced');
        expect(result.map((r) => r.id)).toEqual(['code']);
    });

    it('is case-insensitive', () => {
        const result = filterCommandMenuItemsBySubstring(ITEMS, 'BULLET');
        expect(result.map((r) => r.id)).toEqual(['bullet']);
    });

    it('trims whitespace from query', () => {
        const result = filterCommandMenuItemsBySubstring(ITEMS, '  divider  ');
        expect(result.map((r) => r.id)).toEqual(['hr']);
    });

    it('preserves input order', () => {
        const result = filterCommandMenuItemsBySubstring(ITEMS, 'heading');
        expect(result).toEqual([ITEMS[0], ITEMS[1]]);
    });

    it('returns empty array when nothing matches', () => {
        const result = filterCommandMenuItemsBySubstring(ITEMS, 'nonexistent');
        expect(result).toEqual([]);
    });

    it('matches partial alias substring', () => {
        const result = filterCommandMenuItemsBySubstring(ITEMS, 'sep');
        expect(result.map((r) => r.id)).toEqual(['hr']);
    });
});
