import {
  DaemonMcpServersDetectWarningV1Schema,
  McpDetectedProviderV1Schema,
  PluginMcpServerTransportV1Schema,
  type DaemonMcpServersDetectWarningV1,
  type DetectedMcpServerV1,
  type McpDetectedProviderV1,
} from '@happier-dev/protocol';
import type {
  McpDiscoveryProviderReturnV1,
  McpResolveForSessionInputV1,
  McpServerSpecV1,
} from '@happier-dev/plugin-sdk/experimental/mcp';

import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { assertMcpRuntimeRegistrationSecretFree } from '@/plugins/runtime/api/mcpSafety';

export type PluginMcpDiscoveryProviderEntry = Readonly<{
  pluginId: string;
  provider?: McpDetectedProviderV1;
  registration: Readonly<{
    id: string;
    discover(
      input?: McpResolveForSessionInputV1,
    ): Promise<McpDiscoveryProviderReturnV1> | McpDiscoveryProviderReturnV1;
  }>;
  discover?: (
    input: McpResolveForSessionInputV1,
    signal: AbortSignal,
  ) => Promise<McpDiscoveryProviderReturnV1>;
}>;

export type DetectProviderMcpServersResult = Readonly<{
  servers: ReadonlyArray<DetectedMcpServerV1>;
  warnings: ReadonlyArray<DaemonMcpServersDetectWarningV1>;
}>;

type McpStdioExecutableLaunch =
  Extract<McpServerSpecV1['transport'], { kind: 'stdio' }>['launch'];

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

function readProviderFromDiscoveryDefinition(
  definition: Readonly<{ id: string; metadata?: Readonly<Record<string, unknown>> }>,
): McpDetectedProviderV1 | null {
  const metadataAgentId = definition.metadata?.agentId;
  if (typeof metadataAgentId === 'string') {
    const parsed = McpDetectedProviderV1Schema.safeParse(metadataAgentId);
    if (parsed.success) return parsed.data;
  }
  return readProviderFromDiscoveryId(definition.id);
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

async function acquireDiscoveryProviders(
  entries: readonly PluginMcpDiscoveryProviderEntry[] | undefined,
  providers: ReadonlySet<McpDetectedProviderV1> | null,
): Promise<Readonly<{
  entries: readonly PluginMcpDiscoveryProviderEntry[];
  warnings: readonly DaemonMcpServersDetectWarningV1[];
  release: () => Promise<void>;
}>> {
  if (entries) {
    return Object.freeze({
      entries,
      warnings: Object.freeze([]),
      release: async () => {},
    });
  }
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  const declaredProviders = (lease.registry.contributes.mcpDiscoveryProviders ?? [])
    .flatMap((contribution) => {
      const provider = readProviderFromDiscoveryDefinition(contribution.definition);
      if (!provider || (providers && !providers.has(provider))) return [];
      return [{ contribution, provider }];
    });
  const stableDiscover = lease.registry.discoverMcpServersForDetection;
  const ownedRuntimeEntries = stableDiscover
    ? Object.freeze(declaredProviders.flatMap(({ contribution, provider }) => {
        const pluginId = contribution.pluginId;
        return pluginId
          ? [Object.freeze({
              pluginId,
              provider,
              registration: Object.freeze({
                id: contribution.definition.id,
                discover: async () => Object.freeze([]),
              }),
              discover: async (input: McpResolveForSessionInputV1, signal: AbortSignal) => (
                await stableDiscover({
                  pluginId,
                  localId: contribution.definition.id,
                  input,
                  signal,
                })
              ),
            })]
          : [];
      }))
    : Object.freeze([]);
  const warnings = Object.freeze(declaredProviders.flatMap(({ contribution, provider }) => (
    stableDiscover && contribution.pluginId
      ? []
      : [Object.freeze({
        provider,
        code: 'read_failed' as const,
        path: `plugin:${contribution.definition.id}`,
        detail: 'Plugin MCP discovery provider is unavailable',
      })]
  )));
  return Object.freeze({
    entries: ownedRuntimeEntries,
    warnings,
    release: lease.release,
  });
}

function readEnvKeys(launch: McpStdioExecutableLaunch): string[] {
  if (launch.kind === 'ipc' || !launch.env) return [];
  return Object.keys(launch.env).sort();
}

function readCommand(launch: McpStdioExecutableLaunch): string | null {
  if (launch.kind === 'binary') return launch.executablePath;
  if (launch.kind === 'agent-cli') return launch.agentId;
  return null;
}

function readArgs(launch: McpStdioExecutableLaunch): string[] {
  if (launch.kind === 'ipc') return [];
  return [...(launch.args ?? [])];
}

const MCP_DISCOVERY_ENV_KEY_MAX_LENGTH = 128;
const MCP_DISCOVERY_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DEFAULT_MCP_DISCOVERY_PROVIDER_TIMEOUT_MS = 5_000;
const MCP_DISCOVERY_PROVIDER_TIMEOUT_ENV = 'HAPPIER_MCP_DISCOVERY_PROVIDER_TIMEOUT_MS';
const MCP_DISCOVERY_PROVIDER_TIMEOUT_MAX_MS = 60_000;

function assertLaunchEnvKeySafe(key: string): void {
  if (
    key.length === 0
    || key.length > MCP_DISCOVERY_ENV_KEY_MAX_LENGTH
    || !MCP_DISCOVERY_ENV_KEY_PATTERN.test(key)
  ) {
    throw new Error('MCP discovery env placeholder keys must be valid env var names');
  }
}

function readPositiveFiniteInteger(input: unknown): number | null {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input > 0 ? Math.floor(input) : null;
  }
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function clampDiscoveryTimeoutMs(input: number): number {
  return Math.min(MCP_DISCOVERY_PROVIDER_TIMEOUT_MAX_MS, Math.max(1, Math.floor(input)));
}

function resolveDiscoveryTimeoutMs(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  discoveryTimeoutMs?: number;
}>): number {
  const explicit = readPositiveFiniteInteger(params.discoveryTimeoutMs);
  if (explicit !== null) return clampDiscoveryTimeoutMs(explicit);

  const fromEnv = readPositiveFiniteInteger(params.env?.[MCP_DISCOVERY_PROVIDER_TIMEOUT_ENV]);
  if (fromEnv !== null) return clampDiscoveryTimeoutMs(fromEnv);

  return DEFAULT_MCP_DISCOVERY_PROVIDER_TIMEOUT_MS;
}

