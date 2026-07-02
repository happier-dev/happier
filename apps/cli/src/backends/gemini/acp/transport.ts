/**
 * Gemini Transport Handler
 *
 * Gemini CLI-specific implementation of TransportHandler.
 * Handles:
 * - Long init timeout (Gemini CLI is slow on first start)
 * - Stdout filtering (removes debug output that breaks JSON-RPC)
 * - Stderr parsing (detects rate limits, 404 errors)
 * - Tool name patterns (change_title, save_memory, think)
 * - Investigation tool detection (codebase_investigator)
 *
 * @module GeminiTransport
 */

import type {
  TransportHandler,
  ToolPattern,
  StderrContext,
  StderrResult,
  ToolNameContext,
  PromptErrorContext,
  TerminalToolUpdateLogContext,
} from '@/agent/transport/TransportHandler';
import type { AgentMessage } from '@/agent/core';
import { logger } from '@/ui/logger';
import { filterJsonObjectOrArrayLine } from '@/agent/transport/utils/jsonStdoutFilter';
import { extractHappierToolsShellBridgeToolNameHint } from '@/agent/transport/utils/happierToolsShellBridgeToolNameHint';
import { getSuggestedGeminiModelsForUi } from '@/backends/gemini/models/suggestedGeminiModelsForUi';
import { GEMINI_TOOL_NAME_INFERENCE } from '@happier-dev/plugins-gemini/agent/acp/toolNames';
import {
  findToolNameFromId,
  findToolNameFromInputFields,
  type ToolPatternWithInputFields,
} from '@/agent/transport/utils/toolPatternInference';

/**
 * Gemini-specific timeout values (in milliseconds)
 */
export const GEMINI_TIMEOUTS = {
  /** Gemini CLI can be slow on first start (downloading models, etc.) */
  init: 120_000,
  /** Gemini CLI ACP can swallow early stdin during startup; delay initialize to avoid poisoning stdio. */
  initDelay: 3_000,
  /** Standard tool call timeout */
  toolCall: 120_000,
  /** Investigation tools (codebase_investigator) can run for a long time */
  investigation: 600_000,
  /** Think tools are usually quick */
  think: 30_000,
  /** Idle detection after last message chunk */
  idle: 500,
} as const;

/**
 * Known tool name patterns for Gemini CLI.
 * Used to extract real tool names from toolCallId when Gemini sends "other".
 *
 * Each pattern includes:
 * - name: canonical tool name
 * - patterns: strings to match in toolCallId (case-insensitive)
 * - inputFields: optional fields that indicate this tool when present in input
 */
const GEMINI_TOOL_PATTERNS: readonly ToolPatternWithInputFields[] = GEMINI_TOOL_NAME_INFERENCE.patterns;

function isSyntheticTitleOnlyInferenceInput(input: Record<string, unknown>): boolean {
  const keys = Object.keys(input);
  if (keys.length === 0) return false;
  if (!keys.every((key) => key === 'title' || key === 'description' || key === '_acp')) {
    return false;
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) return false;

  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description && description !== title) return false;

  const acp = input._acp;
  if (acp === undefined) return true;
  if (!acp || typeof acp !== 'object' || Array.isArray(acp)) return false;

  const acpRecord = acp as Record<string, unknown>;
  const acpKeys = Object.keys(acpRecord);
  if (!acpKeys.every((key) => key === 'title')) return false;
  const acpTitle = typeof acpRecord.title === 'string' ? acpRecord.title.trim() : '';
  return !acpTitle || acpTitle === title;
}

function extractOpaqueToolNamePrefix(toolCallId: string): string | null {
  const trimmed = toolCallId.trim();
  if (!trimmed) return null;
  const prefix = trimmed.split('-', 1)[0]?.trim() ?? '';
  if (!prefix) return null;
  if (!/^[a-z0-9_]+$/i.test(prefix)) return null;
  if (findToolNameFromId(prefix, GEMINI_TOOL_PATTERNS, { preferLongestMatch: true })) return null;
  return prefix;
}

function isGeminiAcpDebugEnabled(): boolean {
  const flag = process.env.HAPPIER_STACK_GEMINI_ACP_DEBUG;
  return flag === '1' || flag === 'true';
}

