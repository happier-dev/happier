import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '../../../../node_modules/react-native-enriched-markdown/src/web/parseMarkdown';
import type { ASTNode } from '../../../../node_modules/react-native-enriched-markdown/src/web/types';
import { extractNodeText } from '../../../../node_modules/react-native-enriched-markdown/src/web/utils';
import { normalizeEnrichedMarkdownMathDelimiters } from './normalizeEnrichedMarkdownMathDelimiters';

function collectNodes(root: ASTNode): readonly ASTNode[] {
    return [
        root,
        ...(root.children?.flatMap((child) => collectNodes(child)) ?? []),
    ];
}

describe('normalizeEnrichedMarkdownMathDelimiters against installed MD4C', () => {
    it('produces inline and display math nodes through the renderer parser', async () => {
        const normalized = normalizeEnrichedMarkdownMathDelimiters([
            'Inline \\(x_i\\); existing $a_i$ stays supported.',
            '',
            '\\[',
            'y = \\frac{1}{2}',
            '\\]',
            '',
            '\\[z^2\\]',
            '',
            '$$b^2$$',
        ].join('\n'));

        const ast = await parseMarkdown(normalized, { latexMath: true });
        const mathNodes = collectNodes(ast).filter((node) => node.type.startsWith('LatexMath'));

        expect(mathNodes.map((node) => ({ type: node.type, content: extractNodeText(node).trim() }))).toEqual([
            { type: 'LatexMathInline', content: 'x_i' },
            { type: 'LatexMathInline', content: 'a_i' },
            { type: 'LatexMathDisplay', content: 'y = \\frac{1}{2}' },
            { type: 'LatexMathDisplay', content: 'z^2' },
            { type: 'LatexMathDisplay', content: 'b^2' },
        ]);
    });

    it('renders nested-list prose as math without changing code block contents', async () => {
        const normalized = normalizeEnrichedMarkdownMathDelimiters([
            '- outer',
            '    - inner \\(x\\)',
            '',
            '> ```tex',
            '> \\(fenced code\\)',
            '> ```',
            '>',
            '>     \\(indented code\\)',
            '>',
            '> Prose \\(y\\).',
        ].join('\n'));

        const ast = await parseMarkdown(normalized, { latexMath: true });
        const nodes = collectNodes(ast);
        const math = nodes
            .filter((node) => node.type.startsWith('LatexMath'))
            .map((node) => extractNodeText(node).trim());
        const code = nodes
            .filter((node) => node.type === 'CodeBlock')
            .map((node) => extractNodeText(node));

        expect(math).toEqual(['x', 'y']);
        expect(code.some((content) => content.includes('\\(fenced code\\)'))).toBe(true);
        expect(code.some((content) => content.includes('\\(indented code\\)'))).toBe(true);
    });

    it('produces display math nodes inside blockquotes and list items', async () => {
        const normalized = normalizeEnrichedMarkdownMathDelimiters([
            '> \\[',
            '> x + y',
            '> \\]',
            '> \\[z^2\\]',
            '',
            '- \\[',
            '  a = b',
            '  \\]',
            '- \\[c^2\\]',
        ].join('\n'));

        const ast = await parseMarkdown(normalized, { latexMath: true });
        const math = collectNodes(ast)
            .filter((node) => node.type === 'LatexMathDisplay')
            .map((node) => extractNodeText(node).trim());

        expect(math).toEqual(['x + y', 'z^2', 'a = b', 'c^2']);
    });
});
