import type { buildReviewEngineInventory } from '@/session/actions/inventory/buildReviewEngineInventoryItems';

export async function buildReviewEngineInventoryItemsLazy(args: Parameters<typeof buildReviewEngineInventory>[0]): ReturnType<typeof buildReviewEngineInventory> {
  const mod = await import('@/session/actions/inventory/buildReviewEngineInventoryItems');
  return mod.buildReviewEngineInventory(args);
}
