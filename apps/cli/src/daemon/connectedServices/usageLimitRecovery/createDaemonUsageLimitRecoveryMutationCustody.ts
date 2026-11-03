import { randomUUID } from 'node:crypto';

import {
  createDaemonSessionClientDurableMutationOutbox,
  type DaemonSessionClientDurableMutationOutbox,
} from '@/api/session/client/transport/mutations/createDaemonSessionClientDurableMutationOutbox';
import type { StoredCredentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { commitSessionStoredMessage } from '@/session/transport/http/sessionsHttp';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { sealSessionStoredContent, resolveSessionStoredContentEncryptionMode, resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { hasEffectiveSessionGoalChange } from '@/session/goalControls/commitGoalFollowOccurrence';
import { logger } from '@/ui/logger';
import { persistUsageLimitRecoveryFieldDurably } from '@/session/usageLimitRecoveryControls/persistUsageLimitRecoveryFieldDurably';
import {
  createTranscriptMessageAppendMutation,
  type DaemonUsageLimitRecoveryFieldMutation,
  type DaemonWorkStateFieldMutation,
} from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import { AccountEncryptionMaterialUnavailableError } from '@/api/client/encryptionKey';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { SessionWorkStateV1Schema as SessionStateWorkStateValueSchema, readSessionWorkStateV1FromMetadata, writeSessionWorkStateV1ToMetadata } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { buildAgentEventLocalId } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import type { SessionUsageLimitRecoveryV1, SessionStoredMessageContent } from '@happier-dev/protocol';

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
  stageWorkState(input: Readonly<{
    mutation: DaemonWorkStateFieldMutation;
    rawSession: RawSessionRecord;
    signal?: AbortSignal;
  }>): Promise<void>;
  stageTranscriptEvent(input: Readonly<{
    sessionId: string;
    eventId: string;
    data: Readonly<Record<string, unknown>>;
    usageLimitRecovery?: SessionUsageLimitRecoveryV1;
    observedAt?: number;
  }>): Promise<Readonly<{ persisted: true; delivered: boolean }>>;
  stageTranscriptMessage(input: Readonly<{
    sessionId: string;
    localId: string;
    payload: Readonly<Record<string, unknown>>;
    messageRole: 'user' | 'agent' | 'event';
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
      deliverWorkState: async (mutation) => {
        const rawSession = custody.rawSession;
        let previous: Record<string, unknown> | undefined;
        const committed = await updateSessionMetadataWithRetry({
          token: params.credentials.token,
          credentials: params.credentials,
          sessionId,
          rawSession,
          updater: (metadata) => {
            // A CAS retry can observe a concurrent writer's effective Goal.
            // Only the final successful updater describes this transition.
            previous = metadata;
            return writeSessionWorkStateV1ToMetadata(
              metadata,
              mutation.op.kind === 'clear' ? null : SessionStateWorkStateValueSchema.parse(mutation.op.value),
            );
          },
        });
        if (previous && hasEffectiveSessionGoalChange(
          readSessionWorkStateV1FromMetadata(previous),
          readSessionWorkStateV1FromMetadata(committed.metadata),
        )) {
          const eventId = buildAgentEventLocalId('goal-changed', [randomUUID()]);
          // The append shares this outbox, so it must not block field delivery.
          // Existing transcript custody owns retry; commit-to-append crash loss
          // is accepted, as at the Session client's metadata publication owner.
          const payload = { role: 'agent', content: { type: 'event', id: eventId, data: { type: 'goal-changed' } } };
          const mode = resolveSessionStoredContentEncryptionMode(rawSession);
          let content: SessionStoredMessageContent;
          if (mode === 'plain') {
            content = sealSessionStoredContent({ mode, ctx: null, payload });
          } else {
            const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, rawSession);
            if (!ctx) throw new AccountEncryptionMaterialUnavailableError();
            content = sealSessionStoredContent({ mode, ctx, payload });
          }
          // The successful metadata write already admitted this Session material.
          // A second HTTP lookup must not lose the original before journal admission.
          void enqueueTranscriptMessage(custody, { sessionId, localId: eventId, messageRole: 'event', content }).catch(error => {
            logger.debug('[Session Follow] Committed daemon Goal notice append unavailable', error);
          });
        }
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

  async function enqueueTranscriptMessage(custody: SessionCustody, input: Readonly<{
    sessionId: string;
    localId: string;
    messageRole: 'user' | 'agent' | 'event';
    content: SessionStoredMessageContent;
    observedAt?: number;
  }>): Promise<Readonly<{ persisted: true; delivered: boolean }>> {
    const result = await custody.outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
      sessionId: input.sessionId,
      localId: input.localId,
      messageRole: input.messageRole,
      content: input.content,
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
      provenance: { kind: 'non_dependent', source: 'background' },
    }));
    if (!result.persisted) throw new Error('daemon_session_mutation_journal_admission_failed');
    return { persisted: true, delivered: result.delivered };
  }

  async function stageTranscriptMessage({ sessionId: rawSessionId, localId: rawLocalId, payload, messageRole, observedAt, usageLimitRecovery }: Readonly<{
    sessionId: string;
    localId: string;
    payload: Readonly<Record<string, unknown>>;
    messageRole: 'user' | 'agent' | 'event';
    observedAt?: number;
    usageLimitRecovery?: SessionUsageLimitRecoveryV1;
  }>): Promise<Readonly<{ persisted: true; delivered: boolean }>> {
      if (closed) throw new Error('daemon_session_mutation_custody_closed');
      const sessionId = rawSessionId.trim();
      const localId = rawLocalId.trim();
      if (!sessionId || !localId) {
        throw new DaemonSessionMutationAdmissionError('session_unavailable');
      }
      const resolved = await (params.resolveSessionTransportContext ?? resolveSessionTransportContext)({ reason: 'session-control',
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
      const content: SessionStoredMessageContent = sealSessionStoredContent({
        ...resolved,
        payload,
      });
      retainedSessionIds.delete(sessionId);
      const custody = resolveSessionCustody(sessionId, resolved.rawSession);
      if (usageLimitRecovery) {
        // The existing field journal owns replay and arrival-time merging. Only the
        // presentation value enters custody, never the daemon's recovery intent.
        await persistUsageLimitRecoveryFieldDurably({
          sessionId,
          currentMetadata: {},
          nextMetadata: { [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: usageLimitRecovery },
          stageUsageLimitRecoveryMutation: (mutation) => custody.outbox.enqueueUsageLimitRecovery(mutation),
        });
      }
      return await enqueueTranscriptMessage(custody, { sessionId, localId, messageRole, content, observedAt });
  }

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
    async stageWorkState({ mutation, rawSession, signal }) {
      if (closed) throw new Error('daemon_session_mutation_custody_closed');
      const sessionId = mutation.sessionId.trim();
      if (!sessionId || rawSession.id !== sessionId) {
        throw new Error('daemon_work_state_session_mismatch');
      }
      retainedSessionIds.delete(sessionId);
      await resolveSessionCustody(sessionId, rawSession).outbox.enqueueWorkState(mutation, { signal });
    },
    stageTranscriptMessage,
    async stageTranscriptEvent({ sessionId, eventId, data, observedAt, usageLimitRecovery }) {
      return await stageTranscriptMessage({
        sessionId,
        localId: eventId,
        messageRole: 'event',
        payload: { role: 'agent', content: { type: 'event', id: eventId.trim(), data } },
        observedAt,
        usageLimitRecovery,
      });
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
            resolved = await (params.resolveSessionTransportContext ?? resolveSessionTransportContext)({ reason: 'session-control',
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
