import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
    PluginManifestV2Schema,
    type ParsedPluginManifestV2,
} from '@happier-dev/protocol';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const examplesRoot = join(packageRoot, 'examples');
const packageJsonPath = join(packageRoot, 'package.json');

const requiredExamples = [
    'descriptor-only',
    'hosted-web',
    'react-native-installed',
    'react-native-dev-hot-reload',
    'multi-mode-fallback',
] as const;

async function listTypeScriptFiles(dir: string): Promise<readonly string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            return listTypeScriptFiles(entryPath);
        }
        return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
    }));
    return files.flat().sort();
}

function readExampleManifest(exampleName: (typeof requiredExamples)[number]): ParsedPluginManifestV2 {
    const manifestPath = join(examplesRoot, exampleName, '.happier-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    const parsed = PluginManifestV2Schema.safeParse(manifest);
    const diagnostics = parsed.success
        ? ''
        : `\n${parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('\n')}`;
    expect(
        parsed.success,
        `${exampleName}/.happier-plugin/plugin.json must match the protocol manifest schema${diagnostics}`,
    ).toBe(true);
    if (!parsed.success) {
        throw new Error(parsed.error.message);
    }
    return parsed.data;
}

async function readAuthoredExampleManifest(
    exampleName: (typeof requiredExamples)[number],
): Promise<ParsedPluginManifestV2> {
    const module = await import(pathToFileURL(join(examplesRoot, exampleName, 'src/index.ts')).href) as {
        manifest?: unknown;
    };
    const parsed = PluginManifestV2Schema.safeParse(module.manifest);
    expect(parsed.success, `${exampleName}/src/index.ts must export a protocol-valid manifest`).toBe(true);
    if (!parsed.success) {
        throw new Error(parsed.error.message);
    }
    return parsed.data;
}

function readPackageExportSpecifiers(): ReadonlySet<string> {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        name: string;
        exports: Record<string, unknown>;
    };
    return new Set([
        packageJson.name,
        ...Object.keys(packageJson.exports).map((subpath) => `${packageJson.name}${subpath.slice(1)}`),
    ]);
}

function relativeExampleArtifactPath(exampleName: string, artifactPath: string): string {
    return `${exampleName}/${artifactPath.replace(/^\/+/u, '')}`;
}

function assertExampleFileExists(exampleName: string, relativePath: string, missing: string[]): void {
    const filePath = join(examplesRoot, exampleName, relativePath);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        missing.push(relativeExampleArtifactPath(exampleName, relativePath));
    }
}

function assertExampleDirectoryContainsIndex(exampleName: string, relativePath: string, missing: string[]): void {
    const directoryPath = join(examplesRoot, exampleName, relativePath);
    const indexPath = join(directoryPath, 'index.html');
    if (
        !existsSync(directoryPath)
        || !statSync(directoryPath).isDirectory()
        || !existsSync(indexPath)
        || !statSync(indexPath).isFile()
    ) {
        missing.push(relativeExampleArtifactPath(exampleName, join(relativePath, 'index.html')));
    }
}

function listArtifactFiles(root: string): readonly string[] {
    const entries = readdirSync(root, { withFileTypes: true });
    return entries.flatMap((entry) => {
        const entryPath = join(root, entry.name);
        if (entry.isDirectory()) {
            return listArtifactFiles(entryPath);
        }
        return entry.isFile() ? [entryPath] : [];
    }).sort();
}

function computeExampleFileDigest(exampleName: string, relativePath: string): string {
    return computePluginUiArtifactSha256DigestV1(
        readFileSync(join(examplesRoot, exampleName, relativePath)),
    );
}

function computeExampleDirectoryDigest(exampleName: string, relativePath: string): string {
    const directoryPath = join(examplesRoot, exampleName, relativePath);
    const files = listArtifactFiles(directoryPath).map((filePath) => ({
        relativePath: relative(join(examplesRoot, exampleName), filePath),
        bytes: readFileSync(filePath),
    }));
    return computePluginUiArtifactFileSetSha256DigestV1(files);
}

