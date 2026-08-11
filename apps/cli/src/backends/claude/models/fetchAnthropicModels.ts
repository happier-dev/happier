import { resolveClaudeCodeUserAgent } from '@/backends/claude/utils/claudeCodeUserAgent';

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const MODELS_PATH = 'v1/models?limit=1000';
const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA_HEADER_VALUE = 'oauth-2025-04-20';

/**
 * Build the models endpoint for a base URL.
 *
 * Anthropic-compatible gateways are configured through `ANTHROPIC_BASE_URL` and may live under a
 * path prefix (`https://api.z.ai/api/anthropic`), so the path is appended rather than replacing it.
 * An unusable explicit value returns `null`: credentials must never be silently redirected to
 * Anthropic when the caller intended to use another origin.
 */
export function resolveAnthropicModelsUrl(baseUrl?: string | null): string | null {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  const candidate = raw.length > 0 ? raw : DEFAULT_ANTHROPIC_BASE_URL;
  try {
    return new URL(MODELS_PATH, candidate.endsWith('/') ? candidate : `${candidate}/`).toString();
  } catch {
    return null;
  }
}

/**
 * Subset of a `capabilities.effort` node from the Anthropic Models API.
 *
 * Each tier reports `{ supported: boolean }`; the top-level `supported` gates the
 * whole effort axis (some models — e.g. Haiku — expose no effort control).
 */
export type AnthropicModelEffortCapability = Readonly<{
  supported?: boolean;
  low?: Readonly<{ supported?: boolean }>;
  medium?: Readonly<{ supported?: boolean }>;
  high?: Readonly<{ supported?: boolean }>;
  xhigh?: Readonly<{ supported?: boolean }>;
  max?: Readonly<{ supported?: boolean }>;
}>;

export type AnthropicModelCapabilities = Readonly<{
  effort?: AnthropicModelEffortCapability;
}>;

/** A single `data[]` entry from `GET /v1/models`, narrowed to fields we consume. */
export type AnthropicModelEntry = Readonly<{
  id: string;
  displayName?: string;
  maxInputTokens?: number;
  capabilities?: AnthropicModelCapabilities;
}>;

function readObject(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readEffortTier(value: unknown): Readonly<{ supported?: boolean }> | undefined {
  const node = readObject(value);
  if (!node) return undefined;
  return typeof node.supported === 'boolean' ? { supported: node.supported } : {};
}

function readCapabilities(value: unknown): AnthropicModelCapabilities | undefined {
  const caps = readObject(value);
  const effort = readObject(caps?.effort);
  if (!effort) return undefined;

  const tiers = {
    low: readEffortTier(effort.low),
    medium: readEffortTier(effort.medium),
    high: readEffortTier(effort.high),
    xhigh: readEffortTier(effort.xhigh),
    max: readEffortTier(effort.max),
  } as const;

  return {
    effort: {
      ...(typeof effort.supported === 'boolean' ? { supported: effort.supported } : {}),
      ...(tiers.low ? { low: tiers.low } : {}),
      ...(tiers.medium ? { medium: tiers.medium } : {}),
      ...(tiers.high ? { high: tiers.high } : {}),
      ...(tiers.xhigh ? { xhigh: tiers.xhigh } : {}),
      ...(tiers.max ? { max: tiers.max } : {}),
    },
  };
}

/**
 * Parse a raw `GET /v1/models` JSON body into typed entries.
 *
 * Pure and defensive: unknown shapes yield `null`, malformed entries are dropped,
 * and only entries with a non-empty string `id` survive.
 */
export function parseAnthropicModelsResponse(body: unknown): AnthropicModelEntry[] | null {
  const root = readObject(body);
  const data = root?.data;
  if (!Array.isArray(data)) return null;

  const entries: AnthropicModelEntry[] = [];
  for (const raw of data) {
    const entry = readObject(raw);
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!id) continue;
    const displayName = typeof entry?.display_name === 'string' && entry.display_name.trim().length > 0
      ? entry.display_name.trim()
      : undefined;
    const maxInputTokens = typeof entry?.max_input_tokens === 'number' && Number.isFinite(entry.max_input_tokens)
      ? entry.max_input_tokens
      : undefined;
    const capabilities = readCapabilities(entry?.capabilities);
    entries.push({
      id,
      ...(displayName ? { displayName } : {}),
      ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
      ...(capabilities ? { capabilities } : {}),
    });
  }
  return entries.length > 0 ? entries : null;
}

export type FetchAnthropicModelsParams = Readonly<{
  /** OAuth access token (subscription/Claude Code). Sent as `Authorization: Bearer`. */
  accessToken?: string | null;
  /** Anthropic API key. Sent as `x-api-key` only when no bearer token is available. */
  apiKey?: string | null;
  /** Anthropic-compatible endpoint root (`ANTHROPIC_BASE_URL`). Defaults to the Anthropic host. */
  baseUrl?: string | null;
  timeoutMs: number;
  userAgent?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}>;

/**
 * Fetch the caller's available Claude models from the Anthropic Models API.
 *
 * Returns `null` on any failure (no credential, network error, non-200, unparseable
 * body) so the probe pipeline falls back to the static catalog. Never throws.
 */
export async function fetchAnthropicModels(
  params: FetchAnthropicModelsParams,
): Promise<AnthropicModelEntry[] | null> {
  const apiKey = typeof params.apiKey === 'string' && params.apiKey.trim().length > 0 ? params.apiKey.trim() : null;
  const accessToken = typeof params.accessToken === 'string' && params.accessToken.trim().length > 0
    ? params.accessToken.trim()
    : null;
  if (!apiKey && !accessToken) return null;

  const fetchImpl = params.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'User-Agent': resolveClaudeCodeUserAgent(params.userAgent),
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
    headers['anthropic-beta'] = OAUTH_BETA_HEADER_VALUE;
  } else if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  const modelsUrl = resolveAnthropicModelsUrl(params.baseUrl);
  if (!modelsUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, params.timeoutMs));
  try {
    const response = await fetchImpl(modelsUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    return parseAnthropicModelsResponse(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
