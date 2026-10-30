import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
// Protocol is a devDependency here on purpose: the import fence keeps it out of
// shipped plugin sources, but a test may reach the canonical host owner to
// prove this plugin-scoped delegate cannot drift away from it.
import { readNonBlankOpaqueIdentifier as canonicalReadNonBlankOpaqueIdentifier } from '@happier-dev/protocol';

import { readNonBlankOpaqueIdentifier } from './opaqueIdentifier.js';

const pluginSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ownerRelativePath = 'protocol/opaqueIdentifier.ts';

/**
 * Bytes an Agent minted. Surrounding whitespace, the embedded newline and the
 * `/`, `+`, `=` punctuation are all part of the identity OpenCode hands back to
 * itself, so none of them may be normalized away.
 */
const PROVIDER_MINTED_ID = '  provider\nses/AB+cd==  ';

const IDENTITY_CASES: readonly unknown[] = [
    PROVIDER_MINTED_ID,
    'provider\nses/AB+cd==',
    'ses/AB+cd==',
    ' leading',
    'trailing ',
    '   ',
    '\n',
    ' \t ',
    '',
    null,
    undefined,
    42,
    {},
    ['a'],
];

async function readRuntimeSourcePaths(directory: string): Promise<readonly string[]> {
    const paths = await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => {
        if (entry.name === 'node_modules' || entry.name === 'dist') return [];
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return await readRuntimeSourcePaths(path);
        if (!/\.tsx?$/u.test(entry.name)) return [];
        if (/\.(?:test|test-support|testkit)\.tsx?$/u.test(entry.name)) return [];
        return [path];
    }));
    return paths.flat();
}

describe('OpenCode opaque-identifier owner', () => {
    it('keeps a provider-minted identity byte-exact and answers only presence', () => {
        expect(readNonBlankOpaqueIdentifier(PROVIDER_MINTED_ID)).toBe(PROVIDER_MINTED_ID);
        expect(readNonBlankOpaqueIdentifier('   ')).toBeNull();
        expect(readNonBlankOpaqueIdentifier('\n')).toBeNull();
        expect(readNonBlankOpaqueIdentifier('')).toBeNull();
        expect(readNonBlankOpaqueIdentifier(undefined)).toBeNull();
        expect(readNonBlankOpaqueIdentifier(42)).toBeNull();
    });

    it('cannot drift from the canonical Protocol owner it delegates for', () => {
        for (const value of IDENTITY_CASES) {
            expect(readNonBlankOpaqueIdentifier(value)).toStrictEqual(
                canonicalReadNonBlankOpaqueIdentifier(value),
            );
        }
    });

    it('is the only implementation of the rule in shipped OpenCode sources', async () => {
        const sources = await Promise.all(
            (await readRuntimeSourcePaths(pluginSourceRoot)).map(async (path) => ({
                path: relative(pluginSourceRoot, path).split('\\').join('/'),
                source: await readFile(path, 'utf8'),
            })),
        );

        // A declaration re-implements the rule; an `import`/`export … from`
        // reaches this owner and is how every consumer must consume it.
        const declaringModules = sources
            .filter(({ source }) => (
                /(?:function|const|let|var)\s+readNonBlankOpaqueIdentifier\b/u.test(source)
            ))
            .map(({ path }) => path)
            .sort();

        expect(declaringModules).toEqual([ownerRelativePath]);
    });
});
