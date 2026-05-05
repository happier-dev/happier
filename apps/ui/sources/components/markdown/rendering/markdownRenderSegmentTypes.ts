import type { MarkdownBlock } from '../parseMarkdown';

type MarkdownRenderSegmentBase = Readonly<{
    key: string;
    sourceStart: number;
    sourceLength: number;
    sourceHash: string;
    first: boolean;
    last: boolean;
}>;

export type EnrichedMarkdownRenderSegment = MarkdownRenderSegmentBase & Readonly<{
    type: 'enriched-markdown';
    markdown: string;
}>;

export type SpecialMarkdownRenderSegment = MarkdownRenderSegmentBase & Readonly<{
    type: 'special-block';
    blocks: readonly MarkdownBlock[];
}>;

export type MarkdownRenderSegment = EnrichedMarkdownRenderSegment | SpecialMarkdownRenderSegment;
