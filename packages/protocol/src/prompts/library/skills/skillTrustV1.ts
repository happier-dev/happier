import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

export const SkillTrustV1Schema = lazyZodSchema(() => z.enum(['text_only', 'has_files', 'runs_scripts']));
export type SkillTrustV1 = z.infer<typeof SkillTrustV1Schema>;

/** Bundle modes are the executable fact for import, display and delivery. */
export function deriveSkillTrustV1(files: readonly Readonly<{ path: string; unixMode?: number | null }>[]): SkillTrustV1 {
  if (files.some(file => ((file.unixMode ?? 0) & 0o111) !== 0)) return 'runs_scripts';
  return files.some(file => file.path !== 'SKILL.md') ? 'has_files' : 'text_only';
}
