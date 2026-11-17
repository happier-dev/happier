import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The filesystem is the boundary: count how much manifest text crosses it decoded into strings.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

import { readBundledPluginCanonicalDeclarationDigest, readBundledPluginManifest } from './manifestFile';

const cliRoot = resolve(__dirname, '../../../../..');
const relativePath = 'assets/bundled-plugin-manifests/scm-github.json';
const manifestPath = resolve(cliRoot, relativePath);

function decodedManifestCharacters(): number {
    let characters = 0;
    for (const [index, call] of vi.mocked(fs.readFileSync).mock.calls.entries()) {
        const result = vi.mocked(fs.readFileSync).mock.results[index]?.value;
        if (resolve(String(call[0])) === manifestPath && typeof result === 'string') characters += result.length;
    }
    return characters;
}

describe('bundled manifest summary verification', () => {
    // Every process start verifies each bundled declaration summary against its manifest
    // (~27 MB for the bundled set). Hashing the bytes verifies the same digest without
    // decoding every manifest into a JS string the read then discards.
    it('verifies a matching summary without decoding the manifest text', () => {
        vi.mocked(fs.readFileSync).mockClear();
        const manifest = readBundledPluginManifest({ manifestRelativePath: relativePath }, cliRoot) as { id?: unknown };
        expect(manifest.id).toBe('happier.scm.forge.github');
        expect(readBundledPluginCanonicalDeclarationDigest({ manifestRelativePath: relativePath }, cliRoot)).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(decodedManifestCharacters()).toBe(0);
    });
});
