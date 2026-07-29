import type { PluginVoiceProviderConversationService } from '@happier-dev/plugin-sdk/runtime';

type ProviderConversationSession = {
  mutationTail: Promise<void>;
  activeAttemptEpoch: number;
  forgotten: boolean;
  forgetDurable: boolean;
  forgetPromise: Promise<void> | null;
};

export type ProviderConversationServiceFactory = Readonly<{
  createAttempt(conversationSessionId: string): PluginVoiceProviderConversationService;
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
  read(conversationSessionId: string): Promise<string | null>;
  write(conversationId: string | null, conversationSessionId: string): Promise<void>;
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
  const enqueue = (
    session: ProviderConversationSession,
    operation: () => Promise<void>,
  ): Promise<void> => {
    const result = session.mutationTail.then(operation);
    session.mutationTail = result.catch(() => {});
    return result;
  };

  return Object.freeze({
    createAttempt(conversationSessionId: string): PluginVoiceProviderConversationService {
      const session = getSession(conversationSessionId);
      const attemptEpoch = ++nextAttemptEpoch;
      session.activeAttemptEpoch = attemptEpoch;
      session.forgotten = false;
      session.forgetDurable = false;
      session.forgetPromise = null;
      const isCurrent = () => session.activeAttemptEpoch === attemptEpoch;

      return Object.freeze({
        async read(): Promise<string | null> {
          await session.mutationTail;
          if (!isCurrent() || session.forgotten) return null;
          const conversationId = normalizeConversationId(await input.read(conversationSessionId));
          return isCurrent() && !session.forgotten ? conversationId : null;
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
            await input.write(null, conversationSessionId);
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

const factoriesByHost = new WeakMap<object, Map<string, ProviderConversationServiceFactory>>();

export function getProviderConversationServiceFactory(
  host: Readonly<{
    readProviderConversationState?(input: Readonly<{
      providerId: string;
      conversationSessionId: string;
    }>): Promise<Readonly<{ conversationId: string }> | null>;
    writeProviderConversationState?(input: Readonly<{
      providerId: string;
      conversationSessionId: string;
      state: Readonly<{ conversationId: string }> | null;
    }>): Promise<void>;
  }>,
  providerId: string,
): ProviderConversationServiceFactory {
  let byProvider = factoriesByHost.get(host);
  if (!byProvider) {
    byProvider = new Map();
    factoriesByHost.set(host, byProvider);
  }
  const existing = byProvider.get(providerId);
  if (existing) return existing;
  const readProviderConversationState = host.readProviderConversationState;
  const writeProviderConversationState = host.writeProviderConversationState;
  if (!readProviderConversationState || !writeProviderConversationState) {
    throw new Error('voice_provider_conversation_persistence_unavailable');
  }
  const created = createProviderConversationServiceFactory({
    async read(conversationSessionId) {
      return (await readProviderConversationState({
        providerId,
        conversationSessionId,
      }))?.conversationId ?? null;
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
