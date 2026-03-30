import type { CapabilityId } from '../../capabilities.js';

export const INSTALLABLE_KEYS = {
  CODEX_ACP: 'codex-acp',
} as const;

export type InstallableKey = typeof INSTALLABLE_KEYS[keyof typeof INSTALLABLE_KEYS];

export const CODEX_ACP_DEP_ID = 'dep.codex-acp' as const satisfies CapabilityId;
export const CODEX_ACP_DIST_TAG = 'latest' as const;
