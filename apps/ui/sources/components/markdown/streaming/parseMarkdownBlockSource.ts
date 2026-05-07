import type { MarkdownBlock, MarkdownSpan } from '../parseMarkdown';
import { parseMarkdownBlock } from '../parseMarkdownBlock';
import type { MarkdownBlockSource } from './splitMarkdownIntoBlockSources';

function plainSpan(text: string): MarkdownSpan {
    return {
        styles: [],
        text,
        url: null,
    };
}

function stripOptionTags(line: string): string {
    return line
        .replace(/<\/?options>/g, '')
        .replace(/<option>/g, '')
        .replace(/<\/option>/g, '')
        .trim();
}

function buildPlainTextBlocks(source: string, options: { stripOptionsTags?: boolean } = {}): MarkdownBlock[] {
    return source
        .split('\n')
        .map((line) => options.stripOptionsTags ? stripOptionTags(line) : line.trim())
        .filter((line) => line.length > 0)
        .map((line) => ({
            type: 'text' as const,
            content: [plainSpan(line)],
        }));
}

export function parseMarkdownBlockSource(source: MarkdownBlockSource): MarkdownBlock[] {
    if (source.incompleteKind === 'options') {
        return buildPlainTextBlocks(source.source, { stripOptionsTags: true });
    }

    if (source.incompleteKind) {
        return buildPlainTextBlocks(source.source);
    }

    return parseMarkdownBlock(source.source);
}
