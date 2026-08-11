import { AGENT_MODEL_CONFIG, type AgentModelDescriptor } from '@happier-dev/agents';
import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import { buildDiscoveredClaudeModelDescriptor } from './deriveDiscoveredClaudeModel';
import { fetchAnthropicModels, type AnthropicModelEntry } from './fetchAnthropicModels';
import type { Credentials } from '@/persistence';
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

function readNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Lowercase + strip a trailing dated snapshot suffix (`-YYYYMMDD`) for dedup comparison only. */
function normalizeDatedId(rawId: string): string {
  return rawId.trim().toLowerCase().replace(/-\d{8}$/u, '');
}

/**
 * Major generation of a Claude model id, or `null` for ids that are not Claude models.
 *
 * Both Claude naming schemes put the major generation in the first numeric segment —
 * `claude-3-5-sonnet` (legacy) and `claude-opus-4-8` (current) — so the first number wins. Ids from
 * an Anthropic-compatible gateway (`glm-4.6`, `deepseek-reasoner`) are not Claude models and are
 * never generation-filtered.
 */
function resolveClaudeModelGeneration(normalizedId: string): number | null {
  if (!normalizedId.startsWith('claude')) return null;
  const match = normalizedId.match(/(\d+)/u);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function resolveStaticClaudeModels(): readonly AgentModelDescriptor[] {
  return AGENT_MODEL_CONFIG.claude.staticModels ?? [];
}

/**
 * Oldest Claude generation Happier still curates. The Models API lists every model the account may
 * call, including generations Claude Code can no longer run, so anything below the curated floor is
 * dropped rather than offered as a selectable row.
 */
function resolveMinimumCuratedGeneration(): number | null {
  const generations = resolveStaticClaudeModels()
    .map((model) => resolveClaudeModelGeneration(normalizeDatedId(model.id)))
    .filter((generation): generation is number => generation !== null);
  return generations.length > 0 ? Math.min(...generations) : null;
}

function isRunnableDiscoveredModel(normalizedId: string): boolean {
  const generation = resolveClaudeModelGeneration(normalizedId);
  if (generation === null) return true;
  const floor = resolveMinimumCuratedGeneration();
  return floor === null || generation >= floor;
}

/**
 * Augment the curated static catalog with any Claude models the account can run that are NOT
 * already curated. Static models win (full curation preserved); discovered models are appended
 * with API-derived options. Dated snapshot ids collapse onto their static alias.
 */
function mergeStaticWithDiscovered(entries: readonly AnthropicModelEntry[]): AgentModelDescriptor[] {
  const staticModels = resolveStaticClaudeModels();
  const staticNormalizedIds = new Set(staticModels.map((model) => normalizeDatedId(model.id)));

  const discovered = entries
    .filter((entry) => {
      const normalized = normalizeDatedId(entry.id);
      if (normalized.length === 0 || normalized === 'default') return false;
      if (staticNormalizedIds.has(normalized)) return false;
      return isRunnableDiscoveredModel(normalized);
    })
    .map((entry) => buildDiscoveredClaudeModelDescriptor(entry));

  return [...staticModels, ...discovered];
}

export type ClaudeModelCatalogResolution = Readonly<{
  models: readonly AgentModelDescriptor[];
  source: 'dynamic' | 'static';
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

/** Drop expired entries so a long-lived daemon does not retain one per rotated credential. */
function pruneExpiredCatalogEntries(nowMs: number): void {
  for (const [key, entry] of catalogCache) {
    if (entry.expiresAtMs <= nowMs) catalogCache.delete(key);
  }
}

export type ResolveClaudeModelCatalogParams = Readonly<{
  timeoutMs: number;
  connectedServices?: ConnectedServiceBindingsV1 | null;
  credentials?: Credentials | null;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  profileId?: string | null;
  nowMs?: () => number;
}>;

/**
 * The models this account can run: curated catalog, augmented with anything the Anthropic Models
 * API reports. Falls back to the curated catalog on any failure. Never throws.
 */
export async function resolveClaudeModelCatalogResolution(
  params: ResolveClaudeModelCatalogParams,
): Promise<ClaudeModelCatalogResolution> {
  const nowMs = params.nowMs ?? (() => Date.now());
  // Resolving the target first is what lets the cache key carry the credential identity. It is env
  // reads plus at most one local credential-file read — cheap next to the network fetch it guards,
  // and this runs at session start and on model change, not on a hot path.
  const target = await resolveClaudeModelProbeTarget({
    connectedServices: params.connectedServices,
    credentials: params.credentials,
    accountSettings: params.accountSettings,
    profileId: params.profileId,
  });

  // No resolvable credential is an absence of identity, not an identity of its own. Caching under a
  // placeholder key would let one unreadable credential file evict a valid catalog for the whole
  // failure TTL, so degrade to the curated catalog for this call only and leave the cache untouched.
  if (!target) return { models: resolveStaticClaudeModels(), source: 'static' };

  const cacheKey = target.cacheIdentity;
  const cached = catalogCache.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs()) return cached.resolution;

  const inFlight = inFlightCatalogResolutions.get(cacheKey);
  if (inFlight) return await inFlight;

  const resolution = (async () => {
    const entries = await fetchAnthropicModels({
      ...(target.credential.kind === 'api_key' ? { apiKey: target.credential.value } : {}),
      ...(target.credential.kind === 'bearer' ? { accessToken: target.credential.value } : {}),
      ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
      timeoutMs: params.timeoutMs,
    });

    const resolution: ClaudeModelCatalogResolution = entries
      ? { models: mergeStaticWithDiscovered(entries), source: 'dynamic' }
      : { models: resolveStaticClaudeModels(), source: 'static' };
    const resolvedAtMs = nowMs();
    pruneExpiredCatalogEntries(resolvedAtMs);
    catalogCache.set(cacheKey, {
      resolution,
      expiresAtMs: resolvedAtMs + (entries ? CATALOG_SUCCESS_TTL_MS : CATALOG_FAILURE_TTL_MS),
    });
    return resolution;
  })();

  inFlightCatalogResolutions.set(cacheKey, resolution);
  try {
    return await resolution;
  } finally {
    inFlightCatalogResolutions.delete(cacheKey);
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
  model: AgentModelDescriptor | null | undefined,
): readonly string[] {
  const control = model?.modelOptions?.find((option) => option.id === 'reasoning_effort');
  if (!control || !Array.isArray(control.options)) return [];
  return control.options
    .map((option) => readNonBlankString(option?.value))
    .filter((value): value is string => value !== null);
}
