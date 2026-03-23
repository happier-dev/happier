import { CHANGE_TITLE_TOOL_NAME_ALIASES, isChangeTitleToolNameAlias } from '@happier-dev/protocol/tools/v2';

import { DefaultTransport } from '@/agent/transport/DefaultTransport';
import type { ToolPattern, ToolNameContext } from '@/agent/transport/TransportHandler';
import { findToolNameFromId, findToolNameFromInputFields, isEmptyToolInput, type ToolPatternWithInputFields } from '@/agent/transport/utils/toolPatternInference';

const CODEX_TOOL_PATTERNS: readonly ToolPatternWithInputFields[] = [
  {
    name: 'change_title',
    patterns: CHANGE_TITLE_TOOL_NAME_ALIASES,
    inputFields: ['title'],
    emptyInputDefault: true,
  },
] as const;

function canonicalizeCodexExplicitToolHint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalizedHint = trimmed.replace(/^tool:\s*/i, '').trim();
  if (!normalizedHint) return null;

  if (isChangeTitleToolNameAlias(normalizedHint)) return 'change_title';
  if (normalizedHint.startsWith('mcp__')) return normalizedHint;

  const slashParts = normalizedHint.split('/').filter(Boolean);
  if (slashParts.length < 2) return null;

  const [serverId, ...toolParts] = slashParts;
  if (!serverId || toolParts.length === 0) return null;
  const allParts = [serverId, ...toolParts];
  if (!allParts.every((part) => /^[a-z0-9_.-]+$/i.test(part))) return null;

  return `mcp__${serverId}__${toolParts.join('__')}`;
}

export class CodexAcpTransport extends DefaultTransport {
  constructor(
    private readonly initTimeoutMs: number,
    private readonly preToolIdleTimeoutMs: number,
  ) {
    super('codex');
  }

  override getInitTimeout(): number {
    return this.initTimeoutMs;
  }

  override getPreToolCallIdleTimeoutMs(): number {
    return this.preToolIdleTimeoutMs;
  }

  override getToolPatterns(): ToolPattern[] {
    return [...CODEX_TOOL_PATTERNS];
  }

  override extractToolNameFromId(toolCallId: string): string | null {
    return findToolNameFromId(toolCallId, CODEX_TOOL_PATTERNS, { preferLongestMatch: true });
  }

  override determineToolName(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    _context: ToolNameContext,
  ): string {
    const idToolName = findToolNameFromId(toolCallId, CODEX_TOOL_PATTERNS, { preferLongestMatch: true });
    if (idToolName) return idToolName;

    const explicitInputToolHint = [
      input.tool_name,
      input.toolName,
      input.name,
      input.title,
      input.description,
      (typeof input._acp === 'object' && input._acp && !Array.isArray(input._acp))
        ? (input._acp as Record<string, unknown>).title
        : null,
    ]
      .map(canonicalizeCodexExplicitToolHint)
      .find((candidate): candidate is string => typeof candidate === 'string');
    if (explicitInputToolHint) return explicitInputToolHint;

    const directExplicitToolHint = canonicalizeCodexExplicitToolHint(toolName);
    if (directExplicitToolHint) return directExplicitToolHint;

    const directToolName = findToolNameFromId(toolName, CODEX_TOOL_PATTERNS, { preferLongestMatch: true });
    if (directToolName) return directToolName;

    const normalizedName = toolName.trim().toLowerCase();
    if (normalizedName !== 'unknown' && normalizedName !== 'other' && normalizedName !== 'unknown tool') {
      return toolName;
    }

    const inputToolName = findToolNameFromInputFields(input, CODEX_TOOL_PATTERNS);
    if (inputToolName) return inputToolName;
    if (isEmptyToolInput(input)) return toolName;

    return toolName;
  }
}
