import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

const SESSION_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

export const SessionEnvOverlaySourceV1Schema = lazyZodSchema(() => z.enum(['profile', 'provider', 'system']));
export type SessionEnvOverlaySourceV1 = z.infer<typeof SessionEnvOverlaySourceV1Schema>;

export const SessionEnvOverlayEntryV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.string().check(z.regex(SESSION_ENV_NAME_PATTERN, 'Invalid environment variable name')),
  value: z.nullable(z.string()),
  source: SessionEnvOverlaySourceV1Schema,
}));
export type SessionEnvOverlayEntryV1 = z.infer<typeof SessionEnvOverlayEntryV1Schema>;

export const SessionEnvOverlayV1Schema = lazyZodSchema(() => z.array(SessionEnvOverlayEntryV1Schema).check(z.superRefine((entries, ctx) => {
  const seenBySource = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const key = `${entry.source}\u0000${entry.name}`;
    if (seenBySource.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'name'],
        message: `Duplicate ${entry.source} environment operation for ${entry.name}`,
      });
      continue;
    }
    seenBySource.add(key);
  }
})));
export type SessionEnvOverlayV1 = z.infer<typeof SessionEnvOverlayV1Schema>;
