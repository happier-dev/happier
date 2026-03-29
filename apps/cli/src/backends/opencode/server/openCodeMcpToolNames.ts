import type { McpServerConfig } from '@/agent';

function sanitizeOpenCodeMcpClientName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function resolveOpenCodeChangeTitleToolNameForMcpClient(mcpClientName: string): string {
  return `${sanitizeOpenCodeMcpClientName(mcpClientName)}_change_title`;
}

export function resolveOpenCodeSessionTitleSetToolNameForMcpClient(mcpClientName: string): string {
  return `${sanitizeOpenCodeMcpClientName(mcpClientName)}_session_title_set`;
}

export function canonicalizeOpenCodeConfiguredMcpToolName(
  rawToolName: string,
  mcpServers: Readonly<Record<string, McpServerConfig>>,
): string | null {
  const trimmed = rawToolName.trim();
  if (!trimmed || trimmed.startsWith('mcp__')) return null;

  const matchingAlias = Object.keys(mcpServers)
    .map((serverName) => sanitizeOpenCodeMcpClientName(serverName))
    .filter((serverAlias) => trimmed.startsWith(`${serverAlias}_`))
    .sort((left, right) => right.length - left.length)[0];
  if (!matchingAlias) return null;

  const toolSuffix = trimmed.slice(matchingAlias.length + 1).trim();
  if (!toolSuffix) return null;

  return `mcp__${matchingAlias}__${toolSuffix}`;
}
