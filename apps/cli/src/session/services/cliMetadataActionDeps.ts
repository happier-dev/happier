import type { ResolvedSessionTransport } from '../actions/cliActionDeps/types';
import type { CliActionDepsParams } from '../actions/cliActionDeps/types';
import { writeSessionApprovalReviewerOverrideV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { projectCurrentSessionPresentationActionResult } from '@/session/presentation/currentSessionPresentationService';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { admitSessionContextIntentV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { admitDeclaredSessionVoicePreferenceV1, readBuiltInSessionVoiceDeclarationV1 } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { withCliPromptLibraryArtifactReader } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { SessionUpdatePostInputV1Schema, workerDeliverablesBelongToSessionV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import { projectSessionManagerSourceKeyPreparationV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import type { SessionFollowSourceKeyPreparationResultV1, ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import type { updateSessionStateFieldForTarget } from '@/session/services/updateSessionStateFieldForTarget';
import type { resolveCurrentSessionUiBinding } from '@/session/presentation/currentSessionUiBindings';
import type { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import type { updateSessionMetadataForTarget } from '@/session/services/updateSessionMetadataForTarget';
import type { fetchSessionById, setSessionAttentionStanding, setSessionOrganizationPin, setSessionManager } from '@/session/transport/http/sessionsHttp';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
type FamilyActionDeps = Pick<ActionExecutorDeps, 'sessionUpdatePost' | 'sessionManagerSet' | 'sessionOrganizationPinSet' | 'sessionAttentionSet' | 'sessionApprovalReviewerSet' | 'sessionStateFieldSet' | 'currentSessionPresentationApply'>;

export function createCliMetadataActionDeps(
  params: CliActionDepsParams,
  { callSessionActionRpc, executionRunActionFailure, isSameActionHomeId, normalizeStringValue, prepareSourceKeyAfterCommit, projectHomeId, readServerFeaturesSnapshot, resolveServerRequestHeaders, resolveTransportForSession, withProjectHome }: Readonly<{

    callSessionActionRpc: (transport: ResolvedSessionTransport, method: string, input: unknown, context: ActionExecutorContext) => Promise<unknown>;
    executionRunActionFailure: (code: string, message?: string, details?: unknown) => Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;
    isSameActionHomeId: (serverId: string) => boolean;
    normalizeStringValue: (value: unknown) => string | null;
    prepareSourceKeyAfterCommit: (input: Readonly<{
    effectActionId: 'session.manager.set' | 'session.spawn_new';
    sourceSessionId: string;
    destinationSessionId: string;
    context?: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<SessionFollowSourceKeyPreparationResultV1>;
    projectHomeId: string;
    readServerFeaturesSnapshot: () => Promise<CliServerFeaturesSnapshot | undefined>;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    resolveTransportForSession: (idOrPrefix: string, signal?: AbortSignal, caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>, expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']) => Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>>;
    withProjectHome: <T>(operation: () => Promise<T>) => Promise<T>;
  }>,
): FamilyActionDeps {
  return {

    sessionUpdatePost: async ({ context, ...input }) => {
      if (context.actionCaller?.kind === 'session' && context.actionCaller.sessionId !== params.sessionId) {
        return { ok: false, errorCode: 'session_update_source_mismatch', error: 'session_update_source_mismatch' };
      }
      const caller = params.getAgentStartRunCaller?.();
      if (caller && 'runId' in caller) {
        return { ok: false, errorCode: 'session_update_run_step_requires_publish_draft', error: 'session_update_run_step_requires_publish_draft' };
      }
      if (!params.postSessionUpdate) {
        // Account callers reach the current Session publisher through its
        // registered Action; only that host commits the original transcript event.
        return await withProjectHome(async () => {
          const transport = await resolveTransportForSession(params.sessionId, context.signal, {
            context, actionId: 'session.update.post',
          });
          if (!transport.ok) return { ok: false, errorCode: transport.code, error: transport.code };
          return await callSessionActionRpc(transport, 'session.update.post', input, context);
        });
      }
      const { fetchSessionById } = await import("@/session/transport/http/sessionsHttp");
      const read = () => fetchSessionById({
        reason: 'session-action',
        token: params.token, sessionId: params.sessionId,
        ...(context.signal ? { signal: context.signal } : {}),
        resolveAuthorizationHeaders: (request) => resolveServerRequestHeaders(context, 'session.update.post', request),
      });
      const current = params.serverHttpBaseUrl ? await runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : await read();
      if (!current) return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
      if (current.origin?.kind === 'run_step') return { ok: false, errorCode: 'session_update_run_step_requires_publish_draft', error: 'session_update_run_step_requires_publish_draft' };
      const report = SessionUpdatePostInputV1Schema.safeParse(input);
      if (!report.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      if (!workerDeliverablesBelongToSessionV1(report.data.deliverables, params.sessionId)) {
        return { ok: false, errorCode: 'session_update_deliverable_scope_mismatch', error: 'session_update_deliverable_scope_mismatch' };
      }
      context.signal?.throwIfAborted();
      const committed = await params.postSessionUpdate(report.data);
      if (!committed.persisted || !committed.localId) return { ok: false, errorCode: 'session_update_not_committed', error: 'session_update_not_committed' };
      return { sessionId: params.sessionId, localId: committed.localId, persisted: true };
    },

    sessionManagerSet: async ({ context, sessionId, managerSessionId, expectedManagerSessionId, serverId, signal }) => {
      const credentials = params.credentials;
      if (!credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      if (params.serverId !== undefined && serverId != null && !isSameActionHomeId(serverId)) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      const { setSessionManager } = await import("@/session/transport/http/sessionsHttp");
      const mutate = () => setSessionManager({
        token: credentials.token, sessionId, managerSessionId, expectedManagerSessionId,
        ...(signal ? { signal } : {}),
        resolveAuthorizationHeaders: (request) => resolveServerRequestHeaders(context, 'session.manager.set', request),
      });
      const committed = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate());
      if (!committed.ok || managerSessionId === null) return committed;
      const preparation = await prepareSourceKeyAfterCommit({ effectActionId: 'session.manager.set',
        sourceSessionId: sessionId, destinationSessionId: managerSessionId, context, ...(signal ? { signal } : {}) });
      return projectSessionManagerSourceKeyPreparationV1(committed, preparation);
    },

    sessionOrganizationPinSet: async ({ context, sessionId, request, serverId, signal }) => {
      const credentials = params.credentials;
      if (!credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      if (params.serverId !== undefined && serverId != null
        && !isSameActionHomeId(serverId)) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      const mutate = async () => {
        signal?.throwIfAborted();
        if (request.pinned && request.surface === 'rail') {
          // Re-read on every addition: a cached transport could retain a demoted Bot marker.
          const serverFeaturesSnapshot = await readServerFeaturesSnapshot();
          const { resolveSessionTransportContext } = await import("@/session/services/resolveSessionTransportContext");
          const transport = await resolveSessionTransportContext({ reason: 'session-action', credentials, idOrPrefix: sessionId,
            resolveAuthorizationHeaders: (httpRequest) => resolveServerRequestHeaders(context, 'session.organization.pin.set', httpRequest),
            ...(signal ? { signal } : {}),
            ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
          });
          if (!transport.ok) return { ok: false, errorCode: transport.code, error: transport.code };
          const metadata = tryDecryptSessionMetadata({ credentials, rawSession: transport.rawSession });
          if (!metadata) return { ok: false, errorCode: 'session_metadata_unavailable', error: 'session_metadata_unavailable' };
          if (!readSessionBotV1(metadata.bot)) return { ok: false, errorCode: 'session_not_bot', error: 'session_not_bot' };
        }
        signal?.throwIfAborted();
        const { setSessionOrganizationPin } = await import("@/session/transport/http/sessionsHttp");
        return await setSessionOrganizationPin({ token: credentials.token, sessionId, request,
          ...(signal ? { signal } : {}),
          resolveAuthorizationHeaders: (httpRequest) => resolveServerRequestHeaders(context, 'session.organization.pin.set', httpRequest),
        });
      };
      return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate();
    },

    sessionAttentionSet: async ({ context, sessionId, request, serverId, signal }) => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      if (params.serverId !== undefined && serverId != null && !isSameActionHomeId(serverId)) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      const credentials = params.credentials;
      const { setSessionAttentionStanding } = await import("@/session/transport/http/sessionsHttp");
      const mutate = () => setSessionAttentionStanding({
        token: credentials.token, sessionId, request,
        ...(signal ? { signal } : {}),
        resolveAuthorizationHeaders: (httpRequest) => resolveServerRequestHeaders(context, 'session.attention.set', httpRequest),
      });
      return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate();
    },

    sessionApprovalReviewerSet: async ({ context, sessionId, enabled, serverId }) => {
      const credentials = params.credentials;
      if (!credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      if (params.serverId !== undefined && serverId != null && !isSameActionHomeId(serverId)) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      const { updateSessionMetadataForTarget } = await import("@/session/services/updateSessionMetadataForTarget");
      const mutate = () => updateSessionMetadataForTarget({
        credentials, idOrPrefix: sessionId,
        resolveAuthorizationHeaders: (request) => resolveServerRequestHeaders(context, 'session.approval_reviewer.set', request),
        updater: (metadata) => writeSessionApprovalReviewerOverrideV1(metadata, enabled),
      });
      const result = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate());
      return result.ok ? { updated: true } : { ok: false, errorCode: result.code, error: result.code };
    },

    sessionStateFieldSet: async (write) => {
      const { context, actionId, sessionId, fieldId, value, serverId } = write;
      const credentials = params.credentials;
      if (!credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      if (params.serverId !== undefined && serverId != null && !isSameActionHomeId(serverId))
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      const metadataContext: ActionExecutorContext = context.externalActionExecutionAuthorization
        ? { ...context, externalActionTarget: { kind: 'session', sessionId } }
        : context;
      const resolveAuthorizationHeaders = (request: Readonly<{
        method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown;
      }>) => resolveServerRequestHeaders(metadataContext, actionId, request);
      if (!resolveAuthorizationHeaders({
        method: 'GET', path: '/v1/account/encryption/currentness',
      })) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      if (fieldId === 'intent.context') {
        const readerServerId = credentials.requesterSessionCredentialScope?.serverId ?? projectHomeId;
        if (!isSameActionHomeId(readerServerId)) return executionRunActionFailure('server_target_mismatch');
        const { withCliPromptLibraryArtifactReader } = await import("@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks");
        await withCliPromptLibraryArtifactReader(reader => admitSessionContextIntentV1(value, ref => reader.readArtifactHeader(
          ref.serverId && isSameActionHomeId(ref.serverId) ? { ...ref, serverId: readerServerId } : ref)), {
          credentials, serverId: readerServerId, signal: context.signal,
        });
        context.signal?.throwIfAborted();
      }
      if (fieldId === 'intent.voicePreference' && value !== null) {
        // Running hosts consume their admitted lease. Standalone CLI uses the
        // same current manifest projection owner without activating plugins.
        const builtIn = readBuiltInSessionVoiceDeclarationV1(value.providerContributionId);
        const voiceProviders = builtIn ? [] : params.readPluginVoiceProviders
          ? params.readPluginVoiceProviders()
          : (await (await import('@/plugins/projection/registry/createResolvedContributionRegistry'))
            .resolveMergedContributionRegistry({ happyHomeDir: params.happyHomeDir })).voiceProviders;
        context.signal?.throwIfAborted();
        const entry = voiceProviders.find(entry => buildQualifiedPluginContributionKey(entry.identity) === value.providerContributionId);
        const parsed = VoiceProviderContributionSchema.safeParse(entry?.definition);
        const declaration = builtIn ?? (parsed.success ? parsed.data : null);
        if (!declaration) return { ok: false, errorCode: 'override_unsupported', error: 'override_unsupported' };
        const providerConfig = Object.fromEntries((declaration.settings?.fields ?? []).map(field => [field.id, field.default ?? null]));
        const admitted = admitDeclaredSessionVoicePreferenceV1({ providerContributionId: value.providerContributionId,
          declaration, providerConfig, preference: value });
        if (admitted.kind === 'unavailable') return { ok: false, errorCode: admitted.reason, error: admitted.reason };
      }
      const { updateSessionStateFieldForTarget } = await import("@/session/services/updateSessionStateFieldForTarget");
      const mutate = () => updateSessionStateFieldForTarget({
        credentials,
        idOrPrefix: sessionId,
        fieldId,
        value,
        metadataReason: `cli-${actionId}`,
        // The registered updater checks the caller's read once, then guards
        // its field across retries while preserving unrelated tuple changes.
        expectedMetadataRevision: 'expectedMetadataRevision' in write ? write.expectedMetadataRevision : undefined,
        currentness: { signal: context.signal },
        resolveAuthorizationHeaders,
      });
      const res = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate());
      if (!res.ok) {
        return { ok: false, errorCode: res.code, error: res.code, ...(res.candidates ? { candidates: res.candidates } : {}) };
      }
      return { ok: true, sessionId: res.sessionId, ...(fieldId === 'display.title' ? { title: value }
        : fieldId === 'display.statusReason' ? { reason: value }
        : fieldId === 'display.bot' ? { bot: value } : fieldId === 'display.botFace' ? { face: value } : fieldId === 'intent.memoryEnabled' ? { enabled: value }
        : fieldId === 'intent.voicePreference' ? { preference: value }
        : fieldId === 'intent.context' ? { work: res.metadata.work } : { showToolCalls: value }), version: res.version };
    },

    currentSessionPresentationApply: async ({ input, context, signal }) => {
      const sessionId = normalizeStringValue(context.defaultSessionId);
      if (!sessionId) {
        return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
      }
      const operationId = normalizeStringValue(context.actionRequestId);
      if (!operationId) {
        return { ok: false, errorCode: 'action_request_id_required', error: 'action_request_id_required' };
      }
      const [{ resolveCurrentSessionUiBinding }, { projectCurrentSessionPresentationActionResult }] = await Promise.all([import("@/session/presentation/currentSessionUiBindings"), import("@/session/presentation/currentSessionPresentationService")]);
      const presentation = resolveCurrentSessionUiBinding(sessionId)?.presentation;
      if (!presentation) {
        return {
          ok: false,
          errorCode: 'current_session_presentation_unavailable',
          error: 'current_session_presentation_unavailable',
        };
      }

      const result = await presentation.present(
        { operationId, intent: input.intent },
        signal ? { signal } : undefined,
      );
      return projectCurrentSessionPresentationActionResult(result);
    },
  };
}
