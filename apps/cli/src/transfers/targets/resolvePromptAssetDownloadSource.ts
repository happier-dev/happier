import type { PromptAssetReadRequest } from '@happier-dev/protocol';

import { writePromptAssetTransferPayload } from '@/promptAssets/shared/promptAssetTransferPayload';
import type { PromptAssetAdapter } from '@/promptAssets/types';

import type { DownloadTransferSource } from './downloadTransferSource';

type PromptAssetDownloadSourceResult =
  | Readonly<{ success: true; source: DownloadTransferSource }>
  | Readonly<{ success: false; error: string }>;

export async function resolvePromptAssetDownloadSource(input: Readonly<{
  adapterRegistry: ReadonlyMap<string, PromptAssetAdapter>;
  request: PromptAssetReadRequest;
}>): Promise<PromptAssetDownloadSourceResult> {
  const adapter = input.adapterRegistry.get(input.request.assetTypeId);
  if (!adapter) {
    return {
      success: false,
      error: 'unsupported asset type',
    };
  }

  const result = await adapter.read(input.request);
  if (!result.ok) {
    return {
      success: false,
      error: result.error,
    };
  }

  try {
    return {
      success: true,
      source: await writePromptAssetTransferPayload(result.item),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Prompt asset payload packaging failed',
    };
  }
}
