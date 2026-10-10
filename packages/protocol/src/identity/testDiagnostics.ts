import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

const NonEmptyStringSchema = lazyZodSchema(() => z.string().trim().min(1));

/**
 * Sanitized evidence from one non-mutating identity test, shown to the administrator
 * who started it. It reports whether a claim was present and how the configured rules
 * decided, never the subject, login, email, or external group values themselves.
 */
export const IdentityConnectionTestDiagnosticsV1Schema = lazyZodSchema(() => z.object({
  subjectPresent: z.boolean(),
  loginAvailable: z.boolean(),
  emailAvailable: z.boolean(),
  emailVerified: z.boolean(),
  /** `count` exists only for a complete observation; absent/incomplete never invent one. */
  groups: z.object({
    state: z.enum(['complete', 'absent', 'incomplete']),
    count: z.number().int().min(0).nullable(),
  }).strict().refine(
    (value) => (value.state === 'complete') === (value.count !== null),
    'A group count is available only for a complete observation',
  ),
  eligibility: z.object({
    status: z.enum(['eligible', 'ineligible']),
    rules: z.array(z.object({
      kind: z.enum(['users', 'email_domains', 'groups_any', 'groups_all']),
      matched: z.boolean(),
    }).strict()),
  }).strict(),
  /**
   * Native Groups this connection's exact external mappings would contribute to.
   * It stays empty unless the observation is complete and the mappings are current,
   * so an empty list is never presented as proof that nothing maps.
   */
  mappedGroups: z.array(z.object({
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
  }).strict()),
}).strict());
export type IdentityConnectionTestDiagnosticsV1 = z.infer<typeof IdentityConnectionTestDiagnosticsV1Schema>;
