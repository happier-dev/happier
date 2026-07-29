export const CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES = [
  'ask_every_time',
  'resume_from_summary',
  'resume_full_session',
] as const;

export type ClaudeUnifiedTerminalResumeChoice =
  (typeof CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES)[number];

export const DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE:
  ClaudeUnifiedTerminalResumeChoice = 'ask_every_time';

export const CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES = [
  'ask_every_time',
  'always_trust_happier_workspaces',
  'always_reject_happier_workspaces',
] as const;

export type ClaudeUnifiedTerminalWorkspaceTrustPolicy =
  (typeof CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES)[number];

export const DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY:
  ClaudeUnifiedTerminalWorkspaceTrustPolicy = 'ask_every_time';

function normalizeEnum<TValue extends string>(
  raw: unknown,
  values: readonly TValue[],
): TValue | null {
  return typeof raw === 'string' && (values as readonly string[]).includes(raw)
    ? raw as TValue
    : null;
}

export function normalizeClaudeUnifiedTerminalResumeChoice(
  raw: unknown,
): ClaudeUnifiedTerminalResumeChoice | null {
  return normalizeEnum(raw, CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES);
}

export function normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy(
  raw: unknown,
): ClaudeUnifiedTerminalWorkspaceTrustPolicy | null {
  return normalizeEnum(raw, CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES);
}
