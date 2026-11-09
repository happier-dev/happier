import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';

export function normalizeFileSearchText(value: string): string {
    return normalizeFileSearchSeparators(value).toLowerCase();
}

function normalizeFileSearchSeparators(value: string): string {
    return value.replace(/\\/g, '/').replace(/[-_ ]+/g, ' ');
}

function fileSearchRelevance(file: FileSearchItem, name: string, path: string, needle: string): number {
    if (path === needle || name === needle) return 0;
    if (!needle.includes('/') && !needle.includes('.') && file.fileType === 'file') {
        const extension = name.lastIndexOf('.');
        if (extension > 0 && name.slice(0, extension) === needle) return 1;
    }
    if (!needle.includes('/') && name.startsWith(`${needle}.`)) return 2;
    if ((needle.includes('/') ? path : name).startsWith(needle)) return 3;
    const nameMatch = name.indexOf(needle);
    if (nameMatch >= 0) return nameMatch === 0 || /[/. ]/.test(name[nameMatch - 1] ?? '') ? 4 : 5;
    const pathMatch = path.indexOf(needle);
    if (pathMatch >= 0) return pathMatch === 0 || /[/. ]/.test(path[pathMatch - 1] ?? '') ? 6 : 7;
    return 8;
}

const FILE_SEARCH_NAME_ORDER = new Intl.Collator('en', { numeric: true });

export type WorkspaceFileSearchMatch = Readonly<{
    item: FileSearchItem;
    /** Normalized basename and path (no trailing slash), prepared once when the path was indexed. */
    rankName: string;
    rankPath: string;
    boundaryBonus: number;
    basenameBonus: number | null;
    boundaryMatch: boolean;
    basenameBoundaryMatch: boolean;
}>;

export type WorkspaceFileSearchIndex = Readonly<{
    search(query: string): WorkspaceFileSearchMatch[];
}>;

type RankedFileSearchMatch = WorkspaceFileSearchMatch & Readonly<{ relevance: number }>;

function compareRankedFileSearchMatches(a: RankedFileSearchMatch, b: RankedFileSearchMatch): number {
    const relevanceOrder = a.relevance - b.relevance;
    if (relevanceOrder) return relevanceOrder;
    if (a.relevance === 8) {
        const basenameOrder = Number(a.basenameBonus === null) - Number(b.basenameBonus === null);
        if (basenameOrder) return basenameOrder;
        const initialsOrder = Number(b.basenameBonus === null ? b.boundaryMatch : b.basenameBoundaryMatch)
            - Number(a.basenameBonus === null ? a.boundaryMatch : a.basenameBoundaryMatch);
        if (initialsOrder) return initialsOrder;
        const boundaryOrder = (b.basenameBonus ?? b.boundaryBonus) - (a.basenameBonus ?? a.boundaryBonus);
        if (boundaryOrder) return boundaryOrder;
    }
    return FILE_SEARCH_NAME_ORDER.compare(a.item.fileName, b.item.fileName)
        || FILE_SEARCH_NAME_ORDER.compare(a.item.fullPath, b.item.fullPath);
}

/**
 * The one file-search ranker. With `limit`, only that many leading results are ordered:
 * a picker page is 8-12 rows while a short query on a large repository matches most of
 * it, and a full sort of every match per keystroke was the dominant cost. The leading
 * page is identical to the full order's prefix (same total comparator).
 */
export function rankFileSearchResults(matches: readonly WorkspaceFileSearchMatch[], query: string, limit = Infinity): FileSearchItem[] {
    const needle = normalizeFileSearchText(query.trim()).replace(/\/$/, '');
    const rank = (match: WorkspaceFileSearchMatch): RankedFileSearchMatch => (
        { ...match, relevance: fileSearchRelevance(match.item, match.rankName, match.rankPath, needle) }
    );
    if (!(limit < matches.length)) return matches.map(rank).sort(compareRankedFileSearchMatches).map(match => match.item);
    const page: RankedFileSearchMatch[] = [];
    if (limit < 1) return [];
    for (const match of matches) {
        const ranked = rank(match);
        if (page.length === limit) {
            if (compareRankedFileSearchMatches(ranked, page[limit - 1]!) >= 0) continue;
            page.pop();
        }
        let low = 0;
        let high = page.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (compareRankedFileSearchMatches(page[middle]!, ranked) <= 0) low = middle + 1;
            else high = middle;
        }
        page.splice(low, 0, ranked);
    }
    return page.map(match => match.item);
}

