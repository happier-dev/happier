import {
  DaemonMcpServersDetectWarningV1Schema,
  McpDetectedProviderV1Schema,
  type DaemonMcpServersDetectWarningV1,
  type DetectedMcpServerV1,
  type McpDetectedProviderV1,
} from '@happier-dev/protocol';
import type {
  ExecLaunchInputV1,
  McpDiscoveryProviderReturnV1,
  McpResolveForSessionInputV1,
  McpServerSpecV1,
  PluginApiMcpDiscoveryProviderRegistrationV1,
} from '@happier-dev/plugin-sdk';

import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { assertMcpRuntimeRegistrationSecretFree } from '@/plugins/runtime/api/mcpSafety';

export type PluginMcpDiscoveryProviderEntry = Readonly<{
  pluginId: string;
  registration: PluginApiMcpDiscoveryProviderRegistrationV1;
}>;

export type DetectProviderMcpServersResult = Readonly<{
  servers: ReadonlyArray<DetectedMcpServerV1>;
  warnings: ReadonlyArray<DaemonMcpServersDetectWarningV1>;
}>;

function normalizeProvidersFilter(input: unknown): ReadonlySet<McpDetectedProviderV1> | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out = new Set<McpDetectedProviderV1>();
  for (const entry of input) {
    const parsed = McpDetectedProviderV1Schema.safeParse(entry);
    if (parsed.success) out.add(parsed.data);
  }
  return out.size > 0 ? out : null;
}

function readProviderFromDiscoveryId(id: string): McpDetectedProviderV1 | null {
  const segment = id.split('.')[0]?.trim();
  if (!segment) return null;
  const parsed = McpDetectedProviderV1Schema.safeParse(segment);
  return parsed.success ? parsed.data : null;
}

function readDirectory(input: string | null): string | null {
  return typeof input === 'string' && input.trim().length > 0 ? input.trim() : null;
}

function toDetectionInput(directory: string | null): McpResolveForSessionInputV1 {
  return Object.freeze({
    sessionId: 'mcp-detection',
    ...(directory ? { directory } : {}),
  });
}

async function resolveDiscoveryProviders(
  entries: readonly PluginMcpDiscoveryProviderEntry[] | undefined,
): Promise<readonly PluginMcpDiscoveryProviderEntry[]> {
  if (entries) return entries;
  const registry = await resolveExecutablePluginRuntimeRegistry();
  return Object.freeze([...(registry.mcpDiscoveryProviders ?? [])]);
}

function readEnvKeys(launch: ExecLaunchInputV1): string[] {
  if (launch.kind === 'ipc' || !launch.env) return [];
  return Object.keys(launch.env).sort();
}

function readCommand(launch: ExecLaunchInputV1): string | null {
  if (launch.kind === 'binary') return launch.executablePath;
  if (launch.kind === 'agent-cli') return launch.agentId;
  return null;
}

function readArgs(launch: ExecLaunchInputV1): string[] {
  if (launch.kind === 'ipc') return [];
  return [...(launch.args ?? [])];
}

function normalizeDiscoveredServer(params: Readonly<{
  provider: McpDetectedProviderV1;
  registrationId: string;
  directory: string | null;
  server: McpServerSpecV1;
}>): DetectedMcpServerV1 | null {
  const source = Object.freeze({
    kind: params.directory ? 'project' as const : 'user' as const,
    path: `plugin:${params.registrationId}`,
  });

  if (params.server.transport.kind === 'stdio') {
    const command = readCommand(params.server.transport.launch);
    if (!command) return null;
    return {
      provider: params.provider,
      name: params.server.name,
      transport: 'stdio',
      stdio: {
        command,
        args: readArgs(params.server.transport.launch),
      },
      envKeys: readEnvKeys(params.server.transport.launch),
      enabled: null,
      source,
    };
  }

  if (params.server.transport.kind === 'http' || params.server.transport.kind === 'sse') {
    return {
      provider: params.provider,
      name: params.server.name,
      transport: params.server.transport.kind,
      remote: {
        url: params.server.transport.url,
        headers: [],
      },
      envKeys: [],
      enabled: null,
      source,
    };
  }

  return null;
}

