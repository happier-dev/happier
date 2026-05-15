import { parseMarkdownBlockSource } from '../streaming/parseMarkdownBlockSource';
import { preprocessStreamingMarkdown } from '../streaming/preprocessStreamingMarkdown';
import {
    splitMarkdownIntoBlockSources,
    type MarkdownBlockSource,
} from '../streaming/splitMarkdownIntoBlockSources';
import type { MarkdownBlock } from '../parseMarkdown';
import type { MarkdownSourceRange } from '../parseMarkdown';
import type { MarkdownRenderSegment } from './markdownRenderSegmentTypes';
import { normalizeLooseListContinuations } from './normalizeLooseListContinuations';

type LocatedMarkdownBlockSource = MarkdownBlockSource & Readonly<{
    sourceStart: number;
    sourceLength: number;
    sourceHash: string;
}>;

type PendingEnrichedGroup = Readonly<{
    sources: readonly LocatedMarkdownBlockSource[];
    markdown: string;
    sourceStart: number;
    sourceLength: number;
    sourceHash: string;
    sourceRange: MarkdownSourceRange;
}>;

type DraftMarkdownRenderSegment =
    | Omit<Extract<MarkdownRenderSegment, { type: 'enriched-markdown' }>, 'first' | 'last'>
    | Omit<Extract<MarkdownRenderSegment, { type: 'special-block' }>, 'first' | 'last'>;

const SPECIAL_BLOCK_TYPES: ReadonlySet<MarkdownBlock['type']> = new Set([
    'code-block',
    'mermaid',
    'options',
    'table',
]);
const STATIC_SEGMENT_CACHE_MAX_ENTRIES = 64;
const staticSegmentCache = new Map<string, MarkdownRenderSegment[]>();

