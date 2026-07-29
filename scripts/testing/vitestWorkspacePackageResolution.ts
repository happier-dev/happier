import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import {
    pluginPackageNameToPackageId,
    readBundledPluginPackageNames,
} from '../migrations/extensions/bundledPluginMembership.ts';

export type WorkspacePackageSpec = Readonly<{
    packageName: string;
    packageSourceRoot: string;
}>;

export type WorkspacePackageSourceResolutionOptions = Readonly<{
    exportConditions?: readonly string[];
}>;

export function readBundledPluginWorkspacePackageSpecs(repoRoot: string): readonly WorkspacePackageSpec[] {
    return readBundledPluginPackageNames(repoRoot).map((packageName) => Object.freeze({
        packageName,
        packageSourceRoot: resolve(
            repoRoot,
            'packages',
            'plugins',
            pluginPackageNameToPackageId(packageName),
            'src',
        ),
    }));
}

function stripQueryAndHash(value: string): string {
    return value.replace(/[?#].*$/, '');
}

function isRelativeImport(id: string): boolean {
    return id.startsWith('./') || id.startsWith('../');
}

function isPathInsideDirectory(filePath: string, directoryPath: string): boolean {
    const relativePath = relative(directoryPath, filePath);
    return relativePath === '' || (!relativePath.startsWith('..') && relativePath !== '..');
}

type PackageExportsRecord = Record<string, unknown>;

const packageExportsBySourceRoot = new Map<string, PackageExportsRecord | null>();

function readWorkspacePackageExports(packageSourceRoot: string): PackageExportsRecord | null {
    const cached = packageExportsBySourceRoot.get(packageSourceRoot);
    if (cached !== undefined) {
        return cached;
    }

    const packageJsonPath = resolve(packageSourceRoot, '..', 'package.json');
    let exportsRecord: PackageExportsRecord | null = null;

    try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { exports?: unknown };
        exportsRecord = packageJson.exports && typeof packageJson.exports === 'object' && !Array.isArray(packageJson.exports)
            ? packageJson.exports as PackageExportsRecord
            : null;
    } catch {
        exportsRecord = null;
    }

    packageExportsBySourceRoot.set(packageSourceRoot, exportsRecord);
    return exportsRecord;
}

function readConditionalExportTarget(
    target: unknown,
    exportConditions: readonly string[],
): string | null {
    const targetPath = typeof target === 'string'
        ? target
        : target && typeof target === 'object' && !Array.isArray(target)
            ? [
                ...exportConditions,
                'default',
                'import',
            ].reduce<string | null>((resolvedTarget, condition) => {
                if (resolvedTarget !== null) return resolvedTarget;
                return readConditionalExportTarget(
                    (target as Record<string, unknown>)[condition],
                    exportConditions,
                );
            }, null)
            : null;

    return targetPath;
}

function resolveExportTargetSource(
    packageSourceRoot: string,
    target: unknown,
    options: WorkspacePackageSourceResolutionOptions,
): string | null {
    const targetPath = readConditionalExportTarget(target, options.exportConditions ?? []);
    if (!targetPath?.startsWith('./dist/') || !targetPath.endsWith('.js')) {
        return null;
    }

    const sourceRelativePath = targetPath.slice('./dist/'.length).replace(/\.js$/, '');
    const candidates = [
        resolve(packageSourceRoot, `${sourceRelativePath}.ts`),
        resolve(packageSourceRoot, `${sourceRelativePath}.tsx`),
    ];

    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveWorkspacePackageExportSource(
    subpathSpecifier: string,
    packageSourceRoot: string,
    options: WorkspacePackageSourceResolutionOptions,
): string | null {
    const exportsRecord = readWorkspacePackageExports(packageSourceRoot);
    if (!exportsRecord) {
        return null;
    }

    return resolveExportTargetSource(packageSourceRoot, exportsRecord[subpathSpecifier], options);
}

export function resolveWorkspacePackageSource(
    id: string,
    packageName: string,
    packageSourceRoot: string,
    options: WorkspacePackageSourceResolutionOptions = {},
): string | null {
    if (id === packageName) {
        return resolveWorkspacePackageExportSource('.', packageSourceRoot, options)
            ?? resolve(packageSourceRoot, 'index.ts');
    }

    if (!id.startsWith(`${packageName}/`)) {
        return null;
    }

    const subpath = id.slice(packageName.length + 1);
    const exportedSource = resolveWorkspacePackageExportSource(`./${subpath}`, packageSourceRoot, options);
    if (exportedSource !== null) {
        return exportedSource;
    }

    const candidates = [
        resolve(packageSourceRoot, `${subpath}.ts`),
        resolve(packageSourceRoot, `${subpath}.tsx`),
        resolve(packageSourceRoot, subpath, 'index.ts'),
        resolve(packageSourceRoot, subpath, 'index.tsx'),
    ];

    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function resolveRelativeWorkspaceSource(
    id: string,
    importer: string | undefined,
    workspacePackages: readonly WorkspacePackageSpec[],
): string | null {
    if (!importer || !isRelativeImport(id)) {
        return null;
    }

    const importerPath = stripQueryAndHash(importer);
    const owningWorkspace = workspacePackages.find((workspacePackage) =>
        isPathInsideDirectory(importerPath, workspacePackage.packageSourceRoot),
    );

    if (!owningWorkspace) {
        return null;
    }

    const requestedPath = resolve(dirname(importerPath), stripQueryAndHash(id));
    const candidates = id.endsWith('.js')
        ? [
            requestedPath.replace(/\.js$/, '.ts'),
            requestedPath.replace(/\.js$/, '.tsx'),
        ]
        : [
            `${requestedPath}.ts`,
            `${requestedPath}.tsx`,
            resolve(requestedPath, 'index.ts'),
            resolve(requestedPath, 'index.tsx'),
        ];

    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function createWorkspacePackageSourcesPlugin(
    workspacePackages: readonly WorkspacePackageSpec[],
    name = 'happier-vitest-workspace-package-sources',
    options: WorkspacePackageSourceResolutionOptions = {},
) {
    return {
        name,
        enforce: 'pre' as const,
        resolveId(id: string, importer?: string) {
            for (const workspacePackage of workspacePackages) {
                const resolved = resolveWorkspacePackageSource(
                    id,
                    workspacePackage.packageName,
                    workspacePackage.packageSourceRoot,
                    options,
                );

                if (resolved !== null) {
                    return resolved;
                }
            }

            return resolveRelativeWorkspaceSource(id, importer, workspacePackages);
        },
    };
}
