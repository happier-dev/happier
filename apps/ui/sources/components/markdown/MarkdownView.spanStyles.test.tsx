import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./MermaidRenderer', () => ({
    MermaidRenderer: () => null,
}));

function flattenStyle(style: any): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const visit = (node: any) => {
        if (!node) return;
        if (Array.isArray(node)) {
            for (const child of node) visit(child);
            return;
        }
        if (typeof node === 'object') {
            for (const [k, v] of Object.entries(node)) out[k] = v;
        }
    };
    visit(style);
    return out;
}

describe('MarkdownView (span styles)', () => {
    it('renders bold/italic using the correct font families and keeps inline code aligned with base color/size', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = '**Exploring Reasoning Options** *Considering tools* `git diff`';
        const textStyle = {
            fontStyle: 'italic' as const,
            fontSize: 14,
            lineHeight: 20,
            color: 'rgb(120, 120, 120)',
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MarkdownView markdown={markdown} textStyle={textStyle} />);
        });

        const findTextNode = (text: string) =>
            tree!.root.findAll((n) => typeof n.props?.children === 'string' && n.props.children === text)[0]!;

        const boldNode = findTextNode('Exploring Reasoning Options');
        const italicNode = findTextNode('Considering tools');
        const codeNode = findTextNode('git diff');

        const boldStyle = flattenStyle(boldNode.props.style);
        const italicStyle = flattenStyle(italicNode.props.style);
        const codeStyle = flattenStyle(codeNode.props.style);

        expect(boldStyle.fontFamily).toBe('Inter-SemiBold');
        expect(italicStyle.fontFamily).toBe('Inter-Italic');
        expect(codeStyle.fontFamily).toBe('IBMPlexMono-Regular');
        expect(codeStyle.fontSize).toBe(14);
        expect(codeStyle.lineHeight).toBe(20);
        expect(codeStyle.color).toBe('rgb(120, 120, 120)');
    }, 60_000);
});
