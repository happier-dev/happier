import { describe, expect, it } from 'vitest';

import {
    buildChangedFilesOutlineTree,
    buildChangedOnlyTreeNodes,
    resolveChangedOnlyTreeInitiallyClosedPaths,
} from '@/components/workspaces/files/repositoryTree/buildChangedFilesOutlineTree';

describe('buildChangedFilesOutlineTree', () => {
    it('builds a directory-first, case-insensitive sorted outline tree', () => {
        const files = [
            { fullPath: 'src/zeta.ts', fileName: 'zeta.ts' },
            { fullPath: 'src/alpha.ts', fileName: 'alpha.ts' },
            { fullPath: 'README.md', fileName: 'README.md' },
            { fullPath: 'src/components/Button.tsx', fileName: 'Button.tsx' },
            { fullPath: 'src/components/Alert.tsx', fileName: 'Alert.tsx' },
            { fullPath: 'src/Components/Case.tsx', fileName: 'Case.tsx' },
            { fullPath: 'src\\win\\a.ts', fileName: 'a.ts' },
        ] as any[];

        const tree = buildChangedFilesOutlineTree(files as any);

        expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(['dir:src', 'file:README.md']);

        const src = tree[0]!;
        expect(src.kind).toBe('dir');
        if (src.kind !== 'dir') return;

        expect(src.children.map((n) => `${n.kind}:${n.name}`)).toEqual([
            'dir:components',
            'dir:Components',
            'dir:win',
            'file:alpha.ts',
            'file:zeta.ts',
        ]);

        const components = src.children[0]!;
        expect(components.kind).toBe('dir');
        if (components.kind !== 'dir') return;
        expect(components.children.map((n) => `${n.kind}:${n.name}`)).toEqual(['file:Alert.tsx', 'file:Button.tsx']);
    });

    describe('buildChangedOnlyTreeNodes (Changed only: the tree pruned to the changed files)', () => {
        const files = [
            'apps/ui/sources/app/(app)/settings.tsx',
            'apps/ui/sources/components/settings/modal/SettingsModal.tsx',
            'apps/ui/sources/components/settings/modal/useSettingsRouteKey.ts',
            '.agents/skills/attack-conclusion/SKILL.md',
            '.agents/skills/verify-claims/SKILL.md',
            'AGENTS.md',
        ].map((fullPath) => ({ fullPath, fileName: fullPath.split('/').pop() })) as any[];
        const rows = (nodes: ReturnType<typeof buildChangedOnlyTreeNodes>) =>
            nodes.map((node) => `${'  '.repeat(node.depth)}${node.type === 'directory' ? (node.isExpanded ? 'v ' : '> ') : ''}${node.name}`);

        it('opens every folder and collapses single-child folder chains into one row', () => {
            const nodes = buildChangedOnlyTreeNodes(files, new Set());
            expect(rows(nodes)).toEqual([
                'v .agents/skills',
                '  v attack-conclusion',
                '    SKILL.md',
                '  v verify-claims',
                '    SKILL.md',
                'v apps/ui/sources',
                '  v app/(app)',
                '    settings.tsx',
                '  v components/settings/modal',
                '    SettingsModal.tsx',
                '    useSettingsRouteKey.ts',
                'AGENTS.md',
            ]);
            // A collapsed chain row stands for its deepest folder, so opening, badges and reveal use that path.
            expect(nodes.find((node) => node.name === 'components/settings/modal')?.path).toBe('apps/ui/sources/components/settings/modal');
            expect(nodes.find((node) => node.name === 'settings.tsx')?.path).toBe('apps/ui/sources/app/(app)/settings.tsx');
        });

        it('prioritizes session roots without disturbing alphabetical descendants or single-child compaction', () => {
            const nodes = buildChangedOnlyTreeNodes(files, new Set(), new Set(['apps/ui/sources/app/(app)/settings.tsx']));
            expect(nodes[0]?.name).toBe('apps/ui/sources');
            expect(nodes[1]?.name).toBe('app/(app)');
            expect(nodes.find((node) => node.name === '.agents/skills')?.depth).toBe(0);
        });

        it('hides the files under a folder the person closed, keeping the rest open', () => {
            const nodes = buildChangedOnlyTreeNodes(files, new Set(['apps/ui/sources/components/settings/modal']));
            expect(rows(nodes).slice(5)).toEqual([
                'v apps/ui/sources',
                '  v app/(app)',
                '    settings.tsx',
                '  > components/settings/modal',
                'AGENTS.md',
            ]);
        });
    });
    describe('resolveChangedOnlyTreeInitiallyClosedPaths (a large change opens as far as one page of rows)', () => {
        const toFiles = (paths: readonly string[]) => paths.map((fullPath) => ({ fullPath, fileName: fullPath.split('/').pop() })) as any[];
        const many = (folder: string, count: number) => Array.from({ length: count }, (_, i) => `${folder}/File${String(i).padStart(3, '0')}.tsx`);
        const rows = (nodes: ReturnType<typeof buildChangedOnlyTreeNodes>) =>
            nodes.map((node) => `${'  '.repeat(node.depth)}${node.type === 'directory' ? (node.isExpanded ? 'v ' : '> ') : ''}${node.name}`);

        it('keeps every folder open when the whole tree fits in the row budget', () => {
            const files = toFiles(['apps/ui/sources/app/(app)/settings.tsx', 'apps/ui/sources/components/settings/SettingsModal.tsx', 'AGENTS.md']);
            expect(resolveChangedOnlyTreeInitiallyClosedPaths(files, 12).size).toBe(0);
        });

        it('opens folders breadth first while the visible rows stay within the budget, so every folder is one tap away', () => {
            const files = toFiles([
                ...many('apps/ui/sources/components/settings/pages', 64),
                ...many('apps/ui/sources/components/settings/sections', 21),
                ...many('apps/ui/sources/components/ui', 41),
                ...many('apps/ui/sources/text/translations', 27),
                ...many('packages/protocol/src/settings', 12),
                ...many('docs', 5),
                'yarn.lock',
            ]);
            const closed = resolveChangedOnlyTreeInitiallyClosedPaths(files, 12);
            const nodes = buildChangedOnlyTreeNodes(files, closed);
            expect(rows(nodes)).toEqual([
                'v apps/ui/sources',
                '  > components',
                '  > text/translations',
                'v docs',
                '  File000.tsx',
                '  File001.tsx',
                '  File002.tsx',
                '  File003.tsx',
                '  File004.tsx',
                '> packages/protocol/src/settings',
                'yarn.lock',
            ]);
            // Nothing is cut: every changed file sits beneath a row that is shown.
            const shownFolders = nodes.filter((node) => node.type === 'directory').map((node) => node.path);
            const reachable = files.every((file) => file.fullPath === 'yarn.lock' || shownFolders.some((folder) => file.fullPath.startsWith(`${folder}/`)));
            expect(reachable).toBe(true);
        });

        it('closes every folder when even the top level exceeds the budget', () => {
            const files = toFiles(['a/x.ts', 'b/x.ts', 'c/x.ts', 'd/x.ts']);
            expect(rows(buildChangedOnlyTreeNodes(files, resolveChangedOnlyTreeInitiallyClosedPaths(files, 3)))).toEqual(['> a', '> b', '> c', '> d']);
        });
    });
});
