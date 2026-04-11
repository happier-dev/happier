import { z } from 'zod';

export const OPENCODE_DIRECT_SESSIONS_PROVIDER_ID = 'opencode' as const;

export const OpenCodeDirectSessionsSourceSchema = z
  .object({
    kind: z.literal('opencodeServer'),
    baseUrl: z.string().url().nullish(),
    directory: z.string().min(1).max(10_000).nullish(),
  })
  .passthrough();

function normalizeNullableString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveOpenCodeDirectSessionsSourceKey(source: z.infer<typeof OpenCodeDirectSessionsSourceSchema>): string {
  const baseUrl = normalizeNullableString(source.baseUrl);
  const directory = normalizeNullableString(source.directory);
  return `opencodeServer:${baseUrl}:${directory}`;
}
