import type { SessionConfigOptionValue } from './cursorModelConfigTypes';

export type ParsedModelValue = Readonly<{
  base: string;
  params: ReadonlyMap<string, string>;
  order: ReadonlyArray<string>;
}>;

export type CursorCliTraits = Readonly<{
  fastMode?: boolean;
  thinking?: boolean;
  reasoning?: string;
  contextWindow?: string;
}>;

export function stringifyConfigValue(value: SessionConfigOptionValue | undefined): string {
  return value === undefined || value === null ? '' : String(value);
}

export function normalizeToken(value: string | number | boolean | null | undefined): string {
  return value === undefined || value === null ? '' : String(value).trim().toLowerCase().replace(/[\s_-]+/g, '-');
}

export function stripParameterizedSuffix(value: string): string {
  return value.trim().replace(/\[[^\]]*\]$/u, '');
}

export function parseParameterizedModelValue(value: string): ParsedModelValue {
  const trimmed = value.trim();
  const match = trimmed.match(/^(?<base>[^\[]+)(?:\[(?<params>[^\]]*)\])?$/u);
  const base = match?.groups?.base?.trim() || trimmed;
  const rawParams = match?.groups?.params ?? '';
  const params = new Map<string, string>();
  const order: string[] = [];
  for (const rawPart of rawParams.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = part.slice(0, separatorIndex).trim();
    const paramValue = part.slice(separatorIndex + 1).trim();
    if (!key) continue;
    if (!params.has(key)) order.push(key);
    params.set(key, paramValue);
  }
  return { base, params, order };
}

export function formatParameterizedModelValue(parsed: ParsedModelValue): string {
  if (parsed.params.size === 0) return parsed.base;
  const orderedKeys = [
    ...parsed.order.filter((key) => parsed.params.has(key)),
    ...Array.from(parsed.params.keys()).filter((key) => !parsed.order.includes(key)),
  ];
  return `${parsed.base}[${orderedKeys.map((key) => `${key}=${parsed.params.get(key) ?? ''}`).join(',')}]`;
}

function normalizeCursorReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
    case 'none':
      return normalized;
    case 'xhigh':
    case 'extra-high':
    case 'extra high':
      return 'xhigh';
    default:
      return undefined;
  }
}

export function parseCursorCliTraits(modelId: string): CursorCliTraits {
  const parsed = parseParameterizedModelValue(modelId);
  const normalized = parsed.base.toLowerCase();
  const explicitFast = parsed.params.get('fast');
  const fastMode = explicitFast === 'true' || explicitFast === 'false'
    ? explicitFast === 'true'
    : normalized.endsWith('-fast') || normalized.includes('-fast-') ? true : undefined;
  const tokens = normalized.split('-').filter(Boolean);
  const isClaudeMaxContextAlias = normalized.startsWith('claude-') && tokens.some((token, index) =>
    token === 'max' && tokens[index - 1] !== 'thinking'
  );
  const contextWindow = (() => {
    const explicit = tokens.find((token) => /^\d+(?:k|m)$/u.test(token));
    if (explicit) return explicit;
    return isClaudeMaxContextAlias ? '1m' : undefined;
  })();
  let reasoning: string | undefined;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === 'max' && isClaudeMaxContextAlias && tokens[index - 1] !== 'thinking') continue;
    if (token === 'high' && tokens[index - 1] === 'extra') {
      reasoning = 'xhigh';
      break;
    }
    const normalizedReasoning = normalizeCursorReasoningValue(token);
    if (normalizedReasoning) {
      reasoning = normalizedReasoning;
      break;
    }
  }
  return {
    ...(fastMode === undefined ? {} : { fastMode }),
    ...(normalized.endsWith('-thinking') || normalized.includes('-thinking-') ? { thinking: true } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  };
}

export function normalizeCursorModelVariantBaseId(modelId: string): string {
  let base = stripParameterizedSuffix(modelId)
    .replace(/-\d+(?:k|m)$/u, '')
    .replace(/-fast$/u, '')
    .replace(/-(?:extra-high|none|low|medium|high|xhigh|max)$/u, '')
    .replace(/-thinking$/u, '')
    .replace(/-\d+(?:k|m)$/u, '')
    .replace(/-fast$/u, '')
    .replace(/-(?:extra-high|none|low|medium|high|xhigh|max)$/u, '');

  if (base.endsWith('-max') && !base.includes('codex-max')) {
    base = base.slice(0, -'-max'.length);
  }

  base = base
    .replace(/^claude-(\d+(?:\.\d+)?)-([a-z]+)-max$/u, 'claude-$1-$2')
    .replace(/-preview$/u, '');

  const claudeReordered = base.match(/^claude-(\d+(?:\.\d+)?)-([a-z]+)$/u);
  if (claudeReordered) {
    const version = claudeReordered[1];
    const family = claudeReordered[2];
    if (version && family) {
      return `claude-${family}-${version.replace('.', '-')}`;
    }
  }

  return base;
}
