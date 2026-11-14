import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { TeamGroupNameProjectionV1Schema } from '../teams/groupLabel.js';

const NonEmptyStringSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

/**
 * Sanitized evidence from one non-mutating identity test, shown to the administrator
 * who started it. It reports whether a claim was present and how the configured rules
 * decided, never the subject, login, email, or external group values themselves.
 */
export const IdentityConnectionTestDiagnosticsV1Schema = lazyZodSchema(() => z.strictObject({
  subjectPresent: z.boolean(),
  loginAvailable: z.boolean(),
  emailAvailable: z.boolean(),
  emailVerified: z.boolean(),
  /** `count` exists only for a complete observation; absent/incomplete never invent one. */
  groups: z.strictObject({
    state: z.enum(['complete', 'absent', 'incomplete']),
    count: z.nullable(z.number().check(z.int(), z.minimum(0))),
  }).check(z.refine((value) => (value.state === 'complete') === (value.count !== null), 'A group count is available only for a complete observation')),
  eligibility: z.strictObject({
    status: z.enum(['eligible', 'ineligible']),
    rules: z.array(z.strictObject({
      kind: z.enum(['users', 'email_domains', 'groups_any', 'groups_all']),
      matched: z.boolean(),
    })),
  }),
  /**
   * Native Groups this connection's exact external mappings would contribute to.
   * It stays empty unless the observation is complete and the mappings are current,
   * so an empty list is never presented as proof that nothing maps.
   */
  mappedGroups: z.array(z.strictObject({
    id: NonEmptyStringSchema,
    name: TeamGroupNameProjectionV1Schema,
  })),
}));
export type IdentityConnectionTestDiagnosticsV1 = z.infer<typeof IdentityConnectionTestDiagnosticsV1Schema>;
