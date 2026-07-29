export type SpawnedFirstPromptFollowUpDeliveryStatus = 'queued';

export type SpawnedFirstPromptFollowUp = Readonly<{
  initialMessageText: string;
  messageLocalId: string | null;
  metaOverrides: Record<string, unknown> | undefined;
  optimisticDeliveryStatus: SpawnedFirstPromptFollowUpDeliveryStatus;
}>;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMetaOverrides(value: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  if (!value || Object.keys(value).length === 0) {
    return undefined;
  }
  return { ...value };
}

export function resolveSpawnedFirstPromptFollowUp(params: Readonly<{
  sessionId: string | null;
  fallbackLocalId?: string | null;
  initialMessageText?: string | null;
  metaOverrides?: Record<string, unknown> | null;
}>): SpawnedFirstPromptFollowUp {
  const initialMessageText = normalizeString(params.initialMessageText);
  const fallbackLocalId = normalizeString(params.fallbackLocalId);
  const messageLocalId = fallbackLocalId || null;

  if (!initialMessageText) {
    return {
      initialMessageText: '',
      messageLocalId,
      metaOverrides: undefined,
      optimisticDeliveryStatus: 'queued',
    };
  }

  return {
    initialMessageText,
    messageLocalId,
    metaOverrides: normalizeMetaOverrides(params.metaOverrides),
    optimisticDeliveryStatus: 'queued',
  };
}
