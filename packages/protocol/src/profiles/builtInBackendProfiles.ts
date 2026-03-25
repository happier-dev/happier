import type { AIBackendProfile } from './backendProfileSchema.js';

import { CLAUDE_BUILT_IN_BACKEND_PROFILES } from '../providers/claude/builtInBackendProfiles.js';
import { CODEX_BUILT_IN_BACKEND_PROFILES } from '../providers/codex/builtInBackendProfiles.js';
import { GEMINI_BUILT_IN_BACKEND_PROFILES } from '../providers/gemini/builtInBackendProfiles.js';

export const DEFAULT_BUILT_IN_BACKEND_PROFILES: ReadonlyArray<AIBackendProfile> = [
  ...CLAUDE_BUILT_IN_BACKEND_PROFILES,
  ...CODEX_BUILT_IN_BACKEND_PROFILES,
  ...GEMINI_BUILT_IN_BACKEND_PROFILES,
] as const;

export function getBuiltInBackendProfile(id: string): AIBackendProfile | null {
  const normalized = typeof id === 'string' ? id.trim() : '';
  if (!normalized) return null;
  return DEFAULT_BUILT_IN_BACKEND_PROFILES.find((p) => p.id === normalized) ?? null;
}
