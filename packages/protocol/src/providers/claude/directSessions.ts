import { z } from 'zod';

export const CLAUDE_DIRECT_SESSIONS_PROVIDER_ID = 'claude' as const;

export const ClaudeDirectSessionsSourceSchema = z
  .object({
    kind: z.literal('claudeConfig'),
    configDir: z.string().min(1).max(10_000).nullish(),
    projectId: z.string().min(1).max(2000).nullish(),
  })
  .passthrough();

function normalizeNullableString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveClaudeDirectSessionsSourceKey(source: z.infer<typeof ClaudeDirectSessionsSourceSchema>): string {
  const configDir = normalizeNullableString(source.configDir);
  const projectId = normalizeNullableString(source.projectId);
  return `claudeConfig:${configDir}:${projectId}`;
}
