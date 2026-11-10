import { z } from '../../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { estimateTokensV1 } from '../../../capabilities/estimateTokensV1.js';
import { readStoredSkillFrontmatterV1, splitSkillMarkdownV1 } from './skillLibraryItemV1.js';

export const SkillCostV1Schema = lazyZodSchema(() => z.strictObject({ descriptionTokens: z.number().check(z.int(), z.nonnegative()), bodyTokens: z.number().check(z.int(), z.nonnegative()) }));
export type SkillCostV1 = z.infer<typeof SkillCostV1Schema>;
export function estimateSkillCostV1(skillMarkdown: string): SkillCostV1 {
  const { body } = splitSkillMarkdownV1(skillMarkdown);
  return { descriptionTokens: estimateTokensV1(readStoredSkillFrontmatterV1(skillMarkdown).description ?? ''), bodyTokens: estimateTokensV1(body) };
}
