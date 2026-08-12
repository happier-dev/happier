import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

type WorkspacePackageSpec = Readonly<{
    packageName: string;
    packageSourceRoot: string;
    sourceSubpathAliases?: Readonly<Record<string, string>>;
    sourceFileAliases?: Readonly<Record<string, string>>;
}>;

const firstPartyAgentPluginPackages = [
    ['@happier-dev/plugins-antigravity', 'antigravity'],
    ['@happier-dev/plugins-auggie', 'auggie'],
    ['@happier-dev/plugins-claude', 'claude'],
    ['@happier-dev/plugins-codex', 'codex'],
    ['@happier-dev/plugins-copilot', 'copilot'],
    ['@happier-dev/plugins-cursor', 'cursor'],
    ['@happier-dev/plugins-gemini', 'gemini'],
    ['@happier-dev/plugins-grok', 'grok'],
    ['@happier-dev/plugins-kilo', 'kilo'],
    ['@happier-dev/plugins-kimi', 'kimi'],
    ['@happier-dev/plugins-kiro', 'kiro'],
    ['@happier-dev/plugins-ohmypi', 'ohmypi'],
    ['@happier-dev/plugins-opencode', 'opencode'],
    ['@happier-dev/plugins-pi', 'pi'],
    ['@happier-dev/plugins-qwen', 'qwen'],
    ['@happier-dev/plugins-review-coderabbit', 'review-coderabbit'],
    ['@happier-dev/plugins-review-deepsec', 'review-deepsec'],
] as const;

const workspacePackages: readonly WorkspacePackageSpec[] = [
    {
        packageName: '@happier-dev/protocol',
        packageSourceRoot: resolve('../../packages/protocol/src'),
        sourceSubpathAliases: {
            installablesPolicy: 'installables/policy',
            'plugins/hooks': 'plugins/hooks/catalog',
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
        sourceSubpathAliases: {
            'providers/claude-model-options': 'providers/claudeModelOptions',
        },
    },
    {
        packageName: '@happier-dev/cli-common',
        packageSourceRoot: resolve('../../packages/cli-common/src'),
        sourceFileAliases: {
            cliDistBuildManifest: resolve('../../packages/cli-common/cliDistBuildManifest.cjs'),
        },
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
    ...firstPartyAgentPluginPackages.map(([packageName, pluginDirectory]) => ({
        packageName,
        packageSourceRoot: resolve(`../../packages/plugins/${pluginDirectory}/src`),
    })),
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
    const sourceFileAlias = workspacePackage.sourceFileAliases?.[subpath];
    if (sourceFileAlias) return sourceFileAlias;
    const sourceSubpath = workspacePackage.sourceSubpathAliases?.[subpath] ?? subpath;
    const candidates = [
        resolve(packageSourceRoot, `${sourceSubpath}.ts`),
        resolve(packageSourceRoot, `${sourceSubpath}.tsx`),
        resolve(packageSourceRoot, sourceSubpath, 'index.ts'),
        resolve(packageSourceRoot, sourceSubpath, 'index.tsx'),
    ];

    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export const workspacePackageAliases = [
    {
        find: '@happier-dev/plugin-sdk/internal/fs/json-owner-file-lock',
        replacement: resolve('../../packages/plugin-sdk/src/internal/fs/jsonOwnerFileLock.ts'),
    },
    ...workspacePackages.flatMap((workspacePackage) => [
        ...Object.entries(workspacePackage.sourceFileAliases ?? {}).map(([publicSubpath, sourceFile]) => ({
            find: `${workspacePackage.packageName}/${publicSubpath}`,
            replacement: sourceFile,
        })),
        ...Object.entries(workspacePackage.sourceSubpathAliases ?? {}).map(([publicSubpath, sourceSubpath]) => ({
            find: `${workspacePackage.packageName}/${publicSubpath}`,
            replacement: resolve(workspacePackage.packageSourceRoot, sourceSubpath),
        })),
        {
            find: workspacePackage.packageName,
            replacement: workspacePackage.packageSourceRoot,
        },
    ]),
];

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
