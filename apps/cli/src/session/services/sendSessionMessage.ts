import { randomUUID } from 'node:crypto';

import {
  parsePermissionIntentAlias,
  resolveMetadataStringOverrideV1,
  resolvePermissionIntentFromSessionMetadata,
  type PermissionIntent,
} from '@happier-dev/agents';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { waitForTranscriptEncryptedMessageByLocalId } from '@/api/session/transcriptMessageLookup';
import type { Credentials } from '@/persistence';
import { detectSessionTurnActivity } from '@/session/query/detectSessionTurnInFlight';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { waitForIdleViaSocket } from '@/session/transport/socket/sessionSocketAgentState';
import { sendSessionMessageViaSocketCommitted } from '@/session/transport/socket/sessionSocketSendMessage';
import { encryptSessionPayload, tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';

export type SendSessionMessageResult =
  | Readonly<{ ok: true; sessionId: string; localId: string; waited: boolean }>
  | Readonly<{
      ok: false;
      code: 'session_not_found' | 'session_id_ambiguous' | 'unsupported' | 'timeout' | 'wait_failed';
      candidates?: string[];
      message?: string;
    }>;

function parsePermissionIntentOrThrow(raw: string): PermissionIntent {
  const parsed = parsePermissionIntentAlias(raw);
  if (!parsed) {
    const err = new Error(`Invalid permission mode: ${raw}`);
    (err as any).code = 'invalid_arguments';
    throw err;
  }
  return parsed;
}

function isFallbackSafeRuntimeRpcError(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error ?? '');
  if (
    errorMessage === 'Method not found'
    || errorMessage === 'RPC method not available'
    || errorMessage === 'Socket connect timeout'
  ) {
    return true;
  }

  return errorMessage.toLowerCase().includes('connect_error');
}

function resolvePermissionIntent(params: Readonly<{
  permissionModeOverride?: string;
  decryptedMetadata: unknown;
}>): PermissionIntent {
  if (params.permissionModeOverride) {
    return parsePermissionIntentOrThrow(params.permissionModeOverride);
  }
  const resolved = resolvePermissionIntentFromSessionMetadata(params.decryptedMetadata);
  return resolved?.intent ?? 'default';
}

function resolveModelId(params: Readonly<{
  modelOverride?: string | null;
  decryptedMetadata: unknown;
}>): string {
  if (params.modelOverride !== undefined) {
    return params.modelOverride ?? 'default';
  }
  const resolved = resolveMetadataStringOverrideV1(params.decryptedMetadata, 'modelOverrideV1', 'modelId');
  return resolved?.value ?? '';
}

export async function sendSessionMessage(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  message: string;
  wait: boolean;
  timeoutMs: number;
  permissionModeOverride?: string;
  modelOverride?: string | null;
}>): Promise<SendSessionMessageResult> {
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
  if (!sessionTarget.ok) {
    return {
      ok: false,
      code: sessionTarget.code,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }

  const localId = randomUUID();
  const decryptedMetadata = tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession: sessionTarget.rawSession,
  });
  const permissionIntent = resolvePermissionIntent({
    permissionModeOverride: params.permissionModeOverride,
    decryptedMetadata,
  });
  const modelId = resolveModelId({
    modelOverride: params.modelOverride,
    decryptedMetadata,
  });

  const record = {
    role: 'user',
    content: { type: 'text', text: params.message },
    meta: {
      sentFrom: 'cli',
      // Important: `source: 'cli'` is reserved for CLI-authored transcript traffic that
      // the running agent runtime should treat as "self-sent" (e.g. local provider echoes).
      // A `happier session send` prompt is user intent and must be delivered to the runtime
      // queue even when it is committed by the daemon via session RPC.
      source: 'ui',
      permissionMode: permissionIntent,
      ...(modelId && modelId !== 'default' ? { model: modelId } : {}),
    },
  } as const;

  const content =
    sessionTarget.mode === 'plain'
      ? ({ t: 'plain', v: record } as const)
      : ({ t: 'encrypted', c: encryptSessionPayload({ ctx: sessionTarget.ctx, payload: record }) } as const);

  const shouldUseRuntimeRpc = sessionTarget.rawSession.active === true;
  if (shouldUseRuntimeRpc) {
    try {
      await callSessionRpc({
        token: params.credentials.token,
        sessionId: sessionTarget.sessionId,
        mode: sessionTarget.mode,
        ctx: sessionTarget.ctx,
        method: `${sessionTarget.sessionId}:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`,
        request: {
          text: params.message,
          localId,
          meta: record.meta,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error ?? '');
      if (errorMessage === 'RPC call timeout') {
        return {
          ok: false,
          code: 'timeout',
          message: errorMessage,
        };
      }
      if (!isFallbackSafeRuntimeRpcError(error)) {
        throw error;
      }

      await sendSessionMessageViaSocketCommitted({
        token: params.credentials.token,
        sessionId: sessionTarget.sessionId,
        content,
        localId,
        sentFrom: 'cli',
        permissionMode: permissionIntent,
      });
    }
  } else {
    await sendSessionMessageViaSocketCommitted({
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      content,
      localId,
      sentFrom: 'cli',
      permissionMode: permissionIntent,
    });
  }

  if (!params.wait) {
    return {
      ok: true,
      sessionId: sessionTarget.sessionId,
      localId,
      waited: false,
    };
  }

  const deadlineMs = Date.now() + params.timeoutMs;
  let waitSessionSnapshot = sessionTarget.rawSession;

  try {
    if (shouldUseRuntimeRpc) {
      const materialized = await waitForTranscriptEncryptedMessageByLocalId({
        token: params.credentials.token,
        sessionId: sessionTarget.sessionId,
        localId,
        maxWaitMs: Math.max(1, deadlineMs - Date.now()),
      });
      if (!materialized) {
        return {
          ok: false,
          code: 'timeout',
        };
      }

      const refreshedSession = await fetchSessionById({
        token: params.credentials.token,
        sessionId: sessionTarget.sessionId,
      });
      if (!refreshedSession) {
        throw new Error('Session not found after send');
      }
      waitSessionSnapshot = refreshedSession;
    }

    const initialTurnActivity = await detectSessionTurnActivity({
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      encryptionMode: sessionTarget.mode,
      encryptionKey: sessionTarget.ctx.encryptionKey,
      encryptionVariant: sessionTarget.ctx.encryptionVariant,
    });

    const agentStateCiphertext =
      typeof waitSessionSnapshot.agentState === 'string' ? String(waitSessionSnapshot.agentState).trim() : null;

    await waitForIdleViaSocket({
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      ctx: sessionTarget.ctx,
      sessionEncryptionMode: sessionTarget.mode,
      timeoutMs: Math.max(1, deadlineMs - Date.now()),
      initialTurnActivity,
      recheckTurnActivity: async () =>
        detectSessionTurnActivity({
          token: params.credentials.token,
          sessionId: sessionTarget.sessionId,
          encryptionMode: sessionTarget.mode,
          encryptionKey: sessionTarget.ctx.encryptionKey,
          encryptionVariant: sessionTarget.ctx.encryptionVariant,
        }),
      initialAgentStateCiphertextBase64:
        agentStateCiphertext && agentStateCiphertext.length > 0 ? agentStateCiphertext : null,
    });
    return {
      ok: true,
      sessionId: sessionTarget.sessionId,
      localId,
      waited: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error ?? '');
    if (errorMessage === 'timeout') {
      return {
        ok: false,
        code: 'timeout',
      };
    }
    return {
      ok: false,
      code: 'wait_failed',
      message: errorMessage || 'Wait for idle failed',
    };
  }
}
