import type { AgentAcpExtensionContext } from '@happier-dev/plugin-sdk/agent-runtime';

export const GROK_PROMPT_COMPLETE_METHODS = Object.freeze([
  'x.ai/session/prompt_complete',
  '_x.ai/session/prompt_complete',
] as const);
export const GROK_PROMPT_COMPLETE_METHOD = GROK_PROMPT_COMPLETE_METHODS[0];

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readExactIdentifier(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && value === value.trim()
    ? value
    : null;
}

export type GrokPromptCompletionOutcome =
  | Readonly<{ kind: 'completed'; stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'failed'; message: string }>
  | Readonly<{ kind: 'ignored' }>;

function formatAgentResult(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  try {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    if (rendered.length > 16_384) {
      return null;
    }
    return rendered.slice(0, 1_000).trim();
  } catch {
    return null;
  }
}

export function translateGrokPromptCompletion(params: unknown): Readonly<{
  sessionId: string;
  promptId: string;
  outcome: GrokPromptCompletionOutcome;
}> {
  const record = asRecord(params);
  const sessionId = readExactIdentifier(record?.sessionId);
  const promptId = readExactIdentifier(record?.promptId);
  if (!record || !sessionId || !promptId) {
    throw new Error('Grok prompt completion requires exact sessionId and promptId values');
  }
  const allowedKeys = new Set(['sessionId', 'promptId', 'stopReason', 'agentResult']);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error('Grok prompt completion contains unsupported fields');
  }
  if (
    record.stopReason !== undefined
    && (typeof record.stopReason !== 'string' || record.stopReason.length > 128)
  ) throw new Error('Grok prompt completion stopReason must be a bounded string');

  const stopReason = record.stopReason ?? 'end_turn';
  if (stopReason === 'cancelled') return { sessionId, promptId, outcome: { kind: 'cancelled' } };
  if (stopReason === 'end_turn' || stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
    return { sessionId, promptId, outcome: { kind: 'completed', stopReason } };
  }
  if (stopReason === 'refusal') {
    return { sessionId, promptId, outcome: { kind: 'failed', message: 'Grok prompt was refused' } };
  }
  const summary = stopReason === 'rate_limit'
    ? 'Grok prompt was rate limited'
    : stopReason === 'error'
      ? 'Grok prompt failed'
      : null;
  if (!summary) return { sessionId, promptId, outcome: { kind: 'ignored' } };
  const detail = formatAgentResult(record.agentResult);
  if (detail === null) return { sessionId, promptId, outcome: { kind: 'ignored' } };
  return {
    sessionId,
    promptId,
    outcome: { kind: 'failed', message: detail ? `${summary}: ${detail}` : summary },
  };
}

export function handleGrokPromptComplete(
  params: unknown,
  context: Pick<AgentAcpExtensionContext, 'method' | 'providerSessionId' | 'currentTurn'>,
): boolean {
  if (!(GROK_PROMPT_COMPLETE_METHODS as readonly string[]).includes(context.method)) return false;
  let notification: ReturnType<typeof translateGrokPromptCompletion>;
  try {
    notification = translateGrokPromptCompletion(params);
  } catch {
    return false;
  }
  if (
    notification.outcome.kind === 'ignored'
    ||
    !context.currentTurn
    || notification.sessionId !== context.providerSessionId
    || notification.promptId !== context.currentTurn.turnId
  ) return false;
  const outcome = notification.outcome.kind === 'completed'
    ? { kind: 'completed' as const }
    : notification.outcome.kind === 'cancelled'
      ? { kind: 'cancelled' as const }
      : { kind: 'failed' as const, message: notification.outcome.message };
  return context.currentTurn.submitCompletionEvidence({
    providerSessionId: notification.sessionId,
    promptId: notification.promptId,
    outcome,
  });
}
