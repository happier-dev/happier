import { beforeAll, describe, expect, it } from 'vitest';

import { buildMarkdownSlashCommands, type MarkdownSlashTranslate } from '../buildMarkdownSlashCommands';
import type { CommandMenuItem } from '@/components/ui/commandMenu/commandMenuTypes';

/**
 * Stub `t` that returns the key itself (sufficient to prove the builder calls
 * `t(...)` with the right keys; real i18n correctness is validated by the
 * existing locale-lint tooling).
 */
const stubT: MarkdownSlashTranslate = (key) => {
    return key;
};

describe('buildMarkdownSlashCommands', () => {
    let items: readonly CommandMenuItem[];

    beforeAll(() => {
        items = buildMarkdownSlashCommands(stubT);
    });

    it('returns 9 commands (no link per D50)', () => {
        expect(items).toHaveLength(9);
    });

    it('includes heading1 with correct id', () => {
        const heading1 = items.find((i) => i.id === 'heading1');
        expect(heading1).toBeDefined();
    });

    it('includes heading2 with correct id', () => {
        const heading2 = items.find((i) => i.id === 'heading2');
        expect(heading2).toBeDefined();
    });

    it('includes heading3 with correct id', () => {
        const heading3 = items.find((i) => i.id === 'heading3');
        expect(heading3).toBeDefined();
    });

    it('includes bulletList', () => {
        expect(items.find((i) => i.id === 'bulletList')).toBeDefined();
    });

    it('includes orderedList', () => {
        expect(items.find((i) => i.id === 'orderedList')).toBeDefined();
    });

    it('includes taskList', () => {
        expect(items.find((i) => i.id === 'taskList')).toBeDefined();
    });

    it('includes blockquote', () => {
        expect(items.find((i) => i.id === 'blockquote')).toBeDefined();
    });

    it('includes codeBlock', () => {
        expect(items.find((i) => i.id === 'codeBlock')).toBeDefined();
    });

    it('includes horizontalRule', () => {
        expect(items.find((i) => i.id === 'horizontalRule')).toBeDefined();
    });

    it('does NOT include link (D50)', () => {
        expect(items.find((i) => i.id === 'link')).toBeUndefined();
    });

    it('uses t(...) for labels (stubT returns the key)', () => {
        const heading1 = items.find((i) => i.id === 'heading1')!;
        expect(heading1.label).toBe('markdown.slash.heading1.label');
    });

    it('uses t(...) for descriptions when present', () => {
        const heading1 = items.find((i) => i.id === 'heading1')!;
        expect(heading1.description).toBe('markdown.slash.heading1.description');
    });

    it('uses t(...) for group names', () => {
        const heading1 = items.find((i) => i.id === 'heading1')!;
        expect(heading1.group).toBe('markdown.slash.groups.headings');
    });

    it('heading1 has h1 and title aliases', () => {
        const heading1 = items.find((i) => i.id === 'heading1')!;
        expect(heading1.aliases).toContain('h1');
        expect(heading1.aliases).toContain('title');
    });

    it('bulletList has ul and unordered aliases', () => {
        const bullet = items.find((i) => i.id === 'bulletList')!;
        expect(bullet.aliases).toContain('ul');
        expect(bullet.aliases).toContain('unordered');
    });

    it('blockquote has quote alias', () => {
        const bq = items.find((i) => i.id === 'blockquote')!;
        expect(bq.aliases).toContain('quote');
    });

    it('orderedList has ol and numbered aliases', () => {
        const ol = items.find((i) => i.id === 'orderedList')!;
        expect(ol.aliases).toContain('ol');
        expect(ol.aliases).toContain('numbered');
    });

    it('taskList has todo and checkbox aliases', () => {
        const tl = items.find((i) => i.id === 'taskList')!;
        expect(tl.aliases).toContain('todo');
        expect(tl.aliases).toContain('checkbox');
    });

    it('codeBlock has code and pre aliases', () => {
        const cb = items.find((i) => i.id === 'codeBlock')!;
        expect(cb.aliases).toContain('code');
        expect(cb.aliases).toContain('pre');
    });

    it('horizontalRule has hr and rule aliases', () => {
        const hr = items.find((i) => i.id === 'horizontalRule')!;
        expect(hr.aliases).toContain('hr');
        expect(hr.aliases).toContain('rule');
    });

    it('groups headings under a headings group', () => {
        const headings = items.filter((i) => i.id.startsWith('heading'));
        expect(headings.every((h) => h.group === 'markdown.slash.groups.headings')).toBe(true);
    });

    it('groups lists under a lists group', () => {
        const lists = items.filter((i) => ['bulletList', 'orderedList', 'taskList'].includes(i.id));
        expect(lists.every((l) => l.group === 'markdown.slash.groups.lists')).toBe(true);
    });

    it('groups blocks under a blocks group', () => {
        const blocks = items.filter((i) => ['blockquote', 'codeBlock', 'horizontalRule'].includes(i.id));
        expect(blocks.every((b) => b.group === 'markdown.slash.groups.blocks')).toBe(true);
    });
});
