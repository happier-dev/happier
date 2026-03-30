import type { PromptAssetScopeV1, PromptAssetTypeDescriptorV1 } from '@happier-dev/protocol';

export function listPromptAssetTypesForScope(
  types: readonly PromptAssetTypeDescriptorV1[],
  scope: PromptAssetScopeV1,
): PromptAssetTypeDescriptorV1[] {
  return types.filter((entry) => entry.supportsScope[scope]);
}

export function resolvePromptAssetTypeSelection(args: Readonly<{
  types: readonly PromptAssetTypeDescriptorV1[];
  scope: PromptAssetScopeV1;
  selectedTypeId: string | null | undefined;
}>): string | null {
  const compatibleTypes = listPromptAssetTypesForScope(args.types, args.scope);
  if (compatibleTypes.length === 0) return null;
  if (args.selectedTypeId && compatibleTypes.some((entry) => entry.id === args.selectedTypeId)) {
    return args.selectedTypeId;
  }
  return compatibleTypes[0]?.id ?? null;
}
