import type { InstallablesRegistry } from '@happier-dev/protocol';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

type ResolveSpawnHookInstallablesRegistryDeps = Readonly<{
  contributions?: ResolvedContributionRegistry;
  resolveMergedContributionRegistry?: typeof import(
    '@/plugins/projection/registry/createResolvedContributionRegistry'
  ).resolveMergedContributionRegistry;
}>;

export async function resolveSpawnHookInstallablesRegistry(
  happyHomeDir: string | undefined,
  deps: ResolveSpawnHookInstallablesRegistryDeps = {},
): Promise<InstallablesRegistry | undefined> {
  if (!happyHomeDir || !deps.contributions) return undefined;
  const { createPluginExecInstallablesRegistry } = await import(
    '@/agent/runtime/registry/engineRegistry/contributions'
  );
  return createPluginExecInstallablesRegistry(deps.contributions);
}
