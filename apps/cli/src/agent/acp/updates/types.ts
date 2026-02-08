import type { AgentMessage } from '../../core';
import type { TransportHandler } from '../../transport';

/**
 * Default timeout for idle detection after message chunks (ms).
 * Used when transport handler doesn't provide getIdleTimeout().
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 500;

/**
 * Default timeout for tool calls if transport doesn't specify (ms).
 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 120_000;

/**
 * Extended session update structure with all possible fields.
 */
export interface SessionUpdate {
  sessionUpdate?: string;
  toolCallId?: string;
  status?: string;
  kind?: string | unknown;
  title?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  input?: unknown;
  output?: unknown;
  // Some ACP providers (notably Gemini CLI) may surface tool outputs in other fields.
  result?: unknown;
  liveContent?: unknown;
  live_content?: unknown;
  meta?: unknown;
  availableCommands?: Array<{ name?: string; description?: string } | unknown>;
  currentModeId?: string;
  entries?: unknown;
  content?: {
    text?: string;
    error?: string | { message?: string };
    type?: string;
    [key: string]: unknown;
  } | string | unknown;
  locations?: unknown[];
  messageChunk?: {
    textDelta?: string;
  };
  plan?: unknown;
  thinking?: unknown;
  [key: string]: unknown;
}

/**
 * Context for session update handlers.
 */
export interface HandlerContext {
  /** Transport handler for agent-specific behavior */
  transport: TransportHandler;
  /** Set of active tool call IDs */
  activeToolCalls: Set<string>;
  /** Map of tool call ID to start time */
  toolCallStartTimes: Map<string, number>;
  /** Map of tool call ID to timeout handle */
  toolCallTimeouts: Map<string, NodeJS.Timeout>;
  /** Map of tool call ID to tool name */
  toolCallIdToNameMap: Map<string, string>;
  /** Map of tool call ID to the most-recent raw input (for permission prompts that omit args) */
  toolCallIdToInputMap: Map<string, Record<string, unknown>>;
  /** Current idle timeout handle */
  idleTimeout: NodeJS.Timeout | null;
  /** Tool call counter since last prompt */
  toolCallCountSincePrompt: number;
  /** Emit function to send agent messages */
  emit: (msg: AgentMessage) => void;
  /** Emit idle status helper */
  emitIdleStatus: () => void;
  /** Clear idle timeout helper */
  clearIdleTimeout: () => void;
  /** Set idle timeout helper */
  setIdleTimeout: (callback: () => void, ms: number) => void;
}

/**
 * Result of handling a session update.
 */
export interface HandlerResult {
  /** Whether the update was handled */
  handled: boolean;
  /** Updated tool call counter */
  toolCallCountSincePrompt?: number;
}
