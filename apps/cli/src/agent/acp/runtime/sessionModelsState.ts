import type { Metadata } from '@/api/types';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { normalizeAcpConfigOptionChoices } from '@/agent/acp/configOptionChoiceNormalization';
import { readNonBlankSessionControlIdentifier } from '@/agent/runtime/sessionControlIdentifiers';
import { readNewestSessionModelsMetadataStateV1 } from '@happier-dev/agents';

type NormalizedConfigOptionValue = string | number | boolean | null;

export type NormalizedConfigOption = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: NormalizedConfigOptionValue;
  options?: Array<{
    value: NormalizedConfigOptionValue;
    name: string;
    description?: string;
  }>;
};

type AcpSessionModelsState = NonNullable<Metadata['acpSessionModelsV1']>;
type AcpSessionModel = AcpSessionModelsState['availableModels'][number];

function normalizeOptionToken(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_-]+/g, '-')
    : typeof value === 'number' && Number.isFinite(value) ? String(value)
    : typeof value === 'boolean' ? String(value)
    : '';
}

export function isAcpModelScopedConfigOption(option: Readonly<{
  id?: unknown;
  name?: unknown;
  category?: unknown;
}>): boolean {
  const category = normalizeOptionToken(option.category);
  if (category === 'model-config' || category === 'model-option' || category === 'thought-level') return true;

  const id = normalizeOptionToken(option.id);
  const name = normalizeOptionToken(option.name);
  return id === 'reasoning-effort'
    || id === 'reasoning'
    || id === 'effort'
    || id === 'thought-level'
    || id === 'service-tier'
    || id === 'fast'
    || id === 'thinking'
    || id === 'context'
    || id === 'context-size'
    || id === 'context-window'
    || name === 'reasoning-effort'
    || name === 'reasoning'
    || name === 'thought-level'
    || name === 'thinking'
    || name === 'fast'
    || name === 'context';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeConfigOptionValue(value: unknown): NormalizedConfigOptionValue | null {
  return typeof value === 'string' ? value
    : typeof value === 'number' && Number.isFinite(value) ? value
    : typeof value === 'boolean' ? value
    : null;
}

export function normalizeConfigOptionsArray(raw: unknown): NormalizedConfigOption[] {
  if (!Array.isArray(raw)) return [];

  const out: NormalizedConfigOption[] = [];
  for (const entry of raw) {
    const o = asRecord(entry);
    const id = readNonBlankSessionControlIdentifier(o?.id) ?? '';
    const name = typeof o?.name === 'string' ? String(o.name).trim() : '';
    const type = typeof o?.type === 'string' ? String(o.type).trim() : '';
    if (!id || !name || !type) continue;

    const description = typeof o?.description === 'string' ? String(o.description).trim() : '';
    const category = typeof o?.category === 'string' ? String(o.category).trim() : '';
    const currentValueRaw = o?.currentValue;
    const currentValue = normalizeConfigOptionValue(currentValueRaw);

    const optionsRaw = o?.options;
    const options = Array.isArray(optionsRaw)
      ? normalizeAcpConfigOptionChoices(optionsRaw, normalizeConfigOptionValue)
      : [];

    out.push({
      id,
      name,
      type,
      currentValue,
      ...(description ? { description } : {}),
      ...(category ? { category } : {}),
      ...(options.length > 0 ? { options } : {}),
    });
  }

  return out;
}

export function collectAcpModelScopedConfigOptions(
  configOptions: ReadonlyArray<NormalizedConfigOption>,
): NormalizedConfigOption[] {
  return configOptions.filter(isAcpModelScopedConfigOption);
}

function normalizeAcpSessionModel(raw: unknown): AcpSessionModel | null {
  const model = asRecord(raw);
  if (!model) return null;

  const idRaw = model.id ?? model.modelId;
  const nameRaw = model.name;
  if (typeof idRaw !== 'string' || typeof nameRaw !== 'string') return null;

  const descriptionRaw = model.description;
  const contextWindowTokensRaw = model.contextWindowTokens;
  const modelOptions = normalizeConfigOptionsArray(model.modelOptions ?? model.model_options);
  return {
    id: idRaw,
    name: nameRaw,
    ...(typeof descriptionRaw === 'string' ? { description: descriptionRaw } : {}),
    ...(typeof contextWindowTokensRaw === 'number'
      && Number.isInteger(contextWindowTokensRaw)
      && contextWindowTokensRaw > 0
      ? { contextWindowTokens: contextWindowTokensRaw }
      : {}),
    ...(modelOptions.length > 0 ? { modelOptions } : {}),
  };
}

function normalizeAcpSessionModels(raw: unknown): AcpSessionModel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeAcpSessionModel)
    .filter((model): model is AcpSessionModel => model !== null);
}

export function buildAcpSessionModelsStateFromPayload(params: Readonly<{
  provider: string;
  payload: unknown;
  previousAvailableModels?: unknown;
  requireAvailableModels?: boolean;
}>): AcpSessionModelsState | null {
  const payload = asRecord(params.payload);
  const currentModelIdRaw = payload?.currentModelId;
  const currentModelId = typeof currentModelIdRaw === 'string' ? currentModelIdRaw : '';
  if (!currentModelId) return null;

  const nextModels = normalizeAcpSessionModels(payload?.availableModels);
  const previousModels = normalizeAcpSessionModels(params.previousAvailableModels);
  const availableModels = nextModels.length > 0 ? nextModels : previousModels;
  if (params.requireAvailableModels === true && availableModels.length === 0) return null;

  return {
    v: 1,
    provider: params.provider,
    updatedAt: Date.now(),
    currentModelId,
    availableModels,
  };
}

export function publishAcpSessionModelsState(params: Readonly<{
  session: Readonly<{ updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void }>;
  provider: string;
  payload: unknown;
  logPrefix: string;
  reason: string;
  preservePreviousAvailableModels?: boolean;
  requireAvailableModels?: boolean;
}>): void {
  updateMetadataBestEffort(
    params.session,
    (metadata) => {
      const previous = params.preservePreviousAvailableModels === true
        ? readNewestSessionModelsMetadataStateV1(metadata as unknown as Record<string, unknown>) as AcpSessionModelsState | null
        : null;
      const next = buildAcpSessionModelsStateFromPayload({
        provider: params.provider,
        payload: params.payload,
        previousAvailableModels: previous?.provider === params.provider ? previous.availableModels : undefined,
        requireAvailableModels: params.requireAvailableModels,
      });
      return next ? { ...metadata, sessionModelsV1: next, acpSessionModelsV1: next } : metadata;
    },
    params.logPrefix,
    params.reason,
  );
}