function copyExamplesOutsideWorkspace(): string {
    const tempRoot = mkdtempSync(join(tmpdir(), 'happier-plugin-sdk-examples-'));
    cpSync(examplesRoot, tempRoot, {
        recursive: true,
        filter: (source) => !source.includes('/node_modules/') && !source.includes('/dist/'),
    });
    mkdirSync(join(tempRoot, 'node_modules', '@happier-dev'), { recursive: true });
    symlinkSync(packageRoot, join(tempRoot, 'node_modules', '@happier-dev', 'plugin-sdk'), 'dir');
    return tempRoot;
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
    const host: ts.FormatDiagnosticsHost = {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => packageRoot,
        getNewLine: () => '\n',
    };
    return ts.formatDiagnosticsWithColorAndContext([...diagnostics], host);
}

describe('public SDK authoring examples', () => {
    it('import only public @happier-dev/plugin-sdk entry points', async () => {
        const allowedSpecifiers = readPackageExportSpecifiers();
        const files = await listTypeScriptFiles(examplesRoot);
        expect(files.length).toBeGreaterThan(0);

        const violations: string[] = [];
        for (const filePath of files) {
            const sourceFile = ts.createSourceFile(
                filePath,
                readFileSync(filePath, 'utf8'),
                ts.ScriptTarget.Latest,
                true,
                ts.ScriptKind.TS,
            );
            sourceFile.forEachChild((node) => {
                if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
                    return;
                }
                const specifier = node.moduleSpecifier.text;
                if (specifier.startsWith('@happier-dev/plugin-ui')) {
                    violations.push(`${relative(packageRoot, filePath)} imports ${specifier}`);
                    return;
                }
                if (
                    specifier.startsWith('@happier-dev/plugin-sdk')
                    && !allowedSpecifiers.has(specifier)
                ) {
                    violations.push(`${relative(packageRoot, filePath)} imports ${specifier}`);
                }
            });
        }

        expect(violations).toEqual([]);
    });

    it('ships the required installable example plugin packages', () => {
        const missing: string[] = [];
        for (const exampleName of requiredExamples) {
            const root = join(examplesRoot, exampleName);
            const files = [
                'README.md',
                '.happier-plugin/plugin.json',
                'src/index.ts',
            ];
            for (const file of files) {
                try {
                    readFileSync(join(root, file), 'utf8');
                } catch {
                    missing.push(`${exampleName}/${file}`);
                }
            }
        }

        expect(missing).toEqual([]);
    });

    it('parses every example manifest with the protocol schema', () => {
        for (const exampleName of requiredExamples) {
            expect(readExampleManifest(exampleName).id).toMatch(/^examples\./u);
        }
    });

    it('parses the public authoring source manifest with the protocol schema', async () => {
        const module = await import(pathToFileURL(join(examplesRoot, 'public-authoring', 'manifest.ts')).href) as {
            manifest?: unknown;
        };
        const parsed = PluginManifestV2Schema.safeParse(module.manifest);
        const diagnostics = parsed.success
            ? ''
            : `\n${parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('\n')}`;

        expect(parsed.success, `public-authoring/manifest.ts must match the protocol manifest schema${diagnostics}`).toBe(true);
    });

    it('keeps installable RN manifests aligned with authored Host API ABI', async () => {
        const mismatches: string[] = [];

        for (const exampleName of requiredExamples) {
            const installable = readExampleManifest(exampleName);
            const authored = await readAuthoredExampleManifest(exampleName);
            for (const authoredBundle of authored.contributes.reactNativeBundles ?? []) {
                const installedBundle = installable.contributes.reactNativeBundles?.find((candidate) => (
                    candidate.id === authoredBundle.id
                ));
                if (!installedBundle) {
                    mismatches.push(`${exampleName}:${authoredBundle.id}:missing-installed-rn-bundle`);
                    continue;
                }
                expect(installedBundle.entry).toEqual(authoredBundle.entry);
                expect(installedBundle.hostApi?.methods ?? []).toEqual(authoredBundle.hostApi?.methods ?? []);
            }
        }

        expect(mismatches).toEqual([]);
    });

    it('ships artifact files for every manifest-declared installable UI asset', () => {
        const missing: string[] = [];

        for (const exampleName of requiredExamples) {
            const manifest = readExampleManifest(exampleName);
            for (const hostedWeb of manifest.contributes.hostedWeb ?? []) {
                if (hostedWeb.service.kind === 'staticAssets') {
                    assertExampleDirectoryContainsIndex(exampleName, hostedWeb.service.assetRootId, missing);
                }
            }
            for (const reactNativeBundle of manifest.contributes.reactNativeBundles ?? []) {
                const assetPath = reactNativeBundle.bundle.assetPath;
                if (assetPath) {
                    assertExampleFileExists(exampleName, assetPath, missing);
                }
            }
            for (const artifact of manifest.contributes.uiArtifacts ?? []) {
                if (artifact.assetPath && artifact.artifactKind === 'hostedWebAsset') {
                    assertExampleDirectoryContainsIndex(exampleName, artifact.assetPath, missing);
                } else if (artifact.assetPath) {
                    assertExampleFileExists(exampleName, artifact.assetPath, missing);
                }
            }
        }

        expect(missing).toEqual([]);
    });

    it('ships visible RN example bundles instead of placeholder null panels', () => {
        const placeholders: string[] = [];

        for (const exampleName of requiredExamples) {
            const manifest = readExampleManifest(exampleName);
            for (const reactNativeBundle of manifest.contributes.reactNativeBundles ?? []) {
                const assetPath = reactNativeBundle.bundle.assetPath;
                if (!assetPath) continue;
                const source = readFileSync(join(examplesRoot, exampleName, assetPath), 'utf8');
                if (/return\s+null\s*;?/u.test(source)) {
                    placeholders.push(`${exampleName}:${reactNativeBundle.id}:returns-null`);
                }
                if (!source.includes('getSurfaceContext')) {
                    placeholders.push(`${exampleName}:${reactNativeBundle.id}:does-not-exercise-host-api`);
                }
            }
        }

        expect(placeholders).toEqual([]);
    });

    it('pins installable example artifacts to real content digests while keeping dev-hot-reload unpinned', () => {
        const mismatches: string[] = [];
        const unexpectedDevDigests: string[] = [];

        for (const exampleName of requiredExamples) {
            const manifest = readExampleManifest(exampleName);
            for (const reactNativeBundle of manifest.contributes.reactNativeBundles ?? []) {
                if (reactNativeBundle.bundle.assetPath) {
                    const actualDigest = computeExampleFileDigest(exampleName, reactNativeBundle.bundle.assetPath);
                    if (reactNativeBundle.bundle.integrity?.digest !== actualDigest) {
                        mismatches.push(`${exampleName}:${reactNativeBundle.id}:bundle`);
                    }
                } else if (
                    reactNativeBundle.bundle.channel === 'development'
                    && reactNativeBundle.bundle.integrity !== undefined
                ) {
                    unexpectedDevDigests.push(`${exampleName}:${reactNativeBundle.id}:bundle`);
                }
            }

            for (const artifact of manifest.contributes.uiArtifacts ?? []) {
                if (artifact.devUrl) {
                    if (artifact.integrity !== undefined) {
                        unexpectedDevDigests.push(`${exampleName}:${artifact.id}:artifact`);
                    }
                    continue;
                }
                if (!artifact.assetPath) {
                    continue;
                }
                const actualDigest = artifact.artifactKind === 'hostedWebAsset'
                    ? computeExampleDirectoryDigest(exampleName, artifact.assetPath)
                    : computeExampleFileDigest(exampleName, artifact.assetPath);
                if (artifact.integrity?.digest !== actualDigest) {
                    mismatches.push(`${exampleName}:${artifact.id}:artifact`);
                }
            }
        }

        expect(mismatches).toEqual([]);
        expect(unexpectedDevDigests).toEqual([]);
    });

    it('typechecks copied examples outside the workspace through package exports only', () => {
        const copiedRoot = copyExamplesOutsideWorkspace();
        try {
            const configFile = {
                config: {
                    compilerOptions: {
                        target: 'ES2022',
                        module: 'ESNext',
                        moduleResolution: 'Bundler',
                        lib: ['ES2022', 'DOM'],
                        strict: true,
                        skipLibCheck: true,
                        noEmit: true,
                    },
                    include: ['**/*.ts'],
                    exclude: ['node_modules'],
                },
            };
            const parsedConfig = ts.parseJsonConfigFileContent(
                configFile.config,
                ts.sys,
                copiedRoot,
            );
            expect(parsedConfig.errors).toEqual([]);
            expect(parsedConfig.fileNames.length).toBeGreaterThan(0);

            const program = ts.createProgram({
                rootNames: parsedConfig.fileNames,
                options: parsedConfig.options,
            });
            const diagnostics = ts.getPreEmitDiagnostics(program);
            expect(formatDiagnostics(diagnostics)).toBe('');
        } finally {
            rmSync(copiedRoot, { recursive: true, force: true });
        }
    }, 20_000);
});
