import type { VoiceSessionBinding } from './voiceSessionBindingTypes';

type PersistedVoiceConversationBindingV1 = Readonly<{
  v: 1;
  adapterId: string;
  controlSessionId: string;
  transcriptMode: VoiceSessionBinding['transcriptMode'];
  targetSessionId: string | null;
  updatedAt: number;
}>;

function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readVoiceConversationBindingMetadata(
  conversationSessionId: string,
  metadata: unknown,
): VoiceSessionBinding | null {
  const resolvedConversationSessionId = normalizeId(conversationSessionId);
  if (!resolvedConversationSessionId || !metadata || typeof metadata !== 'object') return null;

  const raw = (metadata as any).voiceConversationBindingV1 as PersistedVoiceConversationBindingV1 | undefined;
  if (!raw || raw.v !== 1) return null;

  const adapterId = normalizeId(raw.adapterId);
  const controlSessionId = normalizeId(raw.controlSessionId);
  const transcriptMode = raw.transcriptMode === 'native_session' ? 'native_session' : raw.transcriptMode === 'synthetic' ? 'synthetic' : null;
  if (!adapterId || !controlSessionId || !transcriptMode) return null;

  const updatedAt = Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : 0;
  return {
    adapterId,
    controlSessionId,
    conversationSessionId: resolvedConversationSessionId,
    transcriptMode,
    targetSessionId: normalizeId(raw.targetSessionId),
    updatedAt,
  };
}

type VoiceConversationBindingMetadataRecord = Record<string, unknown> & {
  voiceConversationBindingV1: PersistedVoiceConversationBindingV1;
};

export function writeVoiceConversationBindingMetadata<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  binding: VoiceSessionBinding,
): TMetadata & VoiceConversationBindingMetadataRecord;
export function writeVoiceConversationBindingMetadata(
  metadata: unknown,
  binding: VoiceSessionBinding,
): VoiceConversationBindingMetadataRecord;
export function writeVoiceConversationBindingMetadata(
  metadata: unknown,
  binding: VoiceSessionBinding,
): VoiceConversationBindingMetadataRecord {
  const base = metadata && typeof metadata === 'object' ? { ...(metadata as Record<string, unknown>) } : {};
  return {
    ...base,
    voiceConversationBindingV1: {
    v: 1,
    adapterId: binding.adapterId,
    controlSessionId: binding.controlSessionId,
    transcriptMode: binding.transcriptMode,
    targetSessionId: binding.targetSessionId,
    updatedAt: binding.updatedAt,
    } satisfies PersistedVoiceConversationBindingV1,
  };
}
