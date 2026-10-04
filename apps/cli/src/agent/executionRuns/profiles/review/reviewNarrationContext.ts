import { ScmDiffSummaryReviewProvenanceSchema } from '@happier-dev/protocol';
import { readScmDiffSummaryIntent } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/publishSavedScmDiffSummaryTurn';
import { collectReviewFindingCitations, findingCitationInstructions, presentReviewFindingCitations,
  reviewFindingCitationsSchema } from './reviewFindingCitations';

export function readReviewFindingCitationContext(input: unknown) {
  const narration = readScmDiffSummaryIntent(readScmDiffSummaryIntent(input).reviewNarration);
  const retained = reviewFindingCitationsSchema.safeParse(narration.reviewFindingCitations);
  return retained.success ? retained.data : collectReviewFindingCitations(narration,
    typeof narration.findingsContext === 'string' ? narration.findingsContext : undefined);
}

/** This private context is authored by the host after finding materialization. */
export function readReviewNarration(input: unknown) {
  const narration = readScmDiffSummaryIntent(readScmDiffSummaryIntent(input).reviewNarration);
  const provenance = ScmDiffSummaryReviewProvenanceSchema.safeParse(narration.provenance);
  return narration.phase === 'writing' && provenance.success ? { provenance: provenance.data,
    reviewFindings: narration.reviewFindings ?? [] } : null;
}

export function buildReviewNarrationInputContext(input: unknown): string {
  const narration = readReviewNarration(input);
  if (!narration) return '';
  const citations = readReviewFindingCitationContext(input);
  const privateNarration = readScmDiffSummaryIntent(readScmDiffSummaryIntent(input).reviewNarration);
  let findings: unknown = narration.reviewFindings;
  if (typeof privateNarration.findingsContext === 'string') {
    try { findings = JSON.parse(privateNarration.findingsContext); } catch { /* Host instructions are not finding identities. */ }
  }
  return [
    `Published review provenance: ${JSON.stringify(narration.provenance)}`,
    `Latest published findings: ${JSON.stringify(presentReviewFindingCitations(findings, citations))}`,
    findingCitationInstructions,
    'A partial, failed, or unavailable review is not a clean review.',
  ].join('\n\n');
}
