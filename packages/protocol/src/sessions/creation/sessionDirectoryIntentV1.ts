import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/** Execution placement intent; only the target daemon resolves managed paths. */
export const SessionDirectoryIntentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), path: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('managed') }).strict(),
]));
export type SessionDirectoryIntentV1 = z.infer<typeof SessionDirectoryIntentV1Schema>;

/** Shared by every creation projection, so none can admit managed checkouts. */
export function refineSessionDirectoryIntentCheckoutV1(
  value: Readonly<{ directory: SessionDirectoryIntentV1; checkoutCreationDraft?: unknown }>,
  context: z.RefinementCtx,
  checkoutPath: PropertyKey[] = ['checkoutCreationDraft'],
): void {
  if (value.directory.kind === 'managed' && value.checkoutCreationDraft != null) {
    context.addIssue({ code: 'custom', path: checkoutPath, message: 'Managed sessions cannot create a checkout.' });
  }
}
