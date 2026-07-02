import { z } from 'zod';

export const SkillMentionOriginV1Schema = z.enum(['vendor', 'happier']);
export type SkillMentionOriginV1 = z.infer<typeof SkillMentionOriginV1Schema>;

export const SkillMentionV1Schema = z.object({
  id: z.string().trim().min(1).optional(),
  origin: SkillMentionOriginV1Schema.optional(),
  name: z.string().trim().min(1),
  path: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).optional(),
  projectionRef: z.string().trim().min(1).optional(),
  backendId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
}).passthrough();

export type SkillMentionV1 = z.infer<typeof SkillMentionV1Schema>;
