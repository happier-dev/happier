import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { NonBlankOpaqueIdentifierSchema } from '../../strings/opaqueIdentifier.js';

export const SkillMentionOriginV1Schema = lazyZodSchema(() => z.enum(['vendor', 'happier']));
export type SkillMentionOriginV1 = z.infer<typeof SkillMentionOriginV1Schema>;

export const SkillMentionV1Schema = lazyZodSchema(() => z.object({
  id: NonBlankOpaqueIdentifierSchema.optional(),
  idSource: z.literal('generated').optional(),
  origin: SkillMentionOriginV1Schema.optional(),
  name: z.string().trim().min(1),
  path: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).optional(),
  projectionRef: z.string().trim().min(1).optional(),
  backendId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
}).passthrough());

export type SkillMentionV1 = z.infer<typeof SkillMentionV1Schema>;