async function discoverWithTimeout(
  entry: PluginMcpDiscoveryProviderEntry,
  input: McpResolveForSessionInputV1,
  timeoutMs: number,
): Promise<
  | Readonly<{ type: 'resolved'; value: McpDiscoveryProviderReturnV1 }>
  | Readonly<{ type: 'rejected'; error: unknown }>
  | Readonly<{ type: 'timeout' }>
> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  try {
    const discovery = Promise.resolve(
      entry.discover?.(input, controller.signal) ?? entry.registration.discover(input),
    )
      .then((value) => ({ type: 'resolved' as const, value }))
      .catch((error: unknown) => ({ type: 'rejected' as const, error }));
    const timeoutResult = new Promise<Readonly<{ type: 'timeout' }>>((resolve) => {
      timeout = setTimeout(() => {
        resolve({ type: 'timeout' });
        controller.abort(new Error('MCP discovery timed out'));
      }, timeoutMs);
      timeout.unref?.();
    });
    return await Promise.race([discovery, timeoutResult]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertLaunchEnvContainsOnlyPlaceholders(launch: McpStdioExecutableLaunch): void {
  if (launch.kind === 'ipc' || !launch.env) return;
  for (const [key, value] of Object.entries(launch.env)) {
    assertLaunchEnvKeySafe(key);
    if (value !== '') {
      throw new Error('MCP discovery env values must be redacted placeholders');
    }
  }
}

function stripLaunchEnvForSafety(server: McpServerSpecV1): unknown {
  if (server.transport.kind !== 'stdio') return server;
  const launch = server.transport.launch;
  if (!('env' in launch) || !launch.env) return server;
  const { env: _env, ...launchWithoutEnv } = launch;
  return {
    ...server,
    transport: {
      ...server.transport,
      launch: launchWithoutEnv,
    },
  };
}

function assertDiscoveredMcpServerSafeForDetection(server: McpServerSpecV1): void {
  if (server.transport.kind === 'stdio') {
    assertLaunchEnvContainsOnlyPlaceholders(server.transport.launch);
  }
  if (
    (server.transport.kind === 'http' || server.transport.kind === 'sse')
    && !PluginMcpServerTransportV1Schema.safeParse({
      kind: 'http',
      url: server.transport.url,
    }).success
  ) {
    throw new Error('Discovered MCP remote URL is not safe');
  }
  assertMcpRuntimeRegistrationSecretFree(stripLaunchEnvForSafety(server));
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
  discoveryTimeoutMs?: number;
  mcpDiscoveryProviders?: readonly PluginMcpDiscoveryProviderEntry[];
}>): Promise<DetectProviderMcpServersResult> {
  const providers = normalizeProvidersFilter(params.providers);
  const directory = readDirectory(params.directory);
  const detectionInput = toDetectionInput(directory);
  const discoveryTimeoutMs = resolveDiscoveryTimeoutMs({
    env: params.env,
    discoveryTimeoutMs: params.discoveryTimeoutMs,
  });
  const servers: DetectedMcpServerV1[] = [];
  const warnings: DaemonMcpServersDetectWarningV1[] = [];
  const discoveryProviders = await acquireDiscoveryProviders(params.mcpDiscoveryProviders, providers);
  warnings.push(...discoveryProviders.warnings);

  try {
    for (const entry of discoveryProviders.entries) {
      const provider = entry.provider ?? readProviderFromDiscoveryId(entry.registration.id);
      if (!provider || (providers && !providers.has(provider))) continue;

      try {
        const outcome = await discoverWithTimeout(entry, detectionInput, discoveryTimeoutMs);
        if (outcome.type === 'timeout') {
          warnings.push(Object.freeze({
            provider,
            code: 'read_failed',
            detail: 'Plugin MCP discovery timed out',
          }));
          continue;
        }
        if (outcome.type === 'rejected') {
          throw outcome.error;
        }

        const discovered = normalizeDiscoveryResult(provider, outcome.value);
        warnings.push(...discovered.warnings);
        for (const server of discovered.servers) {
          try {
            assertDiscoveredMcpServerSafeForDetection(server);
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
  } finally {
    await discoveryProviders.release();
  }

  return Object.freeze({
    servers: Object.freeze(servers),
    warnings: Object.freeze(warnings),
  });
}
