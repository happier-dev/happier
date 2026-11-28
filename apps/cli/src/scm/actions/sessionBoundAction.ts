import { ActionRefusalDiagnosticV1Schema, createActionRefusalDetailsV1, readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readPluginErrorRequestIdV1 } from '@happier-dev/cli-common/plugins/errors';
import { isPluginErrorData } from '@happier-dev/protocol/plugins/errors';
import type { CliActionDepsParams } from '@/session/actions/cliActionDeps/types';
import type { CliMachineActionCall, CliMachineActionServerScopeCurrent } from '@/session/actions/cliActionDeps/machineTransport';
import type { SessionPullRequestBindingResultV1 } from '@happier-dev/channels-protocol/v1';
import { executeCapturedMachineAction } from '@/api/machine/capturedMachineAction';
import { SCM_PULL_REQUEST_OPEN_OR_REUSE_ACTION_ID_V1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { createServerUrlComparableKey } from '@happier-dev/protocol/server/urls/serverUrlComparableKey';
import { externalActionTargetsEqualV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { admitScmRemotePolicy } from '@happier-dev/protocol/scm/remotePolicy';
import { admitScmCommitPolicy, admitScmCommitUndoLast } from '@happier-dev/protocol/scm/capabilities';
import { ScmBackendDescribeResponseSchema, ScmRemoteRequestSchema, ScmCommitCreateRequestSchema } from '@happier-dev/protocol/scm';
import type { ScmCapabilities } from '@happier-dev/protocol/scm';
import { ScmPullRequestOpenOrReuseResponseSchema, type ScmPullRequestOpenOrReuseResponse } from '@happier-dev/protocol/scm/pullRequests';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import type { ResolvedSessionPullRequestBindingInputV1 } from '@/session/actions/createCliActionDeps';
import { createTargetedActionRpcRequestV1, ManagedWorkspaceScmRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import type { ScmCommitCreateActionInput, ScmRemotePushActionInput } from '@happier-dev/protocol/actions/scmGitActionSpecs';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { resolveFilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { resolveCwd } from '@/scm/runtime';
import type { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { isStoredScmReviewEvidenceAction, type bindScmActionToSessionWorkspace, type isRetainedScmReviewAction } from '@/scm/actions/placement';
import { resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/socketRpc';
import type { ActionExecutorDeps, ActionExecutorContext, ScmDiffSummaryGenerateInput } from '@happier-dev/protocol';
import { getActionSpec, requiresExplicitScmMachineTarget } from '@happier-dev/protocol/actions/actionSpecs';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { isOriginalAccountActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readActionPrincipalAccountId } from '@/session/actions/actionPrincipalAccount';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type { resolveSessionMachineWorkspacePath } from '@/session/machineControlLocality';
import type { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import type { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { readMachineRpcRequestDisposition } from '@/session/transport/rpc/machineRpc';
import { isRpcError, isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import { isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import type { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import type { sendFileReviewNoteToSession } from '@/session/services/sendFileReviewNote';
import type { createCliScmReviewedMarkAction } from '@/scm/actions/executeScmReviewedMarkAction';
import type { executeScmDiffSummaryAction } from '@/scm/actions/executeScmDiffSummaryAction';
import type { createRepositoryCheckpointTranscriptPageReader } from '@/scm/checkpoints/readRepositoryCheckpointTranscriptPage';
import type { ReadPullRequestComparisonPage } from '@/scm/comparisons/readPullRequestComparisonPage';
type CurrentMachineControlIdentity = Readonly<{
  machineId: string | null;
  host: string | null;
  homeDir: string | null;
}>;
type ResolvedSessionTransport = Extract<
    Awaited<ReturnType<typeof resolveSessionTransportContext>>,
    Readonly<{ ok: true }>
  >;

export function createSessionBoundScmAction(
  params: Pick<CliActionDepsParams, 'credentials' | 'machineActionDirectTargetTransport' | 'scmFilesystemAccessPolicy' | 'serverHttpBaseUrl' | 'serverId' | 'serverIdentityId' | 'externalActionMachineInstallationId' | 'token' | 'sessionId' | 'rawSession'>,
  { callMachineAction, isMachineActionServerScopeCurrent, invokeSessionPullRequestBinding, normalizeStringValue, readCurrentMachineControlIdentity, readTransportSessionOwnerMetadata, resolveServerRequestHeaders, resolveTransportForSession }: Readonly<{
    callMachineAction: CliMachineActionCall;
    isMachineActionServerScopeCurrent: CliMachineActionServerScopeCurrent;
    invokeSessionPullRequestBinding: (input: ResolvedSessionPullRequestBindingInputV1, caller?: ActionExecutorContext) => Promise<SessionPullRequestBindingResultV1>;
    normalizeStringValue: (value: unknown) => string | null;
    readCurrentMachineControlIdentity: () => Promise<CurrentMachineControlIdentity>;
    readTransportSessionOwnerMetadata: (transport: ResolvedSessionTransport) => ReturnType<typeof tryDecryptSessionOwnerMetadataView>;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    resolveTransportForSession: (idOrPrefix: string, signal?: AbortSignal, caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>, expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']) => Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>>;
  }>,
): NonNullable<ActionExecutorDeps['scmActionExecute']> {

  const executeSessionBoundScmAction: NonNullable<ActionExecutorDeps['scmActionExecute']> = async ({
    actionId,
    input,
    context,
    executeCanonicalAction,
    executeHostingProviderAction,
  }) => {
    const localReviewHomeCurrent = async () => {
      const { isServerProfileHomeIdentity } = await import("@/server/serverProfiles");
      if (context.serverId && !await isServerProfileHomeIdentity(configuration.activeServerId, context.serverId)) return false;
      if (params.serverId && !await isServerProfileHomeIdentity(configuration.activeServerId, params.serverId)) return false;
      if (!params.serverHttpBaseUrl) return true;
      try {
        const selected = createServerUrlComparableKey(params.serverHttpBaseUrl);
        return Boolean(selected && [configuration.serverUrl, configuration.apiServerUrl, resolveServerHttpBaseUrl()]
          .some(url => createServerUrlComparableKey(url) === selected));
      } catch { return false; }
    };
    const localReviewContext = { ...context, serverId: configuration.activeServerId };
    const requesterAccountId = readActionPrincipalAccountId(context);
    const [{ createCliScmReviewedMarkAction }, { resolveBackendTargetFromSessionMetadata }, { createRepositoryCheckpointTranscriptPageReader }, { isRetainedScmReviewAction, bindScmActionToSessionWorkspace }, { resolveSessionMachineWorkspacePath }, { executeScmActionOperation }] = await Promise.all([import("@/scm/actions/executeScmReviewedMarkAction"), import("@/session/backendTargets/resolveBackendTargetFromSessionMetadata"), import("@/scm/checkpoints/readRepositoryCheckpointTranscriptPage"), import("@/scm/actions/placement"), import("@/session/machineControlLocality"), import("@/scm/actions/executeScmActionOperation")]);
    const accountMarksDeps = params.credentials ? {
      executeReviewedMarks: (evidence: import('@happier-dev/protocol').ScmComparison | import('@happier-dev/protocol').ScmReviewedMarksSource, request: import('@happier-dev/protocol').ScmReviewedUnmarkInput, reviewed: boolean) => createCliScmReviewedMarkAction({
        credentials: params.credentials!, ...('id' in evidence ? { comparison: evidence } : { source: evidence }),
        ...('reset' in request ? { reset: true as const } : 'changeKeys' in request ? { changeKeys: request.changeKeys } : { changeRefs: request.changeRefs }), reviewed,
        ...(requesterAccountId ? { requesterAccountId } : {}),
        ...(params.serverHttpBaseUrl ? { serverBaseUrl: params.serverHttpBaseUrl } : {}),
        resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, actionId, request),
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    } : {};
    const attachSuccessfulPullRequest = async (response: unknown) => {
      const sessionId = normalizeStringValue(context.defaultSessionId);
      if (actionId !== SCM_PULL_REQUEST_OPEN_OR_REUSE_ACTION_ID_V1 || !sessionId) return response;
      const parsed = ScmPullRequestOpenOrReuseResponseSchema.safeParse(response);
      if (!parsed.success || !parsed.data.success || !parsed.data.pullRequest) return response;
      const pr = parsed.data.pullRequest;
      if (pr.provider.kind !== 'github' || !pr.provider.nameWithOwner || !pr.number) return response;
      try {
        const result = await invokeSessionPullRequestBinding({ kind: 'attach', sessionId,
          pullRequest: { repository: pr.provider.nameWithOwner, number: pr.number } }, context);
        if (result.kind !== 'attached') throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable', details: createActionRefusalDetailsV1('target_unavailable', 'channels_operation_mismatch') });
        return response;
      } catch (error) {
        const code = readActionErrorCodeV1(error) ?? 'target_unavailable';
        const details = error && typeof error === 'object' ? Reflect.get(error, 'details') : undefined;
        const diagnostic = ActionRefusalDiagnosticV1Schema.safeParse(details && typeof details === 'object' ? Reflect.get(details, 'diagnostic') : undefined);
        const reason = diagnostic.success ? `${code}/${diagnostic.data.reason}` : code;
        const authorDetails = isPluginErrorData(details) && 'details' in details ? details.details : undefined;
        const requestId = readPluginErrorRequestIdV1({ details: authorDetails });
        const remedy = authorDetails && typeof authorDetails === 'object' && 'remedy' in authorDetails
          && typeof authorDetails.remedy === 'string' ? authorDetails.remedy : undefined;
        const reference = requestId ? `${reason}. Request ID ${requestId}` : reason;
        const message = remedy
          ? `The pull request is open. ${remedy} (${reference}).`
          : `The pull request is open. Its link to this Session could not be confirmed (${reference}). Link the existing pull request to this Session.`;
        const nativeOutcome = parsed.data.outcome;
        return {
          ...parsed.data,
          outcome: {
            v: 1,
            kind: 'effect_applied_with_warning',
            errorCode: nativeOutcome?.kind === 'effect_applied_with_warning' ? nativeOutcome.errorCode : SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            effect: { kind: 'pull_request', url: pr.url, number: pr.number },
            nextActions: nativeOutcome?.nextActions ?? [],
            ...(nativeOutcome?.repositoryState ? { repositoryState: nativeOutcome.repositoryState } : {}),
            ...(nativeOutcome?.recoveryStash ? { recoveryStash: nativeOutcome.recoveryStash } : {}),
            message: nativeOutcome?.message ? `${nativeOutcome.message} ${message}` : message,
          },
        } satisfies ScmPullRequestOpenOrReuseResponse;
      }
    };
    const inputRecord = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Readonly<Record<string, unknown>>
      : {};
    const reviewNoteCredentials = params.credentials;
    const emitFileReviewNote: Parameters<typeof executeScmActionOperation>[0]['emitFileReviewNote'] = reviewNoteCredentials
      ? async ({ sessionId, ...note }) => {
        const { sendFileReviewNoteToSession } = await import("@/session/services/sendFileReviewNote");
        return await sendFileReviewNoteToSession({ credentials: reviewNoteCredentials, sessionId, note });
      }
      : undefined;
    const readComparisonTranscriptPage = params.credentials ? createRepositoryCheckpointTranscriptPageReader({
      credentials: params.credentials,
      resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, 'session.transcript.get', request),
      ...(context.signal ? { signal: context.signal } : {}),
    }) : undefined;
    const authorizeReviewSession = async (sessionId: string | undefined) => {
      // An ingress proof is the caller's ceiling; never widen it with the
      // runtime owner's credentials. Ordinary CLI callers prove access at Home.
      if (context.actionCaller?.kind === 'session' && context.actionCaller.sessionId !== sessionId) return false;
      if (context.rpcSessionAuthorization) return context.rpcSessionAuthorization.sessionId === sessionId;
      // A verified Machine requester can reach its own Account shelf after the
      // generator Session is gone. Session callers retain their Session ceiling.
      if (machineRequesterReviewAccess) return true;
      // Standalone evidence needs an admitted Machine requester.
      if (!sessionId) return false;
      const { fetchSessionById } = await import("@/session/transport/http/sessionsHttp");
      const snapshot = await fetchSessionById({ reason: 'session-action', token: params.token, sessionId,
        ...(params.serverHttpBaseUrl ? { serverUrl: params.serverHttpBaseUrl } : {}),
        resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, actionId, request),
        ...(context.signal ? { signal: context.signal } : {}),
      }).catch(() => null);
      return snapshot?.id === sessionId;
    };
    const readPullRequestComparisonPage: ReadPullRequestComparisonPage = async ({ sourceAction, continuation }) => {
      const input = sourceAction.input;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Pull-request source Action requires object input');
      const selectedSourceInput = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'continuation'));
      const result = await executeCanonicalAction('action.invoke', {
        action: sourceAction.action,
        input: { ...selectedSourceInput, comparison: true, ...(continuation ? { continuation } : {}) },
      }, { requiredContributedActionDangerLevel: 'safe' });
      if (!result.ok) throw new Error(`Pull-request source Action unavailable: ${result.errorCode}`);
      return result.result;
    };
    const machineInventory = requiresExplicitScmMachineTarget(actionId);
    // These operations consume protected saved evidence/revisions, not a live
    // backend. Keep their existing local Home/Session access and currentness owner.
    const retainedReviewAction = isRetainedScmReviewAction(actionId, inputRecord);
    const machineContext = context as typeof context & Pick<RpcHandlerContext, 'machineAdmission' | 'verifyMachineAdmissionCurrent'>;
    const admission = machineContext.machineAdmission;
    // Capture the current transport authority once per Action, not once per saved body.
    const signedAuthorization = context.externalActionExecutionAuthorization;
    const signedRequester = signedAuthorization?.requesterHttpProjection;
    const targetMachineId = context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget.machineId : null;
    const machineRequesterReviewAccess = isStoredScmReviewEvidenceAction(actionId, inputRecord)
      && !context.rpcSessionAuthorization
      && context.actionCaller?.kind !== 'session' && context.externalActionTarget?.kind === 'machine'
      && (admission
        ? admission.machineId === targetMachineId && admission.role === 'manage'
          && admission.actorAccountId === requesterAccountId
          && await machineContext.verifyMachineAdmissionCurrent?.().catch(() => false)
        // Signed public Actions carry their own already-admitted Home witness, not
        // a socket Machine stamp. Consume its private currentness port in place;
        // a serialized binding or a Session/delegated invocation is insufficient.
        : signedAuthorization && signedRequester && isOriginalAccountActionCustody(signedAuthorization.binding)
          && !signedAuthorization.binding.sessionActionSource
          && signedAuthorization.binding.actionId === actionId
          && signedAuthorization.binding.machineId === targetMachineId
          && externalActionTargetsEqualV1(signedAuthorization.binding.target, context.externalActionTarget)
          && signedRequester.accountId === signedAuthorization.binding.accountId
          && signedRequester.accountId === requesterAccountId
          && signedRequester.serverId === (params.serverId ?? configuration.activeServerId)
          && signedRequester.serverIdentityId === signedAuthorization.binding.serverIdentityId
          && await signedRequester.isCurrent().catch(() => false));
    if (machineInventory && context.externalActionTarget?.kind !== 'machine') {
      return { ok: false, errorCode: 'machine_not_selected', error: 'machine_not_selected' };
    }
    const workspace = actionId === 'scm.commit.create' || actionId === 'scm.remote.push'
      ? (inputRecord as ScmCommitCreateActionInput | ScmRemotePushActionInput).workspace : undefined;
    const target = context.externalActionTarget;
    if (workspace && (target?.kind !== 'machine' || target.machineId !== workspace.controller.machineId
      || context.actionCaller?.kind === 'session' || context.rpcSessionAuthorization
      || (target.project && target.project.directory !== workspace.rootPath))) {
      return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
    }
    const addressManagedWorkspace = (request: unknown) => ManagedWorkspaceScmRpcRequestV1Schema.parse({
      v: 1, kind: 'targeted_action_rpc', target: workspace, input: request,
    });
    const executeMachineScmAction = async (machineId: string | null, selectedInput: Readonly<Record<string, unknown>>,
      sessionAuthorization = context.rpcSessionAuthorization, sessionRoot?: string, scmSessionWorkspace?: NonNullable<RpcHandlerContext['localActionContext']>['scmSessionWorkspace']) => {
      const selectedTarget = context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget : undefined;
      const root = workspace?.rootPath ?? sessionRoot ?? selectedTarget?.project?.directory;
      const [{ bindScmActionToSessionWorkspace }, { tryAcquireAuthoritativePluginRuntimeRegistryLease }, { executeCapturedMachineAction }] = await Promise.all([import("@/scm/actions/placement"), import("@/plugins/runtime/reload/runtimeLease"), import("@/api/machine/capturedMachineAction")]);
      const { workspace: _workspace, ...nativeInput } = selectedInput;
      const scmInput = workspace ? nativeInput : selectedInput;
      const sessionInput = root && context.defaultSessionId && context.actionCaller?.kind === 'session'
        ? bindScmActionToSessionWorkspace(actionId, scmInput, root, context.defaultSessionId) : scmInput;
      const inputRecord = root && !machineInventory && actionId !== 'scm.repository.clone' && sessionInput.cwd === undefined
        ? { ...sessionInput, cwd: root } : sessionInput;
      const cwd = normalizeStringValue(actionId === 'scm.repository.clone'
        ? inputRecord.destinationParentPath
        : inputRecord.cwd);
      const method = getActionSpec(actionId).bindings?.rpcMethod;
      if (!machineId || (!machineInventory && !cwd) || !method) {
        return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
      }
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      if (!await isMachineActionServerScopeCurrent({ serverId: context.serverId, machineId, context,
        ...(context.signal ? { signal: context.signal } : {}) })) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      // Only the installed daemon has a serving runtime. A runner on the same
      // Machine must still take transport; it cannot recreate that registry.
      const nativeScmAction = actionId.startsWith('scm.diffSummary.') || actionId === 'scm.blame.get'
        || actionId === 'scm.diff.file' && retainedReviewAction;
      const localRuntime = !retainedReviewAction && nativeScmAction
        ? tryAcquireAuthoritativePluginRuntimeRegistryLease() : null;
      const installedScmOwner = localRuntime !== null;
      await localRuntime?.release();
      // Live work for another Account needs the receiving identity owner.
      const { scmRpcOperationContextStorage } = await import('@/scm/rpc/operationContext');
      const operation = scmRpcOperationContextStorage.getStore();
      const captureScope = method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE && context.rpcSessionAuthorization
        && operation?.context.authorization === context.rpcSessionAuthorization ? operation : undefined;
      if (operation && params.credentials && nativeScmAction && (retainedReviewAction || installedScmOwner
        && (captureScope || !signedAuthorization || signedAuthorization.binding.accountId === signedAuthorization.binding.custodianAccountId))) {
        const currentMachine = await readCurrentMachineControlIdentity();
        if (currentMachine.machineId === machineId) {
          if (!await localReviewHomeCurrent()) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
          const [{ executeScmActionOperation }, { resolveCwd }, { resolveFilesystemAccessPolicy }] = await Promise.all([import("@/scm/actions/executeScmActionOperation"), import("@/scm/runtime"), import("@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy")]);
          return executeScmActionOperation({ actionId, input: inputRecord,
            workingDirectory: captureScope?.workingDirectory ?? cwd ?? process.cwd(),
            emitFileReviewNote,
            ...(root && context.defaultSessionId && (context.actionCaller?.kind === 'session'
              || sessionAuthorization?.sessionId === context.defaultSessionId) ? { sessionId: context.defaultSessionId } : {}),
            accessPolicy: captureScope?.accessPolicy ?? (root ? { kind: 'restrictedRoots', roots: resolveCwd(root, cwd ?? process.cwd(),
              params.scmFilesystemAccessPolicy ?? resolveFilesystemAccessPolicy()).ok ? [root] : [] }
              : params.scmFilesystemAccessPolicy ?? resolveFilesystemAccessPolicy()),
            ...(readComparisonTranscriptPage ? { readComparisonTranscriptPage } : {}), readPullRequestComparisonPage,
            authorizeSession: authorizeReviewSession,
            executeCanonicalAction, executeHostingProviderAction, actionContext: localReviewContext, ...accountMarksDeps, ...(context.signal ? { signal: context.signal } : {}),
            executeDiffSummary: async ({ request }) => {
              const summary = request as ScmDiffSummaryGenerateInput;
              const parent = summary.sessionId ? await resolveTransportForSession(summary.sessionId, context.signal) : null;
              if (parent && !parent.ok) return { success: false, errorCode: 'DIFF_UNAVAILABLE', error: parent.code };
              const metadata = parent?.ok ? readTransportSessionOwnerMetadata(parent) : null;
              const parentMachineId = parent?.ok ? normalizeStringValue(parent.rawSession.machineId)
                ?? normalizeStringValue(metadata?.machineId) : null;
              if (parentMachineId && parentMachineId !== machineId) {
                return { success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'scm_action_session_not_local' };
              }
              const { executeScmDiffSummaryAction } = await import("@/scm/actions/executeScmDiffSummaryAction");
              return await executeScmDiffSummaryAction({
                actionContext: localReviewContext,
                request: summary, machineId, credentials: params.credentials,
                ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
                ...(readComparisonTranscriptPage ? { readTranscriptPage: readComparisonTranscriptPage } : {}), readPullRequestComparisonPage,
                backendTarget: resolveBackendTargetFromSessionMetadata(metadata), executeCanonicalAction,
                ...(context.signal ? { signal: context.signal } : {}),
              });
            },
          });
        }
      }
      const admitPolicy = actionId === 'scm.commit.create'
        ? (capabilities?: ScmCapabilities) => admitScmCommitPolicy(ScmCommitCreateRequestSchema.parse(inputRecord), capabilities)
        : actionId === 'scm.commit.undoLast'
          ? (capabilities?: ScmCapabilities) => admitScmCommitUndoLast(capabilities)
          : actionId === 'scm.remote.fetch' || actionId === 'scm.remote.pull' || actionId === 'scm.remote.push'
            ? (capabilities?: ScmCapabilities) => admitScmRemotePolicy(ScmRemoteRequestSchema.parse(inputRecord), capabilities)
            : undefined;
      if (admitPolicy && !admitPolicy().success) {
        let capabilities: ScmCapabilities | undefined;
        try {
          const describe = { cwd, ...(inputRecord.backendPreference ? { backendPreference: inputRecord.backendPreference } : {}), outcomeVersion: 1 };
          const description = ScmBackendDescribeResponseSchema.safeParse(await callMachineAction({
            machineId, serverId: context.serverId ?? undefined, method: 'scm.backend.describe',
            request: workspace ? addressManagedWorkspace(describe) : describe,
            authority: context.authority, context, effectActionId: 'scm.backend.describe', exactMachine: true,
            ...(context.signal ? { signal: context.signal } : {}),
          }));
          if (description.success && description.data.success) capabilities = description.data.capabilities;
        } catch {
          // An unproven exact-target capability is not permission to send fields
          // a predecessor daemon could silently ignore.
        }
        const admission = admitPolicy(capabilities);
        if (!admission.success) return admission;
      }
      const machineInput = {
        ...inputRecord,
        ...(actionId.startsWith('scm.diffSummary.') || machineInventory
          ? {}
          : { outcomeVersion: 1 }),
        ...(actionId === 'scm.status.snapshot' ? { operationStateVersion: 1 } : {}),
      };
      const request = workspace ? addressManagedWorkspace(machineInput) : root ? createTargetedActionRpcRequestV1(machineInput,
        { kind: 'machine', machineId, project: selectedTarget?.project ?? { machineId, directory: root } }, context) : machineInput;
      const invoke = () => executeCapturedMachineAction({ actionId,
        assertCurrent: async () => {
          if (!await isMachineActionServerScopeCurrent({ serverId: context.serverId, machineId, context,
            ...(context.signal ? { signal: context.signal } : {}) })) {
            throw Object.assign(new Error('server_scope_mismatch'), { code: 'server_scope_mismatch' });
          }
        },
        invoke: options => callMachineAction({ machineId, serverId: context.serverId ?? undefined, method, request,
          ...(sessionAuthorization ? { authorization: sessionAuthorization } : {}),
          context, effectActionId: actionId,
          ...(scmSessionWorkspace ? { scmSessionWorkspace } : {}),
          authority: context.authority, exactMachine: true,
          // SCM reads, like effects, belong to the containing Action lifetime.
          timeoutMs: null,
          ...(context.signal ? { signal: context.signal } : {}), ...options }),
      });
      try {
        return await attachSuccessfulPullRequest(await (params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, invoke) : invoke()));
      } catch (error) {
        if (actionId !== 'scm.change.discard') throw error;
        const { readMachineRpcRequestDisposition } = await import("@/session/transport/rpc/machineRpc");
        const disposition = readMachineRpcRequestDisposition(error);
        if (disposition === 'notSent'
          || isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
          return { success: false, errorCode: 'COMPARISON_UNAVAILABLE', error: 'Prepared Undo delivery is unavailable' };
        }
        // Receiver failures already carry the Action executor's typed error.
        if (isRpcError(error) && !isActionOutcomeUnknownErrorCodeV1(error.rpcErrorCode)
          && disposition !== 'outcomeUnknown') throw error;
        // A lost acknowledgement must never trigger a local mutation/replay.
        return { success: false, errorCode: 'COMMAND_OUTCOME_UNKNOWN', error: 'The Machine discard outcome could not be established' };
      }
    };
    if (actionId === 'scm.reviewWorkspace.materializePrepared') {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const selectedRoot = normalizeStringValue(inputRecord.cwd);
      if (!selectedRoot) {
        return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
      }
      const currentMachine = await readCurrentMachineControlIdentity();
      if (context.externalActionTarget?.kind === 'machine'
        && context.externalActionTarget.machineId !== currentMachine.machineId) {
        return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      }
      if (!await localReviewHomeCurrent()) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      const custodianAccountId = readAccountIdFromToken(params.credentials.token);
      const installationId = params.externalActionMachineInstallationId;
      const admission = createFilesystemEffectAdmission({
        resolveHomeServerIdentityId: async () => params.serverIdentityId ?? null,
        resolveHostIdentity: async () => custodianAccountId && currentMachine.machineId && installationId
          ? { custodianAccountId, machineId: currentMachine.machineId, installationId } : null,
      });
      const failure = await admission.action(context as RpcActionExecutorContext);
      if (failure) return { ok: false, ...failure };
      const { executeScmActionOperation } = await import("@/scm/actions/executeScmActionOperation");
      return await executeScmActionOperation({
        actionId,
        input: inputRecord,
        workingDirectory: selectedRoot,
        executeHostingProviderAction,
        emitFileReviewNote,
        accessPolicy: { kind: 'restrictedRoots', roots: [selectedRoot] },
        ...(context.signal ? { signal: context.signal } : {}),
      });
    }
    if (context.externalActionTarget?.kind === 'machine') {
      return await executeMachineScmAction(normalizeStringValue(context.externalActionTarget.machineId), inputRecord);
    }
    if (!params.credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
    const sessionId = normalizeStringValue(context.defaultSessionId);
    if (!sessionId) {
      return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
    }
    if (!await isMachineActionServerScopeCurrent({ serverId: context.serverId, context, signal: context.signal })) {
      return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
    }
    const transport = await resolveTransportForSession(sessionId, context.signal, { context, actionId });
    if (!transport.ok) {
      return { ok: false, errorCode: transport.code, error: transport.code };
    }

    const metadata = readTransportSessionOwnerMetadata(transport);
    // The bound host's location includes a child Run's cwd. An authored cwd
    // never replaces it, and another Session cannot borrow this host's location.
    const boundHostPath = sessionId === params.sessionId ? normalizeStringValue(params.rawSession?.path) : null;
    const ownerWorkingDirectory = normalizeStringValue(metadata?.path);
    if (!ownerWorkingDirectory) {
      return {
        ok: false,
        errorCode: 'scm_action_worktree_unavailable',
        error: 'scm_action_worktree_unavailable',
      };
    }

    const persistedWorkingDirectory = boundHostPath ?? ownerWorkingDirectory;
    const currentMachine = await readCurrentMachineControlIdentity();
    const sessionMachineId = normalizeStringValue(transport.rawSession.machineId)
      ?? normalizeStringValue(metadata?.machineId);
    const workingDirectory = metadata
      ? resolveSessionMachineWorkspacePath({
          metadata,
          currentMachineId: sessionMachineId,
          candidatePath: persistedWorkingDirectory,
        }) ?? persistedWorkingDirectory
      : persistedWorkingDirectory;
    const boundMachineId = sessionId === params.sessionId ? normalizeStringValue(params.rawSession?.machineId) : null;
    const expectedMachineIds = [boundMachineId, normalizeStringValue(context.defaultSessionMachineId),
      normalizeStringValue(context.executionRunTargetMachineId)];
    if (expectedMachineIds.some(id => id && sessionMachineId !== id)) {
      return { ok: false, errorCode: 'scm_action_session_not_local', error: 'scm_action_session_not_local' };
    }
    const sessionHost = normalizeStringValue(transport.rawSession.host)
      ?? normalizeStringValue(metadata?.host);
    const machineMismatch = Boolean(
      sessionMachineId
      && currentMachine.machineId
      && sessionMachineId !== currentMachine.machineId,
    );
    const hostMismatch = Boolean(
      !sessionMachineId
      && sessionHost
      && currentMachine.host
      && sessionHost !== currentMachine.host,
    );
    if (retainedReviewAction && (machineMismatch || hostMismatch)) {
      return {
        ok: false,
        errorCode: 'scm_action_session_not_local',
        error: 'scm_action_session_not_local',
      };
    }

    if (params.scmFilesystemAccessPolicy) {
      const { resolveCwd } = await import("@/scm/runtime");
      const authorized = resolveCwd(workingDirectory, workingDirectory, params.scmFilesystemAccessPolicy);
      if (!authorized.ok) return { ok: false, errorCode: 'scm_action_path_denied', error: authorized.error };
    }

    const sessionBoundInput = bindScmActionToSessionWorkspace(actionId, inputRecord, workingDirectory, transport.sessionId);
    const { isScmRpcOperationActive } = await import('@/scm/rpc/operationContext');
    if (!retainedReviewAction || !isScmRpcOperationActive()) {
      if (!sessionMachineId) return { ok: false, errorCode: 'machine_not_selected', error: 'machine_not_selected' };
      const accessLevel = transport.rawSession.effectiveAccess?.level;
      return await executeMachineScmAction(sessionMachineId, sessionBoundInput,
        context.rpcSessionAuthorization ?? (resolveSocketRpcSessionAuthorization(getActionSpec(actionId).bindings?.rpcMethod ?? '')
          ? { kind: 'session.write', sessionId: transport.sessionId } : undefined), workingDirectory,
        accessLevel === 'edit' || accessLevel === 'owner' ? { sessionId: transport.sessionId, access: accessLevel } : undefined);
    }

    if (actionId.startsWith('scm.diffSummary.') && !await localReviewHomeCurrent()) {
      return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
    }

    return await attachSuccessfulPullRequest(await executeScmActionOperation({
      emitFileReviewNote,
      actionId,
      input: sessionBoundInput,
      workingDirectory,
      accessPolicy: { kind: 'restrictedRoots', roots: [workingDirectory] },
      ...(readComparisonTranscriptPage ? { readComparisonTranscriptPage } : {}),
      readPullRequestComparisonPage,
      sessionId: transport.sessionId,
      authorizeSession: authorizeReviewSession,
      executeCanonicalAction,
      executeHostingProviderAction,
      actionContext: localReviewContext,
      ...accountMarksDeps,
      ...(context.signal ? { signal: context.signal } : {}),
    }));
  };
  return executeSessionBoundScmAction;
}

