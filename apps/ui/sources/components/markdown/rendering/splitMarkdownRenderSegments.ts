import { parseMarkdownBlockSource } from '../streaming/parseMarkdownBlockSource';
import { readMarkdownOption } from '../parseMarkdownBlock';
import { preprocessStreamingMarkdown } from '../streaming/preprocessStreamingMarkdown';
import {
    splitMarkdownIntoBlockSources,
    type MarkdownBlockSource,
} from '../streaming/splitMarkdownIntoBlockSources';
import type { MarkdownSourceRange } from '../parseMarkdown';
import type { MarkdownRenderSegment } from './markdownRenderSegmentTypes';
import {
    buildMarkdownContentCacheSlot,
    readMarkdownRenderSegmentsCache,
    writeMarkdownRenderSegmentsCache,
} from './markdownRenderSegmentsCache';
import { normalizeLooseListContinuations } from './normalizeLooseListContinuations';

type LocatedMarkdownBlockSource = MarkdownBlockSource & Readonly<{
    sourceStart: number;
    sourceLength: number;
    sourceHash: string;
    sourceRange: MarkdownSourceRange;
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
    | Omit<Extract<MarkdownRenderSegment, { type: 'special-block' }>, 'first' | 'last'>
    | Omit<Extract<MarkdownRenderSegment, { type: 'container-block' }>, 'first' | 'last'>;

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
    let line = 1;
    return sources.map((source) => {
        while (cursor < source.sourceStart) if (markdown.charCodeAt(cursor++) === 10) line++;
        const startLine = line;
        const end = source.sourceStart + source.source.length;
        while (cursor < end) if (markdown.charCodeAt(cursor++) === 10) line++;
        return {
            ...source,
            sourceLength: source.source.length,
            sourceHash: hashMarkdownSource(source.source),
            sourceRange: { startLine, endLine: line },
        };
    });
}

function isSpecialSource(source: LocatedMarkdownBlockSource): boolean {
    if (source.container || source.codeBlock) return true;
    if (source.incompleteKind) return true;
    return source.blockType === 'FencedCode'
        || source.blockType === 'Table' || source.source.trimStart().startsWith('<options>')
        || source.source.split('\n').some((line) => readMarkdownOption(line) !== null);
}

function withReferenceDefinitions(markdown: string, definitions: string): string {
    return definitions ? `${definitions}\n\n${markdown}` : markdown;
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
        sourceRange: { startLine: firstSource.sourceRange.startLine, endLine: lastSource.sourceRange.endLine },
    };
}

function applyFirstLast(segments: readonly DraftMarkdownRenderSegment[]): MarkdownRenderSegment[] {
    return segments.map((segment, index) => ({
        ...segment,
        first: index === 0,
        last: index === segments.length - 1,
    } as MarkdownRenderSegment));
}

function readStaticSegmentCache(markdown: string): MarkdownRenderSegment[] | null {
    return readMarkdownRenderSegmentsCache(buildMarkdownContentCacheSlot(markdown), markdown);
}

function writeStaticSegmentCache(markdown: string, segments: MarkdownRenderSegment[]): void {
    writeMarkdownRenderSegmentsCache(buildMarkdownContentCacheSlot(markdown), markdown, segments);
}

function buildEnrichedSegment(source: LocatedMarkdownBlockSource, nextSegmentKey: () => string): DraftMarkdownRenderSegment {
    return {
        type: 'enriched-markdown',
        key: nextSegmentKey(),
        sourceStart: source.sourceStart,
        sourceLength: source.sourceLength,
        sourceHash: source.sourceHash,
        sourceRange: source.sourceRange,
        markdown: source.source,
        renderMarkdown: withReferenceDefinitions(source.source, source.referenceDefinitions),
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
            renderMarkdown: withReferenceDefinitions(group.markdown, group.sources[0]?.referenceDefinitions ?? ''),
        });
    };

    for (const source of locatedSources) {
        if (!isSpecialSource(source)) {
            if (params.splitEnrichedSourceRanges === true) {
                flushPendingEnrichedSources();
                segments.push(buildEnrichedSegment(source, nextSegmentKey));
                continue;
            }
            pendingEnrichedSources.push(source);
            continue;
        }

        flushPendingEnrichedSources();
        if (source.container) {
            segments.push({
                type: 'container-block',
                key: nextSegmentKey(),
                sourceStart: source.sourceStart,
                sourceLength: source.sourceLength,
                sourceHash: source.sourceHash,
                sourceRange: source.sourceRange,
                markdown: source.source,
                container: source.container,
            });
            continue;
        }
        segments.push({
            type: 'special-block',
            key: nextSegmentKey(),
            sourceStart: source.sourceStart,
            sourceLength: source.sourceLength,
            sourceHash: source.sourceHash,
            sourceRange: source.sourceRange,
            markdown: source.source,
            blocks: parseMarkdownBlockSource(source),
        });
    }

    flushPendingEnrichedSources();
    const result = applyFirstLast(segments);
    if (params.streamingMode === 'static' && params.splitEnrichedSourceRanges !== true) {
        writeStaticSegmentCache(params.markdown, result);
    }
    return result;
}
