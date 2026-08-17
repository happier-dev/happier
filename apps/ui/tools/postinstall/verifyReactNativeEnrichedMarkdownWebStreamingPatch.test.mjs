import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES,
    REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_MARKERS,
    formatReactNativeEnrichedMarkdownWebStreamingPatchFailure,
    verifyReactNativeEnrichedMarkdownWebStreamingPatch,
} from './verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs';
import { repairReactNativeEnrichedMarkdownWebStreamingPatch } from './repairReactNativeEnrichedMarkdownWebStreamingPatch.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLED_PACKAGE_DIR = path.join(UI_DIR, 'node_modules', 'react-native-enriched-markdown');

const STREAMING_REVEAL_ARTIFACTS = [
    'lib/module/web/streamingReveal.js',
    'lib/module/web/streamingReveal.d.ts',
    'lib/typescript/src/web/streamingReveal.d.ts',
    'src/web/streamingReveal.ts',
];

const PATCHED_TYPE_DECLARATION = 'lib/typescript/src/types/MarkdownStyle.d.ts';
const PATCHED_TYPE_MARKER = 'texMathBackslashDelimiters?: boolean';
const PATCHED_PARSER_MODULE = 'lib/module/web/parseMarkdown.js';
const PARSER_CACHE_DELETE_MARKER = 'parseCache.delete(cacheKey)';

function createPatchedPackageFixture() {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enriched-markdown-patch-fixture-'));
    const markersByFile = new Map();
    for (const [relativePath, marker, minOccurrences = 1] of REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_MARKERS) {
        const markers = markersByFile.get(relativePath) ?? [];
        markers.push(...Array.from({ length: minOccurrences }, () => marker));
        markersByFile.set(relativePath, markers);
    }
    for (const relativePath of REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES) {
        const filePath = path.join(fixtureDir, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, (markersByFile.get(relativePath) ?? []).join('\n'), 'utf8');
    }
    return fixtureDir;
}

test('installed app-local enriched-markdown materializes every patch-owned streaming-reveal artifact', () => {
    const missing = STREAMING_REVEAL_ARTIFACTS.filter(
        (relativePath) => !fs.existsSync(path.join(INSTALLED_PACKAGE_DIR, relativePath)),
    );

    assert.deepEqual(missing, []);

    const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: INSTALLED_PACKAGE_DIR });
    assert.equal(result.status, 'ok', formatReactNativeEnrichedMarkdownWebStreamingPatchFailure(result));
});

test('DISCRIMINATES: the package type entrypoint exposes the patch-owned TeX flag', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        const declarationPath = path.join(fixtureDir, PATCHED_TYPE_DECLARATION);
        fs.mkdirSync(path.dirname(declarationPath), { recursive: true });
        fs.writeFileSync(declarationPath, 'export interface Md4cFlags { latexMath?: boolean; }', 'utf8');

        const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });

        assert.equal(result.status, 'failed');
        assert.ok(result.missingMarkers.some(([relativePath, marker]) => (
            relativePath === PATCHED_TYPE_DECLARATION && marker === PATCHED_TYPE_MARKER
        )));
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

test('DISCRIMINATES: an installed package missing patch-owned source/types cannot be certified from its built module alone', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        fs.rmSync(path.join(fixtureDir, 'src', 'web', 'streamingReveal.ts'));
        fs.rmSync(path.join(fixtureDir, 'lib', 'typescript', 'src', 'web', 'streamingReveal.d.ts'));

        const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });

        assert.equal(result.status, 'failed');
        assert.deepEqual(
            result.missingFiles.filter((relativePath) => STREAMING_REVEAL_ARTIFACTS.includes(relativePath)).sort(),
            ['lib/typescript/src/web/streamingReveal.d.ts', 'src/web/streamingReveal.ts'],
        );
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

test('DISCRIMINATES: the public splitter export must be present in the built module the plain-text consumer imports', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        const builtModulePath = path.join(fixtureDir, 'lib', 'module', 'web', 'streamingReveal.js');
        const original = fs.readFileSync(builtModulePath, 'utf8');
        fs.writeFileSync(builtModulePath, original.replaceAll('splitStreamingRevealTextParts', 'removedStreamingRevealSplitter'), 'utf8');

        const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });

        assert.equal(result.status, 'failed');
        assert.ok(result.missingMarkers.some(([relativePath, marker]) => (
            relativePath === 'lib/module/web/streamingReveal.js' && marker === 'splitStreamingRevealTextParts'
        )));
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

test('DISCRIMINATES: all four parser cache-cleanup branches remain installed', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        const parserPath = path.join(fixtureDir, PATCHED_PARSER_MODULE);
        const parserContents = fs.readFileSync(parserPath, 'utf8');
        fs.writeFileSync(
            parserPath,
            `${parserContents.replaceAll(PARSER_CACHE_DELETE_MARKER, '')}\n${PARSER_CACHE_DELETE_MARKER}\n`,
            'utf8',
        );

        const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });

        assert.equal(result.status, 'failed');
        assert.ok(result.missingMarkers.some(([relativePath, marker, minOccurrences]) => (
            relativePath === PATCHED_PARSER_MODULE
            && marker === PARSER_CACHE_DELETE_MARKER
            && minOccurrences === 4
        )));
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

test('DISCRIMINATES: the obsolete global parser cache reset remains forbidden', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        const parserPath = path.join(fixtureDir, PATCHED_PARSER_MODULE);
        fs.appendFileSync(parserPath, '\nparseCache.clear()\n', 'utf8');

        const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });

        assert.equal(result.status, 'failed');
        assert.ok(result.forbiddenMarkers.some(([relativePath, marker]) => (
            relativePath === PATCHED_PARSER_MODULE && marker === 'parseCache.clear()'
        )));
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

test('repairs a missing generated streaming module when the remaining patch is already applied', () => {
    const installedResult = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: INSTALLED_PACKAGE_DIR });
    assert.equal(installedResult.status, 'ok', formatReactNativeEnrichedMarkdownWebStreamingPatchFailure(installedResult));

    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enriched-markdown-partial-repair-'));
    try {
        const packageDir = path.join(fixtureDir, 'node_modules', 'react-native-enriched-markdown');
        const fixturePatchDir = path.join(fixtureDir, 'patches');
        fs.mkdirSync(path.dirname(packageDir), { recursive: true });
        fs.mkdirSync(fixturePatchDir, { recursive: true });
        fs.cpSync(INSTALLED_PACKAGE_DIR, packageDir, { recursive: true });
        fs.copyFileSync(
            path.join(UI_DIR, 'patches', 'react-native-enriched-markdown+0.5.0.patch'),
            path.join(fixturePatchDir, 'react-native-enriched-markdown+0.5.0.patch'),
        );
        fs.writeFileSync(path.join(fixtureDir, 'package.json'), '{"name":"partial-repair-fixture","private":true}\n');
        fs.rmSync(path.join(packageDir, 'lib', 'module', 'web', 'streamingReveal.js'));

        const brokenResult = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir });
        assert.equal(brokenResult.status, 'failed');
        const repairedResult = repairReactNativeEnrichedMarkdownWebStreamingPatch({
            packageDir,
            patchDir: fixturePatchDir,
            patchPackageCliPath: path.join(UI_DIR, '..', '..', 'node_modules', 'patch-package', 'dist', 'index.js'),
            label: 'test',
        });
        assert.equal(repairedResult.status, 'ok', formatReactNativeEnrichedMarkdownWebStreamingPatchFailure(repairedResult));
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});
