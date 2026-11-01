import { z } from 'zod';

import type { SessionSkillCatalogItemV1 } from '../../sessionWorkState/sessionWorkStateRpc.js';
import { lazySchema } from '../../lazySchema.js';

export const OpenCodeAppSkillSchema = lazySchema(() => z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    location: z.string().trim().min(1).optional(),
    path: z.string().trim().min(1).optional(),
    content: z.string().optional(),
  })
  .passthrough());
export type OpenCodeAppSkill = z.infer<typeof OpenCodeAppSkillSchema>;

export function normalizeOpenCodeAppSkills(value: unknown): SessionSkillCatalogItemV1[] {
  const skills = Array.isArray(value) ? value : [];
  return skills.flatMap((skill): SessionSkillCatalogItemV1[] => {
    const parsed = OpenCodeAppSkillSchema.safeParse(skill);
    if (!parsed.success) return [];
    return [{
      ...(parsed.data.id ? { id: parsed.data.id } : {}),
      name: parsed.data.name,
      displayName: parsed.data.name,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      ...(parsed.data.path || parsed.data.location ? { path: parsed.data.path ?? parsed.data.location } : {}),
      origin: 'opencode_native',
      enabled: true,
    }];
  });
}
