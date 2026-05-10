import { z } from 'zod';

export const OH_MY_PI_EXTERNAL_SESSIONS_PROVIDER_ID = 'ohMyPi' as const;

export const OhMyPiExternalSessionsSourceSchema = z
  .object({
    kind: z.literal('ohMyPiAgentDir'),
    agentDir: z.string().min(1).max(10_000).nullish(),
  })
  .passthrough();

function normalizeNullableString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveOhMyPiExternalSessionsSourceKey(source: z.infer<typeof OhMyPiExternalSessionsSourceSchema>): string {
  const agentDir = normalizeNullableString(source.agentDir);
  return `ohMyPiAgentDir:${agentDir}`;
}
