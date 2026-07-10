/**
 * Shared classification for user prompt payloads that require dedicated session handling.
 *
 * Claude, Codex, the UI send policy, and the host queue binding all need the same answer to:
 * "can this payload be handed to a live in-flight steer queue, or must it wait for an idle/new-turn
 * boundary?"  The default non-steerable set is intentionally narrow and side-effect based: commands
 * that clear or compact session context must not be interleaved into a running turn; native slash
 * commands such as /model can be accepted by the provider TUI and sequenced at its own safe point.
 */

export interface CompactCommandResult {
  isCompact: boolean;
  originalMessage: string;
}

export interface ClearCommandResult {
  isClear: boolean;
}

export type SpecialCommandType = 'compact' | 'clear';

export interface SpecialCommandResult {
  type: SpecialCommandType | null;
  originalMessage?: string;
}

const DEFAULT_NON_STEERABLE_SPECIAL_COMMANDS = new Set<SpecialCommandType>(['clear', 'compact']);

/**
 * Parse /compact command.
 * Matches messages starting with "/compact" followed by whitespace, or exactly "/compact".
 */
export function parseCompact(message: string): CompactCommandResult {
  const trimmed = message.trim();

  if (/^\/compact(?:\s|$)/u.test(trimmed)) {
    return {
      isCompact: true,
      originalMessage: trimmed,
    };
  }

  return {
    isCompact: false,
    originalMessage: message,
  };
}

/**
 * Parse /clear command.
 * Only matches exactly "/clear".
 */
export function parseClear(message: string): ClearCommandResult {
  const trimmed = message.trim();

  return {
    isClear: trimmed === '/clear',
  };
}

/**
 * Unified parser for special commands.
 * Returns the type of command and original message if applicable.
 */
export function parseSpecialCommand(message: string): SpecialCommandResult {
  const compactResult = parseCompact(message);
  if (compactResult.isCompact) {
    return {
      type: 'compact',
      originalMessage: compactResult.originalMessage,
    };
  }

  const clearResult = parseClear(message);
  if (clearResult.isClear) {
    return {
      type: 'clear',
    };
  }

  return {
    type: null,
  };
}

export function isNonSteerableSpecialCommandType(
  type: SpecialCommandType | null,
): boolean {
  if (type === null) return false;
  return DEFAULT_NON_STEERABLE_SPECIAL_COMMANDS.has(type);
}

export function isNonSteerablePromptPayload(
  message: string | undefined,
): boolean {
  if (typeof message !== 'string') return false;
  return isNonSteerableSpecialCommandType(parseSpecialCommand(message).type);
}
