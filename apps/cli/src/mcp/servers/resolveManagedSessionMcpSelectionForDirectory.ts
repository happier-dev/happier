import { resolveManagedSessionMcpSelectionV1 } from '@happier-dev/protocol/mcp/servers/resolveManagedSessionMcpSelectionV1';
import type { McpServersSettingsV1, ResolveManagedSessionMcpSelectionV1Result, SessionMcpSelectionV1 } from '@happier-dev/protocol';
import { createRealpathNormalizer } from './createRealpathNormalizer';

export function resolveManagedSessionMcpSelectionForDirectory(params: Readonly<{
  settings: McpServersSettingsV1;
  machineId: string;
  directory: string;
  selection?: SessionMcpSelectionV1 | null;
}>): ResolveManagedSessionMcpSelectionV1Result {
  const normalizePath = createRealpathNormalizer();
  return resolveManagedSessionMcpSelectionV1(params.settings, {
    machineId: params.machineId,
    directory: params.directory,
    selection: params.selection ?? null,
    normalizePath,
  });
}
