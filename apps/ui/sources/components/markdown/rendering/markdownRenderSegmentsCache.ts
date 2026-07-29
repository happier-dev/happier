import type { MarkdownRenderSegment } from './markdownRenderSegmentTypes';

const MAX_ENTRIES = 64;
const MAX_SOURCE_CHARS_PER_ENTRY = 32_000;
const MAX_RETAINED_MARKDOWN_CHARS = 512_000;

type MarkdownRenderSegmentsCacheEntry = Readonly<{
    source: string;
    segments: MarkdownRenderSegment[];
    retainedMarkdownChars: number;
}>;

const entries = new Map<string, MarkdownRenderSegmentsCacheEntry>();
let retainedMarkdownChars = 0;

function estimateRetainedMarkdownChars(
    source: string,
    segments: MarkdownRenderSegment[],
): number {
    return source.length + segments.reduce((total, segment) => total + segment.markdown.length, 0);
}

function deleteEntry(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    retainedMarkdownChars -= entry.retainedMarkdownChars;
}

function evictToBounds(): void {
    while (entries.size > MAX_ENTRIES || retainedMarkdownChars > MAX_RETAINED_MARKDOWN_CHARS) {
        const oldestKey = entries.keys().next().value;
        if (typeof oldestKey !== 'string') return;
        deleteEntry(oldestKey);
    }
}

export function buildMarkdownContentCacheSlot(source: string): string {
    let hash = 2166136261;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `content:${source.length}:${(hash >>> 0).toString(36)}`;
}

export function readMarkdownRenderSegmentsCache(
    slot: string,
    source: string,
): MarkdownRenderSegment[] | null {
    const entry = entries.get(slot);
    if (!entry || entry.source !== source) return null;
    entries.delete(slot);
    entries.set(slot, entry);
    return entry.segments;
}

export function writeMarkdownRenderSegmentsCache(
    slot: string,
    source: string,
    segments: MarkdownRenderSegment[],
): void {
    deleteEntry(slot);
    if (source.length > MAX_SOURCE_CHARS_PER_ENTRY) return;

    const entry: MarkdownRenderSegmentsCacheEntry = {
        source,
        segments,
        retainedMarkdownChars: estimateRetainedMarkdownChars(source, segments),
    };
    if (entry.retainedMarkdownChars > MAX_RETAINED_MARKDOWN_CHARS) return;

    entries.set(slot, entry);
    retainedMarkdownChars += entry.retainedMarkdownChars;
    evictToBounds();
}
