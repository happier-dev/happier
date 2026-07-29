// Test support parser for the pinned public evidence fixture.
export type AuggieStopCauseV0_24_0 =
  | 'end_turn'
  | 'interrupted'
  | 'max_iterations'
  | 'error'
  | 'unknown';

type AuggieLifecycleIdentityV0_24_0 = Readonly<{
  conversationId: string;
  workspaceRoots: readonly string[];
}>;

export type AuggieLifecycleHookV0_24_0 =
  | (AuggieLifecycleIdentityV0_24_0 & Readonly<{ kind: 'session_started' }>)
  | (AuggieLifecycleIdentityV0_24_0 & Readonly<{ kind: 'session_ended' }>)
  | (AuggieLifecycleIdentityV0_24_0 & Readonly<{
    kind: 'turn_stopped';
    cause: AuggieStopCauseV0_24_0;
  }>);

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readTrimmedString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readWorkspaceRoots(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const roots: string[] = [];
  for (const root of value) {
    if (typeof root !== 'string' || root.trim().length === 0) return null;
    roots.push(root.trim());
  }
  return roots;
}

function readStopCause(value: unknown): AuggieStopCauseV0_24_0 {
  switch (value) {
    case 'end_turn':
    case 'interrupted':
    case 'max_iterations':
    case 'error':
      return value;
    default:
      return 'unknown';
  }
}

/**
 * Parses Auggie 0.24.0's documented session lifecycle hook envelope as an
 * observation only. It deliberately makes no host status/control decision.
 */
export function parseAuggieLifecycleHookV0_24_0(raw: unknown): AuggieLifecycleHookV0_24_0 | null {
  const record = asRecord(raw);
  if (!record) return null;

  const eventName = readTrimmedString(record, 'hook_event_name');
  const conversationId = readTrimmedString(record, 'conversation_id');
  const workspaceRoots = readWorkspaceRoots(record.workspace_roots);
  if (!eventName || !conversationId || !workspaceRoots) return null;

  const identity = { conversationId, workspaceRoots };
  switch (eventName) {
    case 'SessionStart':
      return { kind: 'session_started', ...identity };
    case 'SessionEnd':
      return { kind: 'session_ended', ...identity };
    case 'Stop':
      return {
        kind: 'turn_stopped',
        ...identity,
        cause: readStopCause(record.agent_stop_cause),
      };
    default:
      return null;
  }
}
