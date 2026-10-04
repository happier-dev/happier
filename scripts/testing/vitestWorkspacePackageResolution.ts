import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import {
    pluginPackageNameToPackageId,
    readBundledPluginPackageNames,
} from '../../apps/cli/scripts/build-owned/bundledPluginMembership.ts';

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
type WorkspacePackageMappings = Readonly<{ exports: PackageExportsRecord | null; imports: PackageExportsRecord | null }>;

const packageMappingsBySourceRoot = new Map<string, WorkspacePackageMappings>();

function readWorkspacePackageMappings(packageSourceRoot: string): WorkspacePackageMappings {
    const cached = packageMappingsBySourceRoot.get(packageSourceRoot);
    if (cached !== undefined) {
        return cached;
    }

    const packageJsonPath = resolve(packageSourceRoot, '..', 'package.json');
    let mappings: WorkspacePackageMappings = { exports: null, imports: null };

    try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { exports?: unknown; imports?: unknown };
        const readRecord = (value: unknown): PackageExportsRecord | null => value && typeof value === 'object' && !Array.isArray(value)
            ? value as PackageExportsRecord : null;
        mappings = { exports: readRecord(packageJson.exports), imports: readRecord(packageJson.imports) };
    } catch {
        // Unreadable manifests have no source mappings; let the ordinary resolver decide.
    }

    packageMappingsBySourceRoot.set(packageSourceRoot, mappings);
    return mappings;
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
    if (!targetPath?.startsWith('./')) {
        return null;
    }

    if (!targetPath.startsWith('./dist/') || !/\.[cm]?js$/.test(targetPath)) {
        const packageRoot = resolve(packageSourceRoot, '..');
        const authoredTarget = resolve(packageRoot, targetPath);
        return isPathInsideDirectory(authoredTarget, packageRoot) && existsSync(authoredTarget)
            ? authoredTarget
            : null;
    }

    const sourceRelativePath = targetPath.slice('./dist/'.length).replace(/\.[cm]?js$/, '');
    const candidates = [
        ...(sourceRelativePath === 'index' || sourceRelativePath.endsWith('/index')
            ? [
                resolve(packageSourceRoot, `${sourceRelativePath}.public.ts`),
                resolve(packageSourceRoot, `${sourceRelativePath}.public.tsx`),
            ]
            : []),
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
    const exportsRecord = readWorkspacePackageMappings(packageSourceRoot).exports;
    if (!exportsRecord) {
        return null;
    }

    // A root conditional object is the package's "." export, not a subpath map.
    const target = subpathSpecifier === '.' && !Object.keys(exportsRecord).some((key) => key.startsWith('.'))
        ? exportsRecord
        : exportsRecord[subpathSpecifier];
    return resolveExportTargetSource(packageSourceRoot, target, options);
}

export function resolveWorkspacePackageSource(
    id: string,
    packageName: string,
    packageSourceRoot: string,
    options: WorkspacePackageSourceResolutionOptions = {},
): string | null {
    if (id === packageName) {
        return resolveWorkspacePackageExportSource('.', packageSourceRoot, options);
    }

    if (!id.startsWith(`${packageName}/`)) {
        return null;
    }

    const subpath = id.slice(packageName.length + 1);
    return resolveWorkspacePackageExportSource(`./${subpath}`, packageSourceRoot, options);
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
            if (id.startsWith('#') && importer) {
                const owningWorkspace = workspacePackages.find((workspacePackage) =>
                    isPathInsideDirectory(stripQueryAndHash(importer), workspacePackage.packageSourceRoot),
                );
                if (!owningWorkspace) return null;
                const imports = readWorkspacePackageMappings(owningWorkspace.packageSourceRoot).imports;
                return resolveExportTargetSource(owningWorkspace.packageSourceRoot, imports?.[id], options);
            }
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
