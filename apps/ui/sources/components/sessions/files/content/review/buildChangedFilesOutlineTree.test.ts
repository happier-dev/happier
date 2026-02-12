import { describe, expect, it } from 'vitest';

import { buildChangedFilesOutlineTree } from './buildChangedFilesOutlineTree';

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
});
