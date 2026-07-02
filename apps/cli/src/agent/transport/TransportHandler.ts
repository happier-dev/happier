/**
 * TransportHandler Interface
 *
 * Abstraction layer for agent-specific transport logic.
 * Allows different ACP agents (Gemini, Codex, Claude, etc.) to customize:
 * - Initialization timeouts
 * - Stdout filtering (for debug output removal)
 * - Stderr handling (for error detection)
 * - Tool name patterns
 *
 * @module TransportHandler
 */

import type { AgentMessage } from '../core';

/**
 * Tool name pattern for extraction from toolCallId
 */
export interface ToolPattern {
  /** Canonical tool name */
  name: string;
  /** Patterns to match in toolCallId (case-insensitive) */
  patterns: readonly string[];
}

/**
 * Context passed to stderr handler
 */
export interface StderrContext {
  /** Currently active tool calls */
  activeToolCalls: Set<string>;
  /** Whether any active tool is an investigation tool */
  hasActiveInvestigation: boolean;
}

/**
 * Context for tool name detection heuristics
 */
export interface ToolNameContext {
  /** Whether the recent prompt contained change_title instruction */
  recentPromptHadChangeTitle: boolean;
  /** Number of tool calls since last prompt */
  toolCallCountSincePrompt: number;
}

/**
 * Context passed to prompt-error suppression hooks.
 */
export interface PromptErrorContext {
  /** Whether the generic ACP backend is still waiting for prompt response completion */
  waitingForResponse: boolean;
  /** Whether the prompt has already produced any session/update traffic */
  sawSessionUpdateSincePrompt: boolean;
  /** Number of tool calls still active for the current prompt */
  activeToolCallCount: number;
}

/**
 * Context passed to terminal tool update logging hooks.
 */
export interface TerminalToolUpdateLogContext {
  /** ACP session update type that carried the terminal tool state */
  sessionUpdateType: string;
}

/**
 * Result of stderr processing
 */
export interface StderrResult {
  /** Message to emit (null = don't emit anything) */
  message: AgentMessage | null;
  /** Whether to suppress this stderr line from logs */
  suppress?: boolean;
}

/**
 * Transport handler interface for ACP backends.
 *
 * Implement this interface to customize behavior for specific agents.
 * Use DefaultTransport as a base or reference implementation.
 */
export interface TransportHandler {
  /**
   * Agent identifier for logging
   */
  readonly agentName: string;

  /**
   * Get initialization timeout in milliseconds.
   *
   * Different agents have different startup times:
   * - Gemini CLI: 120s (slow on first start, downloads models)
   * - Codex: ~30s
   * - Claude: ~10s
   *
   * @returns Timeout in milliseconds
   */
  getInitTimeout(): number;

  /**
   * Optional delay before sending the first ACP request (initialize).
   *
   * Some ACP agents (notably Gemini CLI) have a startup window where stdin is
   * routed to a non-ACP input path; any bytes written during that window can
   * poison the ACP stdio channel and cause initialize to hang indefinitely.
   *
   * Returning a small delay here allows the agent to finish its startup/stdio
   * setup before the client sends ACP JSON-RPC messages.
   */
  getInitDelayMs?(): number;

  /**
   * Filter a line from stdout before ACP parsing.
   *
   * Some agents output debug info to stdout that breaks JSON-RPC parsing.
   * Return null to drop the line, or the (possibly modified) line to keep it.
   *
   * @param line - Raw line from stdout
   * @returns Filtered line or null to drop
   */
  filterStdoutLine?(line: string): string | null;

  /**
   * Handle stderr output from the agent process.
   *
   * Used to detect errors (rate limits, auth failures, etc.) and
   * optionally emit status messages to the UI.
   *
   * @param text - Stderr text
   * @param context - Context about current state
   * @returns Result with optional message to emit
   */
  handleStderr?(text: string, context: StderrContext): StderrResult;

  /**
   * Get tool name patterns for this agent.
   *
   * Used to extract real tool names from toolCallId when the agent
   * sends "other" or "unknown" as the tool name.
   *
   * @returns Array of tool patterns
   */
  getToolPatterns(): ToolPattern[];

  /**
   * Check if a tool is an "investigation" tool that needs longer timeout.
   *
   * Investigation tools (like codebase_investigator) can run for minutes
   * and need special timeout handling.
   *
   * @param toolCallId - The tool call ID
   * @param toolKind - The tool kind/type
   * @returns true if this is an investigation tool
   */
  isInvestigationTool?(toolCallId: string, toolKind?: string): boolean;

  /**
   * Get timeout for a specific tool call.
   *
   * @param toolCallId - The tool call ID
   * @param toolKind - The tool kind/type
   * @returns Timeout in milliseconds, or null to disable the watchdog
   */
  getToolCallTimeout?(toolCallId: string, toolKind?: string): number | null;

  /**
   * Extract tool name from toolCallId.
   *
   * Tool IDs often contain the tool name as a prefix (e.g., "change_title-123" -> "change_title").
   * Uses getToolPatterns() to match known patterns.
   *
   * @param toolCallId - The tool call ID
   * @returns The extracted tool name, or null if not found
   */
  extractToolNameFromId?(toolCallId: string): string | null;

