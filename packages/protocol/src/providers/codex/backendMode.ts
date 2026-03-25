export const CODEX_BACKEND_MODES = ['mcp', 'acp', 'appServer'] as const;

export type CodexBackendMode = (typeof CODEX_BACKEND_MODES)[number];

export function normalizeCodexBackendMode(value: unknown): CodexBackendMode | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === 'mcp') return 'mcp';
    if (trimmed === 'appServer') return 'appServer';
    if (trimmed === 'acp' || trimmed === 'mcp_resume') return 'acp';
    return null;
  }
  return null;
}
