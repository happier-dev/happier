/**
 * OpenCode Transport Handler
 *
 * Minimal TransportHandler for OpenCode's ACP mode.
 *
 * OpenCode ACP is expected to speak JSON-RPC over ndJSON on stdout.
 * This transport focuses on:
 * - Conservative stdout filtering (JSON objects/arrays only)
 * - Reasonable init/tool timeouts
 * - Heuristics for mapping OpenCode "other" tool names to concrete tool names
 * - Basic stderr classification (auth/model errors)
 *
 * Agent-specific stderr parsing can be added later if needed.
 */

import {
  CHANGE_TITLE_TOOL_NAME_ALIASES,
  isChangeTitleToolNameAlias,
  redactBugReportSensitiveText,
} from '@happier-dev/protocol';
import type {
  TransportHandler,
  ToolPattern,
  StderrContext,
  StderrResult,
  ToolNameContext,
} from '@/agent/transport/TransportHandler';
import type { AgentMessage } from '@/agent/core';
import { logger } from '@/ui/logger';
import { filterJsonObjectOrArrayLine } from '@/agent/transport/utils/jsonStdoutFilter';
import {
  findToolNameFromId,
  findToolNameFromInputFields,
  type ToolPatternWithInputFields,
} from '@/agent/transport/utils/toolPatternInference';
import { pickPermissionOptionId as pickAcpPermissionOptionId } from '@/agent/acp/permissions/permissionMapping';
import { normalizeOpenCodeAcpPermissionRulesetActions } from './permissionRulesetCompat';

export const OPENCODE_TIMEOUTS = {
  /**
   * OpenCode startup can be slow on first run (provider config, auth checks, etc.).
   * Prefer a conservative init timeout to avoid false failures.
   */
  init: 60_000,
  toolCall: 120_000,
  investigation: 300_000,
  think: 30_000,
  // OpenCode can emit post-tool assistant chunks in staggered bursts with >1s gaps.
  // Keep idle detection conservative enough to avoid prematurely finalizing strict-JSON turns.
  idle: 1_500,
  idleWithoutAssistantMessage: 10_000,
} as const;

const OPENCODE_TOOL_PATTERNS: readonly ToolPatternWithInputFields[] = [
  {
    name: 'save_memory',
    patterns: ['save_memory', 'save-memory'],
    inputFields: ['memory', 'content'],
  },
  {
    name: 'think',
    patterns: ['think'],
    inputFields: ['thought', 'thinking'],
  },
  // OpenCode sometimes reports file edits as kind="other" with a title/description like "apply_patch".
  // Match these before generic patterns like change_title (which can otherwise match via inferred `title`).
  {
    name: 'apply_patch',
    patterns: ['apply_patch', 'apply-diff', 'apply_diff', 'apply-patch', 'patch'],
    inputFields: ['patchText', 'patch_text', 'patch', 'changes', 'diff'],
  },
  // OpenCode CLI tool conventions
  {
    name: 'read',
    patterns: ['read', 'read_file'],
    inputFields: ['filePath', 'path'],
  },
  {
    name: 'write',
    patterns: ['write', 'write_file'],
    inputFields: ['content', 'filePath'],
  },
  {
    name: 'edit',
    patterns: ['edit'],
    inputFields: ['oldString', 'newString'],
  },
  {
    name: 'bash',
    patterns: ['bash', 'shell', 'exec'],
    inputFields: ['command'],
  },
  {
    name: 'glob',
    patterns: ['glob'],
    inputFields: ['pattern'],
  },
  {
    name: 'grep',
    patterns: ['grep'],
    inputFields: ['pattern', 'include'],
  },
  {
    name: 'task',
    patterns: ['task'],
    inputFields: ['prompt', 'subagent_type'],
  },
  {
    name: 'change_title',
    patterns: CHANGE_TITLE_TOOL_NAME_ALIASES,
    inputFields: ['title'],
  },
] as const;

function canonicalizeOpenCodeCustomMcpAlias(params: Readonly<{
  toolName: string;
  input: Record<string, unknown>;
}>): string | null {
  const rawToolName = params.toolName.trim();
  if (!rawToolName || rawToolName.includes('/') || rawToolName.startsWith('mcp__')) return null;
  if (!/^[a-z0-9_]+$/i.test(rawToolName)) return null;

  const hintedToolName = [params.input.tool_name, params.input.toolName, params.input.name]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    ?.trim();
  if (!hintedToolName || !/^[a-z0-9_]+$/i.test(hintedToolName)) return null;

  const expectedSuffix = `_${hintedToolName}`;
  if (!rawToolName.endsWith(expectedSuffix)) return null;

  const serverAlias = rawToolName.slice(0, -expectedSuffix.length).trim();
  if (!serverAlias) return null;

  return `mcp__${serverAlias}__${hintedToolName.replaceAll('/', '__')}`;
}

