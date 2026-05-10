export type PromptProviderCatalogEntry = Readonly<{
  id: string;
  pluginId: string;
  adapterExportName: string;
}>;

export type PromptProviderCatalog = Readonly<{
  entries: readonly PromptProviderCatalogEntry[];
}>;

export function createPromptProviderCatalog(
  entries: readonly PromptProviderCatalogEntry[] = [],
): PromptProviderCatalog {
  return Object.freeze({
    entries: Object.freeze([...entries]),
  });
}
