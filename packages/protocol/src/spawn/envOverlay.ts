import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

const SESSION_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

export const SessionEnvOverlaySourceV1Schema = lazyZodSchema(() => z.enum(['profile', 'provider', 'system']));
export type SessionEnvOverlaySourceV1 = z.infer<typeof SessionEnvOverlaySourceV1Schema>;

/** Report duplicates in portable overlays, where one name may resolve on Windows. */
export function checkUniqueSessionEnvName(
  seen: Set<string>,
  name: string,
  ctx: z.core.$RefinementCtx,
  path: (string | number)[],
  message: string,
  source: SessionEnvOverlaySourceV1 = 'provider',
): void {
  const key = `${source}\u0000${name.toUpperCase()}`;
  if (seen.has(key)) {
    ctx.addIssue({ code: 'custom', path, message, params: { reason: 'duplicate_environment_name' } });
    return;
  }
  seen.add(key);
}

export const SessionEnvOverlayEntryV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.string().check(z.regex(SESSION_ENV_NAME_PATTERN, 'Invalid environment variable name')),
  value: z.nullable(z.string()),
  source: SessionEnvOverlaySourceV1Schema,
}));
export type SessionEnvOverlayEntryV1 = z.infer<typeof SessionEnvOverlayEntryV1Schema>;

export const SessionEnvOverlayV1Schema = lazyZodSchema(() => z.array(SessionEnvOverlayEntryV1Schema).check(z.superRefine((entries, ctx) => {
  const seenBySource = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    checkUniqueSessionEnvName(
      seenBySource, entry.name, ctx, [index, 'name'],
      `Duplicate ${entry.source} environment operation for ${entry.name}`, entry.source,
    );
  }
})));
export type SessionEnvOverlayV1 = z.infer<typeof SessionEnvOverlayV1Schema>;
