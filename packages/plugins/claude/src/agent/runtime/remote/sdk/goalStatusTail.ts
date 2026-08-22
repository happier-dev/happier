import type {
  AgentTranscriptFileFollowHandle,
  AgentTranscriptFileFollowService,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { ClaudeRuntimeLogger } from '../../dependencies.js';

/**
 * Narrow `goal_status` transcript observer for the Claude agent-SDK runner.
 *
 * The agent-SDK session derives its rendered transcript from the live `query()`
 * `SDKMessage` stream, which carries the system-init `slash_commands` (the `/goal`
 * capability) but NOT the `goal_status` attachment Claude persists when the active
 * goal changes — that attachment is FILE-ONLY. This helper replays the session's
 * persisted transcript JSONL through the SAME host `transcripts.fileFollow.follow`
 * mechanism the unified runner uses, extracts ONLY `goal_status` attachment rows,
 * and feeds them to the goal source. Every other row (assistant/user/system/other
 * attachments) is ignored here — the live stream is the source of truth for those,
 * so this never double-renders the transcript.
 */

type GoalStatusTailContext = Readonly<{
  agentRuntime: Readonly<{
    transcripts: Readonly<{
      fileFollow: Pick<AgentTranscriptFileFollowService, 'follow'>;
    }>;
  }>;
  logger: Pick<ClaudeRuntimeLogger, 'debug'>;
}>;

export type ClaudeAgentSdkGoalStatusTail = Readonly<{
  dispose(): Promise<void>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGoalStatusAttachmentRow(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'attachment') return false;
  const attachment = value.attachment;
  return isRecord(attachment) && attachment.type === 'goal_status';
}

export function createClaudeAgentSdkGoalStatusTail(params: Readonly<{
  ctx: GoalStatusTailContext;
  transcriptPath: string;
  observeGoalStatusRow: (row: unknown) => void;
}>): ClaudeAgentSdkGoalStatusTail {
  let disposed = false;
  let handle: AgentTranscriptFileFollowHandle | null = null;

  const started = (async () => {
    try {
      const followHandle = await params.ctx.agentRuntime.transcripts.fileFollow.follow({
        path: params.transcriptPath,
        // Latest-wins goal reduction: replaying the file from the beginning converges to
        // the current goal (and an already-cleared goal maps back to empty), so a resumed
        // session restores the live goal without an out-of-band capability path.
        startAt: 'beginning',
        strategy: 'poll',
        onLine: async ({ line }) => {
          if (disposed) return;
          const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
          if (!trimmed.trim()) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            return;
          }
          if (!isGoalStatusAttachmentRow(parsed)) return;
          try {
            params.observeGoalStatusRow(parsed);
          } catch (error) {
            params.ctx.logger.debug('[ClaudeAgentSdk] goal_status observer callback failed (non-fatal)', { error });
          }
        },
        onError: (error) => {
          params.ctx.logger.debug('[ClaudeAgentSdk] goal_status transcript observer error (non-fatal)', { error });
        },
      });
      if (disposed) {
        await followHandle.close().catch(() => undefined);
        return;
      }
      handle = followHandle;
    } catch (error) {
      params.ctx.logger.debug('[ClaudeAgentSdk] goal_status transcript observer unavailable (non-fatal)', { error });
    }
  })();

  return {
    async dispose() {
      disposed = true;
      await started.catch(() => undefined);
      const activeHandle = handle;
      handle = null;
      if (activeHandle) {
        await activeHandle.close().catch(() => undefined);
      }
    },
  };
}
