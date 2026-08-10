import { randomUUID } from 'node:crypto';

import {
  readPendingLocalId,
  sanitizeSessionUserMessageSendMeta,
  SessionUserMessageSendRequestSchema,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { resolveTrustedSessionAttachmentLocalImagePaths } from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';
import { deterministicStringify } from '@/utils/deterministicJson';
import type { SessionRuntimeControls } from './sessionControls';

export type ExplicitUserRecoveryDecision =
  | Readonly<{ status: 'ready' }>
  | Readonly<{
    status: 'waiting' | 'action_required' | 'unavailable';
    errorCode: string;
  }>;

export type SessionUserMessageEnqueueResult = Readonly<{
  providerAcceptancePending?: boolean | undefined;
  recoveryBlocked?: Readonly<{
    status: 'waiting' | 'action_required' | 'unavailable';
    errorCode: string;
  }> | undefined;
}> | void;

export function registerSessionUserMessageSendHandler(
  rpc: RpcHandlerRegistrar,
  opts: Readonly<{
    workingDirectory: string;
    enqueueSessionUserMessage?: ((request: {
      text: string;
      localId: string;
      meta: Record<string, unknown>;
    }) => Promise<SessionUserMessageEnqueueResult> | SessionUserMessageEnqueueResult) | null;
    revalidateExplicitUserRequest?: ((request: {
      localId: string;
    }) => Promise<ExplicitUserRecoveryDecision> | ExplicitUserRecoveryDecision) | null;
    sessionRuntimeControls?: SessionRuntimeControls | null;
  }>,
): void {
  const canHandleUserMessage = typeof opts.sessionRuntimeControls?.handleUserMessage === 'function';
  const canEnqueueUserMessage = typeof opts.enqueueSessionUserMessage === 'function';
  if (!canHandleUserMessage && !canEnqueueUserMessage) return;

  const exactOutcomesByLocalId = new Map<string, {
    payloadFingerprint: string;
    outcome: Promise<unknown>;
    terminal: boolean;
  }>();
  const maxExactOutcomes = 1_000;

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, async (raw: unknown) => {
    const rawMeta = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { meta?: unknown }).meta
      : undefined;
    const parsed = SessionUserMessageSendRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'Invalid params', errorCode: 'session_user_message_invalid_input' };
    }

    const rawMetaRecord = rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
      ? rawMeta as Record<string, unknown>
      : parsed.data.meta;
    const allowedLocalImagePaths = await resolveTrustedSessionAttachmentLocalImagePaths({
      cwd: opts.workingDirectory,
      metadata: rawMetaRecord,
    });
    // `text` composes the range half of the mention contract with admission: a reference
    // whose range does not describe its own token in the submitted text is rejected here.
    const meta = sanitizeSessionUserMessageSendMeta(rawMetaRecord, {
      allowedLocalImagePaths,
      text: parsed.data.text,
    });
    const suppliedLocalId = parsed.data.localId;
    const localId = suppliedLocalId === undefined
      ? randomUUID()
      : readPendingLocalId(suppliedLocalId);
    if (localId === null) {
      return { ok: false, error: 'Invalid params', errorCode: 'session_user_message_invalid_input' };
    }
    const request = {
      text: parsed.data.text,
      localId,
      meta,
    };

    const payloadFingerprint = deterministicStringify(request);
    const existing = exactOutcomesByLocalId.get(request.localId);
    if (existing) {
      if (existing.payloadFingerprint !== payloadFingerprint) {
        return {
          ok: false,
          error: 'session_user_message_id_payload_conflict',
          errorCode: 'session_user_message_id_payload_conflict',
        };
      }
      return await existing.outcome;
    }

    const deliver = async (): Promise<unknown> => {
      if (opts.revalidateExplicitUserRequest) {
        const recoveryDecision = await opts.revalidateExplicitUserRequest({ localId: request.localId });
        if (recoveryDecision.status !== 'ready') {
          return {
            ok: false,
            status: recoveryDecision.status,
            errorCode: recoveryDecision.errorCode,
            error: recoveryDecision.errorCode,
          };
        }
      }

      if (typeof opts.sessionRuntimeControls?.handleUserMessage === 'function') {
        const runtimeResult = await opts.sessionRuntimeControls.handleUserMessage(request);
        const runtimeHandled = runtimeResult && typeof runtimeResult === 'object' && 'handled' in runtimeResult
          ? runtimeResult.handled
          : undefined;
        if (runtimeHandled !== false) {
          if (runtimeResult && typeof runtimeResult === 'object' && runtimeResult.handled === true) {
            return runtimeResult.result;
          }
          return { ok: true };
        }
      }

      if (!canEnqueueUserMessage) {
        return {
          ok: false,
          error: 'No session user-message handler accepted the request',
          errorCode: 'session_user_message_unhandled',
        };
      }

      const enqueueResult = await opts.enqueueSessionUserMessage?.(request);
      if (enqueueResult && typeof enqueueResult === 'object' && enqueueResult.recoveryBlocked) {
        return {
          ok: false,
          status: enqueueResult.recoveryBlocked.status,
          errorCode: enqueueResult.recoveryBlocked.errorCode,
          error: enqueueResult.recoveryBlocked.errorCode,
        };
      }
      return {
        ok: true,
        ...(enqueueResult && typeof enqueueResult === 'object' && enqueueResult.providerAcceptancePending === true
          ? { providerAcceptancePending: true }
          : {}),
      };
    };

    if (exactOutcomesByLocalId.size >= maxExactOutcomes) {
      const evictable = [...exactOutcomesByLocalId].find(([, entry]) => entry.terminal);
      if (!evictable) {
        return {
          ok: false,
          error: 'session_user_message_delivery_registry_unavailable',
          errorCode: 'session_user_message_delivery_registry_unavailable',
        };
      }
      exactOutcomesByLocalId.delete(evictable[0]);
    }
    const entry = {
      payloadFingerprint,
      outcome: Promise.resolve(undefined) as Promise<unknown>,
      terminal: false,
    };
    entry.outcome = deliver().finally(() => {
      entry.terminal = true;
    });
    exactOutcomesByLocalId.set(request.localId, entry);
    return await entry.outcome;
  });
}
