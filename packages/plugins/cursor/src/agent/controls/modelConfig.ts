export type CursorParameterizedModelId = Readonly<{
  baseModelId: string;
  options: Readonly<Record<string, string>>;
}>;

export type CursorModelPickerGate =
  | Readonly<{ state: 'enabled' }>
  | Readonly<{ state: 'diagnostic'; reason: 'version_too_old' | 'channel_not_verified' | 'channel_unknown' }>;

const MINIMUM_PARAMETERIZED_PICKER_VERSION = '2026.04.08';

function normalizeString(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function parseVersionDate(version: string): string | null {
  const match = /^(\d{4}\.\d{2}\.\d{2})/u.exec(version.trim());
  return match?.[1] ?? null;
}

export function parseCursorParameterizedModelId(modelId: string): CursorParameterizedModelId {
  const trimmed = modelId.trim();
  const match = /^([^[\]]+)(?:\[(.*)\])?$/u.exec(trimmed);
  const baseModelId = match?.[1]?.trim() ?? trimmed;
  const optionText = match?.[2]?.trim() ?? '';
  const options = Object.fromEntries(
    optionText
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [key, ...valueParts] = entry.split('=');
        return [key?.trim() ?? '', valueParts.join('=').trim()] as const;
      })
      .filter(([key]) => key.length > 0),
  );
  return { baseModelId, options };
}

export function buildCursorParameterizedModelId(model: CursorParameterizedModelId): string {
  const optionEntries = Object.entries(model.options);
  if (optionEntries.length === 0) return model.baseModelId;
  const options = optionEntries.map(([key, value]) => `${key}=${value}`).join(',');
  return `${model.baseModelId}[${options}]`;
}

export function repairCursorModelSelection(params: Readonly<{
  selectedModelId: string | null;
  availableModelIds: readonly string[];
  defaultModelId: string;
}>): Readonly<{ modelId: string; repaired: boolean }> {
  const selected = normalizeString(params.selectedModelId ?? '');
  if (selected && params.availableModelIds.includes(selected)) {
    return { modelId: selected, repaired: false };
  }
  return { modelId: params.defaultModelId, repaired: true };
}

export function resolveCursorModelPickerGate(params: Readonly<{
  cliVersion: string | null;
  channel: string | null;
}>): CursorModelPickerGate {
  const versionDate = parseVersionDate(normalizeString(params.cliVersion));
  if (!versionDate || versionDate < MINIMUM_PARAMETERIZED_PICKER_VERSION) {
    return { state: 'diagnostic', reason: 'version_too_old' };
  }
  const channel = normalizeString(params.channel);
  if (!channel) {
    return { state: 'diagnostic', reason: 'channel_unknown' };
  }
  if (channel !== 'lab') {
    return { state: 'diagnostic', reason: 'channel_not_verified' };
  }
  return { state: 'enabled' };
}
