import { VoiceProviderIdSchema } from '@happier-dev/protocol';

export type VoiceProviderConversationState = Readonly<{
  conversationId: string;
  updatedAt: number;
}>;

type EnvelopeV1 = Readonly<{
  v: 1;
  providers: Readonly<Record<string, VoiceProviderConversationState>>;
}>;

const MAX_CONVERSATION_ID_LENGTH = 512;

function normalizeProviderId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  const parsed = VoiceProviderIdSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

function readState(value: unknown): VoiceProviderConversationState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Readonly<Record<string, unknown>>;
  const conversationId = typeof raw.conversationId === 'string' ? raw.conversationId.trim() : '';
  if (!conversationId || conversationId.length > MAX_CONVERSATION_ID_LENGTH) return null;
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0) return null;
  return Object.freeze({ conversationId, updatedAt: raw.updatedAt });
}

function readProviders(metadata: unknown): Readonly<Record<string, VoiceProviderConversationState>> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return Object.freeze({});
  const envelope = (metadata as Readonly<Record<string, unknown>>).voiceProviderConversationsV1;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return Object.freeze({});
  const rawEnvelope = envelope as Readonly<Record<string, unknown>>;
  if (rawEnvelope.v !== 1 || !rawEnvelope.providers || typeof rawEnvelope.providers !== 'object' || Array.isArray(rawEnvelope.providers)) {
    return Object.freeze({});
  }
  const providers: Record<string, VoiceProviderConversationState> = Object.create(null) as Record<string, VoiceProviderConversationState>;
  for (const [providerId, rawState] of Object.entries(rawEnvelope.providers as Readonly<Record<string, unknown>>)) {
    const normalizedProviderId = normalizeProviderId(providerId);
    const state = readState(rawState);
    if (normalizedProviderId && state) providers[normalizedProviderId] = state;
  }
  return Object.freeze(providers);
}

export function readVoiceProviderConversationMetadata(
  metadata: unknown,
  providerId: string,
): VoiceProviderConversationState | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) return null;
  return readProviders(metadata)[normalizedProviderId] ?? null;
}

export function writeVoiceProviderConversationMetadata<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  input: Readonly<{
    providerId: string;
    state: Readonly<{ conversationId: string }> | null;
    updatedAt: number;
  }>,
): TMetadata;
export function writeVoiceProviderConversationMetadata(
  metadata: unknown,
  input: Readonly<{
    providerId: string;
    state: Readonly<{ conversationId: string }> | null;
    updatedAt: number;
  }>,
): Record<string, unknown>;
export function writeVoiceProviderConversationMetadata(
  metadata: unknown,
  input: Readonly<{
    providerId: string;
    state: Readonly<{ conversationId: string }> | null;
    updatedAt: number;
  }>,
): Record<string, unknown> {
  const providerId = normalizeProviderId(input.providerId);
  if (!providerId) throw new TypeError('invalid_voice_provider_id');
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Readonly<Record<string, unknown>>) }
    : {};
  const providers = { ...readProviders(metadata) };
  if (input.state === null) {
    delete providers[providerId];
  } else {
    const state = readState({ conversationId: input.state.conversationId, updatedAt: input.updatedAt });
    if (!state) throw new TypeError('invalid_voice_provider_conversation_state');
    providers[providerId] = state;
  }
  if (Object.keys(providers).length === 0) {
    delete base.voiceProviderConversationsV1;
    return base;
  }
  base.voiceProviderConversationsV1 = Object.freeze({
    v: 1,
    providers: Object.freeze(providers),
  } satisfies EnvelopeV1);
  return base;
}
