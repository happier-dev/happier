import { resolveOpenCodeChangeTitleToolNameForMcpClient } from '@/backends/opencode/server/openCodeMcpToolNames';

export function resolvePreferredChangeTitleToolNameForProvider(providerId: string | null | undefined): string {
  const normalized = typeof providerId === 'string' ? providerId.trim() : '';
  if (normalized === 'opencode') {
    return resolveOpenCodeChangeTitleToolNameForMcpClient('happier');
  }
  return 'mcp__happier__change_title';
}
