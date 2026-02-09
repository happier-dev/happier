import { describe, expect, it } from 'vitest';

import { buildFileLineSelectionFingerprint, canUseLineSelection } from './gitLineSelection';

describe('canUseLineSelection', () => {
    it('allows line selection only when write operations are enabled and diff mode is explicit', () => {
        expect(
            canUseLineSelection({
                gitWriteEnabled: true,
                hasConflicts: false,
                isBinary: false,
                diffMode: 'unstaged',
                diffContent: 'diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n',
            })
        ).toBe(true);
        expect(
            canUseLineSelection({
                gitWriteEnabled: true,
                hasConflicts: false,
                isBinary: false,
                diffMode: 'staged',
                diffContent: 'diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n',
            })
        ).toBe(true);
    });

    it('blocks line selection for combined diffs, binary files, conflicts, disabled writes, or empty diff', () => {
        expect(
            canUseLineSelection({
                gitWriteEnabled: true,
                hasConflicts: false,
                isBinary: false,
                diffMode: 'both',
                diffContent: 'diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n',
            })
        ).toBe(false);
        expect(
            canUseLineSelection({
                gitWriteEnabled: true,
                hasConflicts: false,
                isBinary: true,
                diffMode: 'unstaged',
                diffContent: 'binary',
            })
        ).toBe(false);
        expect(
            canUseLineSelection({
                gitWriteEnabled: true,
                hasConflicts: true,
                isBinary: false,
                diffMode: 'unstaged',
                diffContent: 'diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n',
            })
        ).toBe(false);
        expect(
            canUseLineSelection({
                gitWriteEnabled: false,
                hasConflicts: false,
                isBinary: false,
                diffMode: 'unstaged',
                diffContent: 'diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n',
            })
        ).toBe(false);
        expect(
            canUseLineSelection({
                gitWriteEnabled: true,
                hasConflicts: false,
                isBinary: false,
                diffMode: 'unstaged',
                diffContent: '',
            })
        ).toBe(false);
    });
});

describe('buildFileLineSelectionFingerprint', () => {
    it('returns stable fingerprint for same entry fields', () => {
        const entry = {
            path: 'src/a.ts',
            previousPath: null,
            indexStatus: 'M',
            worktreeStatus: ' ',
            hasStagedDelta: true,
            hasUnstagedDelta: false,
            stats: {
                stagedAdded: 2,
                stagedRemoved: 1,
                unstagedAdded: 0,
                unstagedRemoved: 0,
                isBinary: false,
            },
        };

        expect(buildFileLineSelectionFingerprint(entry)).toBe(buildFileLineSelectionFingerprint({ ...entry }));
    });

    it('changes fingerprint when git entry state changes', () => {
        const entry = {
            path: 'src/a.ts',
            previousPath: null,
            indexStatus: 'M',
            worktreeStatus: ' ',
            hasStagedDelta: true,
            hasUnstagedDelta: false,
            stats: {
                stagedAdded: 2,
                stagedRemoved: 1,
                unstagedAdded: 0,
                unstagedRemoved: 0,
                isBinary: false,
            },
        };

        const base = buildFileLineSelectionFingerprint(entry);
        const changed = buildFileLineSelectionFingerprint({
            ...entry,
            stats: {
                ...entry.stats,
                unstagedAdded: 3,
            },
        });

        expect(changed).not.toBe(base);
    });
});
