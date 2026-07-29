import {
  createDaemonSessionClientDurableMutationOutbox,
  type DaemonSessionClientDurableMutationOutbox,
} from '@/api/session/client/transport/mutations/createDaemonSessionClientDurableMutationOutbox';
import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import type { DaemonUsageLimitRecoveryFieldMutation } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';

import { applyDaemonUsageLimitRecoveryMutation } from './applyDaemonUsageLimitRecoveryMutation';

export type DaemonUsageLimitRecoveryMutationCustody = Readonly<{
  stage(input: Readonly<{
    mutation: DaemonUsageLimitRecoveryFieldMutation;
    rawSession: RawSessionRecord;
  }>): Promise<void>;
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

export function createDaemonUsageLimitRecoveryMutationCustody(params: Readonly<{
  credentials: Credentials;
  resolveSessionTransportContext?: typeof resolveSessionTransportContext;
}>): DaemonUsageLimitRecoveryMutationCustody {
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
