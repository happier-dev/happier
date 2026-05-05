import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { buildCodeMirrorWebViewBundle } from './buildCodeMirrorWebViewBundle.mjs';

let tempDir: string | null = null;

afterEach(async () => {
    if (!tempDir) return;
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
});

describe('buildCodeMirrorWebViewBundle', () => {
    it('exposes CodeMirror syntax theme primitives in the generated bundle', async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'happier-codemirror-bundle-'));
        const testDir = path.dirname(fileURLToPath(import.meta.url));
        const repoNodeModules = path.resolve(testDir, '../../../..', 'node_modules');
        await fs.symlink(repoNodeModules, path.join(tempDir, 'node_modules'), 'dir');

        const result = await buildCodeMirrorWebViewBundle({
            expoAppDir: tempDir,
            repoRootDir: path.resolve(tempDir, '..'),
        });

        const generated = await fs.readFile(result.outFile, 'utf8');

        expect(generated).toContain('HAPPIER_CODEMIRROR_WEBVIEW');
        expect(generated).toMatch(/\bHighlightStyle:/);
        expect(generated).toMatch(/\btags:/);
    });
});
