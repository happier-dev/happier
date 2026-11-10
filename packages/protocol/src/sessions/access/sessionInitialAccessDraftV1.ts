import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import type { PrincipalRefV1 } from '../../teams/principal.js';
import { SessionGrantIntentV1Schema, SessionGrantMutationV1Schema } from './sessionAccessGrantV1.js';

function enforceUniqueSubjects(
  draft: Readonly<{ grants: readonly Readonly<{ subject: PrincipalRefV1 }>[] }>,
  ctx: z.core.$RefinementCtx,
) {
  const subjects = new Set<string>();
  for (const [index, grant] of draft.grants.entries()) {
    const subject = grant.subject;
    // Group IDs are Home-wide. Supplying another parent cannot create another grant.
    const key = JSON.stringify(subject.kind === 'account'
      ? ['account', subject.accountId]
      : subject.kind === 'team' ? ['team', subject.teamId] : ['group', subject.groupId]);
    if (subjects.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['grants', index, 'subject'], message: 'Duplicate grant subject' });
    }
    subjects.add(key);
  }
}

/** Public desired-state access authored before a Session exists. */
export const SessionInitialAccessDraftV1Schema = lazyZodSchema(() => z.strictObject({
  grants: z.array(SessionGrantIntentV1Schema),
}).check(z.superRefine(enforceUniqueSubjects)));
export type SessionInitialAccessDraftV1 = z.infer<typeof SessionInitialAccessDraftV1Schema>;

/** Private create-request shape after the trusted creator host seals ready recipients. */
export const SessionInitialAccessMaterializedV1Schema = lazyZodSchema(() => z.strictObject({
  grants: z.array(SessionGrantMutationV1Schema),
}).check(z.superRefine(enforceUniqueSubjects)));
export type SessionInitialAccessMaterializedV1 = z.infer<typeof SessionInitialAccessMaterializedV1Schema>;
