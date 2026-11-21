import { normalizePluginGitRepositoryUrl, type PluginGitCatalogPointerV1, type PluginGitInstallSource, type PluginGitSourceV1 } from '@happier-dev/protocol/plugins/source-spec';
import { RegistryFetchErrorV1, type RegistryItemSummaryV1 } from '@happier-dev/protocol/registries';

import { createRegistryGitProtocolV1 } from '@/registries/gitProtocol';
import type { createMarketplaceIndexService } from '@/plugins/store/marketplace/service';
import { resolvePluginGitRelease } from './gitRelease';
import { resolveLocalPathPluginSource, type ResolvedLocalPathPluginSource } from './localPath';

/** Resolve once at use time and hand the temporary checkout to the existing manifest admission owner. */
export async function withResolvedGitPluginSource<T>(selection: PluginGitInstallSource, options: Readonly<{
  signal?: AbortSignal;
  readCatalogPointer?: ReturnType<typeof createMarketplaceIndexService>['readGitPluginPointer'];
}>,
  consume: (input: Readonly<{
    resolved: ResolvedLocalPathPluginSource;
    source: PluginGitSourceV1;
    commit: string;
    releaseTag?: string;
    catalog?: PluginGitCatalogPointerV1;
  }>) => Promise<T>,
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
      ...(release ? { releaseTag: release } : {}),
      ...(catalog ? { catalog } : {}),
    });
  });
}

export async function previewGitPluginSource(source: PluginGitSourceV1, signal?: AbortSignal) {
  try {
    return await withResolvedGitPluginSource({ ...source, kind: 'git' }, { signal }, async acquisition => {
      const { resolved, source, commit, releaseTag } = acquisition;
      if (!resolved.ok) return { ok: false as const, errorCode: 'invalid_source', error: 'invalid_source' };
      const { manifest, vendorContent } = resolved;
      const summary: RegistryItemSummaryV1 = {
        kind: 'plugin',
        sourceId: 'git-preview',
        itemId: manifest.id,
        title: manifest.displayName,
        description: manifest.description,
        version: manifest.version,
        links: { repository: source.locator },
        vendorPlugin: {
          contentCounts: vendorContent?.contentCounts ?? {
            skills: manifest.contributes.skills.length,
            commands: 0,
            agents: 0,
            mcpServers: manifest.contributes.mcp.servers.length,
          },
          ...(vendorContent ? { notImported: vendorContent.notImported } : {}),
        },
      };
      return {
        ok: true as const,
        source,
        resolvedCommit: commit,
        release: releaseTag ? { kind: 'stableRelease' as const, tag: releaseTag } : { kind: 'defaultBranch' as const },
        summary,
      };
    });
  } catch (error) {
    if (!(error instanceof RegistryFetchErrorV1)) throw error;
    return { ok: false as const, errorCode: error.status.state, error: error.status.state };
  }
}
