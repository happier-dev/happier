import type { AgentBackendInventoryItem } from '@happier-dev/protocol';

export async function buildAgentBackendInventoryItemsLazy(args: unknown): Promise<AgentBackendInventoryItem[]> {
  const mod = await import('@/session/actions/inventory/buildAgentBackendInventoryItems');
  return await mod.buildAgentBackendInventoryItems(args as never);
}
