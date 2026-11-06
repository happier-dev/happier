import {
  AGENT_MODEL_CONFIG,
  providers,
  type AgentModelDescriptor,
} from '@happier-dev/agents';
import { parseBooleanEnv, type ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import { buildDiscoveredClaudeModelDescriptor } from './deriveDiscoveredClaudeModel';
import { fetchAnthropicModels, type AnthropicModelEntry } from './fetchAnthropicModels';
import type { Credentials } from '@/persistence';
import type { CatalogProbeLifecycle, RegisterNativeCatalogCleanup } from '@/capabilities/probes/catalogProbeLifecycle';
import {
  resolveClaudeModelProbeTarget,
} from './resolveClaudeModelProbeTarget';

export {
  resolveClaudeProbeBinding,
  type ClaudeProbeBinding,
} from './resolveClaudeModelProbeTarget';

/**
 * Single owner of "which Claude models can this account run".
 *
 * Both the new-session preflight probe and the in-session `sessionModelsV1` publisher read from
 * here, so the two surfaces cannot disagree about which models exist or which effort tiers they
 * support. The result is cached per account binding + endpoint so a session start does not pay a
 * network round trip.
 */

const CATALOG_SUCCESS_TTL_MS = 24 * 60 * 60 * 1_000;
const CATALOG_FAILURE_TTL_MS = 60 * 1_000;
const CATALOG_MAX_ENTRIES = 32;

function readNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Lowercase + strip a trailing dated suffix (`-YYYYMMDD`) for curated-row matching only. */
function normalizeDatedId(rawId: string): string {
  return rawId.trim().toLowerCase().replace(/-\d{8}$/u, '');
}

function resolveStaticClaudeModels(): readonly AgentModelDescriptor[] {
  return AGENT_MODEL_CONFIG.claude.staticModels ?? [];
}

/**
 * A successful Models API response owns membership and API-provided capability/context facts.
 * Curated rows only add presentation and Claude Code-specific metadata to returned ids that match
 * either an alias or its dated snapshot form.
 */
function buildAuthoritativeDynamicCatalog(entries: readonly AnthropicModelEntry[]): AgentModelDescriptor[] {
  const staticByNormalizedId = new Map(
    resolveStaticClaudeModels().map((model) => [normalizeDatedId(model.id), model] as const),
  );

  const seenExactIds = new Set<string>();
  return entries.flatMap((entry) => {
    const exactId = entry.id.trim();
    if (seenExactIds.has(exactId)) return [];
    seenExactIds.add(exactId);

    const discovered = buildDiscoveredClaudeModelDescriptor(entry);
    const curated = staticByNormalizedId.get(normalizeDatedId(entry.id));
    if (!curated) return [discovered];

    return [{
      ...discovered,
      name: curated.name,
      ...(typeof curated.description === 'string' ? { description: curated.description } : {}),
      ...(typeof curated.extendedContextModelId === 'string'
        ? { extendedContextModelId: providers.claude.toClaude1mModelId(exactId) }
        : {}),
    }];
  });
}

export type ClaudeModelCatalogResolution = Readonly<{
  models: readonly AgentModelDescriptor[];
  source: 'dynamic' | 'static';
  observedAt?: number;
  refreshError?: boolean;
}>;

type CatalogCacheEntry = Readonly<{ resolution: ClaudeModelCatalogResolution; expiresAtMs: number }>;
const catalogCache = new Map<string, CatalogCacheEntry>();
/**
 * Resolutions currently in flight, keyed the same as the cache.
 *
 * The preflight probe and the `sessionModelsV1` publisher both resolve at session start; without
 * this they miss the cache in parallel and each issue their own fetch for the same account.
 */
const inFlightCatalogResolutions = new Map<string, Promise<ClaudeModelCatalogResolution>>();

export function resetClaudeModelCatalogCacheForTests(): void {
  catalogCache.clear();
  inFlightCatalogResolutions.clear();
}

/**
 * Drop expired static cold fallbacks. Dynamic snapshots remain eligible as last-good results for
 * their own later refresh; the separate size bound removes least-recently-resolved identities so
 * retaining them cannot grow without limit.
 */
function pruneCatalogEntries(nowMs: number, protectedKey: string): void {
  for (const [key, entry] of catalogCache) {
    if (
      entry.expiresAtMs > nowMs
      || key === protectedKey
      || entry.resolution.source === 'dynamic'
    ) continue;
    catalogCache.delete(key);
  }
}

/** Bound credential-rotation growth while never evicting the snapshot resolving this call. */
function trimCatalogEntries(protectedKey: string): void {
  while (catalogCache.size > CATALOG_MAX_ENTRIES) {
    let oldestUnprotectedKey: string | null = null;
    for (const key of catalogCache.keys()) {
      if (key !== protectedKey) {
        oldestUnprotectedKey = key;
        break;
      }
    }
    if (!oldestUnprotectedKey) return;
    catalogCache.delete(oldestUnprotectedKey);
  }
}

export type ResolveClaudeModelCatalogParams = CatalogProbeLifecycle & Readonly<{
  onNativeCleanup?: RegisterNativeCatalogCleanup;
  bypassCache?: boolean;
  connectedServices?: ConnectedServiceBindingsV1 | null;
  credentials?: Credentials | null;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  profileId?: string | null;
  processEnv?: NodeJS.ProcessEnv;
  nowMs?: () => number;
}>;

function isClaudeDynamicModelProbeEnabled(params: ResolveClaudeModelCatalogParams): boolean {
  if (params.accountSettings?.claudeDynamicModelProbeEnabled === false) return false;
  const processEnv = params.processEnv ?? process.env;
  return parseBooleanEnv(processEnv.HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED, true);
}

/**
 * The models this account can run. A successful Models API response owns membership; static rows
 * enrich matching returned ids. The curated catalog is used only until the first success, after
 * which a failed refresh keeps the last successful dynamic snapshot. Caller cancellation propagates.
 */
export async function resolveClaudeModelCatalogResolution(
  params: ResolveClaudeModelCatalogParams,
): Promise<ClaudeModelCatalogResolution> {
  if (!isClaudeDynamicModelProbeEnabled(params)) {
    return { models: resolveStaticClaudeModels(), source: 'static', refreshError: false };
  }

  params.signal?.throwIfAborted();
  const deadlineAt = params.deadlineAt ?? Date.now() + params.timeoutMs;
  const nowMs = params.nowMs ?? (() => Date.now());
  // Resolving the target first is what lets the cache key carry the credential identity. It is env
  // reads, a native credential read, or the configured user helper. Helper and HTTP phases share
  // one containing deadline, including when the helper rotates a short-lived credential.
  const target = await resolveClaudeModelProbeTarget({
    timeoutMs: params.timeoutMs,
    deadlineAt,
    signal: params.signal,
    onNativeCleanup: params.onNativeCleanup,
    connectedServices: params.connectedServices,
    credentials: params.credentials,
    accountSettings: params.accountSettings,
    profileId: params.profileId,
    processEnv: params.processEnv,
  });

  params.signal?.throwIfAborted();

  // No resolvable credential is an absence of identity, not an identity of its own. Caching under a
  // placeholder key would let one unreadable credential file evict a valid catalog for the whole
  // failure TTL, so degrade to the curated catalog for this call only and leave the cache untouched.
  if (!target) return { models: resolveStaticClaudeModels(), source: 'static', refreshError: true };

  const cacheKey = target.cacheIdentity;
  const cached = catalogCache.get(cacheKey);
  if (!params.bypassCache && cached && cached.expiresAtMs > nowMs()) return cached.resolution;

  // A caller-owned cancellation cannot abort or inherit another caller's work.
  const shareWork = !params.signal;
  const inFlight = shareWork ? inFlightCatalogResolutions.get(cacheKey) : undefined;
  if (inFlight) return await inFlight;

  const resolution = (async () => {
    const entries = await fetchAnthropicModels({
      ...(target.credential.kind === 'api_key' ? { apiKey: target.credential.value } : {}),
      ...(target.credential.kind === 'bearer' ? { accessToken: target.credential.value } : {}),
      ...(target.credential.kind === 'api_key_helper' ? { apiKeyHelperValue: target.credential.value } : {}),
      ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
      timeoutMs: params.timeoutMs,
      deadlineAt,
      signal: params.signal,
    });
    params.signal?.throwIfAborted();

    const resolvedAtMs = nowMs();
    // Another independently cancellable caller may have published a success while we waited.
    const previousResolution = catalogCache.get(cacheKey)?.resolution ?? cached?.resolution;
    const resolution: ClaudeModelCatalogResolution = entries !== null
      ? { models: buildAuthoritativeDynamicCatalog(entries), source: 'dynamic', observedAt: resolvedAtMs }
      : previousResolution?.source === 'dynamic'
        ? { ...previousResolution, refreshError: true }
        : { models: resolveStaticClaudeModels(), source: 'static', refreshError: true };
    pruneCatalogEntries(resolvedAtMs, cacheKey);
    // Refresh insertion order so the bounded cache removes the least recently resolved identity.
    catalogCache.delete(cacheKey);
    catalogCache.set(cacheKey, {
      resolution,
      expiresAtMs: resolvedAtMs + (entries !== null ? CATALOG_SUCCESS_TTL_MS : CATALOG_FAILURE_TTL_MS),
    });
    trimCatalogEntries(cacheKey);
    return resolution;
  })();

  if (shareWork) inFlightCatalogResolutions.set(cacheKey, resolution);
  try {
    return await resolution;
  } finally {
    if (shareWork) inFlightCatalogResolutions.delete(cacheKey);
  }
}

export async function resolveClaudeModelCatalog(
  params: ResolveClaudeModelCatalogParams,
): Promise<readonly AgentModelDescriptor[]> {
  return (await resolveClaudeModelCatalogResolution(params)).models;
}

/**
 * Effort tiers a model descriptor reports, read off its `reasoning_effort` control.
 *
 * This is the evidence `resolveClaudeEffortForModel` needs for a discovered model, whose tiers are
 * not in the static effort table.
 */
export function resolveClaudeEffortLevelsFromModelDescriptor(
  model: Readonly<{ modelOptions?: ReadonlyArray<Readonly<{
    id: string;
    options?: ReadonlyArray<Readonly<{ value: unknown }>>;
  }>> }> | null | undefined,
): readonly string[] {
  const control = model?.modelOptions?.find((option) => option.id === 'reasoning_effort');
  if (!control || !Array.isArray(control.options)) return [];
  return control.options
    .map((option) => readNonBlankString(option?.value))
    .filter((value): value is string => value !== null);
}
