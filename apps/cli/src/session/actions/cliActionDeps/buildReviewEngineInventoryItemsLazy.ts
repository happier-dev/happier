export async function buildReviewEngineInventoryItemsLazy(args: unknown): Promise<unknown> {
  const mod = await import('@/session/actions/inventory/buildReviewEngineInventoryItems');
  return mod.buildReviewEngineInventoryItems(args as never);
}
