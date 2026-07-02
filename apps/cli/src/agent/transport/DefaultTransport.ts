/**
 * Default Transport Handler
 *
 * Basic implementation of TransportHandler with reasonable defaults.
 * Use this for agents that don't need special filtering or error handling.
 *
 * @module DefaultTransport
 */

import type {
  TransportHandler,
  ToolPattern,
  StderrContext,
  StderrResult,
  ToolNameContext,
} from './TransportHandler';
import type { AgentMessage } from '@/agent/core';
import { filterJsonObjectOrArrayLine } from './utils/jsonStdoutFilter';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';

/**
 * Default timeout values (in milliseconds)
 */
const DEFAULT_TIMEOUTS = {
  /** Default initialization timeout: 60 seconds */
  init: 60_000,
  /** Default tool call timeout: 2 minutes */
  toolCall: 120_000,
  /** Investigation tool timeout: 10 minutes */
  investigation: 600_000,
  /** Think tool timeout: 30 seconds */
  think: 30_000,
} as const;

/**
 * Default transport handler implementation.
 *
 * Provides:
 * - 60s init timeout
 * - No stdout filtering (pass through all lines)
 * - Basic stderr logging (no special error detection)
 * - Empty tool patterns (no special tool name extraction)
 * - Standard tool call timeouts
 */
export class DefaultTransport implements TransportHandler {
  readonly agentName: string;

  constructor(agentName: string = 'generic-acp') {
    this.agentName = agentName;
  }

  /**
   * Default init timeout: 60 seconds
   */
  getInitTimeout(): number {
    return DEFAULT_TIMEOUTS.init;
  }

  /**
   * Default: pass through all lines that are valid JSON objects/arrays
   */
  filterStdoutLine(line: string): string | null {
    return filterJsonObjectOrArrayLine(line);
  }

  /**
   * Default: no special stderr handling
   */
  handleStderr(text: string, context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) return { message: null, suppress: true };

    const lower = trimmed.toLowerCase();

    // During long-running investigations, keep stderr as diagnostics but avoid noisy UI errors.
    if (context.hasActiveInvestigation) {
      return { message: null, suppress: false };
    }

    // Rate limits are useful diagnostics and may be retried by the agent.
    if (trimmed.includes('429') || lower.includes('rate limit') || lower.includes('rate_limit')) {
      return { message: null, suppress: false };
    }

    // Authentication errors - surface an actionable message.
    //
    // Be conservative: stderr may contain unrelated text that mentions "authentication" or "API keys"
    // (e.g. documentation snippets, prompts, or structured payloads). Prefer common error phrasing
    // and status-code signals instead of raw substring matches.
    const looksLikeAuthError =
      lower.includes('unauthorized') ||
      trimmed.includes('401') ||
      lower.includes('authentication failed') ||
      lower.includes('authentication error') ||
      lower.includes('invalid api key') ||
      lower.includes('missing api key') ||
      lower.includes('no api key') ||
      lower.includes('api key not set') ||
      lower.includes('api_key') ||
      /\b(openai|anthropic|codex|gemini|google)_(api|access)_key\b/i.test(trimmed);

    if (looksLikeAuthError) {
      const message: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Authentication error. Configure your provider CLI credentials, then retry.',
      };
      return { message };
    }

    // Model not found - common across many ACP CLIs/providers.
    if (lower.includes('model not found') || lower.includes('unknown model') || lower.includes('providermodelnotfounderror')) {
      const message: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Model not found. Check available models in your provider CLI, then retry.',
      };
      return { message };
    }

    const redacted = redactBugReportSensitiveText(trimmed);
    const detail = redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;

    const looksLikeCliInvocationError =
      lower.startsWith('error:') ||
      lower.includes('unknown flag') ||
      lower.includes('unknown option') ||
      lower.includes('unrecognized option') ||
      lower.includes('unknown argument') ||
      lower.includes('flag provided but not defined') ||
      lower.includes('invalid value') ||
      lower.includes('invalid argument') ||
      lower.includes('unknown command');

    const looksLikeNetworkError =
      lower.includes('unable to connect') ||
      lower.includes('connectionrefused') ||
      lower.includes('connection refused') ||
      lower.includes('econnrefused') ||
      lower.includes('fetch failed') ||
      lower.includes('network error') ||
      lower.includes('socket hang up');

    const looksLikeProviderRequestError =
      lower.includes('invalid_request_error') ||
      lower.includes('apierror') ||
      lower.includes('statuscode') ||
      lower.includes('request failed') ||
      lower.includes('bad request') ||
      (lower.includes('http') && (lower.includes(' 4') || lower.includes(' 5'))) ||
      (/\b(4\d\d|5\d\d)\b/.test(lower) && lower.includes('error'));

    const looksLikeStackOrException =
      lower.startsWith('error') ||
      lower.includes('exception') ||
      lower.includes('traceback') ||
      lower.includes('stack trace');

    if (looksLikeCliInvocationError || looksLikeNetworkError || looksLikeProviderRequestError || looksLikeStackOrException) {
      const message: AgentMessage = {
        type: 'status',
        status: 'error',
        detail,
      };
      return { message, suppress: false };
    }

    return { message: null, suppress: false };
  }

  /**
   * Default: no special tool patterns
   */
  getToolPatterns(): ToolPattern[] {
    return [];
  }

  /**
   * Default: no investigation tools
   */
  isInvestigationTool(_toolCallId: string, _toolKind?: string): boolean {
    return false;
  }

  /**
   * Default tool call timeout based on tool kind
   */
  getToolCallTimeout(_toolCallId: string, toolKind?: string): number | null {
    if (toolKind === 'think') {
      return DEFAULT_TIMEOUTS.think;
    }
    return DEFAULT_TIMEOUTS.toolCall;
  }

  /**
   * Default: no tool name extraction (return null)
   */
  extractToolNameFromId(_toolCallId: string): string | null {
    return null;
  }

  /**
   * Default: return original tool name (no special detection)
   */
  determineToolName(
    toolName: string,
    _toolCallId: string,
    _input: Record<string, unknown>,
    _context: ToolNameContext
  ): string {
    return toolName;
  }

  /**
   * Default: no special pre-tool idle window (falls back to standard idle timeout handling).
   */
  getPreToolCallIdleTimeoutMs(): number | undefined {
    return undefined;
  }

  /**
   * Default: no provider-specific content fixups. Provider transports override this to repair
   * payload quirks (e.g. Cursor's diff header noise) before the generic normalizer reads them.
   */
  sanitizeToolUpdateContent<T extends { content?: unknown }>(update: T): T {
    return update;
  }

  /**
   * Default: render standard ACP plan updates through the shared TodoWrite checklist.
   */
  suppressAcpPlanUpdate(): boolean {
    return false;
  }
}

/**
 * Singleton instance for convenience
 */
export const defaultTransport = new DefaultTransport();
