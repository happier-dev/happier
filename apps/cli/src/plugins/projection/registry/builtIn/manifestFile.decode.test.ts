import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { readBundledPluginCanonicalDeclarationDigest, readBundledPluginManifest } from './manifestFile';

const cliRoot = resolve(__dirname, '../../../../..');
const relativePath = 'assets/bundled-plugin-manifests/scm-github.json';

describe('bundled manifest summary reads', () => {
    it('reads the summary and release-less digest without decoding either Action schema section', () => {
        const [, , input, result] = JSON.parse(readFileSync(resolve(cliRoot, relativePath), 'utf8'));
        const deferredSections = new Set([JSON.stringify(input), JSON.stringify(result)]);
        const decode = vi.spyOn(JSON, 'parse');
        try {
            const manifest = readBundledPluginManifest({ manifestRelativePath: relativePath }, cliRoot) as { id?: unknown };
            expect(manifest.id).toBe('happier.scm.forge.github');
            expect(readBundledPluginCanonicalDeclarationDigest({ manifestRelativePath: relativePath }, cliRoot)).toMatch(/^sha256:[0-9a-f]{64}$/);
            expect(decode.mock.calls.filter(([value]) => deferredSections.has(value))).toEqual([]);
        } finally {
            decode.mockRestore();
        }
    });
});
