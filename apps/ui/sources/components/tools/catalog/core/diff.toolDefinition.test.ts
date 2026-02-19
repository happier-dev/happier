import { describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@happier-dev/protocol', () => ({
    DiffInputV2Schema: {},
}));

function getTitle(def: { title?: string | ((opts: { metadata: any; tool: any }) => string) }, tool: any): string | undefined {
    if (!def.title) return undefined;
    return typeof def.title === 'function' ? def.title({ metadata: null, tool }) : def.title;
}

describe('diff tool definition', () => {
    it('uses the file basename as subtitle for a single-file unified diff', async () => {
        const [{ coreDiffTools }] = await Promise.all([import('./diff')]);
        const def = coreDiffTools.Diff;

        const tool = {
            name: 'Diff',
            input: {
                unified_diff: [
                    'diff --git a/apps/ui/a.ts b/apps/ui/a.ts',
                    '--- a/apps/ui/a.ts',
                    '+++ b/apps/ui/a.ts',
                    '@@ -1,1 +1,1 @@',
                    '-old',
                    '+new',
                ].join('\n'),
            },
        };

        expect(def.extractSubtitle?.({ metadata: null, tool } as any)).toBe('a.ts');
        expect(getTitle(def as any, tool)).toBe('tools.names.viewDiff');
    });

    it('omits the subtitle for a multi-file unified diff and uses the turn-diff title', async () => {
        const [{ coreDiffTools }] = await Promise.all([import('./diff')]);
        const def = coreDiffTools.Diff;

        const tool = {
            name: 'Diff',
            input: {
                unified_diff: [
                    'diff --git a/apps/ui/a.ts b/apps/ui/a.ts',
                    '--- a/apps/ui/a.ts',
                    '+++ b/apps/ui/a.ts',
                    '@@ -1,1 +1,1 @@',
                    '-old',
                    '+new',
                    'diff --git a/apps/ui/b.ts b/apps/ui/b.ts',
                    '--- a/apps/ui/b.ts',
                    '+++ b/apps/ui/b.ts',
                    '@@ -1,1 +1,1 @@',
                    '-old2',
                    '+new2',
                ].join('\n'),
            },
        };

        expect(def.extractSubtitle?.({ metadata: null, tool } as any)).toBeNull();
        expect(getTitle(def as any, tool)).toBe('tools.names.turnDiff');
    });

    it('omits the subtitle for CodexDiff when the unified diff contains multiple files', async () => {
        const [{ providerDiffTools }] = await Promise.all([import('../providers/diff')]);
        const def = providerDiffTools.CodexDiff;

        const tool = {
            name: 'CodexDiff',
            input: {
                unified_diff: [
                    'diff --git a/apps/ui/a.ts b/apps/ui/a.ts',
                    '--- a/apps/ui/a.ts',
                    '+++ b/apps/ui/a.ts',
                    '@@ -1,1 +1,1 @@',
                    '-old',
                    '+new',
                    'diff --git a/apps/ui/b.ts b/apps/ui/b.ts',
                    '--- a/apps/ui/b.ts',
                    '+++ b/apps/ui/b.ts',
                    '@@ -1,1 +1,1 @@',
                    '-old2',
                    '+new2',
                ].join('\n'),
            },
        };

        expect(def.extractSubtitle?.({ metadata: null, tool } as any)).toBeNull();
        expect(getTitle(def as any, tool)).toBe('tools.names.turnDiff');
    });
});

