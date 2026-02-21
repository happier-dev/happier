import type { CapabilityId } from './capabilities.js';

export type InstallableKind = 'dep';

export type InstallableAutoUpdateMode = 'off' | 'notify' | 'auto';

export type InstallableDefaultPolicy = Readonly<{
  autoInstallWhenNeeded: boolean;
  autoUpdateMode: InstallableAutoUpdateMode;
}>;

export type InstallableCatalogEntry = Readonly<{
  key: string;
  kind: InstallableKind;
  capabilityId: Extract<CapabilityId, `dep.${string}`>;
  /**
   * Optional npm dist-tag used by the capability detect registry check.
   * This is a metadata default; consumers may override when necessary.
   */
  defaultDistTag: string;
  defaultPolicy: InstallableDefaultPolicy;
  experimental: boolean;
}>;

export const INSTALLABLE_KEYS = {
  CODEX_MCP_RESUME: 'codex-mcp-resume',
  CODEX_ACP: 'codex-acp',
} as const;

export type InstallableKey = typeof INSTALLABLE_KEYS[keyof typeof INSTALLABLE_KEYS];

export const CODEX_MCP_RESUME_DEP_ID = 'dep.codex-mcp-resume' as const satisfies CapabilityId;
export const CODEX_MCP_RESUME_DIST_TAG = 'happy-codex-resume' as const;

export const CODEX_ACP_DEP_ID = 'dep.codex-acp' as const satisfies CapabilityId;
export const CODEX_ACP_DIST_TAG = 'latest' as const;

const DEFAULT_POLICY: InstallableDefaultPolicy = { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' };

export const INSTALLABLES_CATALOG = [
  {
    key: INSTALLABLE_KEYS.CODEX_MCP_RESUME,
    kind: 'dep',
    capabilityId: CODEX_MCP_RESUME_DEP_ID,
    defaultDistTag: CODEX_MCP_RESUME_DIST_TAG,
    defaultPolicy: DEFAULT_POLICY,
    experimental: true,
  },
  {
    key: INSTALLABLE_KEYS.CODEX_ACP,
    kind: 'dep',
    capabilityId: CODEX_ACP_DEP_ID,
    defaultDistTag: CODEX_ACP_DIST_TAG,
    defaultPolicy: DEFAULT_POLICY,
    experimental: true,
  },
] as const satisfies readonly InstallableCatalogEntry[];

