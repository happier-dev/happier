import type { Credentials } from '@/persistence';
import type { VisibleRunSessionPort } from '@/agent/executionRuns/runtime/visibleRuns/visibleRunSessionPort';
import type { VisibleRunTranscriptMessage } from '@/agent/executionRuns/runtime/visibleRuns/visibleRunRules';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  SessionExecutionRunChildTurnReportV1ResponseSchema,
  type SessionExecutionRunChildTurnReportV1Request,
  type SessionExecutionRunChildTurnReportV1Response,
} from '@happier-dev/protocol';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';

import { createSpawnedSession } from './createSpawnedSession';
import { getSessionTranscript } from './getSessionTranscript';
import { resolveSessionTransportContext } from './resolveSessionTransportContext';
import { sendSessionMessage } from './sendSessionMessage';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The hosting runner's visible-run port over the canonical session services: the role-aware spawn
 * owner, the cross-session CAS metadata writer, the message service, and the transcript reader.
 */
export function createVisibleRunSessionPort(params: Readonly<{
  readCredentials: () => Promise<Credentials | null>;
  /** The hosting session's working directory; created children run in the same path. */
  resolveHostDirectory: () => string;
  /** The hosting session's machine, so creation targets the role-aware daemon method on it. */
  resolveHostMachineId: () => string | null;
}>): VisibleRunSessionPort {
  const requireCredentials = async (): Promise<Credentials> => {
    const credentials = await params.readCredentials();
    if (!credentials) throw Object.assign(new Error('Visible runs require an authenticated runner'), { code: 'not_authenticated' });
    return credentials;
  };

  return {
    createChild: async (child) => {
      const credentials = await requireCredentials();
      const machineId = params.resolveHostMachineId();
      const created = await createSpawnedSession({
        credentials,
        directory: params.resolveHostDirectory(),
        ...(machineId ? { machineId } : {}),
        backendTarget: child.backendTarget,
        permissionMode: child.permissionMode,
        ...(child.modelId ? { modelId: child.modelId } : {}),
        ...(child.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: child.sessionConfigOptionOverrides } : {}),
        ...(child.connectedServices ? { connectedServices: child.connectedServices } : {}),
        ...(child.sessionRoleV1 ? { sessionRoleV1: child.sessionRoleV1 } : {}),
        sessionOriginV1: child.sessionOriginV1,
        executionRunLinkV1: child.executionRunLinkV1,
        // The spawn owner turns this into the pending first input under the same spawn nonce.
        initialMessage: child.firstInputText,
        spawnNonce: child.spawnNonce,
      });
      return { sessionId: created.sessionId };
    },

    readChild: async (sessionId) => {
      const credentials = await requireCredentials();
      const target = await resolveSessionTransportContext({ credentials, idOrPrefix: sessionId });
      if (!target.ok) return null;
      const metadata = record(tryDecryptSessionMetadata({ credentials, rawSession: target.rawSession }));
      const archivedAt = (target.rawSession as { archivedAt?: unknown }).archivedAt;
      return { sessionId: target.sessionId, metadata, archived: archivedAt !== null && archivedAt !== undefined };
    },

    updateChildMetadata: async (sessionId, updater) => {
      const credentials = await requireCredentials();
      const target = await resolveSessionTransportContext({ credentials, idOrPrefix: sessionId });
      if (!target.ok) throw Object.assign(new Error('Linked session not found'), { code: target.code });
      await updateSessionMetadataWithRetry({
        token: credentials.token,
        credentials,
        sessionId: target.sessionId,
        rawSession: target.rawSession,
        updater: (metadata) => updater(metadata as Record<string, unknown>) as typeof metadata,
      });
    },

    sendChildMessage: async (sessionId, message) => {
      const credentials = await requireCredentials();
      const sent = await sendSessionMessage({
        credentials,
        idOrPrefix: sessionId,
        message: message.text,
        wait: false,
        timeoutMs: 0,
        requestedAction: message.requestedAction,
        ...(message.executionRunLinkV1 ? { executionRunLinkV1: message.executionRunLinkV1 } : {}),
      });
      if (!sent.ok) throw Object.assign(new Error('The linked session did not accept the message'), { code: sent.code });
    },

    readTranscript: async (sessionId, stopAt) => {
      const credentials = await requireCredentials();
      const newestFirst: VisibleRunTranscriptMessage[] = [];
      let cursor: string | null = null;
      // Page backward only until the requested message is found (the task message or a completion row).
      for (;;) {
        const page = await getSessionTranscript({
          credentials,
          idOrPrefix: sessionId,
          limit: 100,
          cursor,
          direction: 'before',
          roles: ['user', 'assistant'],
          includeRaw: true,
          maxRawPayloadChars: 32_768,
        });
        if (!page.ok) break;
        let found = false;
        for (const item of [...page.items].reverse()) {
          const raw = record(item.raw);
          const message: VisibleRunTranscriptMessage = {
            seq: typeof item.seq === 'number' ? item.seq : null,
            role: item.role === 'user' ? 'user' : 'assistant',
            text: typeof item.text === 'string' ? item.text : '',
            localId: typeof raw?.localId === 'string' ? raw.localId : null,
            meta: record(raw?.meta),
          };
          newestFirst.push(message);
          if (stopAt(message)) found = true;
        }
        if (found || !page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return newestFirst.reverse();
    },
  };
}

/**
 * Child to parent: the server-relayed session RPC on the parent runner. A parent without the exact
 * method answers with an error that this rejects, so the child's retries end and the parent's
 * handshake window fails the run closed.
 */
export async function reportExecutionRunChildTurnToParent(params: Readonly<{
  credentials: Credentials;
  parentSessionId: string;
  request: SessionExecutionRunChildTurnReportV1Request;
}>): Promise<SessionExecutionRunChildTurnReportV1Response> {
  const target = await resolveSessionTransportContext({ credentials: params.credentials, idOrPrefix: params.parentSessionId });
  if (!target.ok) throw Object.assign(new Error('Parent session not reachable'), { code: target.code });
  const payload = await callSessionRpc({
    token: params.credentials.token,
    sessionId: target.sessionId,
    mode: target.mode,
    ctx: target.ctx,
    method: `${target.sessionId}:${SESSION_RPC_METHODS.SESSION_EXECUTION_RUN_CHILD_TURN_REPORT_V1}`,
    request: params.request,
  });
  const parsed = SessionExecutionRunChildTurnReportV1ResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error('The parent runner did not acknowledge the child turn report');
  return parsed.data;
}
