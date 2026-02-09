import type {
  StderrContext,
  StderrResult,
  ToolNameContext,
  ToolPattern,
  TransportHandler,
} from '@/agent/transport/TransportHandler';
import { filterJsonObjectOrArrayLine } from '@/agent/transport/utils/jsonStdoutFilter';
import {
  findToolNameFromId,
  findToolNameFromInputFields,
  type ToolPatternWithInputFields,
} from '@/agent/transport/utils/toolPatternInference';

const KIMI_TIMEOUTS = {
  init: 90_000,
  toolCall: 120_000,
  think: 30_000,
  idle: 500,
} as const;

const KIMI_TOOL_PATTERNS: readonly ToolPatternWithInputFields[] = [
  { name: 'read', patterns: ['read', 'read_file', 'readfile'], inputFields: ['path', 'filePath', 'filepath'] },
  { name: 'write', patterns: ['write', 'write_file', 'writefile'], inputFields: ['path', 'filePath', 'filepath', 'content', 'text'] },
  {
    name: 'edit',
    patterns: ['edit', 'str_replace_file', 'strreplacefile', 'replace_file'],
    inputFields: ['path', 'filePath', 'filepath', 'old_string', 'new_string', 'oldString', 'newString'],
  },
  { name: 'delete', patterns: ['delete', 'delete_file', 'deletefile', 'remove_file'], inputFields: ['path', 'filePath', 'filepath'] },
  { name: 'bash', patterns: ['shell', 'execute', 'execute_command', 'bash'], inputFields: ['command', 'cmd'] },
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function mapTitleToToolName(title: string): string | null {
  const normalized = title.trim().toLowerCase();
  if (!normalized) return null;
  if (/^read(?:[\s_-]*file)?\b/.test(normalized) || normalized === 'readfile') return 'read';
  if (/^write(?:[\s_-]*file)?\b/.test(normalized) || normalized === 'writefile') return 'write';
  if (/^(?:edit|replace|strreplace)(?:[\s_-]*file)?\b/.test(normalized) || normalized === 'strreplacefile') return 'edit';
  if (/^(?:delete|remove)(?:[\s_-]*file)?\b/.test(normalized) || normalized === 'deletefile') return 'delete';
  if (/^(?:shell|execute|bash)\b/.test(normalized)) return 'bash';
  return null;
}

function inferToolNameFromTitleHints(input: Record<string, unknown>): string | null {
  const acp = asRecord(input._acp);
  const candidates = [input.title, input.description, acp?.title];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const mapped = mapTitleToToolName(candidate);
    if (mapped) return mapped;
  }
  return null;
}

export class KimiTransport implements TransportHandler {
  readonly agentName = 'kimi';

  getInitTimeout(): number {
    return KIMI_TIMEOUTS.init;
  }

  filterStdoutLine(line: string): string | null {
    return filterJsonObjectOrArrayLine(line);
  }

  handleStderr(_text: string, _context: StderrContext): StderrResult {
    return { message: null };
  }

  getToolPatterns(): ToolPattern[] {
    return [...KIMI_TOOL_PATTERNS];
  }

  determineToolName(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    _context: ToolNameContext,
  ): string {
    const directToolName = findToolNameFromId(toolName, KIMI_TOOL_PATTERNS, { preferLongestMatch: true });
    if (directToolName) return directToolName;

    const genericTool = toolName === 'other' || toolName === 'unknown' || toolName === 'Unknown tool';
    if (!genericTool) return toolName;

    const idToolName = findToolNameFromId(toolCallId, KIMI_TOOL_PATTERNS, { preferLongestMatch: true });
    if (idToolName) return idToolName;

    const titleHintToolName = inferToolNameFromTitleHints(input);
    if (titleHintToolName) return titleHintToolName;

    const inputToolName = findToolNameFromInputFields(input, KIMI_TOOL_PATTERNS);
    if (inputToolName) return inputToolName;

    return toolName;
  }

  extractToolNameFromId(toolCallId: string): string | null {
    return findToolNameFromId(toolCallId, KIMI_TOOL_PATTERNS, { preferLongestMatch: true });
  }

  isInvestigationTool(_toolCallId: string, _toolKind?: string): boolean {
    return false;
  }

  getToolCallTimeout(_toolCallId: string, toolKind?: string): number {
    if (toolKind === 'think') return KIMI_TIMEOUTS.think;
    return KIMI_TIMEOUTS.toolCall;
  }

  getIdleTimeout(): number {
    return KIMI_TIMEOUTS.idle;
  }
}

export const kimiTransport = new KimiTransport();
