import { z } from 'zod';

const SESSION_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

export const SessionEnvOverlaySourceV1Schema = z.enum(['profile', 'provider', 'system']);
export type SessionEnvOverlaySourceV1 = z.infer<typeof SessionEnvOverlaySourceV1Schema>;

export const SessionEnvOverlayEntryV1Schema = z.object({
  name: z.string().regex(SESSION_ENV_NAME_PATTERN, 'Invalid environment variable name'),
  value: z.string().nullable(),
  source: SessionEnvOverlaySourceV1Schema,
}).strict();
export type SessionEnvOverlayEntryV1 = z.infer<typeof SessionEnvOverlayEntryV1Schema>;

export const SessionEnvOverlayV1Schema = z.array(SessionEnvOverlayEntryV1Schema).superRefine((entries, ctx) => {
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
});
export type SessionEnvOverlayV1 = z.infer<typeof SessionEnvOverlayV1Schema>;
