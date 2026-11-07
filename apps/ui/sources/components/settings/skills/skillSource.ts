import type { SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { CapabilitySource } from '@/components/capabilities/facts/CapabilityFacts';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { RegistryItemSummaryV1, RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';

/** Index the catalog once; row adapters receive only their own displayed source name. */
export function createSkillSourceNameResolver(sources: readonly (Pick<RegistrySourceDescriptorV1, 'id' | 'title'> & { readonly url?: string })[]) {
  const byId = new Map(sources.map(source => [source.id, source.title]));
  const byUrl = new Map(sources.flatMap(source => source.url === undefined ? [] : [[source.url, source.title] as const]));
  return (item: Pick<SkillListItemV1, 'provenance'> | Pick<RegistryItemSummaryV1, 'sourceId'>): string | undefined => {
    if ('sourceId' in item) return byId.get(item.sourceId);
    const provenance = item.provenance;
    if (provenance.kind === 'registry') return byId.get(provenance.registry.sourceId)
      ?? (provenance.registry.sourceUrl === undefined ? undefined : byUrl.get(provenance.registry.sourceUrl));
    if (provenance.kind === 'wellKnown') return byUrl.get(provenance.indexUrl);
    if (provenance.kind === 'link' && provenance.ref.kind === 'wellKnown') return byUrl.get(provenance.ref.indexUrl);
    return undefined;
  };
}

/** Where a skill came from, using held presentation facts only. */
export function skillSource(
  item: Pick<SkillListItemV1, 'provenance'>,
  machineName: (machineId: string) => string,
  installedPlugins?: PluginUiProjectionModel['installedPackagesById'] | null,
  registrySourceName?: string,
): CapabilitySource | undefined {
  const provenance = item.provenance;
  if (registrySourceName?.trim() && (provenance.kind === 'registry' || provenance.kind === 'wellKnown' || provenance.kind === 'link')) {
    return { kind: 'registry', label: registrySourceName };
  }
  switch (provenance.kind) {
    case 'written':
    case 'upload':
      return { kind: 'you' };
    case 'first_party':
      return { kind: 'happier' };
    case 'plugin': {
      const pluginName = installedPlugins?.[provenance.pluginId]?.displayName;
      return pluginName ? { kind: 'plugin', pluginName } : undefined;
    }
    case 'machine':
      return { kind: 'machine', machineName: machineName(provenance.machineId) };
    case 'wellKnown':
      return { kind: 'link', host: hostOf(provenance.indexUrl) };
    case 'registry': {
      if (provenance.registry.ref.kind === 'wellKnown') return skillSource({ provenance: provenance.registry.ref }, machineName);
      const label = repositoryLabel(provenance.registry.ref.kind === 'gitTree' ? provenance.registry.ref.repo : undefined)
        ?? repositoryLabel(provenance.registry.sourceUrl)
        ?? (provenance.registry.sourceUrl === undefined ? undefined : hostOf(provenance.registry.sourceUrl));
      return label === undefined ? undefined : { kind: 'git', label };
    }
    case 'link': {
      if (provenance.ref.kind === 'wellKnown') return skillSource({ provenance: provenance.ref }, machineName);
      const repository = repositoryLabel(provenance.url);
      return repository ? { kind: 'git', label: repository } : { kind: 'link', host: hostOf(provenance.url) };
    }
  }
}

function repositoryLabel(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  return match ? `${match[1]}/${match[2]!.replace(/\.git$/i, '')}` : null;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** The held identity of where a skill came from (P8 Source condition): one value per origin, never its words. */
export function skillSourceId(item: Pick<SkillListItemV1, 'provenance'>): string {
  const provenance = item.provenance;
  switch (provenance.kind) {
    case 'written':
    case 'upload':
      return 'you';
    case 'first_party':
      return 'happier';
    case 'plugin':
      return `plugin:${provenance.pluginId}`;
    case 'machine':
      return `machine:${provenance.machineId}`;
    case 'registry':
      return `registry:${provenance.registry.sourceId}`;
    case 'wellKnown':
      return `link:${provenance.indexUrl}`;
    case 'link':
      return `link:${provenance.ref.kind === 'wellKnown' ? provenance.ref.indexUrl : provenance.url}`;
  }
}
