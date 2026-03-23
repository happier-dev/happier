import type {
  PromptAssetInstallModeV1,
  PromptAssetTypeDescriptorV1,
} from '@happier-dev/protocol';

export function listPromptAssetInstallModesForType(
  assetType: PromptAssetTypeDescriptorV1 | null | undefined,
): PromptAssetInstallModeV1[] {
  if (!assetType) return ['copy'];
  return assetType.capabilities.supportsSymlinkInstall === true
    ? ['symlink', 'copy']
    : ['copy'];
}

export function resolvePromptAssetInstallModeSelection(args: Readonly<{
  assetType: PromptAssetTypeDescriptorV1 | null | undefined;
  selectedInstallMode: PromptAssetInstallModeV1 | null | undefined;
}>): PromptAssetInstallModeV1 {
  const compatibleModes = listPromptAssetInstallModesForType(args.assetType);
  if (args.selectedInstallMode && compatibleModes.includes(args.selectedInstallMode)) {
    return args.selectedInstallMode;
  }
  return compatibleModes[0] ?? 'copy';
}
