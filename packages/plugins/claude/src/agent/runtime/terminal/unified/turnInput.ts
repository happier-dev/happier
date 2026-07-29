import type {
  TerminalHostHandle,
  TerminalInputReadinessV1,
  TerminalPromptInput,
} from '@happier-dev/agents';
import { resolveTerminalPromptWriteTimeoutMs } from '@happier-dev/agents';

export const CLAUDE_UNIFIED_TERMINAL_INPUT_QUIET_PERIOD_MS = 800;

export function createClaudeUnifiedTerminalSessionName(sessionId: string): string {
  const normalized = sessionId.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return `happier-claude-${normalized || 'session'}`.slice(0, 96);
}

export function createClaudeUnifiedTurnId(sessionId: string, index: number): string {
  return `${sessionId}:claude-unified-turn-${index}`;
}

function isUserMessageSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function normalizeStringList(values: readonly unknown[] | null | undefined): string[] {
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || normalized.includes(text)) continue;
    normalized.push(text);
  }
  return normalized;
}

function normalizeSeqList(values: readonly unknown[] | null | undefined): number[] {
  const normalized: number[] = [];
  for (const value of values ?? []) {
    if (!isUserMessageSeq(value) || normalized.includes(value)) continue;
    normalized.push(value);
  }
  return normalized;
}

export function createClaudeUnifiedPromptInput(params: Readonly<{
  text: string;
  sessionId: string;
  nonce: number;
  isSteer: boolean;
  localId?: string | null;
  localIds?: readonly string[];
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
}>): TerminalPromptInput {
  const localIds = normalizeStringList([
    ...(typeof params.localId === 'string' ? [params.localId] : []),
    ...(params.localIds ?? []),
  ]);
  const userMessageSeqs = normalizeSeqList([
    ...(isUserMessageSeq(params.userMessageSeq) ? [params.userMessageSeq] : []),
    ...(params.userMessageSeqs ?? []),
  ]);
  return {
    text: params.text,
    multiline: params.text.includes('\n'),
    origin: {
      kind: params.isSteer ? 'ui_immediate' : 'ui_pending',
      nonce: `${params.sessionId}:${params.nonce}`,
      ...(localIds.length > 0 ? { localIds } : {}),
      ...(isUserMessageSeq(params.userMessageSeq)
        ? { userMessageSeq: params.userMessageSeq }
        : {}),
      ...(userMessageSeqs.length > 0 ? { userMessageSeqs } : {}),
    },
    scheduling: {
      ...(params.isSteer
        ? {}
        : {
          deferredUntilQuietMs: CLAUDE_UNIFIED_TERMINAL_INPUT_QUIET_PERIOD_MS,
          deferReason: 'user_typing' as const,
        }),
      timeoutMs: resolveTerminalPromptWriteTimeoutMs(params.text),
    },
  };
}

export function createClaudeUnifiedWritableReadiness(
  handle: TerminalHostHandle,
  activeTurnId: string | null,
): TerminalInputReadinessV1 {
  return {
    status: 'writable',
    observedAt: Date.now(),
    ...(activeTurnId ? { activeTurnId } : {}),
    hostKind: handle.kind,
    hostSessionName: handle.sessionName,
    ...(handle.paneId ? { paneId: handle.paneId } : {}),
  };
}
