import type { VoiceSessionBinding } from './voiceConversationBindingTypes';
import { isVoiceConversationSystemSessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';

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

function normalizeUpdatedAt(value: unknown): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
}

function requireNormalizedId(value: unknown, fieldName: string): string {
    const normalized = normalizeId(value);
    if (normalized) return normalized;
    throw new TypeError(`Invalid ${fieldName}`);
}

export function readVoiceConversationBindingMetadata(
    conversationSessionId: string,
    metadata: unknown,
): VoiceSessionBinding | null {
    const resolvedConversationSessionId = normalizeId(conversationSessionId);
    if (!resolvedConversationSessionId || !metadata || typeof metadata !== 'object') return null;

    const raw = (metadata as Readonly<Record<string, unknown>>).voiceConversationBindingV1 as PersistedVoiceConversationBindingV1 | undefined;
    if (!raw || raw.v !== 1) return null;

    const adapterId = normalizeId(raw.adapterId);
    const controlSessionId = normalizeId(raw.controlSessionId);
    const transcriptMode =
        raw.transcriptMode === 'native_session'
            ? 'native_session'
            : raw.transcriptMode === 'synthetic'
              ? 'synthetic'
              : null;
    if (!adapterId || !controlSessionId || !transcriptMode) return null;

    const updatedAt = normalizeUpdatedAt(raw.updatedAt);
    return {
        adapterId,
        controlSessionId,
        conversationSessionId: resolvedConversationSessionId,
        transcriptMode,
        targetSessionId: normalizeId(raw.targetSessionId),
        updatedAt,
    };
}

export function readPreferredVoiceConversationBindingMetadata(params: Readonly<{
    conversationSessionId: string;
    preferredMetadata?: unknown;
    directMetadata?: unknown;
}>): VoiceSessionBinding | null {
    const metadataCandidates = [params.preferredMetadata, params.directMetadata];
    for (const metadata of metadataCandidates) {
        if (!isVoiceConversationSystemSessionMetadata(metadata)) continue;
        const binding = readVoiceConversationBindingMetadata(params.conversationSessionId, metadata);
        if (binding) {
            return binding;
        }
    }
    return null;
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
    const adapterId = requireNormalizedId(binding.adapterId, 'voice conversation adapter id');
    const controlSessionId = requireNormalizedId(binding.controlSessionId, 'voice conversation control session id');
    const targetSessionId = normalizeId(binding.targetSessionId);
    return {
        ...base,
        voiceConversationBindingV1: {
            v: 1,
            adapterId,
            controlSessionId,
            transcriptMode: binding.transcriptMode,
            targetSessionId,
            updatedAt: Number.isFinite(binding.updatedAt) ? Number(binding.updatedAt) : 0,
        } satisfies PersistedVoiceConversationBindingV1,
    };
}