function prepareSearchText(value: string) {
    const cased = normalizeFileSearchSeparators(value);
    const lower = cased.toLowerCase();
    const basenameStart = lower.lastIndexOf('/', lower.length - (lower.endsWith('/') ? 2 : 1)) + 1;
    return { cased, lower, basenameStart };
}

function prepareSearchQuery(query: string): string {
    return normalizeFileSearchText(query.trim()).replace(/\s/g, '');
}

/** One forward scan, with no edit-distance retries or 32-character pattern blocks. */
function matchSubsequence(text: ReturnType<typeof prepareSearchText>, needle: string) {
    let matched = 0;
    let basenameMatched = 0;
    let boundaryMatched = 0;
    let basenameBoundaryMatched = 0;
    let bonus = 0;
    let basenameBonus = 0;
    // Track ordinary and word-initial subsequences in one pass. Greedy membership can consume
    // the r inside Dry before the R in Run; that must not hide a complete camelCase abbreviation.
    for (let position = 0; position < text.lower.length && (boundaryMatched < needle.length || basenameBoundaryMatched < needle.length); position += 1) {
        const char = text.lower.charAt(position);
        const pathMatch = char === needle[matched];
        const basenameMatch = position >= text.basenameStart && char === needle[basenameMatched];
        const pathInitialMatch = char === needle[boundaryMatched];
        const basenameInitialMatch = position >= text.basenameStart && char === needle[basenameBoundaryMatched];
        if (!pathMatch && !basenameMatch && !pathInitialMatch && !basenameInitialMatch) continue;
        const previous = text.cased.charCodeAt(position - 1);
        const current = text.cased.charCodeAt(position);
        const boundaryBonus = position === 0 || previous === 47 || previous === 46 || previous === 32 ? 2
            : current >= 65 && current <= 90 && previous >= 97 && previous <= 122 ? 1 : 0;
        if (pathMatch) { bonus += boundaryBonus; matched += 1; }
        if (basenameMatch) { basenameBonus += boundaryBonus; basenameMatched += 1; }
        if (boundaryBonus > 0) {
            if (pathInitialMatch) boundaryMatched += 1;
            if (basenameInitialMatch) basenameBoundaryMatched += 1;
        }
    }
    return matched === needle.length
        ? { boundaryBonus: bonus, basenameBonus: basenameMatched === needle.length ? basenameBonus : null,
            boundaryMatch: boundaryMatched === needle.length, basenameBoundaryMatch: basenameBoundaryMatched === needle.length }
        : null;
}

type PreparedFileSearchEntry = Readonly<{
    item: FileSearchItem;
    text: ReturnType<typeof prepareSearchText>;
    rankName: string;
    rankPath: string;
}>;

/**
 * The existing inventory index prepares paths once; rankFileSearchResults remains the only ranker.
 *
 * Typing narrows: every path matching `abc` also matches `ab` (the needle is a
 * subsequence and its prefix is too), so a query that extends the previous one scans
 * only the previous query's matches instead of the whole corpus.
 */
export function createWorkspaceFileSearchIndex(files: readonly FileSearchItem[]): WorkspaceFileSearchIndex {
    const entries: readonly PreparedFileSearchEntry[] = files.map(item => ({
        item,
        text: prepareSearchText(item.fullPath),
        rankName: normalizeFileSearchText(item.fileName).replace(/\/$/, ''),
        rankPath: normalizeFileSearchText(item.fullPath).replace(/\/$/, ''),
    }));
    let previous: Readonly<{ needle: string; entries: readonly PreparedFileSearchEntry[] }> | null = null;
    return {
        search(query) {
            const needle = prepareSearchQuery(query);
            const candidates = previous && needle.startsWith(previous.needle) ? previous.entries : entries;
            const matched: PreparedFileSearchEntry[] = [];
            const matches: WorkspaceFileSearchMatch[] = [];
            for (const entry of candidates) {
                const match = matchSubsequence(entry.text, needle);
                if (match === null) continue;
                matched.push(entry);
                matches.push({ item: entry.item, rankName: entry.rankName, rankPath: entry.rankPath, ...match });
            }
            previous = { needle, entries: matched };
            return matches;
        },
    };
}

export function matchWorkspaceFileNames(files: readonly FileSearchItem[], query: string): FileSearchItem[] {
    const needle = prepareSearchQuery(query);
    if (!needle) return [...files];
    return files.filter(file => matchSubsequence(prepareSearchText(file.fileName), needle) !== null);
}
