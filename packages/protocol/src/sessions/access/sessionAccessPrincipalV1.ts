import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { AccountDisplayProfileV1BaseSchema, readAccountNameFromLegacyProfileV1 } from '../../account/accountDisplayProfileV1.js';

/** An authorized Session projection's neutral Account identity, never a social profile. */
export const SessionAccessAccountSummaryV1Schema = lazyZodSchema(() => z.pipe((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AccountDisplayProfileV1BaseSchema, {
  kind: z.literal('account'),
  accountId: z.string().check(z.minLength(1)),
})), z.transform(profile => ({ ...profile, name: readAccountNameFromLegacyProfileV1(profile) }))));
export type SessionAccessAccountSummaryV1 = z.infer<typeof SessionAccessAccountSummaryV1Schema>;
