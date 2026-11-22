import type { MarkdownBlock } from '../parseMarkdown';
import type { MarkdownContainerBlock } from '../streaming/readMarkdownContainerBlock';
import type { MarkdownSourceRange } from '../parseMarkdown';

type MarkdownRenderSegmentBase = Readonly<{
    key: string;
    sourceStart: number;
    sourceLength: number;
    sourceHash: string;
    sourceRange: MarkdownSourceRange;
    markdown: string;
    first: boolean;
    last: boolean;
}>;

export type EnrichedMarkdownRenderSegment = MarkdownRenderSegmentBase & Readonly<{
    type: 'enriched-markdown';
    /** Rendering includes document-wide definitions; source identity stays local. */
    renderMarkdown?: string;
}>;

export type SpecialMarkdownRenderSegment = MarkdownRenderSegmentBase & Readonly<{
    type: 'special-block';
    blocks: readonly MarkdownBlock[];
}>;

export type ContainerMarkdownRenderSegment = MarkdownRenderSegmentBase & Readonly<{
    type: 'container-block';
    container: MarkdownContainerBlock;
    referenceDefinitions: string;
}>;

export type MarkdownRenderSegment = EnrichedMarkdownRenderSegment | SpecialMarkdownRenderSegment | ContainerMarkdownRenderSegment;
