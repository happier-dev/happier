import type {
  BuiltInMcpPreviewEntryV1,
  DaemonMcpServersDetectWarningV1,
  DaemonMcpServersPreviewResponse,
  DetectedMcpServerV1,
  McpServersSettingsV1,
  SessionMcpSelectionV1,
} from '@happier-dev/protocol';

import { resolveManagedSessionMcpSelectionForDirectory } from '@/mcp/servers/resolveManagedSessionMcpSelectionForDirectory';

import { buildManagedMcpPreviewEntries } from './buildManagedMcpPreviewEntries';
import { resolveDetectedMcpPreviewEntries } from './resolveDetectedMcpPreviewEntries';

function createBuiltInMcpPreviewEntry(): BuiltInMcpPreviewEntryV1 {
  return {
    key: 'built-in:happier',
    name: 'happier',
    title: 'Happier',
    transport: 'stdio',
    authMode: 'none',
    selected: true,
    selectable: false,
    availability: 'active',
    sourceKind: 'builtIn',
    scopeKind: 'builtIn',
  };
}

function formatWarning(warning: DaemonMcpServersDetectWarningV1): string {
  return `${warning.provider}:${warning.code}${warning.path ? `:${warning.path}` : ''}`;
}

export function resolveSessionMcpPreview(params: Readonly<{
  settings: McpServersSettingsV1;
  machineId: string;
  directory: string;
  agentId: string;
  selection?: SessionMcpSelectionV1 | null;
  detectedServers: ReadonlyArray<DetectedMcpServerV1>;
  detectedWarnings?: ReadonlyArray<DaemonMcpServersDetectWarningV1>;
}>): Extract<DaemonMcpServersPreviewResponse, { ok: true }> {
  const managedSelection = resolveManagedSessionMcpSelectionForDirectory({
    settings: params.settings,
    machineId: params.machineId,
    directory: params.directory,
    selection: params.selection ?? null,
  });

  const builtIn = [createBuiltInMcpPreviewEntry()];
  const managed = buildManagedMcpPreviewEntries(managedSelection);
  const detected = resolveDetectedMcpPreviewEntries({
    agentId: params.agentId,
    servers: params.detectedServers,
  });
  const warnings = (params.detectedWarnings ?? []).map(formatWarning).filter((value) => value.length > 0);

  return {
    ok: true,
    builtIn,
    managed,
    detected,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
