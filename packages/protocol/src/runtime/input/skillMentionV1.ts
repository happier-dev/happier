import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { NonBlankOpaqueIdentifierSchema } from '../../strings/opaqueIdentifier.js';

export const SkillMentionOriginV1Schema = lazyZodSchema(() => z.enum(['vendor', 'happier']));
export type SkillMentionOriginV1 = z.infer<typeof SkillMentionOriginV1Schema>;

export const SkillMentionV1Schema = lazyZodSchema(() => z.looseObject({
  id: z.optional(NonBlankOpaqueIdentifierSchema),
  idSource: z.optional(z.literal('generated')),
  origin: z.optional(SkillMentionOriginV1Schema),
  name: z.string().check(z.trim(), z.minLength(1)),
  path: z.optional(z.string().check(z.trim(), z.minLength(1))),
  label: z.optional(z.string().check(z.trim(), z.minLength(1))),
  projectionRef: z.optional(z.string().check(z.trim(), z.minLength(1))),
  backendId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  agentId: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export type SkillMentionV1 = z.infer<typeof SkillMentionV1Schema>;
