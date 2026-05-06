import { z } from 'zod';

export const OH_MY_PI_DIRECT_SESSIONS_PROVIDER_ID = 'ohMyPi' as const;

export const OhMyPiDirectSessionsSourceSchema = z
  .object({
    kind: z.literal('ohMyPiAgentDir'),
    agentDir: z.string().min(1).max(10_000).nullish(),
  })
  .passthrough();

function normalizeNullableString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveOhMyPiDirectSessionsSourceKey(source: z.infer<typeof OhMyPiDirectSessionsSourceSchema>): string {
  const agentDir = normalizeNullableString(source.agentDir);
  return `ohMyPiAgentDir:${agentDir}`;
}
