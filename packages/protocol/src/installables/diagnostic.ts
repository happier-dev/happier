export type InstallableOwnerProvenance =
  | 'built_in'
  | 'bundled_first_party_plugin'
  | 'external_plugin';

export type InstallableContributionOwner = Readonly<{
  provenance: InstallableOwnerProvenance;
  ownerId: string;
  pluginId?: string;
  manifestPath?: string;
  sharedGroupId?: string;
}>;

export type InstallableRegistryDiagnosticCode =
  | 'installable_duplicate_key'
  | 'installable_duplicate_capability';

type InstallableRegistryDiagnosticBase = Readonly<{
  code: InstallableRegistryDiagnosticCode;
  message: string;
  disabledDescriptorKey: string;
  disabledCapabilityId: string;
  disabledOwnerId: string;
  disabledProvenance: InstallableOwnerProvenance;
  disabledPluginId?: string;
}>;

export type InstallableRegistryDiagnostic = InstallableRegistryDiagnosticBase & Readonly<{
  code: 'installable_duplicate_key' | 'installable_duplicate_capability';
  conflictedField: 'key' | 'capabilityId';
  existingDescriptorKey: string;
  existingCapabilityId: string;
  existingOwnerId: string;
  existingProvenance: InstallableOwnerProvenance;
  existingPluginId?: string;
}>;
