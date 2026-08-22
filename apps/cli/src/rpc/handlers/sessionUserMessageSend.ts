import { randomUUID } from 'node:crypto';

import {
  readPendingLocalId,
  hasRawComposerAttachmentSelectionV1,
  sanitizeSessionUserMessageSendMeta,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
  SessionUserMessageSendRequestSchema,
} from '@happier-dev/protocol';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { deterministicStringify } from '@/utils/deterministicJson';
import { resolveTrustedSessionAttachmentLocalImagePaths } from '../../session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';
import {
  SessionStructuredInputAdmissionError,
  validateSessionStructuredInputIngressV1,
  type SessionStructuredInputAdmissionPolicyV1,
} from '@/session/services/admitSessionStructuredInputV1';
import type { SessionRuntimeControls } from './sessionControls';
import {
  resolveExplicitUserPromptRecoveryDecision,
  type ExplicitUserPromptRecoveryDecision,
} from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryOperationResult';

const MAX_EXACT_USER_MESSAGE_OUTCOMES = 1_000;

function readClosedPluginErrorCode(error: unknown): string | null {
  return isPluginError(error) ? error.code : null;
}

function isPreDurableComposerAttachmentTargetError(error: unknown): boolean {
  const code = readClosedPluginErrorCode(error);
  return code === 'plugin_generation_stale'
    || code === 'composer_attachment_unavailable'
    || code === 'composer_attachment_callback_unavailable'
    || code === 'composer_attachment_not_current'
    || code === 'composer_attachment_timed_out';
}

function hasBlockingExplicitUserRecoveryEvidence(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
    (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
  );
  return parsed.success && (
    parsed.data.status === 'waiting'
    || parsed.data.status === 'armed'
    || parsed.data.status === 'checking'
  );
}

function normalizeUserIntentMessageSendMeta(meta: Record<string, unknown>): Record<string, unknown> {
  return {
    ...meta,
    source: meta.source === 'daemon-initial-prompt' ? 'daemon-initial-prompt' : 'ui',
    sentFrom: typeof meta.sentFrom === 'string' && meta.sentFrom.trim().length > 0 ? meta.sentFrom : 'ui',
  };
}

