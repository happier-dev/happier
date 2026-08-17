import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyReactNativeEnrichedMarkdownPatch } from './verifyReactNativeEnrichedMarkdownPatch.mjs';
import { repairReactNativeEnrichedMarkdownPatch } from './repairReactNativeEnrichedMarkdownPatch.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PARSER_CACHE_DELETE_MARKER = 'parseCache.delete(cacheKey)';
const EXPECTED_PARSER_CACHE_DELETE_OCCURRENCES = 4;

function resolveInstalledPackageDir() {
    try {
        return path.dirname(createRequire(import.meta.url).resolve('react-native-enriched-markdown/package.json'));
    } catch {
        return path.join(UI_DIR, 'node_modules', 'react-native-enriched-markdown');
    }
}

const INSTALLED_PACKAGE_DIR = resolveInstalledPackageDir();

test('accepts the installed enriched-markdown patch after a document parse error', (t) => {
    if (!fs.existsSync(INSTALLED_PACKAGE_DIR)) {
        t.skip('react-native-enriched-markdown is not installed');
        return;
    }

    assert.equal(verifyReactNativeEnrichedMarkdownPatch({ packageDir: INSTALLED_PACKAGE_DIR }), true);
});

test('DISCRIMINATES: losing one parser cache-cleanup branch fails verification', (t) => {
    if (!fs.existsSync(INSTALLED_PACKAGE_DIR)) {
        t.skip('react-native-enriched-markdown is not installed');
        return;
    }

    const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enriched-markdown-patch-'));
    t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }));
    fs.cpSync(INSTALLED_PACKAGE_DIR, packageDir, { recursive: true });

    const parserPath = path.join(packageDir, 'lib', 'module', 'web', 'parseMarkdown.js');
    const original = fs.readFileSync(parserPath, 'utf8');
    assert.equal(
        original.split(PARSER_CACHE_DELETE_MARKER).length - 1,
        EXPECTED_PARSER_CACHE_DELETE_OCCURRENCES,
        'the mutation basis must match the current patched parser',
    );
    const mutated = original.replace(
        PARSER_CACHE_DELETE_MARKER,
        'parseCache.delete(/* dropped cleanup branch */ cacheKey)',
    );
    assert.notEqual(mutated, original, 'the mutation must change the parser bytes');
    fs.writeFileSync(parserPath, mutated, 'utf8');

    assert.equal(verifyReactNativeEnrichedMarkdownPatch({ packageDir }), false);
});

test('DISCRIMINATES: restoring the obsolete global cache reset fails verification', (t) => {
    if (!fs.existsSync(INSTALLED_PACKAGE_DIR)) {
        t.skip('react-native-enriched-markdown is not installed');
        return;
    }

    const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enriched-markdown-patch-'));
    t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }));
    fs.cpSync(INSTALLED_PACKAGE_DIR, packageDir, { recursive: true });

    const parserPath = path.join(packageDir, 'lib', 'module', 'web', 'parseMarkdown.js');
    const original = fs.readFileSync(parserPath, 'utf8');
    const mutated = original.replace(
        '    throw error;',
        '    parseCache.clear();\n    throw error;',
    );
    assert.notEqual(mutated, original, 'the mutation must change the parser bytes');
    fs.writeFileSync(parserPath, mutated, 'utf8');

    assert.equal(verifyReactNativeEnrichedMarkdownPatch({ packageDir }), false);
});

test('repairs a missing generated streaming module when the remaining patch is already applied', (t) => {
    if (!fs.existsSync(INSTALLED_PACKAGE_DIR)) {
        t.skip('react-native-enriched-markdown is not installed');
        return;
    }
    assert.equal(
        verifyReactNativeEnrichedMarkdownPatch({ packageDir: INSTALLED_PACKAGE_DIR }),
        true,
        'the installed package must provide a fully patched recovery fixture',
    );

    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enriched-markdown-partial-repair-'));
    t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
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

    assert.equal(verifyReactNativeEnrichedMarkdownPatch({ packageDir }), false);
    assert.equal(
        repairReactNativeEnrichedMarkdownPatch({
            packageDir,
            patchDir: fixturePatchDir,
            patchPackageCliPath: path.join(UI_DIR, '..', '..', 'node_modules', 'patch-package', 'dist', 'index.js'),
            label: 'test',
        }),
        true,
    );
    assert.equal(verifyReactNativeEnrichedMarkdownPatch({ packageDir }), true);
});
