import type { CapabilityId } from '../capabilities/index.js';

export const INSTALLABLE_KEYS = {
  CODEX_ACP: 'codex-acp',
  GH: 'gh',
  AZ: 'az',
  LOCAL_EMBEDDINGS: 'local-embeddings',
  LOCAL_VOICE_RUNTIME: 'local-voice-runtime',
  DIFFTASTIC: 'difftastic',
} as const;

export type InstallableKey = string;

/** Frozen 0.2 public constant; live runtime dependencies come from plugin declarations. */
export const CODEX_ACP_DEP_ID = 'dep.codex-acp' as const satisfies CapabilityId;
