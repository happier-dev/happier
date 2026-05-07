import type { MarkdownBlock } from '../parseMarkdown';

export type MarkdownRenderSegment = Readonly<{
    type: 'enriched-markdown';
    key: string;
    sourceStart: number;
    sourceLength: number;
    sourceHash: string;
    markdown: string;
    first: boolean;
    last: boolean;
}> | Readonly<{
    type: 'special-block';
    key: string;
    sourceStart: number;
    sourceLength: number;
    sourceHash: string;
    blocks: readonly MarkdownBlock[];
    first: boolean;
    last: boolean;
}>;
