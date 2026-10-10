import { readSessionMcpSelectionV1FromMetadata } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import type { AccountSettings, McpServerCatalogEntryV1, PluginExecutionScopeV1, ResolvedMcpServerV1, SessionMcpSelectionV1 } from '@happier-dev/protocol';
import { readMcpServersSettingsFromAccountSettings } from './readMcpServersSettingsFromAccountSettings';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveManagedSessionMcpSelectionForDirectory } from './resolveManagedSessionMcpSelectionForDirectory';
import type {
  McpSessionResolutionInput,
  ResolvedSessionMcpScope,
  ResolvedSessionMcpServer,
  ResolvedSessionMcpTransport,
} from '../runtimeTypes';

export type ResolvePluginMcpServersForSessionParams = Readonly<{
  input: McpSessionResolutionInput;
  accountSettings: AccountSettings | null;
  accountSettingsSnapshot?: ActiveAccountSettingsSnapshot | null;
  machineId: string;
  directory: string;
  sessionMetadata?: unknown;
  /** Explicit Run-owned selection; avoids fabricating Session metadata for detached Runs. */
  selection?: SessionMcpSelectionV1 | null;
}>;

export type ResolvedPluginMcpServerForExecutionScope = Omit<ResolvedSessionMcpServer, 'scope'> & Readonly<{
  scope: PluginExecutionScopeV1 & Readonly<{ directory: string }>;
}>;

export type ResolvePluginMcpServersForExecutionScopeParams = Omit<
  ResolvePluginMcpServersForSessionParams,
  'input' | 'sessionMetadata'
> & Readonly<{
  scope: PluginExecutionScopeV1;
}>;

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createScope(input: McpSessionResolutionInput, directory: string): ResolvedSessionMcpScope | null {
  const sessionId = readTrimmedString(input.sessionId);
  if (!sessionId) return null;
  return Object.freeze({
    sessionId,
    directory,
  });
}

function resolveManagedTransport(config: McpServerCatalogEntryV1): ResolvedSessionMcpTransport | null {
  if (config.transport === 'stdio') {
    if (!config.stdio) return null;
    return Object.freeze({ kind: 'stdio' });
  }
  if (config.transport === 'http' || config.transport === 'sse') {
    if (!config.remote) return null;
    return Object.freeze({
      kind: config.transport,
      url: config.remote.url,
    });
  }
  return null;
}

function resolveManagedServerSpec(
  server: ResolvedMcpServerV1,
  scope: ResolvedSessionMcpScope,
): ResolvedSessionMcpServer | null {
  const transport = resolveManagedTransport(server.config);
  if (!transport) return null;
  return Object.freeze({
    id: server.serverId,
    name: server.name,
    ...(server.config.title ? { title: server.config.title } : {}),
    ...(server.config.description ? { description: server.config.description } : {}),
    transport,
    scope,
  });
}

function compareResolvedMcpServers(
  left: Pick<ResolvedSessionMcpServer, 'id' | 'name'>,
  right: Pick<ResolvedSessionMcpServer, 'id' | 'name'>,
): number {
  return left.id.localeCompare(right.id) || left.name.localeCompare(right.name);
}

export function resolvePluginMcpServersForSession(
  params: ResolvePluginMcpServersForSessionParams,
): readonly ResolvedSessionMcpServer[] {
  const directory = readTrimmedString(params.directory);
  const machineId = readTrimmedString(params.machineId);
  if (!params.accountSettings || !directory || !machineId) return Object.freeze([]);

  const scope = createScope(params.input, directory);
  if (!scope) return Object.freeze([]);

  const settings = readMcpServersSettingsFromAccountSettings(params.accountSettingsSnapshot ?? null);
  const selection = params.selection === undefined
    ? readSessionMcpSelectionV1FromMetadata(params.sessionMetadata)
    : params.selection;
  const resolvedSelection = resolveManagedSessionMcpSelectionForDirectory({
    settings,
    machineId,
    directory,
    selection,
  });

  const resolved: ResolvedSessionMcpServer[] = [];
  for (const server of Object.values(resolvedSelection.selectedServersByName)) {
    const spec = resolveManagedServerSpec(server, scope);
    if (spec) resolved.push(spec);
  }
  return Object.freeze(resolved.sort(compareResolvedMcpServers));
}

/** Resolves explicit Run-owned MCP selection without manufacturing Session metadata or identity. */
export function resolvePluginMcpServersForExecutionScope(
  params: ResolvePluginMcpServersForExecutionScopeParams,
): readonly ResolvedPluginMcpServerForExecutionScope[] {
  const directory = readTrimmedString(params.directory);
  const machineId = readTrimmedString(params.machineId);
  if (!params.accountSettings || !directory || !machineId) return Object.freeze([]);

  const settings = readMcpServersSettingsFromAccountSettings(params.accountSettingsSnapshot ?? null);
  const resolvedSelection = resolveManagedSessionMcpSelectionForDirectory({
    settings,
    machineId,
    directory,
    selection: params.selection ?? null,
  });
  const scope = Object.freeze({ ...params.scope, directory });
  const resolved: ResolvedPluginMcpServerForExecutionScope[] = [];
  for (const server of Object.values(resolvedSelection.selectedServersByName)) {
    const transport = resolveManagedTransport(server.config);
    if (!transport) continue;
    resolved.push(Object.freeze({
      id: server.serverId,
      name: server.name,
      ...(server.config.title ? { title: server.config.title } : {}),
      ...(server.config.description ? { description: server.config.description } : {}),
      transport,
      scope,
    }));
  }
  return Object.freeze(resolved.sort(compareResolvedMcpServers));
}
