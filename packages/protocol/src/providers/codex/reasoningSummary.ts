import { z } from 'zod';
import { lazySchema } from '../../lazySchema.js';

export const CODEX_REASONING_SUMMARIES_DEFAULT = 'default';

export const CodexReasoningSummariesSchema = lazySchema(() => z
  .enum(['default', 'enabled', 'disabled'])
  .default(CODEX_REASONING_SUMMARIES_DEFAULT)
  .catch(CODEX_REASONING_SUMMARIES_DEFAULT));

export type CodexReasoningSummaries = z.infer<typeof CodexReasoningSummariesSchema>;

export function resolveCodexReasoningSummaryOverride(preference: unknown): 'auto' | 'none' | undefined {
  const parsed = CodexReasoningSummariesSchema.parse(preference);
  if (parsed === 'enabled') return 'auto';
  if (parsed === 'disabled') return 'none';
  return undefined;
}
