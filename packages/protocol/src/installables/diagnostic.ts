export type InstallableOwnerProvenance =
  | 'built_in'
  | 'bundled_first_party_plugin'
  | 'external_plugin';

export type InstallableContributionOwner = Readonly<{
  provenance: InstallableOwnerProvenance;
  ownerId: string;
  pluginId?: string;
  manifestPath?: string;
  manifestDigest?: string;
  sharedGroupId?: string;
}>;

export type InstallableRegistryDiagnosticCode =
  | 'installable_duplicate_key'
  | 'installable_duplicate_capability';

export type InstallableRegistryDiagnostic = Readonly<{
  code: InstallableRegistryDiagnosticCode;
  message: string;
  conflictedField: 'key' | 'capabilityId';
  disabledDescriptorKey: string;
  disabledCapabilityId: string;
  disabledOwnerId: string;
  disabledProvenance: InstallableOwnerProvenance;
  disabledPluginId?: string;
  existingDescriptorKey: string;
  existingCapabilityId: string;
  existingOwnerId: string;
  existingProvenance: InstallableOwnerProvenance;
  existingPluginId?: string;
}>;