  /**
   * Determine the real tool name from various sources.
   *
   * When the agent sends "other" or "Unknown tool", tries to determine the real name from:
   * 1. toolCallId patterns
   * 2. input parameters
   * 3. Context (first tool call after change_title instruction)
   *
   * @param toolName - The initial tool name (may be "other" or "Unknown tool")
   * @param toolCallId - The tool call ID
   * @param input - The input parameters
   * @param context - Context information
   * @returns The determined tool name
   */
  determineToolName?(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    context: ToolNameContext
  ): string;

  /**
   * Optional provider hook to suppress known non-fatal prompt errors.
   *
   * This keeps provider-specific post-response quirks out of the generic ACP prompt path.
   * Implementations should return true only for tightly identified provider errors that are
   * known to arrive after the turn has already produced or completed useful output.
   */
  shouldIgnorePromptError?(error: unknown, context: PromptErrorContext): boolean;

  /**
   * Optional provider hook for debug logging terminal tool update payloads.
   *
   * The generic ACP update path owns terminal-tool detection; providers own whether/how to log
   * their payload shape, including provider-specific feature flags and redaction policy.
   */
  logTerminalToolUpdate?<T extends { sessionUpdate?: unknown; status?: unknown }>(
    update: T,
    context: TerminalToolUpdateLogContext,
  ): void;

  /**
   * Get idle detection timeout in milliseconds.
   *
   * This timeout is used to detect when the agent has finished producing output
   * and is ready for the next prompt. After no chunks arrive for this duration,
   * the backend emits 'idle' status.
   *
   * @returns Timeout in milliseconds (default: 500)
   */
  getIdleTimeout?(): number;

  /**
   * Get the quiet-period timeout to use after assistant chunks but before the first tool call.
   *
   * Some ACP providers emit an initial planning/status message, then start their first tool call
   * a short time later. Using a longer timeout here prevents the runtime from declaring the turn
   * idle in that gap and prematurely flushing streamed transcript state.
   *
   * When omitted, handlers fall back to `getIdleTimeout()`.
   */
  getPreToolCallIdleTimeoutMs?(): number | undefined;

  /**
   * Get the maximum time to wait for the *first* session/update after a prompt.
   *
   * ACP agents commonly ACK `session/prompt` immediately while the model is still working.
   * The real "turn boundary" is inferred from subsequent session/update traffic (chunks/tool calls)
   * and idle detection after the last update.
   *
   * This timeout is a conservative fallback to avoid hanging forever on providers that ACK prompts
   * but never emit any `session/update` events for a turn.
   */
  getPostPromptNoUpdatesTimeoutMs?(): number | null;

  /**
   * Get the maximum time to wait for ACP to acknowledge `session/prompt` or begin
   * emitting `session/update` traffic for that prompt.
   *
   * This is a liveness guard for broken/stuck providers. It is distinct from the
   * overall response-completion timeout, which continues waiting while the prompt
   * is actively producing updates.
   */
  getPromptLivenessTimeoutMs?(): number | null;

  /**
   * Get the quiet-period timeout to use after a tool call completes before declaring the turn idle.
   *
   * Some ACP providers can emit terminal tool updates before they resume trailing assistant text.
   * This timeout gives those providers a short window to continue the turn without the runtime
   * prematurely flushing transcript streaming state.
   */
  getPostToolCallIdleTimeoutMs?(): number;

  /**
   * Get the additional quiet-period timeout to require after an idle candidate when the
   * current prompt has not produced any assistant message chunks yet.
   *
   * Some ACP providers can emit transient idle gaps between tool/thinking phases before they
   * eventually stream the assistant's final answer. Returning a positive value here delays
   * response completion until either assistant chunks arrive or this extra quiet period expires.
   */
  getIdleWithoutAssistantMessageTimeoutMs?(): number;

  /**
   * Optional override for ACP permission option selection.
   *
   * Some ACP agents expose permission options that are semantically equivalent but can differ in
   * reliability. For example, one option may be buggy in a specific vendor version. This hook lets
   * a provider transport select a safer option **without** hard-coding provider rules in core.
   *
   * Return:
   * - `undefined` to use the default generic mapping
   * - a string optionId that exists in `options` to select it
   * - `null` to cancel the permission prompt (fail-closed)
   */
  pickPermissionOptionId?(
    options: ReadonlyArray<Readonly<{ optionId?: string; name?: string; kind?: unknown }>>,
    decision: string,
    context: Readonly<{
      toolCallId: string;
      toolName: string;
      input: unknown;
    }>,
  ): string | null | undefined;

  /**
   * Optional provider hook to sanitize a `tool_call` / `tool_call_update` before the generic
   * normalizer reads its content. Used to fix provider-specific payload quirks (e.g. Cursor jams
   * unified-diff header lines into `content[].oldText`/`newText` diff blocks) WITHOUT leaking
   * provider logic into the provider-agnostic ACP update pipeline.
   *
   * Implementations MUST return the update unchanged (ideally the same reference) when there is
   * nothing to fix, so this is safe to call on every update. Typed structurally to avoid a
   * dependency cycle with the ACP `SessionUpdate` type.
   */
  sanitizeToolUpdateContent?<T extends { content?: unknown }>(update: T): T;

  /**
   * Whether this provider delivers plans/todos through a richer proprietary channel and therefore
   * opts out of the generic ACP `plan` SessionUpdate -> TodoWrite render (to avoid a duplicate
   * checklist). Example: Cursor delivers plans via the `cursor/create_plan` extension method.
   * Defaults to false (render standard ACP plan updates).
   */
  suppressAcpPlanUpdate?(): boolean;
}