export function registerSessionUserMessageSendHandler(
  rpc: RpcHandlerRegistrar,
  opts: Readonly<{
    workingDirectory: string;
    sessionId?: string | null;
    getSessionMetadata?: (() => unknown) | null;
    enqueueSessionUserMessage?: ((request: {
      text: string;
      localId: string;
      meta: Record<string, unknown>;
      structuredInputAdmissionPolicy?: SessionStructuredInputAdmissionPolicyV1;
    }) => Promise<void> | void) | null;
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

  const revalidateExplicitUserRecovery = async (localId: string): Promise<ExplicitUserPromptRecoveryDecision> => {
    const checkNow = opts.sessionRuntimeControls?.checkUsageLimitRecoveryNow;
    if (typeof checkNow !== 'function' || typeof opts.sessionId !== 'string' || opts.sessionId.length === 0) {
      return hasBlockingExplicitUserRecoveryEvidence(opts.getSessionMetadata?.())
        ? { status: 'unavailable', errorCode: 'session_user_message_recovery_control_unavailable' }
        : { status: 'ready' };
    }
    try {
      let deadline: ReturnType<typeof setTimeout> | null = null;
      const timeoutResult = new Promise<null>((resolve) => {
        deadline = setTimeout(() => resolve(null), configuration.transcriptRecoveryMaxWaitMs);
        deadline.unref?.();
      });
      const result = await Promise.race([
        Promise.resolve(checkNow({ sessionId: opts.sessionId })),
        timeoutResult,
      ]).finally(() => {
        if (deadline) clearTimeout(deadline);
      });
      if (result === null) {
        return { status: 'unavailable', errorCode: 'session_user_message_recovery_control_unavailable' };
      }
      return resolveExplicitUserPromptRecoveryDecision({
        sessionId: opts.sessionId,
        result,
        hasBlockingRecoveryEvidence: hasBlockingExplicitUserRecoveryEvidence(opts.getSessionMetadata?.()),
      });
    } catch {
      return { status: 'unavailable', errorCode: 'session_user_message_recovery_control_unavailable' };
    }
  };

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, async (raw: unknown) => {
    const rawMeta = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { meta?: unknown }).meta
      : undefined;
    const rawMetaRecord = rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
      ? rawMeta as Record<string, unknown>
      : null;
    try {
      if (rawMetaRecord) {
        validateSessionStructuredInputIngressV1({ meta: rawMetaRecord });
      }
    } catch (error) {
      if (error instanceof SessionStructuredInputAdmissionError) {
        return { ok: false, error: error.code, errorCode: error.code };
      }
      throw error;
    }
    const parsed = SessionUserMessageSendRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'Invalid params', errorCode: 'session_user_message_invalid_input' };
    }

    const incomingMeta = rawMetaRecord ?? parsed.data.meta;
    const allowedLocalImagePaths = await resolveTrustedSessionAttachmentLocalImagePaths({
      cwd: opts.workingDirectory,
      metadata: incomingMeta,
    });
    const selectedComposerAttachment = hasRawComposerAttachmentSelectionV1(incomingMeta);
    const structuredInputAdmissionPolicy = allowedLocalImagePaths.size > 0
      ? { allowedLocalImagePaths }
      : undefined;
    const sanitizedMeta = normalizeUserIntentMessageSendMeta(sanitizeSessionUserMessageSendMeta(incomingMeta, {
      ...(structuredInputAdmissionPolicy ? structuredInputAdmissionPolicy : {}),
      text: parsed.data.text,
    }));
    // Composer selection is still authored input at this boundary. Preserve it for the
    // pre-persistence owner, while ordinary structured input retains the existing
    // sanitization contract before it reaches durable enqueueing.
    const meta = selectedComposerAttachment
      ? normalizeUserIntentMessageSendMeta(incomingMeta)
      : sanitizedMeta;
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
    const enqueueRequest = {
      ...request,
      ...(structuredInputAdmissionPolicy ? { structuredInputAdmissionPolicy } : {}),
    };

    const payloadFingerprint = deterministicStringify(request);
    const existing = exactOutcomesByLocalId.get(localId);
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
      const recoveryDecision = await revalidateExplicitUserRecovery(localId);
      if (recoveryDecision.status !== 'ready') {
        return {
          ok: false,
          status: recoveryDecision.status,
          errorCode: recoveryDecision.errorCode,
          error: recoveryDecision.errorCode,
        };
      }

      // Attachment-bearing input must pass through the shared pre-persistence transformer.
      // A runtime-local handler has no prepared attachment result and would be a bypass.
      const runtimeResult = !selectedComposerAttachment
        && typeof opts.sessionRuntimeControls?.handleUserMessage === 'function'
        ? await opts.sessionRuntimeControls.handleUserMessage({
          ...request,
          meta: sanitizedMeta,
        })
        : null;
      if (runtimeResult?.handled === true) {
        return runtimeResult.result;
      }

      if (typeof opts.enqueueSessionUserMessage !== 'function') {
        return {
          ok: false,
          error: `unsupported_session_runtime_method:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`,
          errorCode: 'unsupported_session_runtime_method',
        };
      }

      try {
        await opts.enqueueSessionUserMessage(enqueueRequest);
        return { ok: true };
      } catch (error) {
        if (error instanceof SessionStructuredInputAdmissionError) {
          return { ok: false, error: error.code, errorCode: error.code };
        }
        throw error;
      }
    };

    if (exactOutcomesByLocalId.size >= MAX_EXACT_USER_MESSAGE_OUTCOMES) {
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
    entry.outcome = deliver().then(
      (result) => {
        entry.terminal = true;
        if (
          result
          && typeof result === 'object'
          && (result as { ok?: unknown }).ok === false
          && typeof (result as { errorCode?: unknown }).errorCode === 'string'
          && (result as { errorCode: string }).errorCode.startsWith('session_structured_input_')
        ) {
          // Preparation/admission failed before persistence. Keep the caller's stable local id
          // available for a corrected retry instead of treating its raw pre-prepare bytes as a
          // committed exact payload fingerprint.
          exactOutcomesByLocalId.delete(localId);
        }
        return result;
      },
      (error) => {
        entry.terminal = true;
        if (
          error instanceof SessionStructuredInputAdmissionError
          || isPreDurableComposerAttachmentTargetError(error)
        ) {
          // Typed admission and currentness/unavailability target rejections surface before
          // durable custody. They do not reserve this local id or its raw pre-prepare bytes.
          exactOutcomesByLocalId.delete(localId);
        }
        throw error;
      },
    );
    exactOutcomesByLocalId.set(localId, entry);
    return await entry.outcome;
  });
}
