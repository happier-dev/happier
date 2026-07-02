// Shared, provider-agnostic provider-outcome proof contract.
//
// THE SUCCESS BOUNDARY IS THE ROOT CAUSE. Across Codex, Pi, and Claude the live
// recovery loops all came from the same mistake: a LOCAL recovery substep (a
// switch event, an auth-store adoption, a credential refresh, an observed
// generation bump, a process restart, a continuation-prompt enqueue) was treated
// as proof the provider had actually recovered. It is not. Recovery is "done"
// only when the PROVIDER OUTCOME is proven, or when the system reaches a durable,
// user-visible terminal state.
//
// This module is the single source of truth for "what counts as proof". It is
// intentionally PROVIDER-AGNOSTIC: it contains no provider-name branching. Each
// provider/scheduler maps its own domain-specific result onto one of these
// evidence classes in its OWN owner module (backends/<provider>/**,
// runtimeAuth/**, usageLimitRecovery/**), then asks this module whether the
// evidence is proof. Provider specifics never leak in here.
//
// Wave-1 lanes intentionally kept this logic local to avoid parallel-edit
// collisions. This module is the wave-2 consolidation of those local guards
// (Lane A runtime-auth, Lane B usage-limit/Codex). Lane C (Pi compaction turn
// outcome) deliberately uses a DISTINCT vocabulary (turn settlement, not recovery
// proof) and is not folded in here; its `completed_post_final` outcome is a
// turn-lifecycle decision, not a provider-outcome proof.

/**
 * The proof classes the recovery system accepts as evidence that a recovery path
 * may transition out of "still recovering". These mirror the plan's
 * "Provider Outcome Evidence" section exactly.
 *
 * Positive (recovery may complete / terminate visibly):
 * - `provider_activity`: meaningful provider output, tool call, assistant delta,
 *   or accepted in-flight steer AFTER the recovery boundary and matching the
 *   recovery identity. The continuation controller owns the bounded wait and
 *   timeout state; schedulers consume the proof through this shared vocabulary.
 * - `native_resume`: provider-specific evidence that the recovered provider
 *   accepted vendor/session resume state.
 * - `quota_probe_fresh`: a provider quota probe proves the selected profile is
 *   not exhausted for the same service/fingerprint.
 * - `fresh_candidate_selected`: the adopted connected-service profile/account is
 *   genuinely DIFFERENT from the exhausted/failed one (and not known-exhausted
 *   for the same fingerprint). This is useful evidence, but it is still
 *   INTERMEDIATE: the provider has not yet accepted work under the new account.
 * - `account_adoption_verified`: a post-switch account-adoption verification
 *   confirmed the adopted account (verified / weakly_verified).
 * - `terminal_action_required`: no automatic path is valid; a visible user action
 *   state is emitted.
 * - `terminal_exhausted`: retry/dead-letter budget reached and visible.
 */
export type ProviderOutcomeProofKind =
  | 'provider_activity'
  | 'native_resume'
  | 'quota_probe_fresh'
  | 'fresh_candidate_selected'
  | 'account_adoption_verified'
  | 'terminal_action_required'
  | 'terminal_exhausted';

/**
 * Proof classes that mean "the provider recovered" — recovery should be cleared
 * as recovered ONLY for one of these.
 */
export type ProviderOutcomeRecoveredProofKind = Extract<
  ProviderOutcomeProofKind,
  | 'provider_activity'
  | 'native_resume'
  | 'quota_probe_fresh'
  | 'account_adoption_verified'
>;

/**
 * Proof classes that mean "recovery reached a durable terminal state" — visible,
 * not a fabricated success.
 */
export type ProviderOutcomeTerminalProofKind = Extract<
  ProviderOutcomeProofKind,
  'terminal_action_required' | 'terminal_exhausted'
>;

const RECOVERED_PROOF_KINDS: ReadonlySet<ProviderOutcomeProofKind> = new Set<ProviderOutcomeProofKind>([
  'provider_activity',
  'native_resume',
  'quota_probe_fresh',
  'account_adoption_verified',
]);

const TERMINAL_PROOF_KINDS: ReadonlySet<ProviderOutcomeProofKind> = new Set<ProviderOutcomeProofKind>([
  'terminal_action_required',
  'terminal_exhausted',
]);

/**
 * Things that are explicitly NOT provider-outcome proof. These are the local
 * substeps that the live loops mistook for success. Resolvers that observe these
 * MUST map them to `null` (no proof) so the recovery stays pending under the
 * scheduler's backoff/exhaustion lifecycle.
 *
 * This enum exists so call sites and tests can name the negatives explicitly
 * rather than re-deriving them; it documents the contract.
 */
export const NON_PROOF_LOCAL_SUBSTEPS = [
  'local_switch_account', // a switch was applied locally; the provider may still reject the account
  'auth_store_adoption', // the auth store/home adopted the credential; not a provider acceptance
  'credential_refreshed', // a fresh token was minted; the very next spawn can still 401
  'observed_generation', // a metadata-only generation bump; no verification, no candidate change
  'generic_ok', // a bare ok:true with no outcome evidence
  'status_event_row', // a status/diagnostic event was emitted
  'continuation_enqueued', // a continuation prompt was handed off; no later provider activity yet
  'same_account_hot_apply', // the same exhausted account was re-applied for the same fingerprint
  'provider_restart_only', // the provider was restarted; no subsequent outcome evidence
  'transcript_echo_suppression', // a userMessage.send echo was suppressed; not a lost prompt and not proof
] as const;

export type NonProofLocalSubstep = (typeof NON_PROOF_LOCAL_SUBSTEPS)[number];

/**
 * True when the proof means the provider actually recovered (clear-as-recovered).
 */
export function isRecoveredProviderOutcomeProof(
  kind: ProviderOutcomeProofKind | null | undefined,
): kind is ProviderOutcomeRecoveredProofKind {
  return kind !== null && kind !== undefined && RECOVERED_PROOF_KINDS.has(kind);
}

/**
 * True when the proof means recovery reached a durable, visible terminal state.
 */
export function isTerminalProviderOutcomeProof(
  kind: ProviderOutcomeProofKind | null | undefined,
): kind is ProviderOutcomeTerminalProofKind {
  return kind !== null && kind !== undefined && TERMINAL_PROOF_KINDS.has(kind);
}
