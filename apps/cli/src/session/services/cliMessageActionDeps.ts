import type { CliActionDepsParams } from '../actions/cliActionDeps/types';
import type { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { isScmDiffSummaryRunAction } from '@happier-dev/protocol/actions/actionSpecs';
import { isScmRefineInputPurposeV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { randomUUID } from 'node:crypto';
import { readAgentStartCallerWorkDepthV1, AgentStartSessionCallerV1Schema } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { isPermissionModeGrantedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { SessionBridgeLifecycleHookEventIdV1, ActionExecutorDeps, ActionExecutorContext, ComposerAttachmentInputV1, SessionMessageSendResultV1 } from '@happier-dev/protocol';
import { derivePluginSessionInputLocalIdV1, buildTrustedHostSessionInputAdmissionV1, SessionInputSourceSessionV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1, RawIngressStructuredInputV1Schema, hasRawSessionAttachmentSelectionV1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { readSessionInputForgeEvidenceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { SessionPendingMessageComposerAdmissionPrepareResponseV1Schema } from '@happier-dev/protocol/sessions/userMessageRpc';
import { buildUploadedAttachment } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import type { projectSessionAttachmentInputV1 } from '@/session/attachments/projectRawIngressSessionAttachmentsV1';
import type { parsePermissionIntentAlias } from '@happier-dev/agents';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { hasStoredSessionCredentialProvenance } from '@/persistence';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import type { admitPluginSessionInputAttachmentsV1, buildPluginSessionInputAttachmentDraftsV1 } from '@/session/composer/admitPluginSessionInputAttachmentsV1';
import type { notifyComposerAttachmentsAfterMessageAccepted } from '@/session/composer/notifyComposerAttachmentsAfterMessageAccepted';
import type { sendSessionMessage, waitForSessionInputResult, SendSessionMessageResult } from '@/session/services/sendSessionMessage';
import type { mutateSessionMessageReplyObservation } from '@/session/services/sessionMessageReply';
import { SessionMessageReplyObservationRequestV1Schema, SessionMessageReplyMutationResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { resolveSessionMessageAdmissionTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import type { findPersistedSessionUserMessageAdmission } from '@/api/session/client/transcript/sessionUserMessageAdmissionRejoin';
import type { validateComposerAttachmentRejoinCorrespondenceV1 } from '@/session/services/admitSessionStructuredInputV1';
import type { buildCausalSessionInputAdmissionV1, buildPluginSessionInputAdmissionV1, resolveSessionInputTargetMachineId, resolveProtectedSessionInputActionTarget } from '@/session/services/sessionInputAdmissionIdentity';
import type { getExecutionRun } from '@/session/services/executionRuns';
import type { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
type ResolvedSessionTransport = Extract<Awaited<ReturnType<typeof resolveSessionTransportContext>>, Readonly<{ ok: true }>>;
type LifecycleHookSessionContext = Readonly<{
    machineId?: string;
    cwd?: string;
    workspaceId?: string;
  }>;
type MessageActionDeps = Required<Pick<ActionExecutorDeps, 'sessionSendMessage'>> & Pick<ActionExecutorDeps, 'sessionMessageReply'>;


/**
 * Projects the low-level send wrapper onto the one public Action result.
 * Admission evidence is authoritative even when acknowledgement or waiting
 * failed after a durable effect. A successful unprotected send predates the
 * admission envelope, so its resolved local id is projected as accepted.
 */
function projectSessionMessageSendActionResult(
  result: SendSessionMessageResult,
): SessionMessageSendResultV1 | null {
  if (!result.ok && result.settlementResult) return result.settlementResult;
  if (result.admissionResult) return result.admissionResult;
  if (result.ok) return { status: 'accepted', localId: result.localId };
  return null;
}
export function createCliMessageActionDeps(
  params: CliActionDepsParams,
  { assertProjectRequesterCurrent, callSessionActionRpc, callSessionRpcForTransport, dispatchSessionLifecycleHookEvent, projectAccountAdmission, readServerFeaturesSnapshot, resolveServerRequestHeaders, resolveTransportForSession, withProjectHome }: Readonly<{
    assertProjectRequesterCurrent: (context?: ActionExecutorContext) => Promise<void>;
    callSessionActionRpc: (transport: ResolvedSessionTransport, method: string, input: unknown, context: ActionExecutorContext) => Promise<unknown>;
    callSessionRpcForTransport: (transport: ResolvedSessionTransport, methodSuffix: string, request: unknown, signal?: AbortSignal, timeoutMs?: number | null) => Promise<unknown>;
    dispatchSessionLifecycleHookEvent: (event: Readonly<{
    eventId: SessionBridgeLifecycleHookEventIdV1;
    happySessionId: string;
    backendTarget?: string;
    exactSessionContext?: LifecycleHookSessionContext;
    payload: Record<string, unknown>;
  }>) => Promise<void>;
    projectAccountAdmission: (serverId?: string, context?: ActionExecutorContext) => Promise<Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }> | null>;
    readServerFeaturesSnapshot: () => Promise<CliServerFeaturesSnapshot | undefined>;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    resolveTransportForSession: (idOrPrefix: string, signal?: AbortSignal, caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>, expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']) => Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>>;
    withProjectHome: <T>(operation: () => Promise<T>) => Promise<T>;
  }>,
): MessageActionDeps {
  return {
    sessionSendMessage: async ({
      callerInputConstraints,
      context,
      sessionId,
      message,
      recipient,
      displayText,
      messageMeta,
      requestedAction,
      actionCaller,
      idempotencyKey,
      localId,
      source,
      attachments,
      reply,
      returnToSessionId,
      wait,
      timeoutSeconds,
      permissionModeOverride,
      modelOverride,
      providerConnectionId,
      sessionInputSource,
      callerSurface,
      serverId,
      signal,
    }) => {
      const pluginCaller = actionCaller?.kind === 'plugin' ? actionCaller : null;
      if (callerInputConstraints && typeof permissionModeOverride === 'string' && permissionModeOverride.trim()) {
        const { parsePermissionIntentAlias } = await import("@happier-dev/agents");
        const requestedMode = parsePermissionIntentAlias(permissionModeOverride.trim());
        if (!requestedMode || !isPermissionModeGrantedV1(callerInputConstraints, requestedMode)) {
          return { status: 'rejected' as const, code: 'session_input_invalid' as const };
        }
      }
      if (pluginCaller && typeof permissionModeOverride === 'string' && permissionModeOverride.trim().length > 0) {
        return {
          status: 'rejected' as const,
          code: 'session_input_invalid' as const,
        };
      }
      if (!params.credentials) {
        return pluginCaller
          ? { status: 'rejected' as const, code: 'session_input_unauthorized' as const }
          : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }

      const normalizedWait = reply === undefined && wait === true;
      const normalizedTimeoutSeconds =
        typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
          ? timeoutSeconds
          : 300;
      const normalizedPermissionModeOverride = typeof permissionModeOverride === 'string' && permissionModeOverride.trim().length > 0
        ? permissionModeOverride.trim()
        : undefined;
      const normalizedProviderConnectionId = providerConnectionId === null
        ? null
        : providerConnectionId === undefined
          ? undefined
          : ProviderConnectionIdSchema.parse(providerConnectionId);
      const normalizedModelOverride = modelOverride === null
        ? null
        : typeof modelOverride === 'string' && modelOverride.trim().length > 0
          ? modelOverride.trim()
          : undefined;
      if (normalizedProviderConnectionId !== undefined
        && normalizedProviderConnectionId !== null
        && (normalizedModelOverride === undefined || normalizedModelOverride === null)) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const modelSelectionInput = normalizedModelOverride === undefined
        ? undefined
        : {
            ...(normalizedProviderConnectionId !== undefined
              ? { providerConnectionId: normalizedProviderConnectionId }
              : {}),
            modelId: normalizedModelOverride,
          };

      const externalActionRequest = context?.externalActionCredential !== undefined
        || context?.externalActionExecutionAuthorization !== undefined;
      const signedRootActionId = context?.externalActionExecutionAuthorization?.binding.actionId;
      const preparationActionId = signedRootActionId && isScmDiffSummaryRunAction(signedRootActionId)
        ? signedRootActionId : 'session.message.send';
      // Home minted a Machine placement for opaque input. The canonical target
      // resolver has now selected this receiver; sign its exact Session reads
      // under the same root so Home can enforce Session/Machine access. SCM
      // preparation retains its admitted Machine root, not the child send's target.
      const messageContext = context?.externalActionExecutionAuthorization
        && preparationActionId === 'session.message.send'
        ? { ...context, externalActionTarget: { kind: 'session' as const, sessionId } }
        : context;
      const resolveAuthorizationHeaders = externalActionRequest
        ? (request: Readonly<{ method: string; path: string; body?: unknown }>) =>
            resolveServerRequestHeaders(messageContext, preparationActionId, request)
        : undefined;
      if (resolveAuthorizationHeaders && !resolveAuthorizationHeaders({
          method: 'GET',
          path: '/v1/account/encryption/currentness',
        })) {
        return {
          status: 'rejected' as const,
          code: 'session_input_unauthorized' as const,
        };
      }

      if (
        pluginCaller
        && (
          typeof pluginCaller.contributionLocalId !== 'string'
          || typeof idempotencyKey !== 'string'
        )
      ) {
        return {
          status: 'rejected' as const,
          code: 'session_input_untrusted_assertion' as const,
        };
      }
      const pluginLocalId = pluginCaller
        ? derivePluginSessionInputLocalIdV1({
            caller: pluginCaller,
            sessionId,
            idempotencyKey: idempotencyKey!,
          })
        : undefined;
      const [{ buildPluginSessionInputAdmissionV1, buildCausalSessionInputAdmissionV1 }, { sendSessionMessage }, { isOriginalSessionInputExternalActionCustody }, { resolveSessionMessageAdmissionTimeoutMs }, { hasStoredSessionCredentialProvenance }] = await Promise.all([import("@/session/services/sessionInputAdmissionIdentity"), import("@/session/services/sendSessionMessage"), import("@/daemon/sessionEncryption/requesterAccountActionProjection"), import("@/session/transport/shared/sessionTimeouts"), import("@/persistence")]);
      const pluginInputAdmission = pluginCaller
        ? buildPluginSessionInputAdmissionV1({
            caller: pluginCaller,
            surface: callerSurface,
            ...(source ? { source } : {}),
            ...(context?.actionRequestAttributionV1 ? { actionRequestAttributionV1: context.actionRequestAttributionV1 } : {}),
          })
        : undefined;
      const admittedCaller = sessionInputSource && actionCaller?.kind === 'session'
        ? AgentStartSessionCallerV1Schema.safeParse(actionCaller) : null;
      if (admittedCaller && (!admittedCaller.success || admittedCaller.data.sessionId !== sessionInputSource?.sourceSessionId)) {
        return { status: 'rejected' as const, code: 'session_input_untrusted_assertion' as const };
      }
      const turnDepth = sessionInputSource ? params.getCurrentTurnWorkDepth?.(sessionInputSource.sourceTurnId) : undefined;
      // Credentialed daemon execution has an exact-turn reader but no bound
      // Session starter-depth getter. Agent admission consumes this same caller.
      const starterDepth = sessionInputSource
        ? params.getCurrentSessionWorkDepth ? params.getCurrentSessionWorkDepth()
          : admittedCaller?.success ? admittedCaller.data.starterDepth : undefined
        : undefined;
      if (sessionInputSource && (turnDepth === undefined || starterDepth === undefined)) {
        return { status: 'rejected' as const, code: 'session_input_untrusted_assertion' as const };
      }
      // A user turn resets turn depth to zero, but cannot reset the Session or
      // background Run's immutable starter depth when it sends to another Session.
      const callerDepth = sessionInputSource && turnDepth !== undefined && starterDepth !== undefined
        ? readAgentStartCallerWorkDepthV1({ kind: 'session', sessionId: sessionInputSource.sourceSessionId, starterDepth, turnDepth })
        : undefined;
      const causalSessionInputAdmission = sessionInputSource && callerDepth !== undefined
        ? buildCausalSessionInputAdmissionV1({ ...sessionInputSource, callerDepth,
            ...(context?.actionRequestAttributionV1 ? { actionRequestAttributionV1: context.actionRequestAttributionV1 } : {}) })
        : undefined;
      if (returnToSessionId !== undefined && (reply !== 'return' || context?.authority !== 'present_user'
        || actionCaller && actionCaller.kind !== 'host' || sessionInputSource
        || callerSurface !== 'ui' && callerSurface !== 'voice' && callerSurface !== 'cli')) {
        return { status: 'rejected' as const, code: 'session_input_untrusted_assertion' as const };
      }
      const humanOrigin = returnToSessionId === undefined ? undefined : { sessionId: returnToSessionId };
      const canonicalReplyIntent = reply === 'wait' || reply === 'return'
        ? { mode: reply, ...(humanOrigin ? { humanOrigin } : {}) } : undefined;
      if (reply === 'return' && !causalSessionInputAdmission && !humanOrigin) {
        return { status: 'rejected' as const, code: 'session_input_untrusted_assertion' as const };
      }
      const needsSourceReplyRpc = (reply === 'wait' || reply === 'return') && sessionInputSource !== undefined
        && params.sessionMessageReplyPublisher?.sessionId !== sessionInputSource.sourceSessionId;
      if (needsSourceReplyRpc && (!params.sessionActionRpcTransport || !context)) {
        return { ok: false, errorCode: 'session_reply_source_unavailable', error: 'session_reply_source_unavailable' };
      }
      const sourceReplyTransport = needsSourceReplyRpc && sessionInputSource
        ? await resolveTransportForSession(sessionInputSource.sourceSessionId, signal) : null;
      if (sourceReplyTransport && !sourceReplyTransport.ok) {
        return { ok: false, errorCode: 'session_reply_source_unavailable', error: 'session_reply_source_unavailable' };
      }

      const authoredMessageText = String(message ?? '');

      // Declared attachments reach the canonical structured-input admission
      // owner before the Session writer, exactly as a Composer-authored draft
      // does. A retry first consults the durable Pending/transcript owner: the
      // plugin preparation callback is not an idempotent boundary and must not
      // run again after an outcome-unknown write.
      let admittedAttachmentMeta: Record<string, unknown> | undefined;
      let admittedComposerAttachments: readonly ComposerAttachmentInputV1[] = [];
      let admittedMessageText = authoredMessageText;
      let rejoinedMessageMeta: Record<string, unknown> | undefined;
      const composerAttachmentRegistry = params.resolveComposerAttachmentSendPreparation?.() ?? null;
      if (attachments && attachments.length > 0) {
        if (!pluginCaller || !pluginLocalId) {
          return {
            status: 'rejected' as const,
            code: 'session_input_untrusted_assertion' as const,
          };
        }
        const transport = await resolveTransportForSession(sessionId, signal, undefined, context?.expectedSessionAddress);
        if (!transport.ok) {
          return {
            status: 'rejected' as const,
            code: 'session_input_target_unavailable' as const,
          };
        }
        const { buildPluginSessionInputAttachmentDraftsV1 } = await import("@/session/composer/admitPluginSessionInputAttachmentsV1");
        let rawAttachmentMeta: Record<string, unknown>;
        try {
          rawAttachmentMeta = {
            [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
              v: 1 as const,
              composerAttachments: buildPluginSessionInputAttachmentDraftsV1({
                caller: pluginCaller,
                attachments: composerAttachmentRegistry,
                messageLocalId: pluginLocalId,
                authored: attachments,
              }),
            },
          };
        } catch {
          return { status: 'rejected' as const,
            code: composerAttachmentRegistry ? 'session_input_invalid' as const : 'session_input_target_unavailable' as const };
        }
        let persisted: Awaited<ReturnType<typeof findPersistedSessionUserMessageAdmission>>;
        try {
          const { findPersistedSessionUserMessageAdmission } = await import("@/api/session/client/transcript/sessionUserMessageAdmissionRejoin");
          persisted = await findPersistedSessionUserMessageAdmission({
            token: params.credentials.token,
            sessionId: transport.sessionId,
            localId: pluginLocalId,
            queryContext: transport.mode === 'plain'
              ? { encryptionMode: 'plain' }
              : {
                  encryptionMode: 'e2ee',
                  encryptionKey: transport.ctx.encryptionKey,
                  encryptionVariant: transport.ctx.encryptionVariant,
                },
          });
        } catch {
          return {
            status: 'outcomeUnknown' as const,
            localId: pluginLocalId,
            code: 'session_input_rejoin_unavailable',
          };
        }
        if (persisted) {
          try {
            const { validateComposerAttachmentRejoinCorrespondenceV1 } = await import("@/session/services/admitSessionStructuredInputV1");
            validateComposerAttachmentRejoinCorrespondenceV1({
              meta: rawAttachmentMeta,
              preparedComposerAttachments: persisted.composerAttachments,
            });
          } catch {
            return {
              status: 'rejected' as const,
              code: 'session_input_idempotency_conflict' as const,
            };
          }
          admittedMessageText = persisted.text;
          rejoinedMessageMeta = persisted.meta;
          admittedComposerAttachments = persisted.composerAttachments;
        } else {
          const { admitPluginSessionInputAttachmentsV1 } = await import("@/session/composer/admitPluginSessionInputAttachmentsV1");
          const attachmentAdmission = await admitPluginSessionInputAttachmentsV1({
            attachments: composerAttachmentRegistry,
            caller: pluginCaller,
            sessionId: transport.sessionId,
            messageLocalId: pluginLocalId,
            text: authoredMessageText,
            authored: attachments,
            ...(signal ? { signal } : {}),
          });
          if (attachmentAdmission.status === 'rejected') {
            return { status: 'rejected' as const, code: attachmentAdmission.code };
          }
          admittedAttachmentMeta = attachmentAdmission.meta;
          admittedComposerAttachments = attachmentAdmission.attachments;
        }
      }

      if (hasRawSessionAttachmentSelectionV1(messageMeta)) {
        const ingress = RawIngressStructuredInputV1Schema.safeParse(messageMeta?.[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]);
        const preparationLocalId = pluginLocalId ?? (localId === undefined ? randomUUID() : readPendingLocalId(localId));
        if (!ingress.success || !preparationLocalId) {
          return { status: 'rejected' as const, code: 'session_input_invalid' as const };
        }
        localId = preparationLocalId;
        const transport = await resolveTransportForSession(sessionId, signal, undefined, context?.expectedSessionAddress);
        if (!transport.ok) return { status: 'rejected' as const, code: 'session_input_target_unavailable' as const };
        const legacyMeta = { [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1 as const, sessionAttachments: ingress.data.sessionAttachments,
        } };
        const rawResponse = await callSessionRpcForTransport(transport,
          SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1,
          { localId: preparationLocalId, text: authoredMessageText,
            structuredInput: legacyMeta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1] }, signal, null);
        const response = SessionPendingMessageComposerAdmissionPrepareResponseV1Schema.safeParse(rawResponse);
        if (rawResponse && typeof rawResponse === 'object' && 'ok' in rawResponse && rawResponse.ok === false) {
          const errorCode = response.success && !response.data.ok
            && response.data.errorCode === 'session_attachment_upload_checkpoint_stale'
            ? response.data.errorCode : readRpcErrorCode(rawResponse) ?? 'session_rpc_failed';
          return { ok: false, errorCode, error: errorCode };
        }
        const unsupported = { ok: false as const, errorCode: 'session_input_target_update_required', error: 'session_input_target_update_required' };
        if (!response.success || !response.data.ok || !response.data.sessionAttachmentMetadata) return unsupported;
        const descriptors = response.data.sessionAttachmentMetadata.envelope.payload.attachments;
        if (descriptors.some(descriptor => !descriptor.sha256)) return unsupported;
        try {
          const { validateComposerAttachmentRejoinCorrespondenceV1 } = await import("@/session/services/admitSessionStructuredInputV1");
          validateComposerAttachmentRejoinCorrespondenceV1({ meta: legacyMeta,
            preparedComposerAttachments: [], preparedSessionAttachments: descriptors });
        } catch { return unsupported; }
        const { projectSessionAttachmentInputV1 } = await import("@/session/attachments/projectRawIngressSessionAttachmentsV1");
        const projected = projectSessionAttachmentInputV1({ text: authoredMessageText,
          meta: { ...(messageMeta ?? {}), ...(admittedAttachmentMeta ?? {}) },
          uploaded: descriptors.map(descriptor => buildUploadedAttachment(descriptor)) });
        if (projected.text !== response.data.text) return unsupported;
        admittedAttachmentMeta = projected.meta;
        admittedMessageText = projected.text;
      }

      const dispatchMessageHook = async (canonicalSessionId: string, source: 'plugin' | 'user') => {
        try {
          await dispatchSessionLifecycleHookEvent({
            eventId: 'session.message.send',
            happySessionId: canonicalSessionId,
            payload: {
              sessionId: canonicalSessionId,
              text: admittedMessageText,
              source,
            },
          });
        } catch {
          // Hook dispatch is best-effort so a misbehaving plugin cannot break message send.
        }
      };

      // Both admissions resolve the Session again inside the send service, so
      // the exact Home's feature snapshot this dependency is already bound to
      // must travel with them; without it that second resolution decides
      // `sharing.session` for a Home it never observed.
      const sendServerFeaturesSnapshot = await readServerFeaturesSnapshot();
      const sendModelSelection = {
        ...(sendServerFeaturesSnapshot ? { serverFeaturesSnapshot: sendServerFeaturesSnapshot } : {}),
        ...(modelSelectionInput ? { modelSelectionInput } : {}),
      } as const;
      const explicitForgeEvidence = readSessionInputForgeEvidenceV1(messageMeta);
      const sendMessageMeta = messageMeta || admittedAttachmentMeta || displayText ? {
        ...(messageMeta ?? {}),
        ...(admittedAttachmentMeta ?? {}),
        ...(displayText ? { displayText } : {}),
        // Explicit authored evidence already crossed the canonical Action
        // schema. Preserve it while prepared structured input keeps precedence.
        ...(explicitForgeEvidence ? { forgeEvidence: explicitForgeEvidence } : {}),
      } : undefined;

      const protectedInputAdmission = pluginInputAdmission ?? causalSessionInputAdmission;
      const replyCredentials = params.credentials;
      const settleCanonicalReply = async (sent: Extract<SendSessionMessageResult, { ok: true }>, admission: SessionMessageSendResultV1) => {
        if ((reply !== 'wait' && reply !== 'return') || (admission.status !== 'accepted' && admission.status !== 'alreadyAccepted')) return admission;
        const address = { credentials: replyCredentials, sessionId: sent.sessionId, localId: admission.localId,
          ...(resolveAuthorizationHeaders ? { resolveAuthorizationHeaders } : {}),
          ...(sessionInputSource && params.sessionMessageReplyPublisher ? { sourceSession: params.sessionMessageReplyPublisher } : {}) };
        const observe = async (operation: 'inline' | 'release', observationSignal?: AbortSignal) => {
          if (sourceReplyTransport?.ok && context) {
            // Ending a tool's wait releases observation without cancelling the
            // accepted ask. The transport and Session lifetime own that release.
            const { signal: _observerSignal, ...sourceContext } = context;
            const input = SessionMessageReplyObservationRequestV1Schema.parse({
              requestSessionId: sent.sessionId, requestLocalId: admission.localId, operation,
            });
            return SessionMessageReplyMutationResultV1Schema.parse(await callSessionActionRpc(sourceReplyTransport,
              SESSION_RPC_METHODS.SESSION_MESSAGE_REPLY_OBSERVE_V1, input,
              { ...sourceContext, ...(observationSignal ? { signal: observationSignal } : {}) }));
          }
          const { mutateSessionMessageReplyObservation } = await import("@/session/services/sessionMessageReply");
          return mutateSessionMessageReplyObservation({ ...address, operation, ...(observationSignal ? { signal: observationSignal } : {}) });
        };
        const release = async () => {
          try { await observe('release'); }
          catch { /* Accepted execution and original progress survive an unavailable observer. */ }
        };
        if (reply === 'return') {
          try {
            const released = await observe('release');
            if (released.ok) return admission;
          } catch { /* The original admitted work is retained for a safe observation retry. */ }
          return { ok: false as const, errorCode: 'session_reply_return_unavailable', error: 'session_reply_return_unavailable',
            details: { admission } };
        }
        try {
          const { waitForSessionInputResult } = await import("@/session/services/sendSessionMessage");
          const observed = await waitForSessionInputResult({ credentials: replyCredentials,
            idOrPrefix: sent.sessionId, localId: admission.localId, observeReply: true,
            ...((serverId ?? params.serverId) ? { serverId: serverId ?? params.serverId } : {}),
            ...(resolveAuthorizationHeaders ? { resolveAuthorizationHeaders } : {}),
            observation: timeoutSeconds === undefined ? { kind: 'no_deadline' }
              : { kind: 'after_input', timeoutMs: timeoutSeconds * 1000 },
            ...(sendServerFeaturesSnapshot ? { serverFeaturesSnapshot: sendServerFeaturesSnapshot } : {}),
            ...(signal ? { signal } : {}),
          });
          if (!observed.ok) { await release(); return admission; }
          const result = observed.result;
          const saved = observed.replyOutcome;
          const outcome = result.kind === 'final_text' && result.messageRef
            && saved?.kind === 'answer' && 'result' in saved
            && saved.result.sessionId === result.messageRef.session.sessionId
            && saved.result.messageId === result.messageRef.messageId
            ? { kind: 'answer' as const, text: result.text, messageRef: result.messageRef }
            : result.kind === 'cancelled' && result.partialText !== undefined && result.messageRef
              && saved?.kind === 'cancelled' && 'result' in saved
              && saved.result.sessionId === result.messageRef.session.sessionId && saved.result.messageId === result.messageRef.messageId
              ? { kind: 'cancelled' as const, partialText: result.partialText, messageRef: result.messageRef }
            : result.kind === 'fulfilled' && !('result' in result.outcome)
              ? result.outcome : null;
          if (!outcome) { await release(); return admission; }
          const consumed = await observe('inline', signal);
          if (!consumed.ok) { await release(); return admission; }
          return { status: 'replied', localId: admission.localId, outcome,
            ...(observed.inputMessageRef ? { inputMessageRef: observed.inputMessageRef } : {}) };
        } catch {
          await release();
          return admission;
        }
      };
      // Local authority stays bound to its own Session. Standalone/other-Session
      // callers spend their admitted original requester's read custody instead.
      const invokeBoundSessionRpc = params.invokeBoundSessionRpc;
      const { readRequesterAccountActionContext } = await import('@/daemon/sessionEncryption/requesterAccountActionContext');
      const requester = readRequesterAccountActionContext(context?.externalActionExecutionAuthorization);
      const readExecutionRun: Parameters<typeof sendSessionMessage>[0]['readExecutionRun'] = invokeBoundSessionRpc && sessionId === params.sessionId
        ? async (request: Readonly<{ sessionId: string; runId: string; signal?: AbortSignal }>) => (
            request.sessionId === params.sessionId
              ? invokeBoundSessionRpc(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: request.runId }, request.signal)
              : { ok: false, errorCode: 'execution_run_scope_mismatch' }
          )
        : requester ? async request => {
            if (request.sessionId !== sessionId) return { ok: false, errorCode: 'execution_run_scope_mismatch' };
            if (!await requester.isCurrent()) return { ok: false, errorCode: 'not_authenticated' };
            const { getExecutionRun } = await import('@/session/services/executionRuns');
            const result = await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, () => getExecutionRun({
              ...request.crypto,
              token: requester.credentials.token,
              sessionId: request.sessionId,
              request: { runId: request.runId },
              ...(context?.authority === 'account_automation' ? { authorityCeiling: 'account_automation' as const } : {}),
              ...(request.signal ? { signal: request.signal } : {}),
            }));
            if (!await requester.isCurrent()) return { ok: false, errorCode: 'not_authenticated' };
            return result.ok ? result.data : { ok: false, errorCode: result.code };
          } : undefined;
      if (protectedInputAdmission) {
        const [{ sendSessionMessage }, { resolveSessionMessageAdmissionTimeoutMs }] = await Promise.all([import("@/session/services/sendSessionMessage"), import("@/session/transport/shared/sessionTimeouts")]);
        const protectedResult = await sendSessionMessage({
          ...(readExecutionRun ? { readExecutionRun } : {}),
          ...(context?.authority ? { executionAuthority: context.authority } : {}),
          ...(context?.externalActionExecutionAuthorization ? { callerInputAuthorization: context.externalActionExecutionAuthorization } : {}),
          credentials: params.credentials,
          idOrPrefix: sessionId,
          serverId: context?.serverId ?? params.serverId ?? configuration.activeServerId,
          ...(context?.expectedSessionAddress ? { expectedSessionAddress: context.expectedSessionAddress } : {}),
          message: admittedMessageText,
          ...(recipient ? { recipient } : {}),
          requestedAction,
          wait: normalizedWait,
          timeoutMs: reply === undefined ? normalizedTimeoutSeconds * 1000 : resolveSessionMessageAdmissionTimeoutMs(),
          ...(canonicalReplyIntent ? { replyIntent: canonicalReplyIntent } : {}),
          ...(pluginLocalId
            ? { localId: pluginLocalId }
            : typeof localId === 'string' && localId.trim().length > 0
              ? { localId }
              : {}),
          inputAdmission: protectedInputAdmission,
          ...(rejoinedMessageMeta
            ? { messageMeta: rejoinedMessageMeta }
            : sendMessageMeta
            ? { messageMeta: sendMessageMeta }
            : {}),
          ...(params.machineAdmissionTransport
            ? { machineAdmissionTransport: params.machineAdmissionTransport }
            : {}),
          ...(resolveAuthorizationHeaders ? { resolveAuthorizationHeaders } : {}),
          ...(params.machineActionDirectTargetTransport
            ? { machineResumeTransport: params.machineActionDirectTargetTransport.invoke }
            : {}),
          ...sendModelSelection,
          ...(signal ? { signal } : {}),
        });
        if (!protectedResult.ok && protectedResult.code === 'machine_admission_transport_unavailable') {
          return {
            ok: false,
            errorCode: protectedResult.code,
            error: protectedResult.message ?? protectedResult.code,
          };
        }
        const admissionResult = projectSessionMessageSendActionResult(protectedResult);
        if (!admissionResult) {
          return { status: 'rejected' as const, code: 'session_input_target_unavailable' as const };
        }
        if (!protectedResult.ok || protectedResult.suppressed) return admissionResult;
        const canonicalSessionId = typeof protectedResult.sessionId === 'string'
          && protectedResult.sessionId.trim().length > 0
          ? protectedResult.sessionId
          : sessionId;
        if (
          composerAttachmentRegistry
          && (admissionResult.status === 'accepted' || admissionResult.status === 'alreadyAccepted')
        ) {
          const { notifyComposerAttachmentsAfterMessageAccepted } = await import("@/session/composer/notifyComposerAttachmentsAfterMessageAccepted");
          notifyComposerAttachmentsAfterMessageAccepted({
            sessionId: canonicalSessionId,
            localId: admissionResult.localId,
            attachments: admittedComposerAttachments,
            notify: ({ attachment, event, signal: notificationSignal }) => (
              composerAttachmentRegistry.afterMessageAccepted({
                attachment,
                event,
                signal: notificationSignal,
              })
            ),
            signal: signal ?? new AbortController().signal,
          });
        }
        await dispatchMessageHook(canonicalSessionId, pluginCaller ? 'plugin' : 'user');
        return settleCanonicalReply(protectedResult, admissionResult);
      }

      const executionRunLocalId = recipient?.kind === 'execution_run'
        ? (typeof localId === 'string' && localId.trim().length > 0 ? localId : randomUUID())
        : undefined;
      const result = await sendSessionMessage({
        ...(readExecutionRun ? { readExecutionRun } : {}),
        ...(context?.authority ? { executionAuthority: context.authority } : {}),
        ...(context?.externalActionExecutionAuthorization ? { callerInputAuthorization: context.externalActionExecutionAuthorization } : {}),
        credentials: params.credentials,
        idOrPrefix: sessionId,
        serverId: context?.serverId ?? params.serverId ?? configuration.activeServerId,
        ...(context?.expectedSessionAddress ? { expectedSessionAddress: context.expectedSessionAddress } : {}),
        message: admittedMessageText,
        ...(recipient ? { recipient } : {}),
        ...(sendMessageMeta ? { messageMeta: sendMessageMeta } : {}),
        requestedAction,
        // Original Session input and the shared root-bounded Refine child are
        // protected host producers regardless of their original surface.
        // Session/plugin callers retain their causal proofs above.
        ...((reply !== undefined || callerSurface === 'cli' || context?.externalActionExecutionAuthorization
          && (isOriginalSessionInputExternalActionCustody(context.externalActionExecutionAuthorization.binding)
            || isScmRefineInputPurposeV1({ authorization: context.externalActionExecutionAuthorization,
              effectActionId: 'session.message.send', sessionId, localId, requestedAction, recipient,
              machineId: context.defaultSessionMachineId
                ?? (context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget.machineId : undefined) })))
          && (!actionCaller || actionCaller.kind === 'host')
          ? { inputAdmission: buildTrustedHostSessionInputAdmissionV1(callerSurface) }
          : {}),
        wait: normalizedWait,
        timeoutMs: reply === undefined ? normalizedTimeoutSeconds * 1000 : resolveSessionMessageAdmissionTimeoutMs(),
        ...(canonicalReplyIntent ? { replyIntent: canonicalReplyIntent } : {}),
        ...(context?.authority ? { executionAuthority: context.authority } : {}),
        // A caller-retained localId makes an ambiguous send retryable: the
        // durable pending queue is keyed by it, so resubmitting rejoins the
        // existing input instead of enqueuing a second message.
        ...(executionRunLocalId
          ? { localId: executionRunLocalId }
          : typeof localId === 'string' && localId.trim().length > 0
            ? { localId }
            : {}),
        ...(normalizedPermissionModeOverride ? { permissionModeOverride: normalizedPermissionModeOverride } : {}),
        ...sendModelSelection,
        ...(resolveAuthorizationHeaders ? { resolveAuthorizationHeaders } : {}),
        ...(params.machineAdmissionTransport
          ? { machineAdmissionTransport: params.machineAdmissionTransport }
          : {}),
        ...(params.machineActionDirectTargetTransport
          ? { machineResumeTransport: params.machineActionDirectTargetTransport.invoke }
          : {}),
        ...(signal ? { signal } : {}),
      });
      if (!result.ok && result.code === 'machine_admission_transport_unavailable'
        && callerSurface === 'cli' && (!actionCaller || actionCaller.kind === 'host')
        && hasStoredSessionCredentialProvenance(params.credentials)
        && !context?.externalActionCredential && !context?.externalActionExecutionAuthorization
        && !context?.rpcSessionAuthorization && !sessionInputSource) {
        // No input was issued: the standalone CLI has no authenticated Machine
        // socket. Its host children use the same original-Account ingress as a
        // top-level protected Send, preserving input identity and caller authority.
        const [{ resolveSessionTransportContext }, { resolveSessionInputTargetMachineId, resolveProtectedSessionInputActionTarget }] = await Promise.all([import("@/session/services/resolveSessionTransportContext"), import("@/session/services/sessionInputAdmissionIdentity")]);
        const transport = await resolveSessionTransportContext({ reason: 'session-action', credentials: params.credentials, idOrPrefix: sessionId,
          ...(sendServerFeaturesSnapshot ? { serverFeaturesSnapshot: sendServerFeaturesSnapshot } : {}),
          ...(signal ? { signal } : {}) });
        if (!transport.ok) return { ok: false, errorCode: transport.code, error: transport.code };
        const machineId = resolveSessionInputTargetMachineId({ rawSession: transport.rawSession,
          decryptedMetadata: tryDecryptSessionOwnerMetadataView({ credentials: params.credentials, rawSession: transport.rawSession,
            accountEncryptionMode: transport.accountEncryptionCurrentness.mode }) });
        const selectedTarget = context?.externalActionTarget;
        if (!machineId || selectedTarget && (selectedTarget.kind === 'machine'
          ? selectedTarget.machineId !== machineId : selectedTarget.sessionId !== transport.sessionId)) {
          return { status: 'rejected' as const, code: 'session_input_target_unavailable' as const };
        }
        const execution = await dispatchOriginalAccountAction({ actionId: 'session.message.send',
          input: { sessionId: transport.sessionId, message: admittedMessageText, requestedAction,
            ...(recipient ? { recipient } : {}), ...(executionRunLocalId ? { localId: executionRunLocalId } : localId ? { localId } : {}),
            ...(messageMeta || admittedAttachmentMeta ? { messageMeta: { ...(messageMeta ?? {}), ...(admittedAttachmentMeta ?? {}) } } : {}), ...(displayText ? { displayText } : {}),
            ...(permissionModeOverride ? { permissionModeOverride } : {}),
            ...(modelOverride !== undefined ? { modelOverride } : {}), ...(providerConnectionId !== undefined ? { providerConnectionId } : {}),
            ...(reply === undefined ? { wait: normalizedWait, timeoutSeconds: normalizedTimeoutSeconds }
              : { reply, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) }) },
          requestId: context?.actionRequestId ?? randomUUID(),
          target: resolveProtectedSessionInputActionTarget({ sessionId: transport.sessionId, machineId, active: transport.rawSession.active !== false }),
          credentials: params.credentials, authority: context?.authority,
          serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
          serverIdentityId: context?.serverIdentityId ?? params.serverIdentityId,
          ...(params.isCredentialCurrent ? { isCurrent: params.isCredentialCurrent } : {}),
          ...(signal ? { signal } : {}) });
        return execution.ok ? execution.result : execution;
      }
      const admissionResult = projectSessionMessageSendActionResult(result);
      if (!result.ok) {
        if (admissionResult) return admissionResult;
        return {
          ok: false,
          errorCode: result.code,
          error: result.code,
          ...(result.candidates ? { candidates: result.candidates } : {}),
          ...(result.message ? { message: result.message } : {}),
          ...(result.providerError ? { details: result.providerError } : {}),
        };
      }
      const canonicalSessionId = typeof result.sessionId === 'string' && result.sessionId.trim().length > 0
        ? result.sessionId
        : sessionId;
      await dispatchMessageHook(canonicalSessionId, 'user');
      // A successful send always projects an accepted admission from its
      // resolved local id, even for the legacy unprotected writer response.
      if (!admissionResult) throw new Error('Successful Session send is missing its admission projection');
      return settleCanonicalReply(result, admissionResult);
    },

    sessionMessageReply: async ({ sessionId, requestLocalId, reply, reviewDecision, context, serverId, signal }) => {
      if (reviewDecision) {
        if (context.externalActionExecutionAuthorization
          && !context.externalActionExecutionAuthorization.binding.approvalDecisionAdmission) {
          return { v: 1 as const, ok: false as const, error: 'forbidden' as const };
        }
        if (context.authority !== 'present_user' || await projectAccountAdmission(serverId ?? undefined, context)) {
          return { v: 1 as const, ok: false as const, error: 'forbidden' as const };
        }
        const credentials = params.credentials;
        if (!credentials) return { v: 1 as const, ok: false as const, error: 'unavailable' as const };
        await assertProjectRequesterCurrent(context);
        const { mutateSessionMessageReplyObservation } = await import("@/session/services/sessionMessageReply");
        return withProjectHome(() => mutateSessionMessageReplyObservation({ credentials,
          sessionId, localId: requestLocalId, operation: reviewDecision,
          resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, 'approval.request.decide', request),
          ...(signal ? { signal } : {}) }));
      }
      if (!params.sessionMessageReplyPublisher) {
        // Credentialed daemon/CLI executors route back to the receiving
        // Session's existing publisher; only that owner can fulfill its input.
        const transport = await resolveTransportForSession(sessionId, signal, { context, actionId: 'session.message.reply' });
        if (!transport.ok) return { v: 1 as const, ok: false as const, error: 'unavailable' as const };
        return SessionMessageReplyMutationResultV1Schema.parse(await callSessionActionRpc(transport,
          'session.message.reply', { sessionId, requestLocalId, reply }, { ...context, ...(signal ? { signal } : {}) }));
      }
      if (sessionId !== params.sessionMessageReplyPublisher.sessionId) return { v: 1 as const, ok: false as const, error: 'forbidden' as const };
      const source = context.sessionInputSource === undefined ? undefined
        : SessionInputSourceSessionV1Schema.safeParse(context.sessionInputSource);
      if (source && (!source.success || source.data.sourceSessionId !== sessionId)) {
        return { v: 1 as const, ok: false as const, error: 'forbidden' as const };
      }
      return params.sessionMessageReplyPublisher.publishSessionMessageReply({ requestLocalId, reply,
        ...(source?.success ? { sourceTurnId: source.data.sourceTurnId } : {}) },
        signal ? { signal } : undefined);
    },
  };
}
