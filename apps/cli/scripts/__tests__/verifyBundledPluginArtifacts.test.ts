import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    compareBundledPluginPackageTreeToInventory,
    formatBundledPluginArtifactVerification,
    isBundledPluginPublishedRuntimeRelativePath,
    readBundledPluginArtifactInventory,
    verifyBundledPluginArtifactsAgainstInventory,
} from '../verifyBundledPluginArtifacts.mjs';

const INVENTORY_RELATIVE_PATH = 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginArtifacts.ts';
const PACKAGE_NAME = '@happier-dev/plugins-claude';

const roots: string[] = [];

afterEach(() => {
    while (roots.length > 0) {
        rmSync(roots.pop()!, { recursive: true, force: true });
    }
});

function createRoot(): string {
    const root = mkdtempSync(resolve(tmpdir(), 'happier-bundled-plugin-artifacts-'));
    roots.push(root);
    return root;
}

function writeFileAt(root: string, relativePath: string, contents: string): void {
    const path = resolve(root, ...relativePath.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
}

function digestOf(contents: string): string {
    return `sha256:${createHash('sha256').update(Buffer.from(contents, 'utf8')).digest('hex')}`;
}

function writeInventory(repoRoot: string, files: ReadonlyArray<Readonly<{ relativePath: string; contents: string }>>): void {
    const immutableArtifacts = [{
        packageEntryRelativePath: 'dist/index.js',
        packageName: PACKAGE_NAME,
        record: {
            createdAtMs: 0,
            files: files.map((file) => ({
                byteLength: Buffer.byteLength(file.contents, 'utf8'),
                relativePath: file.relativePath,
            })),
            manifestRelativePath: '.happier-plugin/plugin.json',
            pluginId: 'claude',
            schemaVersion: 1,
            t: 'happier_plugin_generation_v1',
        },
    }];
    const sourceArtifactIntegrities = [{
        packageName: PACKAGE_NAME,
        files: files.map((file) => ({
            byteLength: Buffer.byteLength(file.contents, 'utf8'),
            digest: digestOf(file.contents),
            relativePath: file.relativePath,
        })),
    }];
    writeFileAt(
        repoRoot,
        INVENTORY_RELATIVE_PATH,
        // Mirrors the generator's split runtime-record/source-integrity emission.
        [
            '/** GENERATED FILE CONTRACT (WS4.T2/SVC11 bundled immutable artifacts). */',
            "import type { BundledImmutablePluginArtifact } from '../../../store/registry/generationStore';",
            '',
            'export const BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS = Object.freeze(',
            `${JSON.stringify(immutableArtifacts, null, 2)} satisfies readonly BundledImmutablePluginArtifact[]);`,
            '',
            'export type BundledFirstPartySourceArtifactIntegrity = Readonly<{',
            '  packageName: string;',
            '  files: readonly Readonly<{ relativePath: string; byteLength: number; digest: string }>[];',
            '}>;',
            '',
            'export const BUNDLED_FIRST_PARTY_SOURCE_ARTIFACT_INTEGRITIES = Object.freeze(',
            `${JSON.stringify(sourceArtifactIntegrities, null, 2)} satisfies readonly BundledFirstPartySourceArtifactIntegrity[]);`,
            '',
        ].join('\n'),
    );
}

describe('verifyBundledPluginArtifactsAgainstInventory', () => {
    const publishedFiles = [
        { relativePath: '.happier-plugin/plugin.json', contents: '{"id":"claude"}\n' },
        { relativePath: 'dist/.happier-chunks/chunk-C5DYOV67.js', contents: 'export const chunk = 1;\n' },
        { relativePath: 'dist/index.js', contents: 'export * from "./.happier-chunks/chunk-C5DYOV67.js";\n' },
        { relativePath: 'package.json', contents: '{\n  "name": "@happier-dev/plugins-claude"\n}\n' },
    ] as const;

    function seedPackageTree(packageDir: string): void {
        for (const file of publishedFiles) writeFileAt(packageDir, file.relativePath, file.contents);
    }

    it('admits a package tree whose bytes are exactly what the inventory publishes', () => {
        const repoRoot = createRoot();
        const packageDir = resolve(createRoot(), 'plugins-claude');
        writeInventory(repoRoot, publishedFiles);
        seedPackageTree(packageDir);
        // Vendored runtime dependencies are resolved per install and are not inventoried.
        writeFileAt(packageDir, 'node_modules/left-pad/index.js', 'module.exports = 1;\n');
        // The generator excludes the TypeScript incremental cache from the inventory.
        writeFileAt(packageDir, 'dist/.tsbuildinfo', '{}');

        const results = verifyBundledPluginArtifactsAgainstInventory({
            repoRoot,
            resolvePackageDir: () => packageDir,
        });

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            packageName: PACKAGE_NAME,
            inventoryFileCount: 4,
            matchedFileCount: 4,
            missing: [],
            mismatched: [],
            unexpected: [],
        });
        expect(formatBundledPluginArtifactVerification(results)).toBeNull();
    });

    it('compares only the published runtime tree when source-dev repair asks for that scope', () => {
        const packageDir = resolve(createRoot(), 'plugins-claude');
        seedPackageTree(packageDir);
        writeFileAt(packageDir, 'package.json', '{\n  "name": "@happier-dev/plugins-claude",\n  "scripts": { "build": "local" }\n}\n');
        const artifact = {
            packageName: PACKAGE_NAME,
            files: publishedFiles.map((file) => ({
                byteLength: Buffer.byteLength(file.contents, 'utf8'),
                digest: digestOf(file.contents),
                relativePath: file.relativePath,
            })),
        };

        expect(compareBundledPluginPackageTreeToInventory({ artifact, packageDir })).toMatchObject({
            inventoryFileCount: 4,
            matchedFileCount: 3,
            missing: [],
            mismatched: [{ relativePath: 'package.json' }],
            unexpected: [],
        });

        const result = compareBundledPluginPackageTreeToInventory({
            artifact,
            packageDir,
            includeRelativePath: isBundledPluginPublishedRuntimeRelativePath,
        });

        expect(result).toMatchObject({
            inventoryFileCount: 3,
            matchedFileCount: 3,
            missing: [],
            mismatched: [],
            unexpected: [],
        });
    });

    it('rejects a package tree that ships a truncated entry and drops its runtime chunk', () => {
        const repoRoot = createRoot();
        const packageDir = resolve(createRoot(), 'plugins-claude');
        writeInventory(repoRoot, publishedFiles);
        seedPackageTree(packageDir);
        // The exact artifact defect this assertion exists for: a stub entry published
        // without the runtime chunk it re-exports.
        writeFileAt(packageDir, 'dist/index.js', 'export {};\n');
        rmSync(resolve(packageDir, 'dist', '.happier-chunks', 'chunk-C5DYOV67.js'));

        const results = verifyBundledPluginArtifactsAgainstInventory({
            repoRoot,
            resolvePackageDir: () => packageDir,
        });

        expect(results[0]).toMatchObject({
            matchedFileCount: 2,
            missing: ['dist/.happier-chunks/chunk-C5DYOV67.js'],
            unexpected: [],
        });
        expect(results[0]?.mismatched).toEqual([{
            relativePath: 'dist/index.js',
            expectedByteLength: 53,
            actualByteLength: 11,
            expectedDigest: digestOf(publishedFiles[2].contents),
            actualDigest: digestOf('export {};\n'),
        }]);

        const failure = formatBundledPluginArtifactVerification(results);
        expect(failure).toContain('2/4 matching, 1 missing, 1 mismatched, 0 unexpected');
        expect(failure).toContain('missing: dist/.happier-chunks/chunk-C5DYOV67.js');
        expect(failure).toContain('mismatched: dist/index.js expected 53 B');
    });

    it('rejects a package tree that ships a plugin file the inventory does not publish', () => {
        const repoRoot = createRoot();
        const packageDir = resolve(createRoot(), 'plugins-claude');
        writeInventory(repoRoot, publishedFiles);
        seedPackageTree(packageDir);
        writeFileAt(packageDir, 'dist/.happier-chunks/chunk-STALE111.js', 'export const stale = 1;\n');

        const results = verifyBundledPluginArtifactsAgainstInventory({
            repoRoot,
            resolvePackageDir: () => packageDir,
        });

        expect(results[0]).toMatchObject({
            matchedFileCount: 4,
            missing: [],
            mismatched: [],
            unexpected: ['dist/.happier-chunks/chunk-STALE111.js'],
        });
        expect(formatBundledPluginArtifactVerification(results))
            .toContain('unexpected: dist/.happier-chunks/chunk-STALE111.js');
    });

    it('rejects an inventoried package whose bundled tree was never published', () => {
        const repoRoot = createRoot();
        writeInventory(repoRoot, publishedFiles);

        const results = verifyBundledPluginArtifactsAgainstInventory({
            repoRoot,
            resolvePackageDir: () => resolve(createRoot(), 'absent-plugins-claude'),
        });

        expect(results[0]).toMatchObject({ packageDirMissing: true, matchedFileCount: 0 });
        expect(results[0]?.missing).toHaveLength(4);
        expect(formatBundledPluginArtifactVerification(results)).toContain('package tree absent:');
    });

    it('does not treat the structural runtime record as the pack-time digest inventory', () => {
        const repoRoot = createRoot();
        const immutableArtifacts = [{
            packageEntryRelativePath: 'dist/index.js',
            packageName: PACKAGE_NAME,
            record: {
                createdAtMs: 0,
                files: [{
                    byteLength: Buffer.byteLength(publishedFiles[0].contents, 'utf8'),
                    relativePath: publishedFiles[0].relativePath,
                }],
                manifestRelativePath: '.happier-plugin/plugin.json',
                pluginId: 'claude',
                schemaVersion: 1,
                t: 'happier_plugin_generation_v1',
            },
        }];
        writeFileAt(
            repoRoot,
            INVENTORY_RELATIVE_PATH,
            [
                "import type { BundledImmutablePluginArtifact } from '../../../store/registry/generationStore';",
                '',
                'export const BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS = Object.freeze(',
                `${JSON.stringify(immutableArtifacts, null, 2)} satisfies readonly BundledImmutablePluginArtifact[]);`,
                '',
            ].join('\n'),
        );

        expect(() => readBundledPluginArtifactInventory({ repoRoot }))
            .toThrow(/source-artifact integrity inventory/u);
    });

    it('binds nothing for a repository that publishes no bundled plugin inventory', () => {
        const repoRoot = createRoot();

        expect(readBundledPluginArtifactInventory({ repoRoot })).toBeNull();
        expect(verifyBundledPluginArtifactsAgainstInventory({
            repoRoot,
            resolvePackageDir: () => repoRoot,
        })).toEqual([]);
    });
});
