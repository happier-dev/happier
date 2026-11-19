import { normalizePluginGitRepositoryUrl, type PluginGitCatalogPointerV1, type PluginGitInstallSource, type PluginGitSourceV1 } from '@happier-dev/protocol/plugins/source-spec';
import { RegistryFetchErrorV1 } from '@happier-dev/protocol/registries';

import { createRegistryGitProtocolV1 } from '@/registries/gitProtocol';
import type { createMarketplaceIndexService } from '@/plugins/store/marketplace/service';
import { resolvePluginGitRelease } from './gitRelease';
import { resolveLocalPathPluginSource, type ResolvedLocalPathPluginSource } from './localPath';

/** Resolve once at use time and hand the temporary checkout to the existing manifest admission owner. */
export async function withResolvedGitPluginSource<T>(selection: PluginGitInstallSource, options: Readonly<{
  signal?: AbortSignal;
  readCatalogPointer?: ReturnType<typeof createMarketplaceIndexService>['readGitPluginPointer'];
}>,
  consume: (input: Readonly<{ resolved: ResolvedLocalPathPluginSource; source: PluginGitSourceV1; commit: string; catalog?: PluginGitCatalogPointerV1 }>) => Promise<T>,
): Promise<T> {
  const catalog = selection.kind === 'gitCatalog' ? { sourceId: selection.sourceId, itemId: selection.itemId } : undefined;
  const target = selection.kind === 'gitCatalog' ? await options.readCatalogPointer?.(selection) : selection;
  if (!target) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const locator = normalizePluginGitRepositoryUrl(target.locator);
  if (!locator) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const { subdirectory } = target;
  const release = selection.kind === 'git' ? await resolvePluginGitRelease(locator, { signal: options.signal }) : undefined;
  const ref = release ? `refs/tags/${release}` : 'ref' in target ? target.ref : undefined;
  return createRegistryGitProtocolV1({ signal: options.signal }).withCheckout({
    id: locator, title: locator, url: locator, format: 'git', kinds: ['plugin'], enabled: true, addedAt: 0, ref,
  }, subdirectory, async checkout => {
    const resolved = await resolveLocalPathPluginSource({ locator: checkout.sourceRootPath,
      installedSourceKind: 'git', vendorIdentity: JSON.stringify([locator, subdirectory ?? null]) });
    return consume({
      resolved, source: { locator, ...(subdirectory ? { subdirectory } : {}) }, commit: checkout.commit,
      ...(catalog ? { catalog } : {}),
    });
  });
}
