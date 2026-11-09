import { ScmDiffSummaryModelOutputSchema, normalizeScmDiffSummaryModelOutput } from '@happier-dev/protocol/scm/diffSummary';
import type { ScmDiffSummaryModelOutput } from '@happier-dev/protocol';

import { parseTrailingJsonObject } from '@/agent/executionRuns/profiles/shared/parseTrailingJsonObject';

export type DiffSummaryModelOutput = ScmDiffSummaryModelOutput;

export function parseDiffSummaryModelOutput(
  rawText: string,
  context?: Parameters<typeof normalizeScmDiffSummaryModelOutput>[1],
  targetedWalkthroughBase?: Pick<NonNullable<ScmDiffSummaryModelOutput['walkthrough']>, 'title' | 'intro'>,
): DiffSummaryModelOutput | null {
  // The shared Run-output reader tolerates the prose or code fence a model puts around its JSON.
  // The strict protocol schema below remains the contract.
  let parsed = parseTrailingJsonObject(rawText);
  // A selected-stop turn owns only its stops. The saved owner supplies the unchanged reading fields
  // before the same strict schema admits the output; explicit malformed fields still fail.
  if (targetedWalkthroughBase && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const walkthrough = 'walkthrough' in parsed ? parsed.walkthrough
      : 'stops' in parsed && Array.isArray(parsed.stops) ? parsed : undefined;
    if (walkthrough && typeof walkthrough === 'object' && !Array.isArray(walkthrough)) {
      parsed = { ...('walkthrough' in parsed ? parsed : {}),
        walkthrough: { title: targetedWalkthroughBase.title, intro: targetedWalkthroughBase.intro, ...walkthrough } };
    }
  }

  const result = ScmDiffSummaryModelOutputSchema.safeParse(parsed);
  if (!result.success) return null;
  try {
    return context ? normalizeScmDiffSummaryModelOutput(result.data, context) : result.data;
  } catch { return null; }
}
