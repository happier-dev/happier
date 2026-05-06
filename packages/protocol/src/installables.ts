import {
  CODEX_ACP_DEP_ID,
  CODEX_ACP_DIST_TAG,
  CODEX_ACP_INSTALLABLE_DESCRIPTOR,
  INSTALLABLE_KEYS,
  type InstallableKey,
} from './installables/codexAcp.js';
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
} from './installables/definitions/index.js';
import {
  resolveInstallablesRegistry,
  toInstallableCatalogEntry,
  type InstallableRegistryContribution,
} from './installables/index.js';

export {
  CODEX_ACP_DEP_ID,
  CODEX_ACP_DIST_TAG,
  CODEX_ACP_INSTALLABLE_DESCRIPTOR,
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
  INSTALLABLE_KEYS,
  type InstallableKey,
};
export * from './installables/index.js';

export const BUILT_IN_INSTALLABLE_CONTRIBUTIONS = Object.freeze([
  {
    owner: {
      provenance: 'built_in',
      ownerId: 'happier.core',
    },
    descriptor: CODEX_ACP_INSTALLABLE_DESCRIPTOR,
  },
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
] satisfies readonly InstallableRegistryContribution[]);

export const BUILT_IN_INSTALLABLES_REGISTRY = resolveInstallablesRegistry({
  builtIns: BUILT_IN_INSTALLABLE_CONTRIBUTIONS,
});

export const INSTALLABLES_CATALOG = Object.freeze(
  BUILT_IN_INSTALLABLES_REGISTRY.descriptors.map((entry) => toInstallableCatalogEntry(entry.descriptor)),
);
