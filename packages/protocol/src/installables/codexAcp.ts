import type { CapabilityId } from '../capabilities/index.js';

export const INSTALLABLE_KEYS = {
  CODEX_ACP: 'codex-acp',
  GH: 'gh',
  AZ: 'az',
} as const;

export type InstallableKey = string;

export const CODEX_ACP_DEP_ID = 'dep.codex-acp' as const satisfies CapabilityId;
