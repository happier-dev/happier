import { DaemonMcpServersDetectWarningV1Schema, McpDetectedProviderV1Schema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import { PluginMcpServerTransportV1Schema } from '@happier-dev/protocol/plugins/contributions/mcp';
import type { DaemonMcpServersDetectWarningV1, DetectedMcpServerV1, McpDetectedProviderV1 } from '@happier-dev/protocol';
import type {
  McpDiscoveredEndpoint as PluginMcpDiscoveredEndpoint,
  McpDiscoveryRequest as PluginMcpDiscoveryRequest,
} from '@happier-dev/plugin-sdk/mcp';
import { normalizeDetectedMcpServerV1 } from '@happier-dev/plugin-sdk/mcp';

import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { ResolvedMcpEndpointDiscoveryResult } from '@/mcp/runtimeTypes';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

export type PluginMcpEndpointDiscoveryResult = ResolvedMcpEndpointDiscoveryResult;

type PluginMcpDiscoverySourceEntry = Readonly<{
  /**
   * The Agent that owns this discovery source. Detection never derives it from
   * the contribution's local id: identity comes from the declaration, so an
   * undeclared source is reported as unresolvable instead of borrowing one.
   */
  provider: McpDetectedProviderV1;
  loadedInHappierSessions: boolean;
  /** The declaring contribution's local id, used as the detected source path. */
  sourceId: string;
  discover(
    input: PluginMcpDiscoveryRequest,
    signal: AbortSignal,
  ): Promise<PluginMcpEndpointDiscoveryResult>;
}>;

export type DetectProviderMcpServersResult = Readonly<{
  servers: ReadonlyArray<DetectedMcpServerV1>;
  warnings: ReadonlyArray<DaemonMcpServersDetectWarningV1>;
}>;

/**
 * Normalize the requested Agent filter.
 *
 * An empty request means "every Agent". A request that named Agents but whose
 * every entry was unusable keeps an empty filter — never `null` — so a
 * malformed request cannot silently widen into an unfiltered scan, and each
 * dropped entry is reported.
 */
function normalizeProvidersFilter(input: unknown): Readonly<{
  providers: ReadonlySet<McpDetectedProviderV1> | null;
  warnings: readonly DaemonMcpServersDetectWarningV1[];
}> {
  if (!Array.isArray(input) || input.length === 0) {
    return Object.freeze({ providers: null, warnings: Object.freeze([]) });
  }
  const out = new Set<McpDetectedProviderV1>();
  const warnings: DaemonMcpServersDetectWarningV1[] = [];
  for (const entry of input) {
    const parsed = McpDetectedProviderV1Schema.safeParse(entry);
    if (parsed.success) {
      out.add(parsed.data);
      continue;
    }
    warnings.push(Object.freeze({
      code: 'unsupported' as const,
      detail: 'MCP detection was asked for an unresolvable Agent id',
    }));
  }
  return Object.freeze({ providers: out, warnings: Object.freeze(warnings) });
}

/**
 * Resolve the Agent that owns a declared discovery source.
 *
 * Only the declared `metadata.agentId` is authoritative. The contribution's
 * local id is a plugin-chosen name (`config`, `config.servers`, ...), so
 * reading an Agent out of it would fabricate an identity now that Agent ids
 * are open. An undeclared source resolves to `null` and its caller warns.
 */
function readProviderFromDiscoveryDefinition(
  definition: Readonly<{ id: string; metadata?: Readonly<Record<string, unknown>> }>,
): McpDetectedProviderV1 | null {
  const parsed = McpDetectedProviderV1Schema.safeParse(definition.metadata?.agentId);
  return parsed.success ? parsed.data : null;
}

function readDirectory(input: string | null): string | null {
  return typeof input === 'string' && input.trim().length > 0 ? input.trim() : null;
}

function toDetectionInput(directory: string | null): PluginMcpDiscoveryRequest {
  return Object.freeze({
    ...(directory ? { directory } : {}),
  });
}

async function acquireDiscoverySources(
  providers: ReadonlySet<McpDetectedProviderV1> | null,
  runtimeRegistry?: ResolvedExecutablePluginRuntimeRegistry,
): Promise<Readonly<{
  entries: readonly PluginMcpDiscoverySourceEntry[];
  warnings: readonly DaemonMcpServersDetectWarningV1[];
  release: () => Promise<void>;
}>> {
  const lease = runtimeRegistry ? { registry: runtimeRegistry, release: async () => {} } : await acquireAuthoritativePluginRuntimeRegistryLease();
  const contributions = (lease.registry.contributes.mcpDiscoverySources ?? [])
    .map((contribution) => ({
      contribution,
      provider: readProviderFromDiscoveryDefinition(contribution.definition),
    }));
  const unresolvedWarnings = Object.freeze(contributions.flatMap(({ contribution, provider }) => (
    provider
      ? []
      : [Object.freeze({
        code: 'unsupported' as const,
        path: `plugin:${contribution.definition.id}`,
        detail: `Plugin MCP discovery source declares no Agent id (plugin ${contribution.pluginId ?? 'unknown'})`,
      })]
  )));
  const declaredSources = contributions.flatMap(({ contribution, provider }) => (
    provider && (!providers || providers.has(provider))
      ? [{ contribution, provider }]
      : []
  ));
  const stableDiscover = lease.registry.discoverMcpServersForDetection;
  const ownedRuntimeEntries = stableDiscover
    ? Object.freeze(declaredSources.flatMap(({ contribution, provider }) => {
        const pluginId = contribution.pluginId;
        return pluginId
          ? [Object.freeze({
              provider,
              loadedInHappierSessions: contribution.definition.loadedInHappierSessions,
              sourceId: contribution.definition.id,
              discover: async (input: PluginMcpDiscoveryRequest, signal: AbortSignal) => (
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
  const warnings = Object.freeze([
    ...unresolvedWarnings,
    ...declaredSources.flatMap(({ contribution, provider }) => (
      stableDiscover && contribution.pluginId
        ? []
        : [Object.freeze({
          provider,
          code: 'read_failed' as const,
          path: `plugin:${contribution.definition.id}`,
          detail: 'Plugin MCP discovery source is unavailable',
        })]
    )),
  ]);
  return Object.freeze({
    entries: ownedRuntimeEntries,
    warnings,
    release: lease.release,
  });
}

const DEFAULT_MCP_DISCOVERY_PROVIDER_TIMEOUT_MS = 5_000;
const MCP_DISCOVERY_PROVIDER_TIMEOUT_ENV = 'HAPPIER_MCP_DISCOVERY_PROVIDER_TIMEOUT_MS';
const MCP_DISCOVERY_PROVIDER_TIMEOUT_MAX_MS = 60_000;

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

function resolveDiscoveryTimeoutMs(env: ProcessEnvInput | undefined): number {
  const fromEnv = readPositiveFiniteInteger(env?.[MCP_DISCOVERY_PROVIDER_TIMEOUT_ENV]);
  if (fromEnv !== null) return clampDiscoveryTimeoutMs(fromEnv);

  return DEFAULT_MCP_DISCOVERY_PROVIDER_TIMEOUT_MS;
}

async function discoverWithTimeout(
  entry: PluginMcpDiscoverySourceEntry,
  input: PluginMcpDiscoveryRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<
  | Readonly<{ type: 'resolved'; value: PluginMcpEndpointDiscoveryResult }>
  | Readonly<{ type: 'rejected'; error: unknown }>
  | Readonly<{ type: 'timeout' }>
> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  try {
    const discovery = entry.discover(input, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal)
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

function assertDiscoveredMcpEndpointSafeForDetection(endpoint: PluginMcpDiscoveredEndpoint): void {
  const keys = typeof endpoint === 'object' && endpoint !== null && !Array.isArray(endpoint)
    ? Object.keys(endpoint).sort()
    : [];
  if (
    typeof endpoint !== 'object'
    || endpoint === null
    || Array.isArray(endpoint)
    || typeof endpoint.id !== 'string'
    || endpoint.id.trim().length === 0
    || typeof endpoint.name !== 'string'
    || endpoint.name.trim().length === 0
    || (endpoint.kind !== 'http' && endpoint.kind !== 'sse')
    || typeof endpoint.url !== 'string'
    || keys.length !== 4
    || keys[0] !== 'id'
    || keys[1] !== 'kind'
    || keys[2] !== 'name'
    || keys[3] !== 'url'
    || !PluginMcpServerTransportV1Schema.safeParse({
      kind: 'http',
      url: endpoint.url,
    }).success
  ) {
    throw new Error('Discovered MCP remote URL is not safe');
  }
}

function normalizeDiscoveredEndpoint(params: Readonly<{
  provider: McpDetectedProviderV1;
  loadedInHappierSessions: boolean;
  registrationId: string;
  directory: string | null;
  endpoint: PluginMcpDiscoveredEndpoint;
}>): DetectedMcpServerV1 {
  const source = Object.freeze({
    kind: params.directory ? 'project' as const : 'user' as const,
    path: `plugin:${params.registrationId}`,
  });

  return {
    provider: params.provider,
    loadedInHappierSessions: params.loadedInHappierSessions,
    name: params.endpoint.name,
    transport: params.endpoint.kind,
    remote: {
      url: params.endpoint.url,
      headers: [],
    },
    envKeys: [],
    enabled: null,
    source,
  };
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

function normalizeDiscoveryResult(
  provider: McpDetectedProviderV1,
  discovered: PluginMcpEndpointDiscoveryResult,
): Readonly<{
  endpoints: readonly PluginMcpDiscoveredEndpoint[];
  warnings: readonly DaemonMcpServersDetectWarningV1[];
}> {
  const endpoints = Array.isArray(discovered.endpoints) ? Object.freeze([...discovered.endpoints]) : Object.freeze([]);
  const rawWarnings: unknown[] = [];
  if (Array.isArray(discovered.warnings)) rawWarnings.push(...discovered.warnings);

  return Object.freeze({
    endpoints,
    warnings: Object.freeze(rawWarnings.map((warning) => normalizeDiscoveryWarning(provider, warning))),
  });
}

export async function detectProviderMcpServers(params: Readonly<{
  directory: string | null;
  providers: unknown;
  env?: ProcessEnvInput;
  runtimeRegistry?: ResolvedExecutablePluginRuntimeRegistry;
  signal?: AbortSignal;
  assertCurrent?: () => Promise<void>;
}>): Promise<DetectProviderMcpServersResult> {
  const providersFilter = normalizeProvidersFilter(params.providers);
  const providers = providersFilter.providers;
  const directory = readDirectory(params.directory);
  params.signal?.throwIfAborted();
  await params.assertCurrent?.();
  const detectionInput = toDetectionInput(directory);
  const discoveryTimeoutMs = resolveDiscoveryTimeoutMs(params.env);
  const servers: DetectedMcpServerV1[] = [];
  const warnings: DaemonMcpServersDetectWarningV1[] = [...providersFilter.warnings];
  const discoverySources = await acquireDiscoverySources(providers, params.runtimeRegistry);
  warnings.push(...discoverySources.warnings);

  try {
    for (const entry of discoverySources.entries) {
      params.signal?.throwIfAborted();
      await params.assertCurrent?.();
      params.signal?.throwIfAborted();
      const provider = entry.provider;

      try {
        const outcome = await discoverWithTimeout(entry, detectionInput, discoveryTimeoutMs, params.signal);
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
        for (const native of outcome.value.detectedServers ?? []) {
          const server = normalizeDetectedMcpServerV1({ ...native, provider, loadedInHappierSessions: entry.loadedInHappierSessions });
          if (server) servers.push(server);
          else warnings.push(Object.freeze({ provider, code: 'unsupported' as const, path: `plugin:${entry.sourceId}` }));
        }
        for (const endpoint of discovered.endpoints) {
          try {
            assertDiscoveredMcpEndpointSafeForDetection(endpoint);
          } catch {
            warnings.push(Object.freeze({
              provider,
              code: 'unsupported',
              path: `plugin:${entry.sourceId}`,
            }));
            continue;
          }
          servers.push(normalizeDiscoveredEndpoint({
            provider,
            loadedInHappierSessions: entry.loadedInHappierSessions,
            registrationId: entry.sourceId,
            directory,
            endpoint,
          }));
        }
      } catch {
        warnings.push(Object.freeze({
          provider,
          code: 'read_failed',
          detail: 'Plugin MCP discovery failed',
        }));
      }
      await params.assertCurrent?.();
    }
  } finally {
    await discoverySources.release();
  }

  await params.assertCurrent?.();
  params.signal?.throwIfAborted();
  return Object.freeze({
    servers: Object.freeze(servers),
    warnings: Object.freeze(warnings),
  });
}
