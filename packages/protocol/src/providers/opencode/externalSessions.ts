import { z } from 'zod';

export const OPENCODE_EXTERNAL_SESSIONS_PROVIDER_ID = 'opencode' as const;

export const OpenCodeExternalSessionsSourceSchema = z
  .object({
    kind: z.literal('opencodeServer'),
    baseUrl: z.string().url().nullish(),
    directory: z.string().min(1).max(10_000).nullish(),
  })
  .passthrough();

function normalizeNullableString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveOpenCodeExternalSessionsSourceKey(source: z.infer<typeof OpenCodeExternalSessionsSourceSchema>): string {
  const baseUrl = normalizeNullableString(source.baseUrl);
  const directory = normalizeNullableString(source.directory);
  return `opencodeServer:${baseUrl}:${directory}`;
}
