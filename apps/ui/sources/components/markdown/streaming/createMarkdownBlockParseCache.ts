import type { MarkdownBlock } from '../parseMarkdown';
import type { MarkdownBlockSource } from './splitMarkdownIntoBlockSources';

const DEFAULT_MAX_ENTRIES = 160;

export type MarkdownBlockParseCache = Readonly<{
    parse(source: MarkdownBlockSource, parser: (source: MarkdownBlockSource) => MarkdownBlock[]): MarkdownBlock[];
    clear(): void;
}>;

export function createMarkdownBlockParseCache(maxEntries = DEFAULT_MAX_ENTRIES): MarkdownBlockParseCache {
    const entries = new Map<string, MarkdownBlock[]>();

    function touch(key: string, value: MarkdownBlock[]): void {
        entries.delete(key);
        entries.set(key, value);
        while (entries.size > maxEntries) {
            const firstKey = entries.keys().next().value;
            if (typeof firstKey !== 'string') break;
            entries.delete(firstKey);
        }
    }

    return {
        parse(source, parser) {
            const key = `${source.incompleteKind ?? 'complete'}\u0000${source.source}`;
            const cached = entries.get(key);
            if (cached) {
                touch(key, cached);
                return cached;
            }

            const parsed = parser(source);
            touch(key, parsed);
            return parsed;
        },
        clear() {
            entries.clear();
        },
    };
}
