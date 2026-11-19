import {
  listRegistrySourcesV1,
  registrySourceSupportsKindV1,
  type RegistryKindV1,
  type RegistrySourceDescriptorV1,
  type RegistrySourcesRecordV1,
} from '@happier-dev/protocol/registries';

const EMPTY_REGISTRY_SOURCES_RECORD: RegistrySourcesRecordV1 = {
  v: 2,
  sources: [],
  disabledSourceIds: [],
};

/**
 * The registry selection's one rule: built-in, plugin and user sources, enabled only, of `kind` and among
 * `selectedIds` when given. Only an unanswered selection waits: an unloaded record, or a Machine still owing its
 * sources while nothing matches yet. A Machine still owing sources can only add more of a known kind.
 */
export function selectRegistrySources(
  input: Readonly<{
    record: RegistrySourcesRecordV1 | null;
    recordLoading: boolean;
    pluginSources: readonly RegistrySourceDescriptorV1[];
    pluginsResolving: boolean;
    kind?: RegistryKindV1;
    selectedIds?: readonly string[];
  }>,
): Readonly<{
  sources: readonly RegistrySourceDescriptorV1[];
  matching: readonly RegistrySourceDescriptorV1[];
  resolving: boolean;
}> {
  const { kind, selectedIds } = input;
  const sources = listRegistrySourcesV1({
    record: input.record ?? EMPTY_REGISTRY_SOURCES_RECORD,
    pluginSources: input.pluginSources,
  });
  const matching = sources.filter(
    (source) =>
      source.enabled &&
      (kind === undefined || registrySourceSupportsKindV1(source, kind)) &&
      (selectedIds === undefined || selectedIds.includes(source.id)),
  );
  const selectionKnown = selectedIds?.length === 0 || matching.length > 0;
  return {
    sources,
    matching,
    resolving:
      input.recordLoading || (input.pluginsResolving && !selectionKnown),
  };
}
