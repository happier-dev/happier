import type { CapabilityId } from './capabilities.js';

export type InstallableKind = 'dep';
export type InstallableSourceKind = 'github_release_binary';

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
  defaultPolicy: InstallableDefaultPolicy;
  experimental: boolean;
}>;

export const INSTALLABLE_KEYS = {
  CODEX_ACP: 'codex-acp',
} as const;

export type InstallableKey = typeof INSTALLABLE_KEYS[keyof typeof INSTALLABLE_KEYS];

export const CODEX_ACP_DEP_ID = 'dep.codex-acp' as const satisfies CapabilityId;
export const CODEX_ACP_DIST_TAG = 'latest' as const;

const DEFAULT_POLICY: InstallableDefaultPolicy = { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' };

export const INSTALLABLES_CATALOG = [
  {
    key: INSTALLABLE_KEYS.CODEX_ACP,
    kind: 'dep',
    capabilityId: CODEX_ACP_DEP_ID,
    sourceKind: 'github_release_binary',
    defaultPolicy: DEFAULT_POLICY,
    experimental: true,
  },
] as const satisfies readonly InstallableCatalogEntry[];
