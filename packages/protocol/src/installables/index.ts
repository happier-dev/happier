import {
  CODEX_ACP_DEP_ID,
  INSTALLABLE_KEYS,
  type InstallableKey,
} from './codexAcp.js';
import {
  AZ_BINARY_NAME,
  AZ_CLI_SETUP_URL,
  AZ_DEP_ID,
  AZ_INSTALLABLE_DESCRIPTOR,
  AZ_INSTALLABLE_KEY,
  GH_BINARY_NAME,
  GH_DEP_ID,
  GH_DIST_TAG,
  GH_GITHUB_REPO,
  GH_INSTALLABLE_DESCRIPTOR,
  GH_INSTALLABLE_KEY,
  GH_RUNTIME_INSTALLABLE_POLICY,
  PLUGIN_UI_BUNDLER_REPACK_INSTALLABLE_DESCRIPTOR,
  PLUGIN_UI_BUNDLER_VITE_INSTALLABLE_DESCRIPTOR,
} from './definitions/index.js';
import { toInstallableCatalogEntry } from './descriptor.js';
import {
  resolveInstallablesRegistry,
  type InstallableRegistryContribution,
} from './registry.js';

export {
  InstallableAutoUpdateModeSchema,
  InstallableConsentModeSchema,
  InstallableDefaultPolicySchema,
  InstallableDependencyDescriptorSchema,
  toInstallableCatalogEntry,
  type InstallableAutoUpdateMode,
  type InstallableCatalogEntry,
  type InstallableConsentMode,
  type InstallableDefaultPolicy,
  type InstallableDependencyDescriptor,
  type InstallableKind,
} from './descriptor.js';
export {
  GitHubReleaseBinaryInstallableSourceSchema,
  InstallableSourceKindSchema,
  InstallableSourceSchema,
  ManagedPackageInstallableSourceSchema,
  ManagedPypiWheelAssetAutoUpdateModeSchema,
  ManagedPypiWheelAssetInstallConsentSchema,
  ManagedPypiWheelAssetInstallableSourceSchema,
  ManagedPypiWheelAssetPlatformSchema,
  ManualOnlyInstallableSourceSchema,
  VendorRecipeInstallableSourceSchema,
  type InstallableSource,
  type InstallableSourceKind,
} from './sourceKind.js';
export {
  type InstallableContributionOwner,
  type InstallableOwnerProvenance,
  type InstallableRegistryDiagnostic,
  type InstallableRegistryDiagnosticCode,
} from './diagnostic.js';
export {
  CODEX_ACP_DEP_ID,
  AZ_BINARY_NAME,
  AZ_CLI_SETUP_URL,
  AZ_DEP_ID,
  AZ_INSTALLABLE_DESCRIPTOR,
  AZ_INSTALLABLE_KEY,
  GH_BINARY_NAME,
  GH_DEP_ID,
  GH_DIST_TAG,
  GH_GITHUB_REPO,
  GH_INSTALLABLE_DESCRIPTOR,
  GH_INSTALLABLE_KEY,
  GH_RUNTIME_INSTALLABLE_POLICY,
  INSTALLABLE_KEYS,
  type InstallableKey,
};
export {
  resolveInstallablesRegistry,
  type InstallableRegistryContribution,
  type InstallablesRegistry,
  type ResolveInstallablesRegistryInput,
} from './registry.js';
export {
  projectInstallableContribution,
  type InstallableProjectionEntry,
} from './projection.js';
export * from './definitions/index.js';

export const BUILT_IN_INSTALLABLE_CONTRIBUTIONS = Object.freeze([
  {
    owner: {
      provenance: 'built_in',
      ownerId: 'happier.core',
    },
    descriptor: GH_INSTALLABLE_DESCRIPTOR,
  },
  {
    owner: {
      provenance: 'built_in',
      ownerId: 'happier.core',
    },
    descriptor: AZ_INSTALLABLE_DESCRIPTOR,
  },
  {
    owner: {
      provenance: 'built_in',
      ownerId: 'happier.core',
    },
    descriptor: PLUGIN_UI_BUNDLER_VITE_INSTALLABLE_DESCRIPTOR,
  },
  {
    owner: {
      provenance: 'built_in',
      ownerId: 'happier.core',
    },
    descriptor: PLUGIN_UI_BUNDLER_REPACK_INSTALLABLE_DESCRIPTOR,
  },
] satisfies readonly InstallableRegistryContribution[]);

export const BUILT_IN_INSTALLABLES_REGISTRY = resolveInstallablesRegistry({
  builtIns: BUILT_IN_INSTALLABLE_CONTRIBUTIONS,
});

export const INSTALLABLES_CATALOG = Object.freeze(
  BUILT_IN_INSTALLABLES_REGISTRY.descriptors.map((entry) => toInstallableCatalogEntry(entry.descriptor)),
);
