import { z } from 'zod';

export const CLAUDE_EXTERNAL_SESSIONS_PROVIDER_ID = 'claude' as const;

export const ClaudeExternalSessionsSourceSchema = z
  .object({
    kind: z.literal('claudeConfig'),
    configDir: z.string().min(1).max(10_000).nullish(),
    projectId: z.string().min(1).max(2000).nullish(),
  })
  .passthrough();

function normalizeNullableString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveClaudeExternalSessionsSourceKey(source: z.infer<typeof ClaudeExternalSessionsSourceSchema>): string {
  const configDir = normalizeNullableString(source.configDir);
  const projectId = normalizeNullableString(source.projectId);
  return `claudeConfig:${configDir}:${projectId}`;
}
