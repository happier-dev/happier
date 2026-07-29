import type {
  PluginStorageScopeService,
} from '@happier-dev/plugin-sdk/runtime';
import type { ClaudeRuntimeLogger } from '../../dependencies.js';

const CLAUDE_TERMINAL_ORIGIN_SEQUENCE_STORAGE_KEY = 'claude.unifiedTerminal.terminalOriginPromptSequence.v1';

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStoredSequence(value: unknown): number {
  const record = isRecord(value) ? value : null;
  if (record?.v !== 1) return 0;
  const lastNonce = record.lastNonce;
  return typeof lastNonce === 'number' && Number.isInteger(lastNonce) && lastNonce > 0
    ? lastNonce
    : 0;
}

export function createClaudeUnifiedTerminalOriginLocalIdAllocator(params: Readonly<{
  ctx: Readonly<{
    logger: Pick<ClaudeRuntimeLogger, 'debug'>;
    storage: Readonly<{ session: Pick<PluginStorageScopeService, 'get' | 'set'> }>;
  }>;
  sessionId: string;
}>): Readonly<{
  next(input?: Readonly<{ agentTurnId?: string | null }>): Promise<string>;
}> {
  let inMemoryLastNonce = 0;

  async function readLastNonce(): Promise<number> {
    try {
      return readStoredSequence(await params.ctx.storage.session.get(CLAUDE_TERMINAL_ORIGIN_SEQUENCE_STORAGE_KEY));
    } catch (error) {
      params.ctx.logger.debug('[ClaudeUnifiedTerminal] failed to read terminal-origin prompt sequence', { error });
      return inMemoryLastNonce;
    }
  }

  async function writeLastNonce(lastNonce: number): Promise<void> {
    try {
      await params.ctx.storage.session.set(CLAUDE_TERMINAL_ORIGIN_SEQUENCE_STORAGE_KEY, {
        v: 1,
        lastNonce,
      });
    } catch (error) {
      params.ctx.logger.debug('[ClaudeUnifiedTerminal] failed to persist terminal-origin prompt sequence', { error });
    }
  }

  return {
    async next(input = {}) {
      const agentTurnId = normalizeString(input.agentTurnId);
      if (agentTurnId) {
        return `${params.sessionId}:claude-terminal-origin-provider:${encodeURIComponent(agentTurnId)}`;
      }
      const lastNonce = Math.max(inMemoryLastNonce, await readLastNonce());
      const nextNonce = lastNonce + 1;
      inMemoryLastNonce = nextNonce;
      await writeLastNonce(nextNonce);
      return `${params.sessionId}:claude-terminal-origin-${nextNonce}`;
    },
  };
}
