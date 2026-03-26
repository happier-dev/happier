import type { PromptRegistryFetchItemRequestV1 } from '@happier-dev/protocol';

import type { PromptRegistryRegistry } from '@/promptRegistries/createPromptRegistryAdapterRegistry';
import { writePromptRegistryTransferPayload } from '@/promptRegistries/shared/promptRegistryTransferPayload';

import type { DownloadTransferSource } from './downloadTransferSource';

type PromptRegistryItemDownloadSourceResult =
  | Readonly<{ success: true; source: DownloadTransferSource }>
  | Readonly<{ success: false; error: string }>;

export async function resolvePromptRegistryItemDownloadSource(input: Readonly<{
  registry: PromptRegistryRegistry;
  request: PromptRegistryFetchItemRequestV1;
}>): Promise<PromptRegistryItemDownloadSourceResult> {
  const result = await input.registry.fetchItem({
    sourceId: input.request.sourceId,
    itemId: input.request.itemId,
    configuredSources: input.request.configuredSources,
  });
  if (!result.ok) {
    return {
      success: false,
      error: result.error,
    };
  }

  try {
    return {
      success: true,
      source: await writePromptRegistryTransferPayload(result.item),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Prompt registry payload packaging failed',
    };
  }
}
