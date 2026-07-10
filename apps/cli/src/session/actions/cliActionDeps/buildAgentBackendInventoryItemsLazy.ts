export async function buildAgentBackendInventoryItemsLazy(args: unknown): Promise<unknown> {
  const mod = await import('@/session/actions/inventory/buildAgentBackendInventoryItems');
  return await mod.buildAgentBackendInventoryItems(args as never);
}
