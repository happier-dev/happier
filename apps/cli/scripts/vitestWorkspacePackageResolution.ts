import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

type WorkspacePackageSpec = Readonly<{
    packageName: string;
    packageSourceRoot: string;
}>;

const workspacePackages: readonly WorkspacePackageSpec[] = [
    {
        packageName: '@happier-dev/protocol',
        packageSourceRoot: resolve('../../packages/protocol/src'),
    },
    {
        packageName: '@happier-dev/agents',
        packageSourceRoot: resolve('../../packages/agents/src'),
    },
    {
        packageName: '@happier-dev/cli-common',
        packageSourceRoot: resolve('../../packages/cli-common/src'),
    },
    {
        packageName: '@happier-dev/connection-supervisor',
        packageSourceRoot: resolve('../../packages/connection-supervisor/src'),
    },
    {
        packageName: '@happier-dev/release-runtime',
        packageSourceRoot: resolve('../../packages/release-runtime/src'),
    },
    {
        packageName: '@happier-dev/transfers',
        packageSourceRoot: resolve('../../packages/transfers/src'),
    },
    {
        packageName: '@happier-dev/plugins-claude',
        packageSourceRoot: resolve('../../packages/plugins/claude/src'),
    },
    {
        packageName: '@happier-dev/plugins-codex',
        packageSourceRoot: resolve('../../packages/plugins/codex/src'),
    },
] as const;

function resolveWorkspacePackageSource(
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

export const workspacePackageAliases = workspacePackages.map((workspacePackage) => ({
    find: workspacePackage.packageName,
    replacement: workspacePackage.packageSourceRoot,
}));

export const workspacePackageOptimizationExcludes = workspacePackages.map((workspacePackage) => workspacePackage.packageName);

export const workspacePackageSourcesPlugin = {
    name: 'happier-vitest-workspace-package-sources',
    enforce: 'pre' as const,
    resolveId(id: string) {
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

        return null;
    },
};
