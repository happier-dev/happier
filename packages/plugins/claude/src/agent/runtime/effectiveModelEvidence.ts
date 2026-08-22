export type ClaudeEffectiveModelEvidence = Readonly<{
  modelId: string;
  displayName?: string | null;
  contextWindowTokens?: number | null;
}>;

export type ClaudeEffectiveModelEvidenceSubscription = (
  listener: (evidence: ClaudeEffectiveModelEvidence) => void,
) => () => void;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function readClaudeMainChainAssistantModelId(value: unknown): string | null {
  const row = readRecord(value);
  if (row?.type !== 'assistant') return null;
  if (row.isSidechain === true || row.isMeta === true || readString(row.parent_tool_use_id)) return null;
  if (row.isApiErrorMessage === true || readString(row.error)) return null;

  const modelId = readString(readRecord(row.message)?.model);
  if (!modelId || modelId.includes('<')) return null;
  return modelId;
}
