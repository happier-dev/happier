export type ClaudeUnifiedPromptEchoSuppressor = Readonly<{
  recordAcceptedPrompt(input: Readonly<{ text: string; acceptedAtMs?: number }>): void;
  consumeAcceptedPromptEcho(input: Readonly<{ text: string; observedAtMs?: number }>): boolean;
  recordMaterializedTerminalPrompt(input: Readonly<{ text: string; materializedAtMs?: number }>): void;
  consumeMaterializedTerminalPromptDuplicate(input: Readonly<{ text: string; observedAtMs?: number }>): boolean;
}>;

export type ClaudeUnifiedPromptEchoSuppressorOptions = Readonly<{
  acceptedPromptEchoWindowMs?: number;
  terminalPromptDuplicateWindowMs?: number;
  nowMs?: () => number;
}>;

type PendingPromptText = Readonly<{
  text: string;
  expiresAtMs: number;
}>;

const DEFAULT_ACCEPTED_PROMPT_ECHO_WINDOW_MS = 30_000;
const DEFAULT_TERMINAL_PROMPT_DUPLICATE_WINDOW_MS = 30_000;

function normalizeWindowMs(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(100, Math.trunc(value));
}

function normalizeText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pruneExpired(prompts: PendingPromptText[], observedAtMs: number): void {
  while (prompts.length > 0) {
    const next = prompts[0];
    if (!next || next.expiresAtMs >= observedAtMs) return;
    prompts.shift();
  }
}

function consumeMatchingPrompt(
  prompts: PendingPromptText[],
  input: Readonly<{ text: string; observedAtMs?: number }>,
  nowMs: () => number,
): boolean {
  const text = normalizeText(input.text);
  if (!text) return false;
  const observedAtMs =
    typeof input.observedAtMs === 'number' && Number.isFinite(input.observedAtMs)
      ? Math.trunc(input.observedAtMs)
      : nowMs();
  pruneExpired(prompts, observedAtMs);
  const matchIndex = prompts.findIndex((prompt) => prompt.text === text);
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
        expiresAtMs: acceptedAtMs + acceptedPromptEchoWindowMs,
      });
    },
    consumeAcceptedPromptEcho(input) {
      return consumeMatchingPrompt(acceptedPromptEchoes, input, nowMs);
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
      });
    },
    consumeMaterializedTerminalPromptDuplicate(input) {
      return consumeMatchingPrompt(materializedTerminalPrompts, input, nowMs);
    },
  };
}
