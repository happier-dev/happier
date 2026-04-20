import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export type WorkspacePackageSpec = Readonly<{
    packageName: string;
    packageSourceRoot: string;
}>;

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

export function resolveWorkspacePackageSource(
    id: string,
    packageName: string,
    packageSourceRoot: string,
): string | null {
    if (id === packageName) {
        return resolve(packageSourceRoot, 'index.ts');
    }

    if (!id.startsWith(`${packageName}/`)) {
        return null;
    }

    const subpath = id.slice(packageName.length + 1);
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
                );

                if (resolved !== null) {
                    return resolved;
                }
            }

            return resolveRelativeWorkspaceSource(id, importer, workspacePackages);
        },
    };
}
