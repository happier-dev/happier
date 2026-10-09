import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { ManagedResourceDependencyV1Schema } from '../../machines/managed/managedDependencyV1.js';

/**
 * Typed Home-governance denials and conflicts.
 *
 * These are decided by the mutation's own transaction, not by a projected
 * capability, so a client that raced a role or lifecycle change receives an
 * actionable outcome instead of a generic failure.
 */
export const HomeGovernanceErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  /** The actor's current role/status does not permit this operation. */
  'home_governance_forbidden',
  /** The Home has no active owner and requires deployment-local recovery. */
  'home_governance_setup_required',
  /** The Home would be left with no active owner. */
  'home_owner_transfer_required',
  /** A Team would be left with no active owner. Decided by the Team owner. */
  'team_owner_transfer_required',
  /** The policy changed since the editor loaded it. */
  'home_policy_revision_conflict',
  /** Home settings changed since the editor loaded them. */
  'home_settings_revision_conflict',
  /** A retention sweep holds the sweep lock; a dry run can start once it finishes. */
  'retention_sweep_in_progress',
  /** Direct (Iroh) connections are not composed on this Home, or the deployment fixes their mode. */
  'home_iroh_not_available',
  /** Turning direct connections off would leave devices no address to reach this Home. */
  'home_iroh_needs_public_address',
  /** The submitted policy is structurally or referentially unusable. */
  'home_policy_invalid',
  /**
   * The patch widens sign-in, admission or storage policy and did not carry
   * `confirmWidening: true`. Nothing was written; confirm and resend.
   */
  'home_policy_widening_unconfirmed',
  /**
   * A Home claim was refused. One answer for every cause (no code printed, a
   * wrong, expired or used code, an owner already present, an inactive
   * Account), so a failed attempt learns nothing.
   */
  'home_claim_refused',
  /** The submitted Home-governance request does not match its strict input schema. */
  'invalid_home_input',
  /** A page cursor is malformed or belongs to another query. */
  'invalid_home_cursor',
  /** The target Account does not exist on this Home. */
  'home_account_not_found',
  /** The target Account is not active and cannot receive this authority. */
  'home_account_inactive',
  /** Replacement would collide with an existing membership of the same Team. */
  'team_membership_transfer_conflict',
  /** Access was revoked but cleanup did not finish; the request is retryable. */
  'account_erasure_incomplete',
  /** Transition cleanup made progress; retry before Account retirement. */
  'account_erasure_transition_cleanup_pending',
  'account_erasure_managed_resources_review_required',
]));

export type HomeGovernanceErrorCodeV1 = z.infer<typeof HomeGovernanceErrorCodeV1Schema>;

export const HomeGovernanceErrorV1Schema = lazyZodSchema(() => z.union([z.object({
  error: HomeGovernanceErrorCodeV1Schema.exclude(['account_erasure_managed_resources_review_required']),
}).strict(), z.object({
  error: z.literal('account_erasure_managed_resources_review_required'),
  resources: z.array(ManagedResourceDependencyV1Schema),
}).strict()]));

export type HomeGovernanceErrorV1 = z.infer<typeof HomeGovernanceErrorV1Schema>;

/**
 * The single Home-governance code → HTTP status mapping.
 *
 * Routes and clients both consume this owner so a validation error, authority
 * refusal, missing Account, or state conflict cannot acquire a second category
 * while crossing the Action transport.
 */
export function homeGovernanceErrorHttpStatusV1(
  code: HomeGovernanceErrorCodeV1,
): 400 | 403 | 404 | 409 {
  switch (code) {
    case 'invalid_home_input':
    case 'home_policy_invalid':
    case 'invalid_home_cursor':
      return 400;
    case 'home_governance_forbidden':
    case 'home_claim_refused':
      return 403;
    case 'home_account_not_found':
      return 404;
    case 'home_account_inactive':
    case 'home_governance_setup_required':
    case 'home_owner_transfer_required':
    case 'team_owner_transfer_required':
    case 'home_policy_revision_conflict':
    case 'home_policy_widening_unconfirmed':
    case 'home_settings_revision_conflict':
    case 'retention_sweep_in_progress':
    case 'home_iroh_not_available':
    case 'home_iroh_needs_public_address':
    case 'team_membership_transfer_conflict':
    case 'account_erasure_incomplete':
    case 'account_erasure_transition_cleanup_pending':
    case 'account_erasure_managed_resources_review_required':
      return 409;
  }
}
