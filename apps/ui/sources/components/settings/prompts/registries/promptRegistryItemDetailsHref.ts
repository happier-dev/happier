import type { PromptRegistryItemSummaryV1 } from '@happier-dev/protocol';

export function buildPromptRegistryItemDetailsHref(args: Readonly<{
  machineId: string;
  item: PromptRegistryItemSummaryV1;
  workspacePath?: string | null;
}>): string {
  const params = new URLSearchParams({
    machineId: args.machineId,
    sourceId: args.item.sourceId,
    itemId: args.item.itemId,
    title: args.item.title,
    displayPath: args.item.displayPath,
  });
  if (typeof args.workspacePath === 'string' && args.workspacePath.trim().length > 0) {
    params.set('workspacePath', args.workspacePath.trim());
  }
  return `/settings/prompts/registries/item?${params.toString()}`;
}
