import { createHash } from 'node:crypto';

import { AGENT_MODEL_CONFIG, type AgentModelDescriptor } from '@happier-dev/agents';
import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { readClaudeCodeNativeCredential } from '@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile';
import {
  resolveClaudeConnectedServiceStableConfigDir,
  type ClaudeConnectedServiceId,
} from '@/backends/claude/connectedServices/resolveClaudeConnectedServiceStableAuthDir';
import { fetchAnthropicModels, type AnthropicModelEntry } from '@/backends/claude/preflight/anthropicModelsFetch';
import { buildDiscoveredClaudeModelDescriptor } from '@/backends/claude/preflight/deriveDiscoveredClaudeModel';
import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';

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

type ClaudeProbeCredential =
  | Readonly<{ apiKey: string }>
  | Readonly<{ accessToken: string }>;

type ClaudeProbeTarget = Readonly<{
  baseUrl: string | null;
  credential: ClaudeProbeCredential;
}>;

export type ClaudeProbeBinding = Readonly<{
  serviceId: ClaudeConnectedServiceId;
  selection:
    | Readonly<{ kind: 'group'; groupId: string }>
    | Readonly<{ kind: 'profile'; profileId: string }>;
}>;

const CLAUDE_PROBE_SERVICE_IDS: readonly ClaudeConnectedServiceId[] = ['claude-subscription', 'anthropic'];

function readEnvValue(name: string): string | null {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function resolveClaudeProbeBinding(
  connectedServices?: ConnectedServiceBindingsV1 | null,
): ClaudeProbeBinding | null {
  for (const serviceId of CLAUDE_PROBE_SERVICE_IDS) {
    const binding = connectedServices?.bindingsByServiceId[serviceId] ?? null;
    if (!binding || binding.source === 'native') continue;

    if (binding.selection === 'group') {
      const groupId = readNonBlankString(binding.groupId);
      if (groupId) return { serviceId, selection: { kind: 'group', groupId } };
      continue;
    }
    const profileId = readNonBlankString(binding.profileId);
    if (profileId) return { serviceId, selection: { kind: 'profile', profileId } };
  }
  return null;
}

/** Stable identity for a binding, used for both the probe cache variant and this module's cache. */
export function resolveClaudeProbeBindingIdentity(
  connectedServices?: ConnectedServiceBindingsV1 | null,
): string {
  const bound = resolveClaudeProbeBinding(connectedServices);
  if (!bound) return 'native';
  return bound.selection.kind === 'group'
    ? `${bound.serviceId}:group:${bound.selection.groupId}`
    : `${bound.serviceId}:profile:${bound.selection.profileId}`;
}

/**
 * Read a configured Anthropic-compatible endpoint root, or `null` when unset/unusable.
 *
 * `ANTHROPIC_BASE_URL` is how Happier's built-in Claude backend profiles point the CLI at
 * third-party gateways (Z.AI, DeepSeek, MiniMax), always paired with a gateway-issued
 * `ANTHROPIC_AUTH_TOKEN`.
 */
function readConfiguredBaseUrl(): string | null {
  const raw = readEnvValue('ANTHROPIC_BASE_URL');
  if (!raw) return null;
  try {
    new URL(raw);
    return raw;
  } catch {
    return null;
  }
}

function isAnthropicFirstPartyBaseUrl(baseUrl: string | null): boolean {
  if (!baseUrl) return true;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'anthropic.com' || host.endsWith('.anthropic.com');
  } catch {
    return true;
  }
}

/**
 * Ambient auth env keys the catalog fetch may use for a bound session.
 *
 * Mirrors `isolateClaudeRuntimeAuthEnv`, which strips every `CLAUDE_AUTH_ENV_KEYS` entry from the
 * spawned child for a bound session and keeps only `ANTHROPIC_API_KEY` for the `anthropic`
 * service. Reading a key the spawn deletes would describe one account for a session that runs as
 * another.
 */
function resolveAllowedEnvKeys(bound: ClaudeProbeBinding | null): readonly string[] {
  if (!bound) return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
  return bound.serviceId === 'anthropic' ? ['ANTHROPIC_API_KEY'] : [];
}

/**
 * Config dir holding the credentials of the account this catalog describes.
 *
 * This doubles as the cache identity. The preflight probe resolves it from the binding it is
 * handed; an in-session consumer resolves the same materialized dir from `CLAUDE_CONFIG_DIR`,
 * which the daemon sets for a bound session. Both therefore land on the same cache entry without
 * the in-session side having to know the binding.
 */
function resolveClaudeCatalogConfigDir(bound: ClaudeProbeBinding | null): string {
  const ownConfigDir = resolveConfiguredClaudeConfigDir({ env: process.env });
  if (!bound) return ownConfigDir;

  const { serviceId, selection } = bound;
  const boundDir = resolveClaudeConnectedServiceStableConfigDir({
    activeServerDir: configuration.activeServerDir,
    serviceId,
    fallbackProfileId: selection.kind === 'group' ? selection.groupId : selection.profileId,
    selection,
  });
  return boundDir ?? ownConfigDir;
}

