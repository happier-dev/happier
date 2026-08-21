export type PiThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type PiModelCatalogEntry = Readonly<{
  id: string;
  name: string;
  description: string;
  modelOptions?: unknown[];
}>;

export function normalizePiThinkingEffort(raw: unknown): PiThinkingEffort | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value;
  if (value === 'max') return 'xhigh';
  return null;
}

export function qualifyPiModelId(providerRaw: unknown, modelIdRaw: unknown): string | null {
  const provider = typeof providerRaw === 'string' ? providerRaw.trim() : '';
  const modelId = typeof modelIdRaw === 'string' ? modelIdRaw.trim() : '';
  if (!provider || !modelId) return null;
  return modelId.includes('/') ? modelId : `${provider}/${modelId}`;
}

export function createPiModelCatalogEntry(params: Readonly<{
  provider: unknown;
  modelId: unknown;
  name?: unknown;
  supportsThinking?: boolean;
  thinkingEffort?: unknown;
}>): PiModelCatalogEntry | null {
  const provider = typeof params.provider === 'string' ? params.provider.trim() : '';
  const id = qualifyPiModelId(provider, params.modelId);
  if (!provider || !id) return null;

  const name = typeof params.name === 'string' && params.name.trim().length > 0
    ? params.name.trim()
    : id.slice(id.indexOf('/') + 1);
  const thinkingEffort = normalizePiThinkingEffort(params.thinkingEffort) ?? 'medium';

  return {
    id,
    name,
    description: provider,
    ...(params.supportsThinking === true ? {
      modelOptions: [{
        id: 'reasoning_effort',
        name: 'Thinking',
        type: 'select',
        currentValue: thinkingEffort,
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
          { value: 'xhigh', name: 'Max' },
        ],
      }],
    } : {}),
  };
}
