import {
  resolveManagedSessionMcpSelectionV1,
  type McpServersSettingsV1,
  type ResolveManagedSessionMcpSelectionV1Result,
  type SessionMcpSelectionV1,
} from '@happier-dev/protocol';
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
