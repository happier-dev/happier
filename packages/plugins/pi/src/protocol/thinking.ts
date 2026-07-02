export const PI_NEW_SESSION_OPTION_THINKING_LEVEL = 'piThinkingLevel' as const;

export const PI_THINKING_LEVEL_ENV = 'HAPPIER_PI_THINKING_LEVEL' as const;

export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

const PI_THINKING_LEVELS_SET: ReadonlySet<string> = new Set(PI_THINKING_LEVELS);

export function normalizePiThinkingLevel(value: unknown): PiThinkingLevel | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return PI_THINKING_LEVELS_SET.has(normalized) ? (normalized as PiThinkingLevel) : null;
}

export function applyPiThinkingLevelEnv(
  environmentVariables: Record<string, string> | undefined,
  thinkingLevelRaw: unknown,
): Record<string, string> | undefined {
  const thinkingLevel = normalizePiThinkingLevel(thinkingLevelRaw);
  if (!thinkingLevel) return environmentVariables;
  return {
    ...(environmentVariables ?? {}),
    [PI_THINKING_LEVEL_ENV]: thinkingLevel,
  };
}

export function resolvePiThinkingLevelFromEnv(env: Readonly<Record<string, string | undefined>>): PiThinkingLevel | null {
  return normalizePiThinkingLevel(env[PI_THINKING_LEVEL_ENV]);
}
