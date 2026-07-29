import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '../../../../node_modules/react-native-enriched-markdown/src/web/parseMarkdown';
import type { ASTNode } from '../../../../node_modules/react-native-enriched-markdown/src/web/types';
import { applyEnrichedMarkdownImagePolicy } from './enrichedMarkdownLinkHandling';

function collectNodes(root: ASTNode): ASTNode[] {
    return [
        root,
        ...(root.children?.flatMap((child) => collectNodes(child)) ?? []),
    ];
}

const nestedImageCases = [
    {
        name: 'inline',
        markdown: '![outer ![tracking](https://tracking.invalid/inline.gif)](https://images.invalid/outer.png)',
        expectedText: 'outer tracking',
    },
    {
        name: 'full reference',
        markdown: [
            '![outer ![tracking][pixel]](https://images.invalid/outer.png)',
            '',
            '[pixel]: https://tracking.invalid/reference.gif',
        ].join('\n'),
        expectedText: 'outer tracking',
    },
    {
        name: 'shortcut reference',
        markdown: [
            '![outer ![tracking]](https://images.invalid/outer.png)',
            '',
            '[tracking]: https://tracking.invalid/shortcut.gif',
        ].join('\n'),
        expectedText: 'outer tracking',
    },
] as const;

describe('applyEnrichedMarkdownImagePolicy against installed MD4C', () => {
    it.each(nestedImageCases)('removes nested $name images at every depth', async ({ markdown, expectedText }) => {
        const unsafeAst = await parseMarkdown(markdown);
        expect(collectNodes(unsafeAst).some((node) => node.type === 'Image')).toBe(true);

        const sanitized = applyEnrichedMarkdownImagePolicy(markdown);
        const safeAst = await parseMarkdown(sanitized);

        expect(sanitized).not.toContain('![');
        expect(sanitized).toContain(expectedText);
        expect(collectNodes(safeAst).some((node) => node.type === 'Image')).toBe(false);
    });

    it('removes arbitrarily nested images rather than exposing a copied image label', async () => {
        const markdown = [
            '![outer ![middle ![tracking](https://tracking.invalid/deep.gif)](https://images.invalid/middle.png)](https://images.invalid/outer.png)',
            '',
            '[open ![linked](https://tracking.invalid/link-label.gif)](https://example.com)',
        ].join('\n');

        const sanitized = applyEnrichedMarkdownImagePolicy(markdown);
        const safeAst = await parseMarkdown(sanitized);

        expect(sanitized).toBe([
            'outer middle tracking',
            '',
            '[open linked](https://example.com)',
        ].join('\n'));
        expect(collectNodes(safeAst).some((node) => node.type === 'Image')).toBe(false);
    });

    it('keeps incomplete streaming input inert while stripping any complete nested image', async () => {
        const markdown = '![outer ![tracking](https://tracking.invalid/stream.gif)';

        const sanitized = applyEnrichedMarkdownImagePolicy(markdown);
        const safeAst = await parseMarkdown(sanitized);

        expect(sanitized).toBe('![outer tracking');
        expect(collectNodes(safeAst).some((node) => node.type === 'Image')).toBe(false);
    });

    it('fails deeply nested attacker-authored images closed without overflowing the call stack', async () => {
        const depth = 5_000;
        const markdown = `${'!['.repeat(depth)}tracking${']'.repeat(depth)}`;

        const sanitized = applyEnrichedMarkdownImagePolicy(markdown);
        const safeAst = await parseMarkdown(sanitized);

        expect(sanitized).toBe('tracking');
        expect(collectNodes(safeAst).some((node) => node.type === 'Image')).toBe(false);
    });
});
