import { z } from 'zod';

import type { SessionSkillCatalogItemV1 } from '../../sessionWorkState/sessionWorkStateRpc.js';
import { lazySchema } from '../../lazySchema.js';

export const ClaudeSdkSkillsOptionSchema = lazySchema(() => z.union([z.literal('all'), z.array(z.string().trim().min(1))]));
export type ClaudeSdkSkillsOption = z.infer<typeof ClaudeSdkSkillsOptionSchema>;

export function normalizeClaudeSdkInitSkills(value: unknown): SessionSkillCatalogItemV1[] {
  const names = Array.isArray(value) ? value : [];
  return names.flatMap((name): SessionSkillCatalogItemV1[] => {
    if (typeof name !== 'string' || name.trim().length === 0) return [];
    const normalized = name.trim();
    return [{
      name: normalized,
      displayName: normalized,
      origin: 'claude_native',
      enabled: true,
    }];
  });
}
