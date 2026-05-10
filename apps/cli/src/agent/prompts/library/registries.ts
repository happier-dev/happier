export type PromptRegistryCatalogEntry = Readonly<{
  id: string;
  pluginId: string;
  adapterExportName: string;
}>;

export type PromptRegistryCatalog = Readonly<{
  entries: readonly PromptRegistryCatalogEntry[];
}>;

export function createPromptRegistryCatalog(
  entries: readonly PromptRegistryCatalogEntry[] = [],
): PromptRegistryCatalog {
  return Object.freeze({
    entries: Object.freeze([...entries]),
  });
}
