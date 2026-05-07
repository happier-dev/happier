import type { CapabilityId } from './capabilities.js';
import {
  CODEX_ACP_DEP_ID,
  CODEX_ACP_DIST_TAG,
  INSTALLABLE_KEYS as CODEX_INSTALLABLE_KEYS,
} from './providers/codex/installables.js';
import {
  GH_BINARY_NAME,
  GH_DEP_ID,
  GH_GITHUB_REPO,
  GH_INSTALLABLE_KEY,
} from './providers/github/installables.js';

export {
  CODEX_ACP_DEP_ID,
  CODEX_ACP_DIST_TAG,
  GH_BINARY_NAME,
  GH_DEP_ID,
  GH_GITHUB_REPO,
};

export const INSTALLABLE_KEYS = {
  CODEX_ACP: CODEX_INSTALLABLE_KEYS.CODEX_ACP,
  GH: GH_INSTALLABLE_KEY,
} as const;

export type InstallableKey = typeof INSTALLABLE_KEYS[keyof typeof INSTALLABLE_KEYS];

export type InstallableKind = 'dep';
export type InstallableSourceKind =
  | 'github_release_binary'
  | 'managed_package'
  | 'vendor_recipe'
  | 'manual_only';

export type InstallableAutoUpdateMode = 'off' | 'notify' | 'auto';

export type InstallableDefaultPolicy = Readonly<{
  autoInstallWhenNeeded: boolean;
  autoUpdateMode: InstallableAutoUpdateMode;
}>;

export type InstallableCatalogEntry = Readonly<{
  key: string;
  kind: InstallableKind;
  capabilityId: Extract<CapabilityId, `dep.${string}`>;
  sourceKind: InstallableSourceKind;
  source?: Readonly<{
    githubRepo?: string;
    binaryName?: string;
    assetPattern?: string;
  }>;
  fallbackInstall?: Readonly<{
    kind: InstallableSourceKind;
    recipes?: Partial<Record<string, string>>;
  }>;
  defaultPolicy: InstallableDefaultPolicy;
  experimental: boolean;
}>;

const DEFAULT_POLICY: InstallableDefaultPolicy = { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' };
const OPTIONAL_TOOL_POLICY: InstallableDefaultPolicy = { autoInstallWhenNeeded: false, autoUpdateMode: 'notify' };

export const INSTALLABLES_CATALOG = [
  {
    key: INSTALLABLE_KEYS.CODEX_ACP,
    kind: 'dep',
    capabilityId: CODEX_ACP_DEP_ID,
    sourceKind: 'github_release_binary',
    defaultPolicy: DEFAULT_POLICY,
    experimental: true,
  },
  {
    key: INSTALLABLE_KEYS.GH,
    kind: 'dep',
    capabilityId: GH_DEP_ID,
    sourceKind: 'github_release_binary',
    source: {
      githubRepo: GH_GITHUB_REPO,
      binaryName: GH_BINARY_NAME,
      assetPattern: 'gh_*_<platform>_<arch>.<archive>',
    },
    fallbackInstall: {
      kind: 'managed_package',
      recipes: {
        darwin: 'brew install gh',
        linux: 'Use your distribution package manager to install GitHub CLI.',
        win32: 'winget install GitHub.cli',
      },
    },
    defaultPolicy: OPTIONAL_TOOL_POLICY,
    experimental: false,
  },
] as const satisfies readonly InstallableCatalogEntry[];
