import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';

/**
 * Per-keystroke work contracts for the shared workspace file matcher (composer `@`,
 * Go to file, file trees). A picker shows a page of 8-12 rows; a large repository
 * has tens of thousands of paths. The work a keystroke does must follow the page and
 * the narrowing match set, not the whole corpus.
 */

function file(fullPath: string): FileSearchItem {
    const parts = fullPath.split('/');
    return { fileName: parts.at(-1)!, filePath: parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '', fullPath, fileType: 'file' };
}

function corpus(size: number): FileSearchItem[] {
    const words = ['session', 'store', 'list', 'row', 'view', 'model', 'composer', 'palette', 'tree', 'agent'];
    return Array.from({ length: size }, (_, index) => {
        const a = words[index % words.length]!;
        const b = words[(index * 7) % words.length]!;
        return file(`apps/${a}${index % 37}/${b}${a}${index}.tsx`);
    });
}

async function loadMatcherCountingCollatorCompares() {
    const counter = { compares: 0 };
    const RealCollator = Intl.Collator;
    vi.stubGlobal('Intl', {
        ...Intl,
        Collator: function CountingCollator(...args: ConstructorParameters<typeof Intl.Collator>) {
            const real = new RealCollator(...args);
            return { compare: (left: string, right: string) => { counter.compares += 1; return real.compare(left, right); } };
        },
    });
    vi.resetModules();
    const matcher = await import('./workspaceFileSearchMatcher');
    return { matcher, counter };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('workspaceFileSearchMatcher per-keystroke work', () => {
    it('ranks only the requested page with tie-break work proportional to the matches, not a full sort', async () => {
        const { matcher, counter } = await loadMatcherCountingCollatorCompares();
        const files = corpus(4_000);
        const index = matcher.createWorkspaceFileSearchIndex(files);
        const matches = index.search('se');
        expect(matches.length).toBeGreaterThan(1_000);

        const fullOrder = matcher.rankFileSearchResults(matches, 'se');
        counter.compares = 0;
        const page = matcher.rankFileSearchResults(matches, 'se', 12);

        expect(page).toEqual(fullOrder.slice(0, 12));
        // A full comparison sort needs ~matches·log2(matches) (> 10 per match here).
        expect(counter.compares).toBeLessThan(matches.length * 3);
    });

    it('narrows an extending query to the previous query matches instead of rescanning the corpus', async () => {
        const { matcher } = await loadMatcherCountingCollatorCompares();
        const files = [...corpus(5_000), file('src/zqxsearch.ts'), file('src/zqxsession.ts'), file('lib/zq/x/s.ts')];
        const index = matcher.createWorkspaceFileSearchIndex(files);
        expect(index.search('zqx').map((match) => match.item.fullPath).sort())
            .toEqual(['lib/zq/x/s.ts', 'src/zqxsearch.ts', 'src/zqxsession.ts']);

        const charAt = vi.spyOn(String.prototype, 'charAt');
        const narrowed = index.search('zqxse');
        const scannedCharacters = charAt.mock.calls.length;
        charAt.mockRestore();

        expect(narrowed.map((match) => match.item.fullPath).sort()).toEqual(['src/zqxsearch.ts', 'src/zqxsession.ts']);
        expect(narrowed).toEqual(matcher.createWorkspaceFileSearchIndex(files).search('zqxse'));
        // Fewer scanned characters than corpus entries: only the 3 previous matches were visited.
        expect(scannedCharacters).toBeLessThan(files.length);

        // A non-extending edit (Backspace, a different query) scans the corpus again.
        expect(index.search('zq').length).toBeGreaterThan(narrowed.length);
        expect(index.search('row').length).toEqual(matcher.createWorkspaceFileSearchIndex(files).search('row').length);
    });
});
