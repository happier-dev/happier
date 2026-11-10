import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/** Execution placement intent; only the target daemon resolves managed paths. */
export const SessionDirectoryIntentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('path'), path: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ kind: z.literal('managed') }),
]));
export type SessionDirectoryIntentV1 = z.infer<typeof SessionDirectoryIntentV1Schema>;

/** Shared by every creation projection, so none can admit managed checkouts. */
export function refineSessionDirectoryIntentCheckoutV1(
  value: Readonly<{ directory: SessionDirectoryIntentV1; checkoutCreationDraft?: unknown }>,
  context: z.core.$RefinementCtx,
  checkoutPath: PropertyKey[] = ['checkoutCreationDraft'],
): void {
  if (value.directory.kind === 'managed' && value.checkoutCreationDraft != null) {
    context.addIssue({ code: 'custom', path: checkoutPath, message: 'Managed sessions cannot create a checkout.' });
  }
}
