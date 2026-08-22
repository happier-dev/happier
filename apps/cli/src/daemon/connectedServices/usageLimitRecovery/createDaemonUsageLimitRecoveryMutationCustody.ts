import {
  createDaemonSessionClientDurableMutationOutbox,
  type DaemonSessionClientDurableMutationOutbox,
} from '@/api/session/client/transport/mutations/createDaemonSessionClientDurableMutationOutbox';
import type { StoredCredentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { commitSessionStoredMessage } from '@/session/transport/http/sessionsHttp';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import {
  createTranscriptMessageAppendMutation,
  type DaemonUsageLimitRecoveryFieldMutation,
} from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import { AccountEncryptionMaterialUnavailableError } from '@/api/client/encryptionKey';
import {
  SessionStoredMessageContentSchema,
  type SessionStoredMessageContent,
} from '@happier-dev/protocol';

import { applyDaemonUsageLimitRecoveryMutation } from './applyDaemonUsageLimitRecoveryMutation';

export class DaemonSessionMutationAdmissionError extends Error {
  constructor(readonly code: 'session_unavailable') {
    super(`Daemon session mutation admission failed: ${code}`);
    this.name = 'DaemonSessionMutationAdmissionError';
  }
}

export type DaemonSessionMutationCustody = Readonly<{
  stage(input: Readonly<{
    mutation: DaemonUsageLimitRecoveryFieldMutation;
    rawSession: RawSessionRecord;
  }>): Promise<void>;
  stageTranscriptEvent(input: Readonly<{
    sessionId: string;
    eventId: string;
    data: Readonly<Record<string, unknown>>;
    observedAt?: number;
  }>): Promise<Readonly<{ persisted: true; delivered: boolean }>>;
  bindRecoveredJournals(sessionIds: readonly string[]): Promise<Readonly<{
    boundSessionIds: readonly string[];
    retainedSessionIds: readonly string[];
  }>>;
  close(): Promise<void>;
}>;

type SessionCustody = {
  rawSession: RawSessionRecord;
  outbox: DaemonSessionClientDurableMutationOutbox;
};

export function createDaemonSessionMutationCustody(params: Readonly<{
  credentials: StoredCredentials;
  resolveSessionTransportContext?: typeof resolveSessionTransportContext;
}>): DaemonSessionMutationCustody {
  const sessions = new Map<string, SessionCustody>();
  const retainedSessionIds = new Set<string>();
  let bindingTail: Promise<void> = Promise.resolve();
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const resolveSessionCustody = (
    sessionId: string,
    rawSession: RawSessionRecord,
  ): SessionCustody => {
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.rawSession = rawSession;
      return existing;
    }

    const custody = {} as SessionCustody;
    custody.rawSession = rawSession;
    custody.outbox = createDaemonSessionClientDurableMutationOutbox({
      token: params.credentials.token,
      sessionId,
      getSocket: () => null,
      requestReconnect: () => undefined,
      deliverUsageLimitRecovery: async (mutation) => {
        await updateSessionMetadataWithRetry({
          token: params.credentials.token,
          credentials: params.credentials,
          sessionId,
          rawSession: custody.rawSession,
          updater: (metadata) => applyDaemonUsageLimitRecoveryMutation(metadata, mutation),
        });
        return true;
      },
      deliverTranscriptMessage: async (mutation) => {
        const content = SessionStoredMessageContentSchema.parse(mutation.content);
        const committed = await commitSessionStoredMessage({
          token: params.credentials.token,
          sessionId,
          localId: mutation.localId,
          ...(mutation.messageRole ? { messageRole: mutation.messageRole } : {}),
          content,
        });
        return committed.localId === mutation.localId;
      },
    });
    sessions.set(sessionId, custody);
    return custody;
  };

  return {
    async stage({ mutation, rawSession }) {
      if (closed) throw new Error('daemon_usage_limit_recovery_custody_closed');
      const sessionId = mutation.sessionId.trim();
      if (!sessionId || rawSession.id !== sessionId) {
        throw new Error('daemon_usage_limit_recovery_session_mismatch');
      }
      retainedSessionIds.delete(sessionId);
      await resolveSessionCustody(sessionId, rawSession).outbox.enqueueUsageLimitRecovery(mutation);
    },
    async stageTranscriptEvent({ sessionId: rawSessionId, eventId: rawEventId, data, observedAt }) {
      if (closed) throw new Error('daemon_session_mutation_custody_closed');
      const sessionId = rawSessionId.trim();
      const eventId = rawEventId.trim();
      if (!sessionId || !eventId) {
        throw new DaemonSessionMutationAdmissionError('session_unavailable');
      }
      const resolved = await (params.resolveSessionTransportContext ?? resolveSessionTransportContext)({
        credentials: params.credentials,
        idOrPrefix: sessionId,
      });
      if (!resolved.ok) {
        if (resolved.code === 'encryption_material_unavailable') {
          throw new AccountEncryptionMaterialUnavailableError();
        }
        throw new DaemonSessionMutationAdmissionError('session_unavailable');
      }
      if (resolved.sessionId !== sessionId || resolved.rawSession.id !== sessionId) {
        throw new DaemonSessionMutationAdmissionError('session_unavailable');
      }
      const payload = {
        role: 'agent',
        content: {
          type: 'event',
          id: eventId,
          data,
        },
      };
      const content: SessionStoredMessageContent = resolved.mode === 'plain'
        ? { t: 'plain' as const, v: payload }
        : {
            t: 'encrypted' as const,
            c: encryptSessionPayload({
              ctx: resolved.ctx,
              payload,
            }),
          };
      retainedSessionIds.delete(sessionId);
      const result = await resolveSessionCustody(sessionId, resolved.rawSession).outbox.enqueueTranscriptMessage(
        createTranscriptMessageAppendMutation({
          sessionId,
          localId: eventId,
          messageRole: 'event',
          content,
          createdAt: observedAt,
          updatedAt: observedAt,
          provenance: { kind: 'non_dependent', source: 'background' },
        }),
      );
      if (!result.persisted) {
        throw new Error('daemon_session_mutation_journal_admission_failed');
      }
      return { persisted: true, delivered: result.delivered };
    },
    async bindRecoveredJournals(sessionIds) {
      if (closed) return { boundSessionIds: [], retainedSessionIds: [] };
      for (const sessionId of sessionIds) {
        const normalizedSessionId = sessionId.trim();
        if (normalizedSessionId && !sessions.has(normalizedSessionId)) {
          retainedSessionIds.add(normalizedSessionId);
        }
      }

      const binding = bindingTail.then(async () => {
        const boundSessionIds: string[] = [];
        for (const sessionId of [...retainedSessionIds].sort()) {
          if (closed) break;
          if (sessions.has(sessionId)) {
            retainedSessionIds.delete(sessionId);
            continue;
          }
          let resolved: Awaited<ReturnType<typeof resolveSessionTransportContext>>;
          try {
            resolved = await (params.resolveSessionTransportContext ?? resolveSessionTransportContext)({
              credentials: params.credentials,
              idOrPrefix: sessionId,
            });
          } catch {
            continue;
          }
          if (closed) break;
          if (!resolved.ok || resolved.sessionId !== sessionId) continue;
          resolveSessionCustody(sessionId, resolved.rawSession);
          retainedSessionIds.delete(sessionId);
          boundSessionIds.push(sessionId);
        }
        return {
          boundSessionIds,
          retainedSessionIds: [...retainedSessionIds].sort(),
        };
      });
      bindingTail = binding.then(() => undefined, () => undefined);
      return await binding;
    },
    async close() {
      closePromise ??= (async () => {
        closed = true;
        await bindingTail;
        const outboxes = Array.from(sessions.values(), (entry) => entry.outbox);
        sessions.clear();
        retainedSessionIds.clear();
        await Promise.all(outboxes.map(async (outbox) => await outbox.close()));
      })();
      await closePromise;
    },
  };
}
