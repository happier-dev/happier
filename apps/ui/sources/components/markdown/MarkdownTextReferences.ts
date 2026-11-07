import { createContext } from 'react';
import { parser } from '@lezer/markdown';

export type MarkdownTextReferences = Readonly<Record<string, Readonly<{ text: string; url: string }>>>;
export const EMPTY_MARKDOWN_TEXT_REFERENCES: MarkdownTextReferences = Object.freeze({});
export const MarkdownTextReferencesContext = createContext(EMPTY_MARKDOWN_TEXT_REFERENCES);

const protectedNodes = new Set(['CodeBlock', 'FencedCode', 'InlineCode', 'Link', 'Image', 'Autolink', 'LinkReference', 'HTMLBlock', 'HTMLTag']);

/** Render-only projection: source ranges, copying, quoting, and option submission keep authored text. */
export function linkifyMarkdownTextReferences(markdown: string, references: MarkdownTextReferences): string {
    const aliases = Object.keys(references).filter((alias) => alias.length > 0 && markdown.includes(alias));
    if (aliases.length === 0) return markdown;
    const renderLink = (reference: Readonly<{ text: string; url: string }>) => {
        const label = reference.text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]{}()<>!|]/g, '\\$&');
        return `[${label}](${reference.url})`;
    };
    const replacements: Array<Readonly<{ from: number; to: number; text: string }>> = [];
    const protectedRanges: Array<Readonly<{ from: number; to: number }>> = [];
    parser.parse(markdown).iterate({
        enter(node) {
            if (!protectedNodes.has(node.name)) return;
            protectedRanges.push({ from: node.from, to: node.to });
            if (node.name === 'InlineCode') {
                // A standalone session name is a reference even when an agent wraps it in
                // backticks. Commands, paths, fenced code, and existing links stay literal.
                const alias = markdown.slice(node.from, node.to).replace(/^`+|`+$/g, '').trim();
                const reference = Object.hasOwn(references, alias) ? references[alias] : undefined;
                if (reference) replacements.push({ from: node.from, to: node.to, text: renderLink(reference) });
            }
            return false;
        },
    });
    let rangeIndex = 0;
    const pattern = new RegExp(aliases.sort((a, b) => b.length - a.length).map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    for (const match of markdown.matchAll(pattern)) {
        const alias = match[0];
        const offset = match.index;
        if (/[A-Za-z0-9_/@\\-]/.test(markdown[offset - 1] ?? '') || /[A-Za-z0-9_/@\\-]/.test(markdown[offset + alias.length] ?? '')) continue;
        while (protectedRanges[rangeIndex] && protectedRanges[rangeIndex]!.to <= offset) rangeIndex += 1;
        const range = protectedRanges[rangeIndex];
        if (range && range.from <= offset && offset < range.to) continue;
        const reference = references[alias];
        if (reference) replacements.push({ from: offset, to: offset + alias.length, text: renderLink(reference) });
    }
    let cursor = 0;
    const parts: string[] = [];
    for (const replacement of replacements.sort((left, right) => left.from - right.from)) {
        parts.push(markdown.slice(cursor, replacement.from), replacement.text);
        cursor = replacement.to;
    }
    parts.push(markdown.slice(cursor));
    return parts.join('');
}
