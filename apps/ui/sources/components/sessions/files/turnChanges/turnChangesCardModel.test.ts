import { describe, expect, it, vi } from 'vitest';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';

import { nextTurnChangesVisibleCount, summarizeTurnChanges } from './turnChangesCardModel';

function file(fullPath: string, linesAdded: number, linesRemoved: number, extra: Partial<ScmFileStatus> = {}): ScmFileStatus {
    const slash = fullPath.lastIndexOf('/');
    return {
        fileName: fullPath.slice(slash + 1),
        filePath: slash >= 0 ? fullPath.slice(0, slash) : '',
        fullPath,
        status: 'modified',
        isIncluded: false,
        linesAdded,
        linesRemoved,
        ...extra,
    };
}

describe('summarizeTurnChanges', () => {
    it('counts 214 files and their root folder without building or sorting file rows', () => {
        const files = Array.from({ length: 214 }, (_, index) => file(`src/File${String(index).padStart(3, '0')}.ts`, 1, 2));
        // Call-through observation of real sort work; the outline and summary implementations stay real.
        const compare = vi.spyOn(String.prototype, 'localeCompare');
        let comparisons = 0;
        let summary: ReturnType<typeof summarizeTurnChanges>;
        try {
            summary = summarizeTurnChanges(files);
            comparisons = compare.mock.calls.length;
        } finally { compare.mockRestore(); }
        expect(summary).toEqual({ fileCount: 214, folderCount: 1, added: 214, removed: 428, linesKnown: true });
        expect(comparisons).toBe(0);
    });

    it('uses the tree folder identity for trimmed and mixed-separator paths', () => {
        const summary = summarizeTurnChanges([
            file(' src\\nested\\one.ts ', 1, 0),
            file('src//nested/two.ts', 1, 0),
            file('/docs\\guide.md', 1, 0),
            file('root.ts', 1, 0),
        ]);
        expect(summary).toEqual({ fileCount: 4, folderCount: 2, added: 4, removed: 0, linesKnown: true });
    });

    it('totals every file and counts the folders the tree opens with', () => {
        const summary = summarizeTurnChanges([
            file('apps/ui/sources/app/(app)/settings.tsx', 2, 2),
            file('apps/ui/sources/components/settings/SettingsModal.tsx', 4, 2),
            file('docs/settings.md', 11, 0),
            file('yarn.lock', 0, 0),
        ]);
        expect(summary).toEqual({ fileCount: 4, folderCount: 2, added: 17, removed: 4, linesKnown: true });
    });

    it('does not present partial line counts as the turn total when a file has no line evidence', () => {
        const summary = summarizeTurnChanges([
            file('a.ts', 3, 1),
            file('b.bin', 0, 0, { isComplete: false }),
        ]);
        expect(summary.fileCount).toBe(2);
        expect(summary.linesKnown).toBe(false);
    });
});

describe('nextTurnChangesVisibleCount', () => {
    it('grows by one page at a time until every file is shown, never past the total', () => {
        let visible = nextTurnChangesVisibleCount({ visible: 0, total: 214, pageRows: 12 });
        expect(visible).toBe(12);
        const seen = [visible];
        while (visible < 214) {
            visible = nextTurnChangesVisibleCount({ visible, total: 214, pageRows: 12 });
            seen.push(visible);
        }
        expect(seen.at(-1)).toBe(214);
        expect(seen).toContain(24);
    });

    it('shows a small turn whole', () => {
        expect(nextTurnChangesVisibleCount({ visible: 0, total: 4, pageRows: 12 })).toBe(4);
    });
});
