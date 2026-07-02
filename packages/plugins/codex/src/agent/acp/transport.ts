import { CHANGE_TITLE_TOOL_NAME_ALIASES, isChangeTitleToolNameAlias } from '@happier-dev/protocol/tools/v2';

export type CodexAcpToolPattern = Readonly<{
  name: string;
  patterns: readonly string[];
  inputFields: readonly string[];
  emptyInputDefault?: boolean;
}>;

export const CODEX_ACP_TOOL_PATTERNS: readonly CodexAcpToolPattern[] = [
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

export function resolveCodexAcpExplicitToolHint(params: Readonly<{
  toolName: string;
  input: Readonly<Record<string, unknown>>;
}>): string | null {
  const explicitInputToolHint = [
    params.input.tool_name,
    params.input.toolName,
    params.input.name,
    params.input.title,
    params.input.description,
    (typeof params.input._acp === 'object' && params.input._acp && !Array.isArray(params.input._acp))
      ? (params.input._acp as Record<string, unknown>).title
      : null,
  ]
    .map(canonicalizeCodexExplicitToolHint)
    .find((candidate): candidate is string => typeof candidate === 'string');
  if (explicitInputToolHint) return explicitInputToolHint;

  return canonicalizeCodexExplicitToolHint(params.toolName);
}
