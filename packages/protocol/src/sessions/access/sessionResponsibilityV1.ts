import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { AccountDisplayProfileV1Schema } from '../../account/accountDisplayProfileV1.js';
import {
  HOME_ACCOUNT_PAGE_CURSOR_MAX_LENGTH_V1,
  HOME_ACCOUNT_PAGE_LIMIT_MAX_V1,
  HOME_ACCOUNT_SEARCH_QUERY_MAX_LENGTH_V1,
} from '../../home/governance/accounts.js';
import { SessionAccessAccountSummaryV1Schema } from './sessionAccessPrincipalV1.js';

/**
 * One nullable human Account is currently expected to handle a Session.
 *
 * Responsibility is not access: assigning grants nothing and requires the
 * target to already read the Session. The request is strict because this is an
 * identity/authority boundary where an unknown field is a bug, not an additive
 * extension.
 */
export const SetSessionResponsibilityRequestSchema = lazyZodSchema(() => z.strictObject({
    sessionId: z.string().check(z.minLength(1)),
    responsibleAccountId: z.nullable(z.string().check(z.minLength(1))),
  }));
export type SetSessionResponsibilityRequest = z.infer<typeof SetSessionResponsibilityRequestSchema>;

/**
 * The shared desired-state Action returns the actual mutation outcome. It does
 * not expose another Account's identity, the transient alert handoff, or any
 * recipient's delivery state.
 *
 * `responsibleAccount` is the safe current summary for the authoritative id:
 * `null` when unassigned, matching `responsibleAccountId`. It lets read-only
 * viewers and unloaded candidate pages render the named assignee without a
 * new identity endpoint or candidate-query bypass.
 * `autoFollowed` is the transient result of this exact committed assignment;
 * it is never persisted as assignment origin or inferred by a client.
 */
export const SetSessionResponsibilityResponseSchema = lazyZodSchema(() => z.strictObject({
    changed: z.boolean(),
    responsibleAccountId: z.nullable(z.string().check(z.minLength(1))),
    responsibleAccount: z.nullable(SessionAccessAccountSummaryV1Schema),
    autoFollowed: z.boolean(),
  }).check(z.superRefine((value, ctx) => {
    if (value.autoFollowed && (!value.changed || value.responsibleAccountId === null)) {
      ctx.addIssue({
        code: "custom",
        message: 'auto-Follow requires this response to describe a changed assignment',
        path: ['autoFollowed'],
      });
    }
    if (value.responsibleAccountId === null && value.responsibleAccount !== null) {
      ctx.addIssue({ code: "custom", message: 'unassigned responsibility must project a null summary', path: ['responsibleAccount'] });
    }
    if (
      typeof value.responsibleAccountId === 'string' &&
      (value.responsibleAccount === null || value.responsibleAccount.accountId !== value.responsibleAccountId)
    ) {
      ctx.addIssue({ code: "custom", message: 'assigned responsibility must project the matching summary', path: ['responsibleAccount'] });
    }
  })));
export type SetSessionResponsibilityResponse = z.infer<typeof SetSessionResponsibilityResponseSchema>;

/**
 * The authorized purpose of one principal-discovery page.
 *
 * `assignment` requires the actor's `assignResponsibility` capability. `mention`
 * reuses the same bounded audience projection for discussion editors without
 * exposing assignment-only access hints.
 */
export const SessionResponsibilityCandidatePurposeV1Schema = lazyZodSchema(() => z.enum(['assignment', 'mention']));
export type SessionResponsibilityCandidatePurposeV1 =
  z.infer<typeof SessionResponsibilityCandidatePurposeV1Schema>;

export const SessionResponsibilityCandidatesRequestSchema = lazyZodSchema(() => z.strictObject({
    sessionId: z.string().check(z.minLength(1)),
    purpose: SessionResponsibilityCandidatePurposeV1Schema,
    query: z.optional(z.string().check(z.minLength(1), z.maxLength(HOME_ACCOUNT_SEARCH_QUERY_MAX_LENGTH_V1))),
    cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(HOME_ACCOUNT_PAGE_CURSOR_MAX_LENGTH_V1))),
    limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(HOME_ACCOUNT_PAGE_LIMIT_MAX_V1))),
  }));
export type SessionResponsibilityCandidatesRequest =
  z.infer<typeof SessionResponsibilityCandidatesRequestSchema>;

/**
 * The bounded access context a candidate row may carry. It repeats only what
 * the acting Account is already authorized to see about this Session, and never
 * the grant topology that produced it.
 */
export const SessionResponsibilityCandidateAccessHintV1Schema = lazyZodSchema(() => z.enum([
  'view',
  'edit',
  'admin',
  'owner',
]));
export type SessionResponsibilityCandidateAccessHintV1 =
  z.infer<typeof SessionResponsibilityCandidateAccessHintV1Schema>;

export const SessionResponsibilityCandidateV1Schema = lazyZodSchema(() => z.strictObject({
    accountId: z.string().check(z.minLength(1)),
    profile: AccountDisplayProfileV1Schema,
    accessHint: z.optional(SessionResponsibilityCandidateAccessHintV1Schema),
  }));
export type SessionResponsibilityCandidateV1 = z.infer<typeof SessionResponsibilityCandidateV1Schema>;

export const SessionResponsibilityCandidatesResponseSchema = lazyZodSchema(() => z.strictObject({
    candidates: z.array(SessionResponsibilityCandidateV1Schema),
    nextCursor: z.nullable(z.string().check(z.minLength(1), z.maxLength(HOME_ACCOUNT_PAGE_CURSOR_MAX_LENGTH_V1))),
  }));
export type SessionResponsibilityCandidatesResponse =
  z.infer<typeof SessionResponsibilityCandidatesResponseSchema>;

export {
  SESSION_RESPONSIBILITY_ASSIGNEE_UNAVAILABLE_V1,
  SESSION_RESPONSIBILITY_CANDIDATES_INVALID_CURSOR_V1,
} from './sessionAccessErrorCodeV1.js';
