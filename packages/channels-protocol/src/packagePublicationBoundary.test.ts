import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const packageDirectory = new URL('../', import.meta.url);

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(new URL(path, packageDirectory));
        return true;
    } catch {
        return false;
    }
}

describe('Channels protocol publication boundary', () => {
    it('is publishable and contains exactly the explicit root, V1, and testing-V1 entrypoints', async () => {
        const packageJson = JSON.parse(await readFile(
            new URL('package.json', packageDirectory),
            'utf8',
        )) as Readonly<{
            private?: boolean;
            exports?: Record<string, unknown>;
            happier?: { publicSdkRelease?: { posture?: string } };
        }>;

        expect(packageJson.private).not.toBe(true);
        // The canonical npm release owner packs this package through the public
        // pack sandbox, whose publication transform refuses a public candidate
        // without Developer Preview release metadata.
        expect(packageJson.happier?.publicSdkRelease?.posture).toBe('developer_preview');
        expect(Object.keys(packageJson.exports ?? {}).sort()).toEqual([
            '.',
            './testing/v1',
            './v1',
        ]);

        await expect(Promise.all([
            'src/index.ts',
            'src/v1/index.ts',
            'src/testing/v1/index.ts',
            'dist/index.js',
            'dist/index.d.ts',
            'dist/v1/index.js',
            'dist/v1/index.d.ts',
            'dist/testing/v1/index.js',
            'dist/testing/v1/index.d.ts',
        ].map(async (path) => ({ path, exists: await fileExists(path) })))).resolves.toEqual([
            { path: 'src/index.ts', exists: true },
            { path: 'src/v1/index.ts', exists: true },
            { path: 'src/testing/v1/index.ts', exists: true },
            { path: 'dist/index.js', exists: true },
            { path: 'dist/index.d.ts', exists: true },
            { path: 'dist/v1/index.js', exists: true },
            { path: 'dist/v1/index.d.ts', exists: true },
            { path: 'dist/testing/v1/index.js', exists: true },
            { path: 'dist/testing/v1/index.d.ts', exists: true },
        ]);
    });

    it('prepares its published dist itself, because the pack sandbox never builds a candidate', async () => {
        const packageJson = JSON.parse(await readFile(
            new URL('package.json', packageDirectory),
            'utf8',
        )) as Readonly<{ scripts?: Record<string, string> }>;

        // Both candidate producers - the canonical npm release owner and the
        // natural packed-artifact builder - pack this package through the pack
        // sandbox, which copies source and runs `npm pack` without ever
        // building. `dist` is a git-ignored build output, so on a clean
        // checkout the candidate ships as package.json plus README unless this
        // package prepares itself through its own pack lifecycle.
        expect(typeof packageJson.scripts?.build).toBe('string');
        expect(packageJson.scripts?.prepack).toBe(packageJson.scripts?.build);
    });
});
