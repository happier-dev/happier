import type { AgentModelOption } from '@happier-dev/protocol';

export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

export function normalizeClaudeEffortLevel(raw: unknown): ClaudeEffortLevel | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return CLAUDE_EFFORT_LEVELS.find((level) => level === value) ?? null;
}

export function formatClaudeEffortLevelLabel(level: ClaudeEffortLevel): string {
  switch (level) {
    case 'low': return 'Low';
    case 'medium': return 'Medium';
    case 'high': return 'High';
    case 'xhigh': return 'XHigh';
    case 'max': return 'Max';
  }
}

export function buildClaudeModelOptions(input: Readonly<{
  supportedLevels: readonly ClaudeEffortLevel[];
  defaultEffort?: ClaudeEffortLevel | null;
}>): readonly AgentModelOption[] {
  const supported = new Set(input.supportedLevels);
  const levels = CLAUDE_EFFORT_LEVELS.filter((level) => supported.has(level));
  if (levels.length === 0) return [];

  const currentValue = input.defaultEffort && supported.has(input.defaultEffort)
    ? input.defaultEffort
    : supported.has('high')
      ? 'high'
      : levels[levels.length - 1]!;
  const options: AgentModelOption[] = [{
    id: 'reasoning_effort',
    name: 'Thinking',
    type: 'select',
    currentValue,
    options: levels.map((level) => ({
      value: level,
      name: formatClaudeEffortLevelLabel(level),
    })),
  }];

  if (supported.has('xhigh')) {
    options.push({
      id: 'ultracode',
      name: 'Ultracode',
      description: 'Maximum coding effort. Forces XHigh Thinking effort while enabled.',
      type: 'boolean',
      currentValue: 'false',
      overridesWhenOn: {
        optionIds: ['reasoning_effort'],
        forcedValue: 'xhigh',
      },
    });
  }

  return options;
}
