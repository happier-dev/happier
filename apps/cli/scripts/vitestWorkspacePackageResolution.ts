import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

type WorkspacePackageSpec = Readonly<{
  packageName: string;
  packageSourceRoot: string;
  sourceSubpathAliases?: Readonly<Record<string, string>>;
  sourceFileAliases?: Readonly<Record<string, string>>;
}>;

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
  { packageName: '@happier-dev/agents', packageSourceRoot: resolve('../../packages/agents/src') },
  {
    packageName: '@happier-dev/cli-common',
    packageSourceRoot: resolve('../../packages/cli-common/src'),
    sourceFileAliases: {
      cliDistBuildManifest: resolve('../../packages/cli-common/cliDistBuildManifest.cjs'),
      processInstance: resolve('../../packages/cli-common/processInstance.mjs'),
      runtimeImportProbePolicy: resolve('../../packages/cli-common/runtimeImportProbePolicy.mjs'),
    },
  },
  { packageName: '@happier-dev/connection-supervisor', packageSourceRoot: resolve('../../packages/connection-supervisor/src') },
  { packageName: '@happier-dev/release-runtime', packageSourceRoot: resolve('../../packages/release-runtime/src') },
  { packageName: '@happier-dev/transfers', packageSourceRoot: resolve('../../packages/transfers/src') },
] as const;

function resolveWorkspacePackageSource(id: string, spec: WorkspacePackageSpec): string | null {
  if (id === spec.packageName) return resolve(spec.packageSourceRoot, 'index.ts');
  if (!id.startsWith(`${spec.packageName}/`)) return null;
  const subpath = id.slice(spec.packageName.length + 1);
  const fileAlias = spec.sourceFileAliases?.[subpath];
  if (fileAlias) return fileAlias;
  const sourceSubpath = spec.sourceSubpathAliases?.[subpath] ?? subpath;
  return [
    resolve(spec.packageSourceRoot, `${sourceSubpath}.ts`),
    resolve(spec.packageSourceRoot, `${sourceSubpath}.tsx`),
    resolve(spec.packageSourceRoot, sourceSubpath, 'index.ts'),
    resolve(spec.packageSourceRoot, sourceSubpath, 'index.tsx'),
  ].find((candidate) => existsSync(candidate)) ?? null;
}

export const workspacePackageAliases = workspacePackages.flatMap((spec) => [
  ...Object.entries(spec.sourceFileAliases ?? {}).map(([subpath, replacement]) => ({
    find: `${spec.packageName}/${subpath}`,
    replacement,
  })),
  ...Object.entries(spec.sourceSubpathAliases ?? {}).flatMap(([subpath, sourceSubpath]) => {
    const replacement = resolve(spec.packageSourceRoot, sourceSubpath);
    const hasSourceTarget = [
      `${replacement}.ts`,
      `${replacement}.tsx`,
      resolve(replacement, 'index.ts'),
      resolve(replacement, 'index.tsx'),
    ].some((candidate) => existsSync(candidate));
    return hasSourceTarget
      ? [{ find: `${spec.packageName}/${subpath}`, replacement }]
      : [];
  }),
  { find: spec.packageName, replacement: spec.packageSourceRoot },
]);

export const workspacePackageOptimizationExcludes = workspacePackages.map((spec) => spec.packageName);

export const workspacePackageSourcesPlugin = {
  name: 'happier-vitest-workspace-package-sources',
  enforce: 'pre' as const,
  resolveId(id: string) {
    for (const spec of workspacePackages) {
      const resolved = resolveWorkspacePackageSource(id, spec);
      if (resolved) return resolved;
    }
    return null;
  },
};