function sanitizeForGeminiAcpDebugLogs(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated depth]';
  if (typeof value === 'string') {
    const max = 400;
    if (value.length <= max) return value;
    return `${value.slice(0, max)}... [truncated ${value.length - max} chars]`;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) {
      return [
        ...value.slice(0, 50).map((entry) => sanitizeForGeminiAcpDebugLogs(entry, depth + 1)),
        `... [truncated ${value.length - 50} items]`,
      ];
    }
    return value.map((entry) => sanitizeForGeminiAcpDebugLogs(entry, depth + 1));
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj)) {
      if (/(token|secret|authorization|cookie|api[_-]?key|password)/i.test(key)) {
        out[key] = '[redacted]';
        continue;
      }
      out[key] = sanitizeForGeminiAcpDebugLogs(entry, depth + 1);
    }
    return out;
  }
  return value;
}

function extractInternalErrorDetails(error: unknown): Readonly<{
  code: number | null;
  details: string;
}> {
  const errorRecord = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const code = typeof errorRecord?.code === 'number' ? errorRecord.code : null;
  const errorData = errorRecord?.data;
  const details =
    errorData && typeof errorData === 'object' && typeof (errorData as Record<string, unknown>).details === 'string'
      ? (errorData as Record<string, unknown>).details as string
      : '';
  return { code, details };
}

/**
 * Gemini CLI transport handler.
 *
 * Handles all Gemini-specific quirks:
 * - Debug output filtering from stdout
 * - Rate limit and error detection in stderr
 * - Tool name extraction from toolCallId
 */
export class GeminiTransport implements TransportHandler {
  readonly agentName = 'gemini';

  /**
   * Gemini CLI needs 2 minutes for first start (model download, warm-up)
   */
  getInitTimeout(): number {
    return GEMINI_TIMEOUTS.init;
  }

  /**
   * Gemini CLI ACP: delay initialize to avoid early-stdin poisoning.
   */
  getInitDelayMs(): number {
    return GEMINI_TIMEOUTS.initDelay;
  }

  /**
   * Filter Gemini CLI debug output from stdout.
   *
   * Gemini CLI outputs various debug info (experiments, flags, etc.) to stdout
   * that breaks ACP JSON-RPC parsing. We only keep valid JSON lines.
   */
  filterStdoutLine(line: string): string | null {
    return filterJsonObjectOrArrayLine(line);
  }

  /**
   * Handle Gemini CLI stderr output.
   *
   * Detects:
   * - Rate limit errors (429) - logged but not shown (CLI handles retries)
   * - Model not found (404) - emit error with available models
   * - Other errors during investigation - logged for debugging
   */
  handleStderr(text: string, context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) {
      return { message: null, suppress: true };
    }

    // Rate limit error (429) - Gemini CLI handles retries internally
    if (
      trimmed.includes('status 429') ||
      trimmed.includes('code":429') ||
      trimmed.includes('rateLimitExceeded') ||
      trimmed.includes('RESOURCE_EXHAUSTED')
    ) {
      return {
        message: null,
        suppress: false, // Log for debugging but don't show to user
      };
    }

