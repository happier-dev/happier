import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

type WorkspacePackageSpec = Readonly<{
    packageName: string;
    packageSourceRoot: string;
    sourceSubpathAliases?: Readonly<Record<string, string>>;
}>;

const workspacePackages: readonly WorkspacePackageSpec[] = [
    {
        packageName: '@happier-dev/protocol',
        packageSourceRoot: resolve('../../packages/protocol/src'),
        sourceSubpathAliases: {
            installablesPolicy: 'installables/policy',
            rpcErrors: 'rpc/errors',
            socketRpc: 'rpc/socket',
            spawnSession: 'sessions/spawnSession',
            transferRelayV2: 'transfers/relay/v2',
            transferSessions: 'transfers/sessions',
        },
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
    {
        packageName: '@happier-dev/plugins-ohmypi',
        packageSourceRoot: resolve('../../packages/plugins/ohmypi/src'),
    },
] as const;

function resolveWorkspacePackageSource(
    id: string,
    workspacePackage: WorkspacePackageSpec,
): string | null {
    const { packageName, packageSourceRoot } = workspacePackage;
    if (id === packageName) {
        return resolve(packageSourceRoot, 'index.ts');
    }

    if (!id.startsWith(`${packageName}/`)) {
        return null;
    }

    const subpath = id.slice(packageName.length + 1);
    const sourceSubpath = workspacePackage.sourceSubpathAliases?.[subpath] ?? subpath;
    const candidates = [
        resolve(packageSourceRoot, `${sourceSubpath}.ts`),
        resolve(packageSourceRoot, `${sourceSubpath}.tsx`),
        resolve(packageSourceRoot, sourceSubpath, 'index.ts'),
        resolve(packageSourceRoot, sourceSubpath, 'index.tsx'),
    ];

    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export const workspacePackageAliases = workspacePackages.flatMap((workspacePackage) => [
    ...Object.entries(workspacePackage.sourceSubpathAliases ?? {}).map(([publicSubpath, sourceSubpath]) => ({
        find: `${workspacePackage.packageName}/${publicSubpath}`,
        replacement: resolve(workspacePackage.packageSourceRoot, sourceSubpath),
    })),
    {
        find: workspacePackage.packageName,
        replacement: workspacePackage.packageSourceRoot,
    },
]);

export const workspacePackageOptimizationExcludes = workspacePackages.map((workspacePackage) => workspacePackage.packageName);

export const workspacePackageSourcesPlugin = {
    name: 'happier-vitest-workspace-package-sources',
    enforce: 'pre' as const,
    resolveId(id: string) {
        for (const workspacePackage of workspacePackages) {
            const resolved = resolveWorkspacePackageSource(
                id,
                workspacePackage,
            );

            if (resolved !== null) {
                return resolved;
            }
        }

        return null;
    },
};
