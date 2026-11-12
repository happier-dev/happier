import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { Alias } from 'vite';
import { fileURLToPath } from 'node:url';
import packageExportMatch from '../../packages/cli-common/packageExportMatch.cjs';

import {
    pluginPackageNameToPackageId,
    readBundledPluginPackageNames,
} from '../../apps/cli/scripts/build-owned/bundledPluginMembership.js';

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

/** The host's declared workspace closure, using the same source roots as its bundled plugins. */
export function readHostWorkspacePackageSpecs(
    repoRoot: string,
    hostRoot: string,
    additionalPackages: readonly WorkspacePackageSpec[] = [],
): readonly WorkspacePackageSpec[] {
    const firstPartyPrefix = '@happier-dev/';
    const pluginPrefix = `${firstPartyPrefix}plugins-`;
    const hostManifest = JSON.parse(readFileSync(resolve(hostRoot, 'package.json'), 'utf8')) as Readonly<{
        dependencies?: Readonly<Record<string, unknown>>;
        devDependencies?: Readonly<Record<string, unknown>>;
    }>;
    const workspacePackages = new Map<string, WorkspacePackageSpec>();
    const addWorkspacePackage = (workspacePackage: WorkspacePackageSpec): void => {
        const existing = workspacePackages.get(workspacePackage.packageName);
        if (existing && existing.packageSourceRoot !== workspacePackage.packageSourceRoot) {
            throw new Error(`Conflicting source roots for ${workspacePackage.packageName}: `
                + `${existing.packageSourceRoot} and ${workspacePackage.packageSourceRoot}`);
        }
        workspacePackages.set(workspacePackage.packageName, workspacePackage);
    };
    const packageSpec = (packageName: string, owner: string): WorkspacePackageSpec => {
        const packageRoot = packageName.startsWith(pluginPrefix)
            ? resolve(repoRoot, 'packages', 'plugins', packageName.slice(pluginPrefix.length))
            : resolve(repoRoot, 'packages', packageName.slice(firstPartyPrefix.length));
        const packageSourceRoot = resolve(packageRoot, 'src');
        if (!existsSync(packageSourceRoot)) {
            throw new Error(`Missing source root for ${owner} workspace dependency ${packageName}: ${packageSourceRoot}`);
        }
        return { packageName, packageSourceRoot };
    };

    for (const packageName of Object.keys(hostManifest.dependencies ?? {}).sort()) {
        if (!packageName.startsWith(firstPartyPrefix) || packageName.startsWith(pluginPrefix)) continue;
        addWorkspacePackage(packageSpec(packageName, hostRoot));
    }
    for (const workspacePackage of additionalPackages) addWorkspacePackage(workspacePackage);
    for (const workspacePackage of readBundledPluginWorkspacePackageSpecs(repoRoot)) addWorkspacePackage(workspacePackage);
    // Public plugin test dependencies need not join the shipped bundle.
    for (const packageName of Object.keys(hostManifest.devDependencies ?? {}).sort()) {
        if (packageName.startsWith(pluginPrefix)) addWorkspacePackage(packageSpec(packageName, hostRoot));
    }

    return readWorkspacePackageSourceClosure(repoRoot, [...workspacePackages.values()]);
}

/** Complete every source graph at the resolver owner, including transitive imports. */
function readWorkspacePackageSourceClosure(
    repoRoot: string,
    seeds: readonly WorkspacePackageSpec[],
): readonly WorkspacePackageSpec[] {
    const workspacePackages = new Map(seeds.map(spec => [spec.packageName, spec]));
    const pending = [...workspacePackages.values()];
    for (let index = 0; index < pending.length; index += 1) {
        const owner = pending[index]!;
        const manifest = JSON.parse(readFileSync(resolve(owner.packageSourceRoot, '..', 'package.json'), 'utf8')) as Readonly<{
            dependencies?: Readonly<Record<string, unknown>>;
        }>;
        for (const packageName of Object.keys(manifest.dependencies ?? {}).sort()) {
            if (!packageName.startsWith('@happier-dev/') || workspacePackages.has(packageName)) continue;
            const packageId = packageName.slice('@happier-dev/'.length);
            const packageSourceRoot = resolve(repoRoot, 'packages',
                packageId.startsWith('plugins-') ? `plugins/${packageId.slice('plugins-'.length)}` : packageId, 'src');
            if (!existsSync(packageSourceRoot)) {
                throw new Error(`Missing source root for ${owner.packageName} workspace dependency ${packageName}: ${packageSourceRoot}`);
            }
            const dependency = { packageName, packageSourceRoot };
            workspacePackages.set(packageName, dependency);
            pending.push(dependency);
        }
    }
    return [...workspacePackages.values()].sort((left, right) => left.packageName.localeCompare(right.packageName));
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

/** Compose real host sources while retaining each importer's package-local @ alias. */
export function createWorkspaceHostSourceAlias(repoRoot: string, defaultSourceRoot: string): Alias {
    const hostSourceRoots = [
        resolve(repoRoot, 'apps/ui/sources'),
        resolve(repoRoot, 'apps/cli/src'),
        resolve(repoRoot, 'apps/server/sources'),
    ];
    return {
        find: '@',
        replacement: '@',
        async customResolver(id, importer, options) {
            const importerPath = importer ? stripQueryAndHash(importer) : null;
            const root = importerPath
                ? hostSourceRoots.find((sourceRoot) => isPathInsideDirectory(importerPath, sourceRoot)) ?? defaultSourceRoot
                : defaultSourceRoot;
            const target = resolve(root, id.slice('@/'.length));
            const resolved = await this.resolve(target, importer, { ...options, skipSelf: true });
            return resolved ?? { id: target };
        },
    };
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
    replacement?: string,
): string | null {
    const conditionalTarget = readConditionalExportTarget(target, options.exportConditions ?? []);
    const targetPath = replacement === undefined ? conditionalTarget : conditionalTarget?.replaceAll('*', replacement) ?? null;
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

    // The repository's one Node-precedence matcher (root conditional object, exact key, `*` patterns).
    const match = packageExportMatch.matchPackageExport(exportsRecord, subpathSpecifier);
    return match ? resolveExportTargetSource(packageSourceRoot, match.declaration, options, match.replacement) : null;
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
    workspacePackages = readWorkspacePackageSourceClosure(fileURLToPath(new URL('../../', import.meta.url)), workspacePackages);
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
