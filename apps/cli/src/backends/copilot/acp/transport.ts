/**
 * Copilot Transport Handler
 *
 * Minimal TransportHandler for GitHub Copilot CLI's ACP mode.
 *
 * Copilot ACP is expected to speak JSON-RPC over ndJSON on stdout.
 * This transport focuses on:
 * - Conservative stdout filtering (JSON objects/arrays only)
 * - Reasonable init/tool timeouts
 * - Heuristics for mapping tool names to concrete tool names
 * - Basic stderr classification (auth/model errors)
 */

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

export const COPILOT_TIMEOUTS = {
  // Copilot may run auth checks or plugin setup on first ACP start. Be conservative.
  init: 90_000,
  toolCall: 120_000,
  investigation: 300_000,
  think: 30_000,
  idle: 500,
} as const;

const COPILOT_TOOL_PATTERNS: readonly ToolPatternWithInputFields[] = [
  {
    name: 'change_title',
    patterns: [
      'change_title',
      'change-title',
      'happy__change_title',
      'mcp__happy__change_title',
      'happier__change_title',
      'mcp__happier__change_title',
    ],
    inputFields: ['title'],
  },
  {
    name: 'think',
    patterns: ['think'],
    inputFields: ['thought', 'thinking'],
  },
  { name: 'read', patterns: ['read', 'read_file', 'read-file'], inputFields: ['path', 'filePath', 'uri'] },
  { name: 'write', patterns: ['write', 'write_file', 'write_to_file', 'write-file'], inputFields: ['path', 'filePath', 'content', 'text'] },
  { name: 'edit', patterns: ['edit', 'apply_diff', 'apply_patch', 'apply-diff', 'apply-patch'], inputFields: ['changes', 'old_string', 'new_string', 'edits'] },
  { name: 'bash', patterns: ['bash', 'shell', 'exec', 'exec_command', 'execute_command'], inputFields: ['command', 'cmd'] },
  { name: 'glob', patterns: ['glob', 'glob_files'], inputFields: ['pattern', 'glob'] },
  { name: 'grep', patterns: ['grep', 'search_code', 'code_search'], inputFields: ['pattern', 'query', 'text'] },
  { name: 'ls', patterns: ['ls', 'list_files', 'ls_files'], inputFields: ['path', 'dir'] },
  { name: 'task', patterns: ['task', 'subtask'], inputFields: ['prompt'] },
  // MCP wrappers (prefer resolving via tool_name hint)
  { name: 'mcp', patterns: ['use_mcp_tool', 'access_mcp_resource'], inputFields: ['server', 'tool', 'name', 'uri'] },
] as const;

export class CopilotTransport implements TransportHandler {
  readonly agentName = 'copilot';

  getInitTimeout(): number {
    return COPILOT_TIMEOUTS.init;
  }

  filterStdoutLine(line: string): string | null {
    return filterJsonObjectOrArrayLine(line);
  }

  handleStderr(text: string, _context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) return { message: null };

    if (
      trimmed.toLowerCase().includes('authentication') ||
      trimmed.toLowerCase().includes('unauthorized') ||
      trimmed.toLowerCase().includes('not logged in') ||
      trimmed.includes('401')
    ) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Authentication error. Run `copilot auth login` to authenticate with GitHub.',
      };
      return { message: errorMessage };
    }

    if (trimmed.toLowerCase().includes('model not found') || trimmed.toLowerCase().includes('unknown model')) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Model not found. Check available models with `copilot models`.',
      };
      return { message: errorMessage };
    }

    if (
      trimmed.toLowerCase().includes('subscription') ||
      trimmed.toLowerCase().includes('copilot is not enabled')
    ) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'GitHub Copilot subscription required. Check your Copilot access at https://github.com/settings/copilot.',
      };
      return { message: errorMessage };
    }

    return { message: null };
  }

  getToolPatterns(): ToolPattern[] {
    return [...COPILOT_TOOL_PATTERNS];
  }

  determineToolName(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    _context: ToolNameContext,
  ): string {
    const directToolName = findToolNameFromId(toolName, COPILOT_TOOL_PATTERNS, { preferLongestMatch: true });
    if (directToolName) return directToolName;

    if (toolName !== 'other' && toolName !== 'Unknown tool') return toolName;

    const idToolName = findToolNameFromId(toolCallId, COPILOT_TOOL_PATTERNS, { preferLongestMatch: true });
    if (idToolName && idToolName !== 'mcp') return idToolName;

    const inputToolName = findToolNameFromInputFields(input, COPILOT_TOOL_PATTERNS);
    if (inputToolName && inputToolName !== 'mcp') return inputToolName;

    const toolNameHintRaw = (() => {
      const candidates = [input.tool_name, input.toolName, input.name];
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
      }
      return null;
    })();
    if (toolNameHintRaw) {
      const hintToolName = findToolNameFromId(toolNameHintRaw, COPILOT_TOOL_PATTERNS, { preferLongestMatch: true });
      if (hintToolName) return hintToolName;
    }

    if (idToolName) return idToolName;
    if (inputToolName) return inputToolName;

    const inputKeys = input && typeof input === 'object' ? Object.keys(input) : [];
    logger.debug(
      `[CopilotTransport] Unknown tool pattern - toolCallId: "${toolCallId}", toolName: "${toolName}", inputKeys: [${inputKeys.join(', ')}].`,
    );
    return toolName;
  }

  extractToolNameFromId(toolCallId: string): string | null {
    return findToolNameFromId(toolCallId, COPILOT_TOOL_PATTERNS, { preferLongestMatch: true });
  }

  isInvestigationTool(toolCallId: string, toolKind?: string): boolean {
    const lowerId = toolCallId.toLowerCase();
    return lowerId.includes('task') || (typeof toolKind === 'string' && toolKind.includes('task'));
  }

  getToolCallTimeout(toolCallId: string, toolKind?: string): number {
    if (this.isInvestigationTool(toolCallId, toolKind)) return COPILOT_TIMEOUTS.investigation;
    if (toolKind === 'think') return COPILOT_TIMEOUTS.think;
    return COPILOT_TIMEOUTS.toolCall;
  }

  getIdleTimeout(): number {
    return COPILOT_TIMEOUTS.idle;
  }
}

export const copilotTransport = new CopilotTransport();