/**
 * Resolve the endpoint + credential pair for the catalog fetch.
 *
 * The credential must belong to the endpoint it is sent to. Environment credentials are configured
 * alongside `ANTHROPIC_BASE_URL` and travel with it; the on-disk Claude Code subscription token is
 * Anthropic-only and is never sent to a third-party gateway. Returns `null` when no usable pair
 * exists so callers fall back to the curated catalog. Never throws.
 */
async function resolveClaudeCatalogTarget(
  connectedServices?: ConnectedServiceBindingsV1 | null,
): Promise<ClaudeProbeTarget | null> {
  const baseUrl = readConfiguredBaseUrl();
  const bound = resolveClaudeProbeBinding(connectedServices);
  const allowedEnvKeys = resolveAllowedEnvKeys(bound);
  const readAllowedEnvValue = (name: string): string | null =>
    allowedEnvKeys.includes(name) ? readEnvValue(name) : null;

  const apiKey = readAllowedEnvValue('ANTHROPIC_API_KEY');
  if (apiKey) return { baseUrl, credential: { apiKey } };

  const envToken = readAllowedEnvValue('ANTHROPIC_AUTH_TOKEN')
    ?? readAllowedEnvValue('ANTHROPIC_OAUTH_TOKEN')
    ?? readAllowedEnvValue('CLAUDE_CODE_OAUTH_TOKEN');
  if (envToken) return { baseUrl, credential: { accessToken: envToken } };

  if (!isAnthropicFirstPartyBaseUrl(baseUrl)) return null;

  try {
    const claudeConfigDir = resolveClaudeCatalogConfigDir(bound);
    const credential = await readClaudeCodeNativeCredential({ claudeConfigDir });
    const accessToken = credential?.payload.claudeAiOauth.accessToken;
    if (typeof accessToken === 'string' && accessToken.trim().length > 0) {
      return { baseUrl, credential: { accessToken: accessToken.trim() } };
    }
  } catch {
    // best-effort — fall through to the curated catalog
  }
  return null;
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

/**
 * Non-reversible fingerprint of an ambient env credential, or `''` when none is set.
 *
 * The config dir identifies a bound or on-disk account, but an ambient `ANTHROPIC_API_KEY` or
 * token can be swapped without it changing — which would otherwise serve the previous key's model
 * list for the whole TTL. Only env-derived credentials need this: rotating an on-disk credential
 * does not change which models the same account can run. The secret itself never enters the key.
 */
function resolveAmbientCredentialFingerprint(bound: ClaudeProbeBinding | null): string {
  const value = resolveAllowedEnvKeys(bound)
    .map((key) => readEnvValue(key))
    .find((candidate): candidate is string => candidate !== null);
  if (!value) return '';
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function resolveCatalogCacheKey(bound: ClaudeProbeBinding | null): string {
  return [
    resolveClaudeCatalogConfigDir(bound),
    readConfiguredBaseUrl() ?? 'default',
    resolveAmbientCredentialFingerprint(bound),
  ].join('|');
}

type CatalogCacheEntry = Readonly<{ models: readonly AgentModelDescriptor[]; expiresAtMs: number }>;
const catalogCache = new Map<string, CatalogCacheEntry>();

export function resetClaudeModelCatalogCacheForTests(): void {
  catalogCache.clear();
}

export type ResolveClaudeModelCatalogParams = Readonly<{
  timeoutMs: number;
  connectedServices?: ConnectedServiceBindingsV1 | null;
  nowMs?: () => number;
}>;

/**
 * The models this account can run: curated catalog, augmented with anything the Anthropic Models
 * API reports. Falls back to the curated catalog on any failure. Never throws.
 */
export async function resolveClaudeModelCatalog(
  params: ResolveClaudeModelCatalogParams,
): Promise<readonly AgentModelDescriptor[]> {
  const nowMs = params.nowMs ?? (() => Date.now());
  const cacheKey = resolveCatalogCacheKey(resolveClaudeProbeBinding(params.connectedServices));

  const cached = catalogCache.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs()) return cached.models;

  const target = await resolveClaudeCatalogTarget(params.connectedServices);
  const entries = target
    ? await fetchAnthropicModels({
      ...('apiKey' in target.credential ? { apiKey: target.credential.apiKey } : {}),
      ...('accessToken' in target.credential ? { accessToken: target.credential.accessToken } : {}),
      ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
      timeoutMs: params.timeoutMs,
    })
    : null;

  const models = entries ? mergeStaticWithDiscovered(entries) : resolveStaticClaudeModels();
  catalogCache.set(cacheKey, {
    models,
    expiresAtMs: nowMs() + (entries ? CATALOG_SUCCESS_TTL_MS : CATALOG_FAILURE_TTL_MS),
  });
  return models;
}

/** Whether the catalog fetch found anything beyond the curated list (used to report probe source). */
export function hasDiscoveredClaudeModels(models: readonly AgentModelDescriptor[]): boolean {
  return models.length > resolveStaticClaudeModels().length;
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
