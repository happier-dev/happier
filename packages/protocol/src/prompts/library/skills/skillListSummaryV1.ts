import { z } from 'zod/mini';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../../json/storedReadSchema.js';
import type { SkillBundleContentV1 } from '../promptBundleSchemas.js';
import { deriveSkillTrustV1, SkillTrustV1Schema } from './skillTrustV1.js';
import { estimateSkillCostV1, SkillCostV1Schema } from './skillCostV1.js';

/** Body-derived list facts only; private creator, reach and source retain their own owners. */
export const SkillListSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), name: z.string().check(z.minLength(1)), description: z.nullable(z.string()),
  userInvocable: z.boolean(), digest: z.string().check(z.minLength(1)),
  trust: SkillTrustV1Schema, cost: SkillCostV1Schema,
  createdAt: z.number().check(z.int(), z.nonnegative()),
}));
export type SkillListSummaryV1 = z.infer<typeof SkillListSummaryV1Schema>;
const storedSummary = createStoredReadSchema(SkillListSummaryV1Schema);

export function buildSkillListSummaryV1(content: SkillBundleContentV1): SkillListSummaryV1 {
  return { v: 1, name: content.frontmatter.name, description: content.frontmatter.description ?? null,
    userInvocable: content.frontmatter.userInvocable, digest: content.digest,
    trust: deriveSkillTrustV1(content.body.entries), cost: estimateSkillCostV1(content.skillMd), createdAt: content.body.createdAtMs };
}

export function readSkillListSummaryV1(header: Readonly<Record<string, unknown>>): SkillListSummaryV1 | null {
  const parsed = storedSummary.safeParse(header.skillListSummary);
  return parsed.success ? parsed.data : null;
}
