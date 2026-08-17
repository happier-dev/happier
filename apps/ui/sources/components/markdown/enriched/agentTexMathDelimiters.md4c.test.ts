import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '../../../../node_modules/react-native-enriched-markdown/src/web/parseMarkdown';
import type { Md4cFlags } from '../../../../node_modules/react-native-enriched-markdown/src/types/MarkdownStyle';
import type { ASTNode } from '../../../../node_modules/react-native-enriched-markdown/src/web/types';
import { extractNodeText } from '../../../../node_modules/react-native-enriched-markdown/src/web/utils';

type BackslashTexMathFlags = Md4cFlags & Readonly<{ texMathBackslashDelimiters: boolean }>;

function collectNodes(root: ASTNode): readonly ASTNode[] {
    return [root, ...(root.children?.flatMap((child) => collectNodes(child)) ?? [])];
}

async function parseAgentTex(markdown: string, agentTexMath = true): Promise<ASTNode> {
    const flags: BackslashTexMathFlags = { latexMath: true, texMathBackslashDelimiters: agentTexMath };
    return parseMarkdown(markdown, flags);
}

function collectMath(root: ASTNode): readonly Readonly<{ type: string; content: string }>[] {
    return collectNodes(root)
        .filter((node) => node.type.startsWith('LatexMath'))
        .map((node) => ({ type: node.type, content: extractNodeText(node).trim() }));
}

describe('agent-style TeX delimiters in the enriched Markdown parser', () => {
    it('parses inline, standalone display, bracketed prose, and existing dollar math through one owner', async () => {
        const ast = await parseAgentTex([
            'Inline \\(x_i\\); interval [\\(a\\), \\(b\\)].',
            '*Emphasized \\(e\\).*',
            '',
            '\\[',
            'y = \\frac{1}{2}',
            '\\]',
            '',
            '  \\[z^2\\]',
            '',
            '$a_i$ and $$b^2$$',
        ].join('\n'));

        expect(collectMath(ast)).toEqual([
            { type: 'LatexMathInline', content: 'x_i' },
            { type: 'LatexMathInline', content: 'a' },
            { type: 'LatexMathInline', content: 'b' },
            { type: 'LatexMathInline', content: 'e' },
            { type: 'LatexMathDisplay', content: 'y = \\frac{1}{2}' },
            { type: 'LatexMathDisplay', content: 'z^2' },
            { type: 'LatexMathInline', content: 'a_i' },
            { type: 'LatexMathDisplay', content: 'b^2' },
        ]);
    });

    it('lets Markdown structure protect code and link destinations while allowing math in visible link labels', async () => {
        const ast = await parseAgentTex([
            'Code: `\\(inline code\\)`.',
            '```tex',
            '\\(fenced code\\)',
            '```',
            '    \\(indented code\\)',
            '[label \\(x\\)](https://example.com/\\(path\\))',
            'Escaped: \\\\(literal\\\\).',
            'Incomplete: \\(pending',
            'Embedded display \\[not display\\] text.',
        ].join('\n'));

        expect(collectMath(ast)).toEqual([{ type: 'LatexMathInline', content: 'x' }]);
        const nodes = collectNodes(ast);
        expect(nodes.filter((node) => node.type === 'Code').map(extractNodeText)).toContain('\\(inline code\\)');
        expect(nodes.filter((node) => node.type === 'CodeBlock').map((node) => extractNodeText(node).trim())).toEqual(
            expect.arrayContaining(['\\(fenced code\\)', '\\(indented code\\)']),
        );
        // MD4C applies the ordinary Markdown escape in destinations, but the path is not claimed as math.
        expect(nodes.find((node) => node.type === 'Link')?.attributes?.url).toBe('https://example.com/(path)');
    });

    it('keeps agent-style delimiters as ordinary Markdown escapes when the syntax mode is disabled', async () => {
        const ast = await parseAgentTex('Use \\(foo\\) as a parenthesized token.', false);

        expect(collectMath(ast)).toEqual([]);
        expect(extractNodeText(ast)).toContain('Use (foo) as a parenthesized token.');
    });

    it('does not let an incomplete opener consume a later complete expression', async () => {
        const ast = await parseAgentTex('Streaming: \\(pending; complete: \\(x\\).');

        expect(collectMath(ast)).toEqual([{ type: 'LatexMathInline', content: 'x' }]);
        expect(extractNodeText(ast)).toContain('\\(pending');
    });

    it('recognizes standalone display delimiters inside Markdown containers', async () => {
        const ast = await parseAgentTex([
            '> \\[',
            '> q^2',
            '> \\]',
            '',
            '- \\[',
            '  r^2',
            '  \\]',
        ].join('\n'));

        expect(collectMath(ast)).toEqual([
            { type: 'LatexMathDisplay', content: 'q^2' },
            { type: 'LatexMathDisplay', content: 'r^2' },
        ]);
    });

    it('keeps parse-cache entries isolated by the delimiter syntax flag', async () => {
        const markdown = 'Value: \\(x\\).';

        expect(collectMath(await parseAgentTex(markdown, false))).toEqual([]);
        expect(collectMath(await parseAgentTex(markdown, true))).toEqual([
            { type: 'LatexMathInline', content: 'x' },
        ]);
        expect(collectMath(await parseAgentTex(markdown, false))).toEqual([]);
    });
});
