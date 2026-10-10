import type { buildReviewEngineInventoryItems } from '@/session/actions/inventory/buildReviewEngineInventoryItems';

export async function buildReviewEngineInventoryItemsLazy(args: Parameters<typeof buildReviewEngineInventoryItems>[0]): ReturnType<typeof buildReviewEngineInventoryItems> {
  const mod = await import('@/session/actions/inventory/buildReviewEngineInventoryItems');
  return mod.buildReviewEngineInventoryItems(args);
}