function normalizeDiscoveryWarning(
  provider: McpDetectedProviderV1,
  warning: unknown,
): DaemonMcpServersDetectWarningV1 {
  const parsed = DaemonMcpServersDetectWarningV1Schema.safeParse(warning);
  if (!parsed.success) {
    return Object.freeze({
      provider,
      code: 'unsupported',
      detail: 'Plugin MCP discovery returned an invalid warning',
    });
  }
  return Object.freeze({
    ...parsed.data,
    provider,
  });
}

function isMcpServerSpecArray(discovered: McpDiscoveryProviderReturnV1): discovered is readonly McpServerSpecV1[] {
  return Array.isArray(discovered);
}

function normalizeDiscoveryResult(
  provider: McpDetectedProviderV1,
  discovered: McpDiscoveryProviderReturnV1,
): Readonly<{
  servers: readonly McpServerSpecV1[];
  warnings: readonly DaemonMcpServersDetectWarningV1[];
}> {
  if (isMcpServerSpecArray(discovered)) {
    return Object.freeze({
      servers: Object.freeze([...discovered]),
      warnings: Object.freeze([]),
    });
  }

  const servers = Array.isArray(discovered.servers) ? Object.freeze([...discovered.servers]) : Object.freeze([]);
  const rawWarnings: unknown[] = [];
  if (Array.isArray(discovered.warnings)) rawWarnings.push(...discovered.warnings);
  if (Array.isArray(discovered.diagnostics)) rawWarnings.push(...discovered.diagnostics);

  return Object.freeze({
    servers,
    warnings: Object.freeze(rawWarnings.map((warning) => normalizeDiscoveryWarning(provider, warning))),
  });
}

export async function detectProviderMcpServers(params: Readonly<{
  directory: string | null;
  providers: unknown;
  env?: NodeJS.ProcessEnv;
  mcpDiscoveryProviders?: readonly PluginMcpDiscoveryProviderEntry[];
}>): Promise<DetectProviderMcpServersResult> {
  void params.env;
  const providers = normalizeProvidersFilter(params.providers);
  const directory = readDirectory(params.directory);
  const servers: DetectedMcpServerV1[] = [];
  const warnings: DaemonMcpServersDetectWarningV1[] = [];

  for (const entry of await resolveDiscoveryProviders(params.mcpDiscoveryProviders)) {
    const provider = readProviderFromDiscoveryId(entry.registration.id);
    if (!provider || (providers && !providers.has(provider))) continue;

    try {
      const discovered = normalizeDiscoveryResult(
        provider,
        await entry.registration.discover(toDetectionInput(directory)),
      );
      warnings.push(...discovered.warnings);
      for (const server of discovered.servers) {
        try {
          assertMcpRuntimeRegistrationSecretFree(server);
        } catch {
          warnings.push(Object.freeze({
            provider,
            code: 'unsupported',
            path: `plugin:${entry.registration.id}`,
          }));
          continue;
        }
        const normalized = normalizeDiscoveredServer({
          provider,
          registrationId: entry.registration.id,
          directory,
          server,
        });
        if (normalized) {
          servers.push(normalized);
        } else {
          warnings.push(Object.freeze({
            provider,
            code: 'unsupported',
            detail: 'Unsupported plugin MCP discovery transport',
          }));
        }
      }
    } catch {
      warnings.push(Object.freeze({
        provider,
        code: 'read_failed',
        detail: 'Plugin MCP discovery failed',
      }));
    }
  }

  return Object.freeze({
    servers: Object.freeze(servers),
    warnings: Object.freeze(warnings),
  });
}
