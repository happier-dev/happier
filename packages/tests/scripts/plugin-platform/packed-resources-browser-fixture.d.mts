export type PackedResourcesBrowserPayloads = Readonly<Record<
  'prompt' | 'skill' | 'template' | 'asset' | 'config',
  string
>>;

export function buildPackedResourcesBrowserManifest(params: Readonly<{
  manifest: Record<string, unknown>;
  pluginId: string;
  version: string;
}>): Record<string, unknown>;

export function packedResourcesBrowserPayloads(version: string): PackedResourcesBrowserPayloads;

export function buildPackedResourcesBrowserRuntimeSource(params: Readonly<{
  pluginId: string;
  version: string;
}>): string;