    // Model not found (404) - show error with available models
    if (trimmed.includes('status 404') || trimmed.includes('code":404')) {
      const suggested = getSuggestedGeminiModelsForUi();
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: `Model not found. Suggested models: ${suggested.join(', ')}`,
      };
      return { message: errorMessage };
    }

    // During investigation tools, log any errors/timeouts for debugging
    if (context.hasActiveInvestigation) {
      const hasError =
        trimmed.includes('timeout') ||
        trimmed.includes('Timeout') ||
        trimmed.includes('failed') ||
        trimmed.includes('Failed') ||
        trimmed.includes('error') ||
        trimmed.includes('Error');

      if (hasError) {
        // Just log, don't emit - investigation might recover
        return { message: null, suppress: false };
      }
    }

    return { message: null };
  }

  /**
   * Gemini-specific tool patterns
   */
  getToolPatterns(): ToolPattern[] {
    return [...GEMINI_TOOL_PATTERNS];
  }

  /**
   * Check if tool is an investigation tool (needs longer timeout)
   */
  isInvestigationTool(toolCallId: string, toolKind?: string): boolean {
    const lowerId = toolCallId.toLowerCase();
    return (
      lowerId.includes('codebase_investigator') ||
      lowerId.includes('investigator') ||
      (typeof toolKind === 'string' && toolKind.includes('investigator'))
    );
  }

  /**
   * Get timeout for a tool call
   */
  getToolCallTimeout(toolCallId: string, toolKind?: string): number {
    if (this.isInvestigationTool(toolCallId, toolKind)) {
      return GEMINI_TIMEOUTS.investigation;
    }
    if (toolKind === 'think') {
      return GEMINI_TIMEOUTS.think;
    }
    return GEMINI_TIMEOUTS.toolCall;
  }

  /**
   * Get idle detection timeout
   */
  getIdleTimeout(): number {
    return GEMINI_TIMEOUTS.idle;
  }

  /**
   * Extract tool name from toolCallId using Gemini patterns.
   *
   * Tool IDs often contain the tool name as a prefix (e.g., "change_title-1765385846663" -> "change_title")
   */
  extractToolNameFromId(toolCallId: string): string | null {
    return findToolNameFromId(toolCallId, GEMINI_TOOL_PATTERNS, { preferLongestMatch: true });
  }

  /**
   * Determine the real tool name from various sources.
   *
   * When Gemini sends "other" or "Unknown tool", tries to determine the real name from:
   * 1. toolCallId patterns (most reliable - tool name often embedded in ID)
 * 2. Input field signatures (specific fields indicate specific tools)
 *
 * Context-based heuristics were removed as they were fragile and the above
 * methods cover all known cases.
   */
  determineToolName(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    _context: ToolNameContext
  ): string {
    const shellBridgeToolName = extractHappierToolsShellBridgeToolNameHint(input);
    if (shellBridgeToolName) return shellBridgeToolName;
    const syntheticTitleOnlyInput = isSyntheticTitleOnlyInferenceInput(input);
    const opaqueToolPrefix = syntheticTitleOnlyInput ? extractOpaqueToolNamePrefix(toolCallId) : null;

    // 0. Normalize direct legacy aliases (for example happy__change_title) to canonical names.
    const directToolName = findToolNameFromId(toolName, GEMINI_TOOL_PATTERNS, { preferLongestMatch: true });
    if (directToolName) return directToolName;

    // 1. Check toolCallId for known tool names (most reliable)
    // Tool IDs often contain the tool name: "change_title-123456" -> "change_title"
    const idToolName = findToolNameFromId(toolCallId, GEMINI_TOOL_PATTERNS, { preferLongestMatch: true });
    if (idToolName) {
      return idToolName;
    }

    // If tool name is already known and not generic, keep it.
    if (toolName !== 'other' && toolName !== 'Unknown tool') {
      return toolName;
    }

    // 2. Check input fields for tool-specific signatures
    const inputFieldToolName = syntheticTitleOnlyInput
      ? null
      : findToolNameFromInputFields(input, GEMINI_TOOL_PATTERNS);
    if (inputFieldToolName) return inputFieldToolName;
    if (opaqueToolPrefix) return opaqueToolPrefix;

    // Return original tool name if we couldn't determine it
    // Log unknown patterns so developers can add them to GEMINI_TOOL_PATTERNS
    if (toolName === 'other' || toolName === 'Unknown tool') {
      const inputKeys = input && typeof input === 'object' ? Object.keys(input) : [];
      logger.debug(
        `[GeminiTransport] Unknown tool pattern - toolCallId: "${toolCallId}", ` +
        `toolName: "${toolName}", inputKeys: [${inputKeys.join(', ')}]. ` +
        `Consider adding a new pattern to GEMINI_TOOL_PATTERNS if this tool appears frequently.`
      );
    }

    return toolName;
  }

  shouldIgnorePromptError(error: unknown, context: PromptErrorContext): boolean {
    const { code, details } = extractInternalErrorDetails(error);
    return (
      code === -32603 &&
      details.includes('Model stream ended with empty response text') &&
      (!context.waitingForResponse || context.sawSessionUpdateSincePrompt) &&
      context.activeToolCallCount === 0
    );
  }

  logTerminalToolUpdate<T extends { sessionUpdate?: unknown; status?: unknown }>(
    update: T,
    _context: TerminalToolUpdateLogContext,
  ): void {
    if (!isGeminiAcpDebugEnabled()) return;
    logger.debug('[AcpBackend] [GeminiACP] Terminal tool update keys:', Object.keys(update));
    logger.debug(
      '[AcpBackend] [GeminiACP] Terminal tool update payload:',
      JSON.stringify(sanitizeForGeminiAcpDebugLogs(update), null, 2),
    );
  }
}

/**
 * Singleton instance for convenience
 */
export const geminiTransport = new GeminiTransport();
