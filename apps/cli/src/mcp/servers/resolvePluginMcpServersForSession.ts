import {
  readSessionMcpSelectionV1FromMetadata,
  type AccountSettings,
  type McpServerCatalogEntryV1,
  type ResolvedMcpServerV1,
} from '@happier-dev/protocol';
import type {
  McpResolveForSessionInputV1,
  McpResolvedScopeV1,
  McpResolvedServerTransportV1,
  McpServerSpecV1,
  McpServerTransportV1,
  ResolvedMcpServerSpecV1,
} from '@happier-dev/plugin-sdk';

import { readMcpServersSettingsFromAccountSettings } from './readMcpServersSettingsFromAccountSettings';
import { resolveManagedSessionMcpSelectionForDirectory } from './resolveManagedSessionMcpSelectionForDirectory';

export type ResolvePluginMcpServersForSessionParams = Readonly<{
  input: McpResolveForSessionInputV1;
  accountSettings: AccountSettings | null;
  machineId: string;
  directory: string;
  sessionMetadata?: unknown;
  pluginServers?: readonly McpServerSpecV1[];
}>;

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createScope(input: McpResolveForSessionInputV1, directory: string): McpResolvedScopeV1 | null {
  const sessionId = readTrimmedString(input.sessionId);
  if (!sessionId) return null;
  return Object.freeze({
    sessionId,
    directory,
  });
}

function sanitizePluginTransport(transport: McpServerTransportV1): McpResolvedServerTransportV1 | null {
  if (transport.kind === 'hosted') {
    return Object.freeze({ kind: 'hosted' });
  }
  if (transport.kind === 'http' || transport.kind === 'sse') {
    return Object.freeze({
      kind: transport.kind,
      url: transport.url,
    });
  }
  if (transport.kind === 'stdio') {
    return Object.freeze({ kind: 'stdio' });
  }
  if (transport.kind === 'managed') {
    const url = readTrimmedString(transport.url);
    return Object.freeze({
      kind: 'managed',
      ...(url ? { url } : {}),
    });
  }
  return null;
}

function resolveManagedTransport(config: McpServerCatalogEntryV1): McpResolvedServerTransportV1 | null {
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
  scope: McpResolvedScopeV1,
): ResolvedMcpServerSpecV1 | null {
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

function resolvePluginServerSpec(
  server: McpServerSpecV1,
  scope: McpResolvedScopeV1,
): ResolvedMcpServerSpecV1 | null {
  const transport = sanitizePluginTransport(server.transport);
  if (!transport) return null;
  return Object.freeze({
    id: server.id,
    name: server.name,
    ...(server.title ? { title: server.title } : {}),
    ...(server.description ? { description: server.description } : {}),
    transport,
    scope,
  });
}

function compareResolvedMcpServers(left: ResolvedMcpServerSpecV1, right: ResolvedMcpServerSpecV1): number {
  return left.id.localeCompare(right.id) || left.name.localeCompare(right.name);
}

export function resolvePluginMcpServersForSession(
  params: ResolvePluginMcpServersForSessionParams,
): readonly ResolvedMcpServerSpecV1[] {
  const directory = readTrimmedString(params.directory);
  const machineId = readTrimmedString(params.machineId);
  if (!params.accountSettings || !directory || !machineId) return Object.freeze([]);

  const scope = createScope(params.input, directory);
  if (!scope) return Object.freeze([]);

  const settings = readMcpServersSettingsFromAccountSettings(params.accountSettings);
  const selection = readSessionMcpSelectionV1FromMetadata(params.sessionMetadata);
  const resolvedSelection = resolveManagedSessionMcpSelectionForDirectory({
    settings,
    machineId,
    directory,
    selection,
  });

  const resolved: ResolvedMcpServerSpecV1[] = [];
  for (const server of Object.values(resolvedSelection.selectedServersByName)) {
    const spec = resolveManagedServerSpec(server, scope);
    if (spec) resolved.push(spec);
  }
  for (const server of params.pluginServers ?? []) {
    const spec = resolvePluginServerSpec(server, scope);
    if (spec) resolved.push(spec);
  }

  return Object.freeze(resolved.sort(compareResolvedMcpServers));
}
