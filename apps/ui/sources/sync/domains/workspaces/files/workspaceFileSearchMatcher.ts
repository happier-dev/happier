import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';

export function normalizeFileSearchText(value: string): string {
    return normalizeFileSearchSeparators(value).toLowerCase();
}

function normalizeFileSearchSeparators(value: string): string {
    return value.replace(/\\/g, '/').replace(/[-_ ]+/g, ' ');
}

function fileSearchRelevance(file: FileSearchItem, needle: string): number {
    const name = normalizeFileSearchText(file.fileName).replace(/\/$/, '');
    const path = normalizeFileSearchText(file.fullPath).replace(/\/$/, '');
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
    boundaryBonus: number;
    basenameBonus: number | null;
    boundaryMatch: boolean;
    basenameBoundaryMatch: boolean;
}>;

export type WorkspaceFileSearchIndex = Readonly<{
    search(query: string): WorkspaceFileSearchMatch[];
}>;

export function rankFileSearchResults(matches: readonly WorkspaceFileSearchMatch[], query: string): FileSearchItem[] {
    const needle = normalizeFileSearchText(query.trim()).replace(/\/$/, '');
    return matches.map(match => ({ ...match, relevance: fileSearchRelevance(match.item, needle) }))
        .sort((a, b) => {
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
        })
        .map(match => match.item);
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

/** The existing inventory index prepares paths once; rankFileSearchResults remains the only ranker. */
export function createWorkspaceFileSearchIndex(files: readonly FileSearchItem[]): WorkspaceFileSearchIndex {
    const entries = files.map(item => ({ item, text: prepareSearchText(item.fullPath) }));
    return {
        search(query) {
            const needle = prepareSearchQuery(query);
            const matches: WorkspaceFileSearchMatch[] = [];
            for (const { item, text } of entries) {
                const match = matchSubsequence(text, needle);
                if (match !== null) matches.push({ item, ...match });
            }
            return matches;
        },
    };
}

export function matchWorkspaceFileNames(files: readonly FileSearchItem[], query: string): FileSearchItem[] {
    const needle = prepareSearchQuery(query);
    if (!needle) return [...files];
    return files.filter(file => matchSubsequence(prepareSearchText(file.fileName), needle) !== null);
}
