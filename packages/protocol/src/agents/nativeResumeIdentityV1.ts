import { z } from 'zod';

/**
 * Matched provider-native resume identity: a vendor resume id together with the
 * proof that the id actually refers to a usable native conversation.
 *
 * `REQ-STATE-01` requires the id and its proof to be ATOMIC — an Agent may only
 * be resumed natively when the proof was produced by the SAME runtime
 * generation that produced the id. That is why the proof is nested inside the
 * value carrying the id rather than living in a sibling field:
 *
 * - a writer cannot publish a proof without the id it belongs to;
 * - replacing the id necessarily discards the previous proof;
 * - a reader that trusts `vendorResumeId` has, by construction, the matching
 *   `continuityProof` or an explicit `null`.
 *
 * A pair with `continuityProof: null` is a bare id: still usable where an Agent
 * needs no proof, never usable to claim native return for an Agent that does.
 * Missing, unmatched, or unparseable proof degrades to a FRESH target plus
 * bounded context; it never selects an arbitrary native session.
 *
 * This is dev-only by design. The predecessor discards inactive native state and
 * clears the outgoing flat resume key (`REQ-STATE-02`), so it needs no pair.
 *
 * Widening obligation for the identity lane: `identity.providerSessionId` widens
 * to carry THIS pair instead of gaining a second, independently-writable proof
 * field. The producers that already compute a proof and then drop it are the two
 * emit sites to convert — the SDK path proves the id by prompt materialization
 * and keeps it as `promotedTranscriptPath`, and the unified terminal keeps it as
 * `statuslineTranscriptPath`; both currently publish only the bare id.
 */

/**
 * Proof kinds are catalog-declared, never free-form. `transcriptPath` is the
 * only kind today (Claude proves a resume id by its on-disk transcript). The
 * kind is explicit so a proof is never reinterpreted as a different kind of
 * evidence, and so a machine-local filesystem path is never mistaken for a
 * portable value.
 */
export const AgentNativeContinuityProofKindV1Schema = z.enum(['transcriptPath']);
export type AgentNativeContinuityProofKindV1 =
  z.infer<typeof AgentNativeContinuityProofKindV1Schema>;

export const AgentNativeContinuityProofV1Schema = z
  .object({
    kind: AgentNativeContinuityProofKindV1Schema,
    /**
     * Catalog-declared string proof. For `transcriptPath` this is a
     * MACHINE-LOCAL path: it is protected device-local state and must never
     * enter a transcript, System Record, another machine, another Agent's
     * prompt, or any generic UI/plugin route.
     */
    value: z.string().trim().min(1).max(4_096),
  })
  .strict();
export type AgentNativeContinuityProofV1 = z.infer<typeof AgentNativeContinuityProofV1Schema>;

export const AgentNativeResumeIdentityV1Schema = z
  .object({
    v: z.literal(1),
    vendorResumeId: z.string().trim().min(1).max(512),
    /**
     * Explicitly `null` rather than omitted when there is no proof, so "this
     * runtime produced no proof" is distinguishable from "this producer forgot
     * to set the field".
     */
    continuityProof: AgentNativeContinuityProofV1Schema.nullable(),
  })
  .strict();
export type AgentNativeResumeIdentityV1 = z.infer<typeof AgentNativeResumeIdentityV1Schema>;

/**
 * Read a matched pair from an unknown identity value.
 *
 * Accepts the widened pair and the released bare-string form, so a reader can
 * consume both during the transition without every call site branching. A bare
 * string yields `continuityProof: null` — never a fabricated proof.
 */
export function readAgentNativeResumeIdentityV1(
  value: unknown,
): AgentNativeResumeIdentityV1 | null {
  if (typeof value === 'string') {
    const vendorResumeId = value.trim();
    return vendorResumeId ? { v: 1, vendorResumeId, continuityProof: null } : null;
  }
  const parsed = AgentNativeResumeIdentityV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * True when the pair can support native return for an Agent that requires
 * proof. Callers that do not require proof use `vendorResumeId` directly.
 */
export function hasMatchedAgentNativeContinuityProofV1(
  identity: AgentNativeResumeIdentityV1 | null,
): boolean {
  return identity?.continuityProof != null;
}
