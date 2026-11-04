import { isDeepStrictEqual } from 'node:util';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import { DEFAULT_SPAWN_INITIAL_INPUT_ADMISSION_TIMEOUT_MS } from '@happier-dev/protocol/sessions/creation/sessionSpawnBudget';
import { hasSessionInputContentV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAuthoringV1';
import { SessionInputAdmissionRejectionCodeV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmissionRejectionV1';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { sanitizeSessionUserMessageSendMeta } from '@happier-dev/protocol/sessions/userMessageRpc';
import type { SessionSpawnNewInitialInputDispositionV1 } from '@happier-dev/protocol';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { StoredCredentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { resolveExactSessionOrCredentialCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { findPersistedSessionUserMessageAdmission } from '@/api/session/client/transcript/sessionUserMessageAdmissionRejoin';
import { logger } from '@/utils/logger';
import type { CreateSpawnedSessionParams } from './createSpawnedSession';
import { sendSessionMessage } from './sendSessionMessage';
import { resolveSessionUserMessageRequestedAction } from './resolveSessionUserMessageRequestedAction';

export async function submitSpawnInitialInput(params: Readonly<{
  credentials: StoredCredentials;
  serverId?: string;
  sessionId: string;
  targetMachineId?: string;
  initialInput?: CreateSpawnedSessionParams['initialInput'];
  localId: string;
  initialInputHandoff?: ReturnType<NonNullable<CreateSpawnedSessionParams['buildInitialInputHandoff']>>;
  machineAdmissionTransport?: CreateSpawnedSessionParams['machineAdmissionTransport'];
  callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
  resumeInactiveSession?: false;
  rejoinSession?: RawSessionRecord;
  signal?: AbortSignal;
}>): Promise<SessionSpawnNewInitialInputDispositionV1> {
  const text = typeof params.initialInput?.text === 'string' ? params.initialInput.text : '';
  const attachmentCount = (params.initialInput?.attachments?.length ?? 0)
    + (params.initialInput?.structuredInput?.composerAttachments?.length ?? 0);
  if (!hasSessionInputContentV1({ text, attachmentCount })) return { status: 'notRequested' };
  // Session identity is already settled at this call site. A caller that
  // retired before Message admission began has a definite nested rejection,
  // not a reason to recast the committed Session as cancelled.
  if (params.signal?.aborted) {
    return { status: 'rejected', code: 'session_input_cancelled' };
  }
  if (!params.initialInputHandoff) {
    throw Object.assign(new Error('Initial input requires Message-owned admission identity'), {
      code: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST, details: { sessionId: params.sessionId },
    });
  }
  const initialInputHandoff = params.initialInputHandoff;
  const reviewComments = params.initialInput?.reviewComments;
  const messageMeta = reviewComments
    ? {
        ...(initialInputHandoff.meta ?? {}),
        displayText: reviewComments.displayText,
        happier: {
          kind: 'review_comments.v1',
          payload: { sessionId: params.sessionId, comments: reviewComments.comments },
        },
      }
    : initialInputHandoff.meta;
  try {
    // A creation retry observes the already-admitted input. Rebuilding it from
    // the retry's modality would replace its original provenance and defaults.
    if (params.rejoinSession && initialInputHandoff.inputAdmission.request.caller?.kind === 'host') {
      const crypto = resolveExactSessionOrCredentialCryptoContext({ credentials: params.credentials },
        params.sessionId, params.rejoinSession);
      if (!crypto) return { status: 'outcomeUnknown', localId: params.localId, code: 'session_input_rejoin_unavailable' };
      let original: Awaited<ReturnType<typeof findPersistedSessionUserMessageAdmission>>;
      try {
        original = await findPersistedSessionUserMessageAdmission({ token: params.credentials.token,
          sessionId: params.sessionId, localId: params.localId,
          queryContext: crypto.mode === 'plain' ? { encryptionMode: 'plain' }
            : { encryptionMode: 'e2ee', ...crypto.ctx },
        });
      } catch {
        return { status: 'outcomeUnknown', localId: params.localId, code: 'session_input_rejoin_unavailable' };
      }
      if (original) {
        const authoredMeta = sanitizeSessionUserMessageSendMeta(messageMeta ?? {}, { text });
        const authoredPayload = (meta: Record<string, unknown>) => ({
          structuredInput: meta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1] ?? null,
          reviewComments: meta.happier && typeof meta.happier === 'object'
            && 'kind' in meta.happier && meta.happier.kind === 'review_comments.v1' ? meta.happier : null,
          displayText: meta.displayText ?? null,
        });
        if (original.text !== text || !isDeepStrictEqual(authoredPayload(authoredMeta), authoredPayload(original.meta))) {
          return { status: 'rejected', code: 'session_input_idempotency_conflict' };
        }
        return { status: 'alreadyAccepted', localId: params.localId };
      }
    }
    const sent = await sendSessionMessage({
      credentials: params.credentials,
      ...(params.serverId ? { serverId: params.serverId } : {}),
      idOrPrefix: params.sessionId,
      message: text,
      wait: false,
      timeoutMs: DEFAULT_SPAWN_INITIAL_INPUT_ADMISSION_TIMEOUT_MS,
      localId: params.localId,
      inputAdmission: initialInputHandoff.inputAdmission,
      executionAuthority: initialInputHandoff.executionAuthority,
      ...(params.callerInputAuthorization ? { callerInputAuthorization: params.callerInputAuthorization } : {}),
      ...(params.resumeInactiveSession === false ? { resumeInactiveSession: false } : {}),
      ...(params.targetMachineId ? { targetMachineId: params.targetMachineId } : {}),
      ...(messageMeta ? { messageMeta } : {}),
      requestedAction: resolveSessionUserMessageRequestedAction({ deliveryIntent: 'runtime_bootstrap' }),
      ...(params.machineAdmissionTransport
        ? { machineAdmissionTransport: params.machineAdmissionTransport }
        : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    const disposition = sent.admissionResult;
    if (disposition.status === 'rejected' || disposition.status === 'outcomeUnknown') {
      logger.warn('[SESSION SPAWN] Initial input admission did not accept the message', {
        sessionId: params.sessionId,
        localId: params.localId,
        status: disposition.status,
        code: disposition.code,
        ...(!sent.ok && sent.message ? { reason: sent.message } : {}),
      });
    }
    return disposition;
  } catch (error) {
    const parsedCause = SessionInputAdmissionRejectionCodeV1Schema.safeParse(
      error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined,
    );
    const code = parsedCause.success ? parsedCause.data : 'session_input_action_execution_failed';
    logger.warn('[SESSION SPAWN] Initial input admission failed', {
      sessionId: params.sessionId,
      localId: params.localId,
      status: 'outcomeUnknown',
      code,
    });
    return {
      status: 'outcomeUnknown',
      localId: params.localId,
      code,
    };
  }
}
