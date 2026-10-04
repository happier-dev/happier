import { ReviewFindingsV1Schema, ReviewFindingsV2Schema, type ReviewFindingsV2 } from '@happier-dev/protocol';
import { buildReviewFindingsV2Payload } from './buildReviewFindingsV2Payload';

/** Read original findings even after the Run's current projection becomes narration. */
export function readRetainedReviewFindings(run: Readonly<{
  runId: string; callId: string; backendId: string;
  structuredMeta?: Readonly<{ kind: string; payload: unknown }>;
  intentInput?: unknown;
}>): ReviewFindingsV2 | null {
  const record = (value: unknown): Readonly<Record<string, unknown>> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : {};
  const narration = record(record(run.intentInput).reviewNarration);
  const candidates = run.structuredMeta?.kind === 'review_findings.v2' || run.structuredMeta?.kind === 'review_findings.v1'
    ? [run.structuredMeta.payload] : Array.isArray(narration.reviewFindings) ? narration.reviewFindings : [];
  for (const candidate of candidates) {
    const current = ReviewFindingsV2Schema.safeParse(candidate);
    const legacy = current.success ? null : ReviewFindingsV1Schema.safeParse(candidate);
    const payload = current.success ? current.data : legacy?.success ? buildReviewFindingsV2Payload({
      ...legacy.data, ...legacy.data.runRef, findings: legacy.data.findings,
    }) : null;
    if (payload && payload.runRef.runId === run.runId && payload.runRef.callId === run.callId && payload.runRef.backendId === run.backendId) return payload;
  }
  return null;
}
