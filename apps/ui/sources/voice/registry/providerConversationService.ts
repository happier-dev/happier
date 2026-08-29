import type { VoiceProviderConversationService } from '@happier-dev/plugin-sdk/voice/client';

import { VOICE_PROVIDER_CONVERSATION_RETENTION_MS } from '@/voice/persistence/voiceProviderConversationRetention';

type ProviderConversationSession = {
  mutationTail: Promise<void>;
  activeAttemptEpoch: number;
  forgotten: boolean;
  forgetDurable: boolean;
  forgetPromise: Promise<void> | null;
};

export type ProviderConversationServiceFactory = Readonly<{
  createAttempt(
    conversationSessionId: string,
    options?: Readonly<{ writeForgottenState(): Promise<void> }>,
  ): VoiceProviderConversationService;
}>;

function normalizeConversationId(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 ? normalized : null;
}

/**
 * Canonical host owner for provider conversation persistence ordering and
 * attempt fencing. Provider leaves never receive app session storage access.
 */
export function createProviderConversationServiceFactory(input: Readonly<{
  read(conversationSessionId: string): Promise<Readonly<{
    conversationId: string;
    updatedAt: number;
  }> | null>;
  write(conversationId: string | null, conversationSessionId: string): Promise<void>;
  now?: () => number;
}>): ProviderConversationServiceFactory {
  const sessions = new Map<string, ProviderConversationSession>();
  let nextAttemptEpoch = 0;

  const getSession = (conversationSessionId: string): ProviderConversationSession => {
    const existing = sessions.get(conversationSessionId);
    if (existing) return existing;
    const created: ProviderConversationSession = {
      mutationTail: Promise.resolve(),
      activeAttemptEpoch: 0,
      forgotten: false,
      forgetDurable: false,
      forgetPromise: null,
    };
    sessions.set(conversationSessionId, created);
    return created;
  };
  const enqueue = <T>(
    session: ProviderConversationSession,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const result = session.mutationTail.then(operation);
    session.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  return Object.freeze({
    createAttempt(
      conversationSessionId: string,
      options?: Readonly<{ writeForgottenState(): Promise<void> }>,
    ): VoiceProviderConversationService {
      const session = getSession(conversationSessionId);
      const attemptEpoch = ++nextAttemptEpoch;
      session.activeAttemptEpoch = attemptEpoch;
      session.forgotten = false;
      session.forgetDurable = false;
      session.forgetPromise = null;
      const isCurrent = () => session.activeAttemptEpoch === attemptEpoch;

      return Object.freeze({
        async read(): Promise<string | null> {
          return await enqueue(session, async () => {
            if (!isCurrent() || session.forgotten) return null;
            const state = await input.read(conversationSessionId);
            const conversationId = normalizeConversationId(state?.conversationId ?? null);
            if (!isCurrent() || session.forgotten || !conversationId || !state) return null;
            const now = input.now?.() ?? Date.now();
            if (now - state.updatedAt >= VOICE_PROVIDER_CONVERSATION_RETENTION_MS) {
              await input.write(null, conversationSessionId);
              return null;
            }
            return isCurrent() && !session.forgotten ? conversationId : null;
          });
        },
        async write(conversationId: string): Promise<void> {
          const normalized = normalizeConversationId(conversationId);
          if (!normalized) throw new Error('voice_provider_conversation_id_invalid');
          if (!isCurrent() || session.forgotten) return;
          await enqueue(session, async () => {
            if (!isCurrent() || session.forgotten) return;
            await input.write(normalized, conversationSessionId);
          });
        },
        async forget(): Promise<void> {
          if (!isCurrent()) return;
          session.forgotten = true;
          if (session.forgetDurable) return;
          if (session.forgetPromise) return await session.forgetPromise;
          const operation = enqueue(session, async () => {
            if (options) {
              await options.writeForgottenState();
            } else {
              await input.write(null, conversationSessionId);
            }
            if (isCurrent()) session.forgetDurable = true;
          });
          session.forgetPromise = operation;
          try {
            await operation;
          } finally {
            if (session.forgetPromise === operation) session.forgetPromise = null;
          }
        },
      });
    },
  });
}

const factoriesByPersistenceBoundary = new WeakMap<
  object,
  WeakMap<object, Map<string, ProviderConversationServiceFactory>>
>();

export function getProviderConversationServiceFactory(
  host: Readonly<{
    readProviderConversationState?(input: Readonly<{
      providerId: string;
      conversationSessionId: string;
    }>): Promise<Readonly<{ conversationId: string; updatedAt: number }> | null>;
    writeProviderConversationState?(input: Readonly<{
      providerId: string;
      conversationSessionId: string;
      state: Readonly<{ conversationId: string }> | null;
    }>): Promise<void>;
  }>,
  providerId: string,
): ProviderConversationServiceFactory {
  const readProviderConversationState = host.readProviderConversationState;
  const writeProviderConversationState = host.writeProviderConversationState;
  if (!readProviderConversationState || !writeProviderConversationState) {
    throw new Error('voice_provider_conversation_persistence_unavailable');
  }
  let byWrite = factoriesByPersistenceBoundary.get(readProviderConversationState);
  if (!byWrite) {
    byWrite = new WeakMap();
    factoriesByPersistenceBoundary.set(readProviderConversationState, byWrite);
  }
  let byProvider = byWrite.get(writeProviderConversationState);
  if (!byProvider) {
    byProvider = new Map();
    byWrite.set(writeProviderConversationState, byProvider);
  }
  const existing = byProvider.get(providerId);
  if (existing) return existing;
  const created = createProviderConversationServiceFactory({
    async read(conversationSessionId) {
      return (await readProviderConversationState({
        providerId,
        conversationSessionId,
      })) ?? null;
    },
    async write(conversationId, conversationSessionId) {
      await writeProviderConversationState({
        providerId,
        conversationSessionId,
        state: conversationId === null ? null : Object.freeze({ conversationId }),
      });
    },
  });
  byProvider.set(providerId, created);
  return created;
}
