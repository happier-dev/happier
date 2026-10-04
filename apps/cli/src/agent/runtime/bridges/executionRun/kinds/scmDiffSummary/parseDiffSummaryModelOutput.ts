import {
  ScmDiffSummaryModelOutputSchema,
  normalizeScmDiffSummaryModelOutput,
  type ScmDiffSummaryModelOutput,
} from '@happier-dev/protocol';

export type DiffSummaryModelOutput = ScmDiffSummaryModelOutput;

export function parseDiffSummaryModelOutput(
  rawText: string,
  context?: Parameters<typeof normalizeScmDiffSummaryModelOutput>[1],
): DiffSummaryModelOutput | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = null;
  }

  const result = ScmDiffSummaryModelOutputSchema.safeParse(parsed);
  if (!result.success) return null;
  try {
    return context ? normalizeScmDiffSummaryModelOutput(result.data, context) : result.data;
  } catch { return null; }
}