export class OpenCodeTransport implements TransportHandler {
  readonly agentName = 'opencode';

  getInitTimeout(): number {
    return OPENCODE_TIMEOUTS.init;
  }

  filterStdoutLine(line: string): string | null {
    const filtered = filterJsonObjectOrArrayLine(line);
    if (!filtered) return filtered;
    return normalizeOpenCodeAcpPermissionRulesetActions(filtered) ?? filtered;
  }

  handleStderr(text: string, context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) return { message: null, suppress: true };
    const lower = trimmed.toLowerCase();

    // Rate limit errors - OpenCode (or its providers) may retry; keep logs for debugging.
    if (
      trimmed.includes('429') ||
      lower.includes('rate limit') ||
      trimmed.includes('RATE_LIMIT')
    ) {
      return { message: null, suppress: false };
    }

    // Authentication error - show actionable message.
    if (
      lower.includes('authentication') ||
      lower.includes('unauthorized') ||
      lower.includes('api key')
    ) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Authentication error. Configure your OpenCode-compatible CLI credentials (for example: `opencode auth login`).',
      };
      return { message: errorMessage };
    }

    // Model not found - show actionable message.
    if (lower.includes('model not found') || lower.includes('providermodelnotfounderror')) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Model not found. Check available models in your CLI (for example: `opencode models`).',
      };
      return { message: errorMessage };
    }

    const redacted = redactBugReportSensitiveText(trimmed);
    const detail = redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;

    // CLI invocation/config errors (flags/args/etc) should be surfaced directly so misconfiguration
    // doesn't appear as a "silent" failure.
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

    if (looksLikeCliInvocationError) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail,
      };
      return { message: errorMessage, suppress: false };
    }

    // Provider request failures (e.g. Anthropic/OpenAI invalid_request_error) often only show up as
    // OpenCode logs when `opencode acp --print-logs` is enabled. Surface these as user-visible errors
    // so the UI doesn't appear stuck with no response.
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
      lower.includes('image exceeds') ||
      (lower.includes('exceeds') && lower.includes('maximum')) ||
      lower.includes('request failed') ||
      lower.includes('bad request') ||
      (lower.includes('http') && (lower.includes(' 4') || lower.includes(' 5'))) ||
      (/\b(4\d\d|5\d\d)\b/.test(lower) && lower.includes('error'));

    if (looksLikeNetworkError || looksLikeProviderRequestError) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail,
      };
      return { message: errorMessage, suppress: false };
    }

    // During long-running tools, keep stderr available for debugging but avoid noisy UI messages.
    if (context.hasActiveInvestigation) {
      const hasError =
        trimmed.includes('timeout') ||
        trimmed.includes('Timeout') ||
        trimmed.includes('failed') ||
        trimmed.includes('Failed') ||
        trimmed.includes('error') ||
        trimmed.includes('Error');

      if (hasError) return { message: null, suppress: false };
    }

    return { message: null };
  }

  getIdleWithoutAssistantMessageTimeoutMs(): number {
    return OPENCODE_TIMEOUTS.idleWithoutAssistantMessage;
  }

  getPostToolCallIdleTimeoutMs(): number {
    return OPENCODE_TIMEOUTS.idle;
  }

  getToolPatterns(): ToolPattern[] {
    // TransportHandler expects a mutable array type; keep our source list readonly and
    // return a shallow copy to satisfy the signature without risking accidental mutation.
    return [...OPENCODE_TOOL_PATTERNS];
  }

  pickPermissionOptionId(
    options: ReadonlyArray<Readonly<{ optionId?: string; name?: string; kind?: unknown }>>,
    decision: string,
  ): string | null | undefined {
    if (decision.trim().toLowerCase() !== 'approved') return undefined;

    // OpenCode-family ACP permission prompts have been observed to stall tool completion when
    // selecting the "allow once" option. Prefer the "allow always" option when available.
    const allowAlways = pickAcpPermissionOptionId(options, 'approved_for_session');
    if (!allowAlways) return undefined;
    return allowAlways;
  }

  determineToolName(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    _context: ToolNameContext
  ): string {
    const inferredTitle = (() => {
      const rawAcpTitle = input?._acp;
      const acpTitle =
        rawAcpTitle && typeof rawAcpTitle === 'object' && !Array.isArray(rawAcpTitle) && typeof (rawAcpTitle as any).title === 'string'
          ? String((rawAcpTitle as any).title).trim()
          : '';
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const description = typeof input.description === 'string' ? input.description.trim() : '';
      return (acpTitle || description || title).toLowerCase();
    })();

    // OpenCode sometimes sends kind="other" tool calls with no structured input on the first update,
    // but sets the tool title/description to "apply_patch". In that case, treat it as Patch immediately
    // so subsequent tool_call_update events don't get stuck under a generic name like change_title.
    if (
      (toolName === 'other' || toolName === 'Unknown tool') &&
      (inferredTitle === 'apply_patch' || inferredTitle === 'apply-patch' || inferredTitle === 'apply_diff' || inferredTitle === 'apply-diff' || inferredTitle === 'patch')
    ) {
      return 'apply_patch';
    }

    // OpenCode uses `change_title` as the task/subagent tool in some ACP implementations.
    // Map it to `SubAgent` when ACP metadata indicates this is the task tool so that downstream
    // features (like sidechain replay import) can key off a stable name.
    if (isChangeTitleToolNameAlias(toolName)) {
      const acp = input?._acp;
      const acpTitle =
        acp && typeof acp === 'object' && !Array.isArray(acp) && typeof (acp as any).title === 'string'
          ? String((acp as any).title).trim().toLowerCase()
          : '';
      if (acpTitle === 'task') return 'SubAgent';

      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const memory = typeof input.memory === 'string' ? input.memory.trim() : '';
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      const subagentType = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : '';

      const looksLikeTaskTool = Boolean(prompt) && Boolean(subagentType);
      const looksLikeChangeTitle = Boolean(title);
      const looksLikeSaveMemory = Boolean(memory);

      if (looksLikeTaskTool && !looksLikeChangeTitle && !looksLikeSaveMemory) return 'SubAgent';
    }

    const directToolName = findToolNameFromId(toolName, OPENCODE_TOOL_PATTERNS, { preferLongestMatch: true });
    if (directToolName) return directToolName;

    const directCustomMcpTool = canonicalizeOpenCodeCustomMcpAlias({ toolName, input });
    if (directCustomMcpTool) return directCustomMcpTool;

    if (toolName !== 'other' && toolName !== 'Unknown tool') return toolName;

    // 1) Prefer toolCallId pattern matching (most reliable).
    const idToolName = findToolNameFromId(toolCallId, OPENCODE_TOOL_PATTERNS, { preferLongestMatch: true });
    if (idToolName) return idToolName;

    // 2) Fallback to input field signatures.
    const inputToolName = findToolNameFromInputFields(input, OPENCODE_TOOL_PATTERNS);
    if (inputToolName) return inputToolName;

    // 3) Some agents wrap tools (e.g. `use_mcp_tool`) and include an explicit tool name hint.
    // Prefer resolving that hint to a known tool name to avoid rendering generic "other" tool UIs.
    const toolNameHintRaw = (() => {
      const candidates = [input.tool_name, input.toolName, input.name];
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
      }
      return null;
    })();
    if (toolNameHintRaw) {
      const hintToolName = findToolNameFromId(toolNameHintRaw, OPENCODE_TOOL_PATTERNS, { preferLongestMatch: true });
      if (hintToolName) return hintToolName;
    }

    if (toolName === 'other' || toolName === 'Unknown tool') {
      const inputKeys = input && typeof input === 'object' ? Object.keys(input) : [];
      logger.debug(
        `[OpenCodeTransport] Unknown tool pattern - toolCallId: "${toolCallId}", ` +
          `toolName: "${toolName}", inputKeys: [${inputKeys.join(', ')}].`
      );
    }

    return toolName;
  }

  extractToolNameFromId(toolCallId: string): string | null {
    return findToolNameFromId(toolCallId, OPENCODE_TOOL_PATTERNS, { preferLongestMatch: true });
  }

  isInvestigationTool(toolCallId: string, toolKind?: string): boolean {
    const lowerId = toolCallId.toLowerCase();
    return (
      lowerId.includes('task') ||
      lowerId.includes('explore') ||
      (typeof toolKind === 'string' && toolKind.includes('task'))
    );
  }

  getToolCallTimeout(toolCallId: string, toolKind?: string): number {
    if (this.isInvestigationTool(toolCallId, toolKind)) return OPENCODE_TIMEOUTS.investigation;
    if (toolKind === 'think') return OPENCODE_TIMEOUTS.think;
    return OPENCODE_TIMEOUTS.toolCall;
  }

  getIdleTimeout(): number {
    return OPENCODE_TIMEOUTS.idle;
  }
}

export const openCodeTransport = new OpenCodeTransport();