function hashMarkdownSource(source: string): string {
    let hash = 2166136261;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function locateSources(markdown: string, sources: readonly MarkdownBlockSource[]): LocatedMarkdownBlockSource[] {
    let cursor = 0;
    return sources.map((source) => {
        const foundIndex = markdown.indexOf(source.source, cursor);
        const sourceStart = foundIndex >= 0 ? foundIndex : cursor;
        const sourceLength = source.source.length;
        cursor = sourceStart + sourceLength;
        return {
            ...source,
            sourceStart,
            sourceLength,
            sourceHash: hashMarkdownSource(source.source),
        };
    });
}

function isSpecialSource(source: LocatedMarkdownBlockSource, blocks: readonly MarkdownBlock[]): boolean {
    if (source.incompleteKind) return true;
    return blocks.some((block) => SPECIAL_BLOCK_TYPES.has(block.type));
}

function buildGroupMarkdown(markdown: string, sources: readonly LocatedMarkdownBlockSource[]): string {
    const firstSource = sources[0];
    const lastSource = sources[sources.length - 1];
    if (!firstSource || !lastSource) return '';

    const end = lastSource.sourceStart + lastSource.sourceLength;
    return markdown.slice(firstSource.sourceStart, end);
}

function buildGroup(markdown: string, sources: readonly LocatedMarkdownBlockSource[]): PendingEnrichedGroup | null {
    const firstSource = sources[0];
    const lastSource = sources[sources.length - 1];
    if (!firstSource || !lastSource) return null;

    const sourceStart = firstSource.sourceStart;
    const sourceLength = lastSource.sourceStart + lastSource.sourceLength - sourceStart;
    const groupMarkdown = buildGroupMarkdown(markdown, sources);
    if (!groupMarkdown) return null;

    return {
        sources,
        markdown: groupMarkdown,
        sourceStart,
        sourceLength,
        sourceHash: hashMarkdownSource(groupMarkdown),
        sourceRange: resolveSourceRange(markdown, sourceStart, sourceLength),
    };
}

function countNewlines(value: string): number {
    return (value.match(/\n/g) ?? []).length;
}

function resolveSourceRange(markdown: string, sourceStart: number, sourceLength: number): MarkdownSourceRange {
    const before = markdown.slice(0, Math.max(0, sourceStart));
    const source = markdown.slice(sourceStart, sourceStart + Math.max(0, sourceLength));
    const startLine = countNewlines(before) + 1;
    const endLine = startLine + countNewlines(source);
    return { startLine, endLine };
}

function applyFirstLast(segments: readonly DraftMarkdownRenderSegment[]): MarkdownRenderSegment[] {
    return segments.map((segment, index) => ({
        ...segment,
        first: index === 0,
        last: index === segments.length - 1,
    } as MarkdownRenderSegment));
}

function readStaticSegmentCache(markdown: string): MarkdownRenderSegment[] | null {
    const cached = staticSegmentCache.get(markdown);
    if (!cached) return null;
    staticSegmentCache.delete(markdown);
    staticSegmentCache.set(markdown, cached);
    return cached;
}

function writeStaticSegmentCache(markdown: string, segments: MarkdownRenderSegment[]): void {
    staticSegmentCache.set(markdown, segments);
    while (staticSegmentCache.size > STATIC_SEGMENT_CACHE_MAX_ENTRIES) {
        const oldestKey = staticSegmentCache.keys().next().value;
        if (typeof oldestKey !== 'string') return;
        staticSegmentCache.delete(oldestKey);
    }
}

function buildEnrichedSegment(markdown: string, source: LocatedMarkdownBlockSource, nextSegmentKey: () => string): DraftMarkdownRenderSegment {
    return {
        type: 'enriched-markdown',
        key: nextSegmentKey(),
        sourceStart: source.sourceStart,
        sourceLength: source.sourceLength,
        sourceHash: source.sourceHash,
        sourceRange: resolveSourceRange(markdown, source.sourceStart, source.sourceLength),
        markdown: source.source,
    };
}

export function splitMarkdownRenderSegments(params: Readonly<{
    markdown: string;
    streamingMode: 'static' | 'streaming';
    streamingRepair?: 'sync' | 'prepared';
    splitEnrichedSourceRanges?: boolean;
}>): MarkdownRenderSegment[] {
    if (params.streamingMode === 'static' && params.splitEnrichedSourceRanges !== true) {
        const cached = readStaticSegmentCache(params.markdown);
        if (cached) return cached;
    }

    const repairedMarkdown = params.streamingMode === 'streaming' && params.streamingRepair !== 'prepared'
        ? preprocessStreamingMarkdown(params.markdown)
        : params.markdown;
    const renderMarkdown = normalizeLooseListContinuations(repairedMarkdown);
    const locatedSources = locateSources(renderMarkdown, splitMarkdownIntoBlockSources(renderMarkdown));
    const segments: DraftMarkdownRenderSegment[] = [];
    let pendingEnrichedSources: LocatedMarkdownBlockSource[] = [];
    let segmentOrdinal = 0;
    const nextSegmentKey = () => {
        const key = `segment:${segmentOrdinal}`;
        segmentOrdinal++;
        return key;
    };

    const flushPendingEnrichedSources = () => {
        const group = buildGroup(renderMarkdown, pendingEnrichedSources);
        pendingEnrichedSources = [];
        if (!group) return;

        segments.push({
            type: 'enriched-markdown',
            key: nextSegmentKey(),
            sourceStart: group.sourceStart,
            sourceLength: group.sourceLength,
            sourceHash: group.sourceHash,
            sourceRange: group.sourceRange,
            markdown: group.markdown,
        });
    };

    for (const source of locatedSources) {
        const blocks = parseMarkdownBlockSource(source);
        if (!isSpecialSource(source, blocks)) {
            if (params.splitEnrichedSourceRanges === true) {
                flushPendingEnrichedSources();
                segments.push(buildEnrichedSegment(renderMarkdown, source, nextSegmentKey));
                continue;
            }
            pendingEnrichedSources.push(source);
            continue;
        }

        flushPendingEnrichedSources();
        segments.push({
            type: 'special-block',
            key: nextSegmentKey(),
            sourceStart: source.sourceStart,
            sourceLength: source.sourceLength,
            sourceHash: source.sourceHash,
            sourceRange: resolveSourceRange(renderMarkdown, source.sourceStart, source.sourceLength),
            markdown: source.source,
            blocks,
        });
    }

    flushPendingEnrichedSources();
    const result = applyFirstLast(segments);
    if (params.streamingMode === 'static' && params.splitEnrichedSourceRanges !== true) {
        writeStaticSegmentCache(params.markdown, result);
    }
    return result;
}
