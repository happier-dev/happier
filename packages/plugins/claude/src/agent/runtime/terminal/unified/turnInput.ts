import type {
  TerminalHostHandle,
  TerminalInputReadinessV1,
  TerminalPromptInput,
} from '@happier-dev/agents';

export function createClaudeUnifiedTerminalSessionName(sessionId: string): string {
  const normalized = sessionId.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return `happier-claude-${normalized || 'session'}`.slice(0, 96);
}

export function createClaudeUnifiedTurnId(sessionId: string, index: number): string {
  return `${sessionId}:claude-unified-turn-${index}`;
}

export function createClaudeUnifiedPromptInput(params: Readonly<{
  text: string;
  sessionId: string;
  nonce: number;
  isSteer: boolean;
}>): TerminalPromptInput {
  return {
    text: params.text,
    multiline: params.text.includes('\n'),
    origin: {
      kind: params.isSteer ? 'ui_immediate' : 'ui_pending',
      nonce: `${params.sessionId}:${params.nonce}`,
    },
    scheduling: {},
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
