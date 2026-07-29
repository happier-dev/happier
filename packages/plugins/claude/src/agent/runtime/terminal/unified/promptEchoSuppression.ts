import { normalizeClaudeUnifiedPromptIdentityText } from './promptIdentity.js';

export type ClaudeUnifiedPromptEchoSuppressor = Readonly<{
  recordAcceptedPrompt(input: Readonly<{
    text: string;
    acceptedAtMs?: number;
    agentTurnId?: string | null;
    retainUntilObserved?: boolean;
  }>): void;
  consumeAcceptedPromptEcho(input: Readonly<{ text: string; observedAtMs?: number; agentTurnId?: string | null }>): boolean;
  // Hook and JSONL identities may differ during one live turn; after it ends, same-text rows are independent input.
  clearAcceptedPromptEchoes(): void;
  recordMaterializedTerminalPrompt(input: Readonly<{ text: string; materializedAtMs?: number; agentTurnId?: string | null }>): void;
  consumeMaterializedTerminalPromptDuplicate(input: Readonly<{ text: string; observedAtMs?: number; agentTurnId?: string | null }>): boolean;
}>;

export type ClaudeUnifiedPromptEchoSuppressorOptions = Readonly<{
  acceptedPromptEchoWindowMs?: number;
  terminalPromptDuplicateWindowMs?: number;
  nowMs?: () => number;
}>;

type PendingPromptText = Readonly<{
  text: string;
  expiresAtMs: number | null;
  agentTurnId: string | null;
  retainUntilObserved: boolean;
}>;

const DEFAULT_ACCEPTED_PROMPT_ECHO_WINDOW_MS = 30_000;
const DEFAULT_TERMINAL_PROMPT_DUPLICATE_WINDOW_MS = 30_000;

function normalizeWindowMs(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(100, Math.trunc(value));
}

function normalizeText(value: string): string | null {
  const trimmed = normalizeClaudeUnifiedPromptIdentityText(value);
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeProviderTurnId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pruneExpired(prompts: PendingPromptText[], observedAtMs: number): void {
  for (let index = prompts.length - 1; index >= 0; index -= 1) {
    const expiresAtMs = prompts[index]?.expiresAtMs;
    if (expiresAtMs !== null && expiresAtMs !== undefined && expiresAtMs < observedAtMs) {
      prompts.splice(index, 1);
    }
  }
}

function promptMatches(
  prompt: PendingPromptText,
  input: Readonly<{ text: string; agentTurnId?: string | null }>,
): boolean {
  const text = normalizeText(input.text);
  if (text === null || prompt.text !== text) return false;
  if (prompt.retainUntilObserved) return true;

  const agentTurnId = normalizeProviderTurnId(input.agentTurnId);
  if (prompt.agentTurnId !== null && agentTurnId !== null) {
    return prompt.agentTurnId === agentTurnId;
  }
  if (prompt.agentTurnId !== null || agentTurnId !== null) {
    return false;
  }
  return true;
}

function consumeMatchingPrompt(
  prompts: PendingPromptText[],
  input: Readonly<{ text: string; observedAtMs?: number; agentTurnId?: string | null }>,
  nowMs: () => number,
): boolean {
  const text = normalizeText(input.text);
  if (!text) return false;
  const observedAtMs =
    typeof input.observedAtMs === 'number' && Number.isFinite(input.observedAtMs)
      ? Math.trunc(input.observedAtMs)
      : nowMs();
  pruneExpired(prompts, observedAtMs);
  const matchIndex = prompts.findIndex((prompt) => promptMatches(prompt, {
    text,
    agentTurnId: input.agentTurnId,
  }));
  if (matchIndex < 0) return false;
  prompts.splice(matchIndex, 1);
  return true;
}

export function createClaudeUnifiedPromptEchoSuppressor(
  options: ClaudeUnifiedPromptEchoSuppressorOptions = {},
): ClaudeUnifiedPromptEchoSuppressor {
  const acceptedPromptEchoes: PendingPromptText[] = [];
  const materializedTerminalPrompts: PendingPromptText[] = [];
  const nowMs = options.nowMs ?? Date.now;
  const acceptedPromptEchoWindowMs = normalizeWindowMs(
    options.acceptedPromptEchoWindowMs,
    DEFAULT_ACCEPTED_PROMPT_ECHO_WINDOW_MS,
  );
  const terminalPromptDuplicateWindowMs = normalizeWindowMs(
    options.terminalPromptDuplicateWindowMs,
    DEFAULT_TERMINAL_PROMPT_DUPLICATE_WINDOW_MS,
  );

  return {
    recordAcceptedPrompt(input) {
      const text = normalizeText(input.text);
      if (!text) return;
      const acceptedAtMs =
        typeof input.acceptedAtMs === 'number' && Number.isFinite(input.acceptedAtMs)
          ? Math.trunc(input.acceptedAtMs)
          : nowMs();
      pruneExpired(acceptedPromptEchoes, acceptedAtMs);
      acceptedPromptEchoes.push({
        text,
        expiresAtMs: input.retainUntilObserved === true
          ? null
          : acceptedAtMs + acceptedPromptEchoWindowMs,
        agentTurnId: normalizeProviderTurnId(input.agentTurnId),
        retainUntilObserved: input.retainUntilObserved === true,
      });
    },
    consumeAcceptedPromptEcho(input) {
      return consumeMatchingPrompt(acceptedPromptEchoes, input, nowMs);
    },
    clearAcceptedPromptEchoes() {
      acceptedPromptEchoes.length = 0;
    },
    recordMaterializedTerminalPrompt(input) {
      const text = normalizeText(input.text);
      if (!text) return;
      const materializedAtMs =
        typeof input.materializedAtMs === 'number' && Number.isFinite(input.materializedAtMs)
          ? Math.trunc(input.materializedAtMs)
          : nowMs();
      pruneExpired(materializedTerminalPrompts, materializedAtMs);
      materializedTerminalPrompts.push({
        text,
        expiresAtMs: materializedAtMs + terminalPromptDuplicateWindowMs,
        agentTurnId: normalizeProviderTurnId(input.agentTurnId),
        retainUntilObserved: false,
      });
    },
    consumeMaterializedTerminalPromptDuplicate(input) {
      return consumeMatchingPrompt(materializedTerminalPrompts, input, nowMs);
    },
  };
}
