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
    verifyUiPatchedDependencies,
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
const VISIBILITY_MARKERS = [
    ['src/web/EnrichedMarkdownText.tsx', 'if (syncAst) return;'],
    ['lib/module/web/EnrichedMarkdownText.js', 'if (syncAst) return;'],
    ['src/web/streamingReveal.ts', '.start <= start'],
    ['lib/module/web/streamingReveal.js', '.start <= start'],
];

test('UI dependency preflight verifies both app-local and hoisted patched copies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-patched-copy-preflight-'));
    const fixture = createPatchedPackageFixture();
    const uiPackageDir = path.join(root, 'apps', 'ui');
    const appCopy = path.join(uiPackageDir, 'node_modules', 'react-native-enriched-markdown');
    const hoistedCopy = path.join(root, 'node_modules', 'react-native-enriched-markdown');
    try {
        fs.cpSync(fixture, appCopy, { recursive: true });
        fs.cpSync(fixture, hoistedCopy, { recursive: true });
        assert.doesNotThrow(() => verifyUiPatchedDependencies({ uiPackageDir }));
        fs.unlinkSync(path.join(hoistedCopy, 'lib/module/web/streamingReveal.js'));
        assert.throws(() => verifyUiPatchedDependencies({ uiPackageDir }));
        fs.cpSync(fixture, hoistedCopy, { recursive: true });
        fs.unlinkSync(path.join(appCopy, 'lib/module/web/streamingReveal.js'));
        assert.throws(() => verifyUiPatchedDependencies({ uiPackageDir }));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

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

test('dependency preflight rejects an installed eager math loader', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        const file = 'lib/module/web/katex.js';
        fs.mkdirSync(path.dirname(path.join(fixtureDir, file)), { recursive: true });
        fs.writeFileSync(path.join(fixtureDir, file), "export const loadKaTeX = () => Promise.resolve(require('katex'));\n");
        const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });
        assert.equal(result.status, 'failed');
        assert.ok(result.missingMarkers.some(([relativePath]) => relativePath === file));
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

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

test('rejects stale visibility behavior independently in every consumed source and compiled owner', () => {
    const fixtureDir = createPatchedPackageFixture();
    try {
        for (const [relativePath, marker] of VISIBILITY_MARKERS) {
            const filePath = path.join(fixtureDir, relativePath);
            const original = fs.readFileSync(filePath, 'utf8');
            fs.writeFileSync(filePath, original.replaceAll(marker, ''), 'utf8');
            const result = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir: fixtureDir });
            assert.equal(result.status, 'failed', relativePath);
            assert.ok(result.missingMarkers.some(([file, missing]) => file === relativePath && missing === marker));
            fs.writeFileSync(filePath, original, 'utf8');
        }
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});

for (const scenario of ['missing module', 'stale overlapping implementation', 'stale native renderer ownership']) {
test(`partial repair handles ${scenario} without certifying an incompatible dependency`, () => {
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
        if (scenario === 'missing module') {
            fs.rmSync(path.join(packageDir, 'lib', 'module', 'web', 'streamingReveal.js'));
        } else if (scenario === 'stale native renderer ownership') {
            const rendererPath = path.join(packageDir, 'ios', 'renderer', 'StrongRenderer.m');
            const current = fs.readFileSync(rendererPath, 'utf8');
            assert.match(current, /(?:__weak )?RendererFactory \*_rendererFactory;/);
            fs.writeFileSync(rendererPath, current.replace('__weak RendererFactory *_rendererFactory;', 'RendererFactory *_rendererFactory;'));
        } else {
            for (const [relativePath, marker] of VISIBILITY_MARKERS) {
                const filePath = path.join(packageDir, relativePath);
                const original = fs.readFileSync(filePath, 'utf8');
                const stale = original.replaceAll(marker, marker.includes('syncAst') ? '' : '.start < end');
                assert.notEqual(stale, original);
                fs.writeFileSync(filePath, stale, 'utf8');
            }
        }

        const brokenResult = verifyReactNativeEnrichedMarkdownWebStreamingPatch({ packageDir });
        assert.equal(brokenResult.status, 'failed');
        const repairedResult = repairReactNativeEnrichedMarkdownWebStreamingPatch({
            packageDir,
            patchDir: fixturePatchDir,
            patchPackageCliPath: path.join(UI_DIR, '..', '..', 'node_modules', 'patch-package', 'dist', 'index.js'),
            label: 'test',
        });
        // --partial can restore a missing added file, but cannot rebase overlapping
        // previously patched implementation hunks. The verifier must fail closed.
        assert.equal(repairedResult.status, scenario === 'stale overlapping implementation' ? 'failed' : 'ok');
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});
}
