import { asRecord, normalizeString } from '../runtime/server/openCodeParsing.js';
import { OPEN_CODE_REQUEST_AUTH_CODEX_BASE_URL } from '../auth/services/requestAuth/source.js';

export type OpenCodeProviderInventory = Readonly<{
  id: string;
  env?: readonly string[];
  models?: Readonly<Record<string, unknown>>;
  usesChatGptAccount?: true;
}>;

/** Decode only the nonsecret route fact, never provider options or credentials. */
export function isOpenCodeChatGptAccountRoute(providerId: string, baseURL: unknown): boolean {
  if (providerId !== 'openai' || typeof baseURL !== 'string') return false;
  try {
    const route = new URL(baseURL);
    const chatGpt = new URL(OPEN_CODE_REQUEST_AUTH_CODEX_BASE_URL);
    return route.origin === chatGpt.origin
      && (route.pathname === chatGpt.pathname || route.pathname.startsWith(`${chatGpt.pathname}/`));
  } catch {
    return false;
  }
}

type KnownUnavailableOpenCodeModel = Readonly<{
  retiredAtMs: number;
  replacementModelId: string;
}>;

/**
 * OpenCode's own replacement pin for Anthropic's retired flagship models.
 *
 * Every other replacement in the table below is pinned the same way: the table
 * is OpenCode's product data about a third party's lineup, not a Happier-wide
 * model policy. Reading it from a host workspace package instead made this
 * plugin unbuildable for an external author writing the same plugin: the
 * plugin scaffold binds an author to the public toolchain packages
 * (`@happier-dev/plugin-sdk`, plus `@happier-dev/plugin-ui` for a UI plugin)
 * and to no host workspace package.
 */
const ANTHROPIC_FLAGSHIP_REPLACEMENT_MODEL_ID = 'claude-opus-5';

const ANTHROPIC_KNOWN_UNAVAILABLE_MODELS: Readonly<Record<string, KnownUnavailableOpenCodeModel>> = Object.freeze({
  'claude-2.0': { retiredAtMs: Date.UTC(2025, 6, 21), replacementModelId: ANTHROPIC_FLAGSHIP_REPLACEMENT_MODEL_ID },
  'claude-2.1': { retiredAtMs: Date.UTC(2025, 6, 21), replacementModelId: ANTHROPIC_FLAGSHIP_REPLACEMENT_MODEL_ID },
  'claude-instant-1.0': { retiredAtMs: Date.UTC(2024, 10, 6), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-instant-1.1': { retiredAtMs: Date.UTC(2024, 10, 6), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-instant-1.2': { retiredAtMs: Date.UTC(2024, 10, 6), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-opus-20240229': { retiredAtMs: Date.UTC(2026, 0, 5), replacementModelId: ANTHROPIC_FLAGSHIP_REPLACEMENT_MODEL_ID },
  'claude-3-opus-latest': { retiredAtMs: Date.UTC(2026, 0, 5), replacementModelId: ANTHROPIC_FLAGSHIP_REPLACEMENT_MODEL_ID },
  'claude-3-sonnet-20240229': { retiredAtMs: Date.UTC(2025, 6, 21), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-sonnet-latest': { retiredAtMs: Date.UTC(2025, 6, 21), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-haiku-20240307': { retiredAtMs: Date.UTC(2026, 3, 20), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-haiku-latest': { retiredAtMs: Date.UTC(2026, 3, 20), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-5-sonnet-20240620': { retiredAtMs: Date.UTC(2025, 9, 28), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-5-sonnet-20241022': { retiredAtMs: Date.UTC(2025, 9, 28), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-5-sonnet-latest': { retiredAtMs: Date.UTC(2025, 9, 28), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-5-haiku-20241022': { retiredAtMs: Date.UTC(2026, 1, 19), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-5-haiku-latest': { retiredAtMs: Date.UTC(2026, 1, 19), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-7-sonnet-20250219': { retiredAtMs: Date.UTC(2026, 1, 19), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-7-sonnet-latest': { retiredAtMs: Date.UTC(2026, 1, 19), replacementModelId: 'claude-sonnet-4-6' },
  'claude-sonnet-4-20250514': { retiredAtMs: Date.UTC(2026, 5, 15), replacementModelId: 'claude-sonnet-4-6' },
  'claude-opus-4-20250514': { retiredAtMs: Date.UTC(2026, 5, 15), replacementModelId: ANTHROPIC_FLAGSHIP_REPLACEMENT_MODEL_ID },
});

const KNOWN_UNAVAILABLE_MODELS_BY_PROVIDER = Object.freeze({
  anthropic: ANTHROPIC_KNOWN_UNAVAILABLE_MODELS,
} as const);

function isKnownUnavailableOpenCodeModel(params: Readonly<{
  providerId: string;
  modelId: string;
  nowMs: number;
}>): boolean {
  const providerModels = KNOWN_UNAVAILABLE_MODELS_BY_PROVIDER[
    normalizeString(params.providerId).toLowerCase() as keyof typeof KNOWN_UNAVAILABLE_MODELS_BY_PROVIDER
  ];
  const entry = providerModels?.[normalizeString(params.modelId).toLowerCase()];
  return Boolean(entry && params.nowMs >= entry.retiredAtMs);
}

/** One eligibility rule for preflight discovery and runtime selection. */
export function isOpenCodeModelSelectable(input: Readonly<{
  providerID: string;
  modelID: string;
  modelRecord?: unknown;
  nowMs?: number;
}>): boolean {
  const providerId = normalizeString(input.providerID);
  const modelId = normalizeString(input.modelID);
  if (!providerId || !modelId) return false;
  if (isKnownUnavailableOpenCodeModel({ providerId, modelId, nowMs: input.nowMs ?? Date.now() })) return false;
  const record = asRecord(input.modelRecord);
  if (!record) return true;
  const status = normalizeString(record.status);
  if (status && status !== 'active') return false;
  const capabilities = asRecord(record.capabilities);
  if (Array.isArray(capabilities?.input)) return capabilities.input.includes('text');
  return asRecord(capabilities?.input)?.text !== false;
}
