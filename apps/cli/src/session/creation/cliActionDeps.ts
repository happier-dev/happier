import { isActionExecuteFailure, projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readMachineIsolationV1 } from '@happier-dev/protocol/machines/machineIsolationV1';
import { sameStrictJsonValue, projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { isManagedPresetAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } from '@happier-dev/protocol/sessions/creation/sessionSpawnBudget';
import { BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '@happier-dev/protocol/bots/templates/botTemplateActionIdsV1';
import { SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { applyMachineSetupBeforeAgent } from '@/machines/setup/applyMachineSetupBeforeAgent';
import { resolveInheritedApprovalProfileIdV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import type { CliActionDepsParams } from '../actions/cliActionDeps/types';
import type { SessionExecutionTargetV1 } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import { prepareSessionAgentReadiness } from './prepareSessionAgentReadiness';
import { incompatibleSessionSpawnTarget, projectSessionInitialAccessEnvelopeHostErrorResult } from '../actions/cliActionDeps/sessionSpawnErrors';
import { SessionSpawnNewIncompatibleTargetV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createPrepareSessionCreationAuthorization, createReviewedSecondOpinionSessionCreationAuthorization } from '@/api/externalActionExecutionAuthorization';
import type { resolveCliPromptStackSystemAppendBlocks } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { AgentStartRefusalV1Schema } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import type { SessionFollowSourceKeyPreparationResultV1, ActionExecutorDeps, ActionExecutorContext, SessionSpawnNewResultV1, SessionCreationTargetPreparationRequestV1, SessionCreationTargetPreparationResultV1 } from '@happier-dev/protocol';
import { buildAcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { normalizeSessionCreationOrganizationPlacementV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { withSessionNativeSandbox } from '@/session/shared/sessionCreationCorrespondence';
import type { buildSessionCreationCorrespondence } from '@/session/shared/sessionCreationCorrespondence';
import { projectDiscussionModelParticipantLaunchV1 } from '@happier-dev/protocol/discussions/modelParticipantLaunch';
import { readSessionCreationTargetPreparationResultV1, projectSessionCreationTargetPreparationRpcFailureV1, SessionCreationDirectoryApprovalV1Schema, needsSessionCreationDirectoryApprovalPreflightV1, projectSessionCreationDirectoryApprovalV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { SessionAuthoringTerminalV1Schema } from '@happier-dev/protocol/sessions/authoring/creationFieldsV1';
import { projectSessionAuthoringTerminalForSpawn } from '@/terminal/runtime/terminalConfig';
import { normalizeSpawnSessionErrorDetail, SessionCreationTerminalSpawnErrorDetailSchema, SPAWN_SESSION_ERROR_DETAIL_KINDS, isSessionCreationCorrespondenceConflictSpawnErrorDetail, isSessionCreationOrganizationInvalidSpawnErrorDetail } from '@happier-dev/protocol/spawnSession';
import { supportsMachineOperationProtocolCapabilityV1, supportsMachineSessionSpawnProtocolVersionV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import type { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import type { createStableSpawnNonce } from '@/session/shared/spawnNonce';
import { configuration } from '@/configuration';
import type { MachineAdmissionTransportUnavailableError } from '@/daemon/machineAdmissionTransport';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import type { readSessionCreationTerminalSpawnErrorDetail } from '@/api/session/sessionCreationTerminalSpawnErrorDetail';
import type { readMachineOperationProtocolCapabilitiesV1 } from '@/api/machine/machineOperationProtocolCapabilities';
import { SessionInitialAccessUpdateRequiredError } from '@/api/session/sessionCreationInitialAccess';
import type { createCliWorkflowTriggerActions } from '../actions/workflowTriggers';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { type RoleSourceReader } from '@/session/roles/roleSources';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readStoredCredentials } from '@/persistence';
import type { createSpawnedSession, ReplaySeededSessionCreationV1 } from '@/session/services/createSpawnedSession';
import type { buildReplaySeededSpawnRecipe } from '@/session/replay/buildReplaySeededSpawnRecipe';
import type { resolveReplaySourceContextAuthority } from '@/session/replay/resolveReplaySourceContextAuthority';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { readRequesterAccountActionContext, resolveRequesterSavedSecretActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { resolveRolesSnapshotV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { buildPluginSessionInputAttachmentDraftsV1 } from '@/session/composer/admitPluginSessionInputAttachmentsV1';
import type { buildSessionSpawnInitialInputAdmissionForLocalIdV1, requiresMachineAdmissionForSessionInput } from '@/session/services/sessionInputAdmissionIdentity';
import type { resolveSessionCreationAgentTarget } from '@/session/creation/resolveSessionCreationAgentTarget';
import type { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import type { dispatchRequesterSessionSpawnNewRpc, readMachineRpcRequestDisposition } from '@/session/transport/rpc/machineRpc';
import type { resolveLiveDaemonControlTargetForServer } from '@/daemon/multiDaemon';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, isMachineRpcTimeoutError, MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { type RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import type { CliMachineActionCall } from '@/session/actions/cliActionDeps/machineTransport';
import type { AccountRoleOverridesReadV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import { buildHostOnboardingInput } from './hostOnboardingInput';
import { createTemplateHostOnboardingAdmissionTransport } from '@/api/session/templateHostOnboardingAdmission';
import { resolveSessionSpawnManagedDefaults } from './resolveSessionSpawnManagedDefaults';
import { resolveManagedAgentSandbox } from '@happier-dev/protocol/teams/managedDefaults';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { refreshConnectedAccountCatalogForAdmission } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import { agentSupportsSpawnConnectedServicesDefaults, ConnectedServicesDefaultUnavailableError } from '@/session/services/spawnConnectedServicesDefaults';
import { createCliManagedSessionDefaultsContextLoader } from './cliManagedSessionDefaultsContext';
import { createPrepareSessionSpawnInput } from './prepareSessionSpawnInput';


type SpawnActionDeps = Pick<ActionExecutorDeps, 'sessionSpawnNewDirectoryApprovalPreflight' | 'prepareSessionSpawnNewInput'>
  & Required<Pick<ActionExecutorDeps, 'sessionSpawnNew'>>;

export function createCliSpawnActionDeps(
  params: CliActionDepsParams,
  { callMachineAction, isSameActionHomeId, machineReferenceServerUrl, normalizeStringValue, prepareAccountRoleOverrides, prepareSourceKeyAfterCommit, projectHomeId, readAccountRoleOverrides, readRecord, readRoleSources, resolveServerRequestHeaders, roleSettingsProvider, spawnConnectedServicesList, workflowTriggers }: Readonly<{
    callMachineAction: CliMachineActionCall;
    isSameActionHomeId: (serverId: string) => boolean;
    machineReferenceServerUrl: string;
    normalizeStringValue: (value: unknown) => string | null;
    prepareAccountRoleOverrides: (signal?: AbortSignal) => Promise<void>;
    prepareSourceKeyAfterCommit: (input: Readonly<{
    effectActionId: 'session.manager.set' | 'session.spawn_new';
    sourceSessionId: string;
    destinationSessionId: string;
    context?: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<SessionFollowSourceKeyPreparationResultV1>;
    projectHomeId: string;
    readAccountRoleOverrides: () => AccountRoleOverridesReadV1 | Readonly<{ status: 'unavailable'; reason: string }>;
    readRecord: (value: unknown) => Record<string, unknown>;
    readRoleSources: RoleSourceReader;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    roleSettingsProvider: RuntimeActionSettingsProvider;
    spawnConnectedServicesList: NonNullable<ActionExecutorDeps['spawnConnectedServicesList']>;
    workflowTriggers: ReturnType<typeof createCliWorkflowTriggerActions> | null;
  }>,
): SpawnActionDeps {

function hasPossiblyAcceptedSpawnNonce(error: unknown): boolean {
  const details = readRecord(readRecord(error).details);
  return typeof details.spawnNonce === 'string' && details.spawnNonce.trim().length > 0;
}

function readSessionCreationTargetRpcCause(error: unknown): Readonly<{
  code: string;
  message: string;
  rpcErrorCode?: typeof MACHINE_RPC_TIMEOUT_ERROR_CODE | typeof RPC_ERROR_CODES.OUTCOME_UNKNOWN | typeof RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE;
}> | null {
  const code = isMachineRpcTimeoutError(error) ? MACHINE_RPC_TIMEOUT_ERROR_CODE : readRpcErrorCode(error);
  if (!code) return null;
  const rpcErrorCode = code === MACHINE_RPC_TIMEOUT_ERROR_CODE || code === RPC_ERROR_CODES.OUTCOME_UNKNOWN
    || code === RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE ? code : undefined;
  const message = rpcErrorCode === MACHINE_RPC_TIMEOUT_ERROR_CODE ? 'Target Machine RPC timed out.'
    : rpcErrorCode === RPC_ERROR_CODES.OUTCOME_UNKNOWN ? 'Target Machine RPC outcome is unknown.'
      : rpcErrorCode === RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE ? 'Target Machine transport is unavailable.'
        : 'Session target preparation was refused.';
  return rpcErrorCode ? { code, message, rpcErrorCode } : { code, message };
}

/**
 * The Action surface consumes only the protocol-owned terminal detail, never
 * daemon/server wording. Direct daemon-control failures carry it at
 * `details.errorDetail`; the awaiter path nests the original response once.
 */
function hasSessionCreationOrganizationInvalidDetail(error: unknown): boolean {
  const details = readRecord(readRecord(error).details);
  return isSessionCreationOrganizationInvalidSpawnErrorDetail(
    details.errorDetail,
  ) || isSessionCreationOrganizationInvalidSpawnErrorDetail(
    readRecord(details.spawnResponse).errorDetail,
  );
}

function hasSessionCreationCorrespondenceConflictDetail(error: unknown): boolean {
  const details = readRecord(readRecord(error).details);
  return isSessionCreationCorrespondenceConflictSpawnErrorDetail(
    details.errorDetail,
  ) || isSessionCreationCorrespondenceConflictSpawnErrorDetail(
    readRecord(details.spawnResponse).errorDetail,
  );
}

  const ambiguousSpawnActionRequestIds = new Set<string>();

  type SessionSpawnTargetPreparation =
    | Readonly<{
        ok: true;
        preparedTarget: Extract<
          SessionCreationTargetPreparationResultV1,
          Readonly<{ ok: true }>
        >;
      }>
    | Readonly<{
        ok: false;
        result: Extract<SessionSpawnNewResultV1, Readonly<{ type: 'error' }>>;
      }>;

  /**
   * A direct transport is installed only by the authenticated exact-machine
   * receiver. Once that receiver has selected this daemon, its local profile
   * id is not an Account-routing identity: retain the portable server id in
   * the Action input and approval artifact instead of comparing it to that
   * profile-local value.
   */
  const isCurrentSessionSpawnExecutionTarget = (executionTarget: SessionExecutionTargetV1,
    selectedTarget?: SessionExecutionTargetV1): boolean => {
    if (selectedTarget && (selectedTarget.machineId !== executionTarget.machineId
      || !isSameActionHomeId(selectedTarget.serverId))) return false;
    const directTargetTransport = params.sessionSpawnDirectTargetTransport;
    if (directTargetTransport?.machineId === executionTarget.machineId) {
      return true;
    }
    // Retained plugin recipes carry portable Home identities too. Use the
    // same captured Home equivalence as other Actions before target I/O.
    return isSameActionHomeId(executionTarget.serverId)
      && (params.serverId !== undefined || configuration.activeServerId === projectHomeId);
  };

  /**
   * One exact-target bridge to the daemon-owned preparation RPC. Both the
   * Action approval probe and the eventual V2 spawn consume this owner; no
   * caller resolves a remote path or synthesizes its directory state.
   */
  const prepareSessionSpawnTarget = async (input: Readonly<{
    executionTarget: Readonly<{ serverId: string; machineId: string }>;
    directory: SessionCreationTargetPreparationRequestV1['directory'];
    sessionCreationTag?: SessionCreationTargetPreparationRequestV1['sessionCreationTag'];
    checkoutCreationDraft?: SessionCreationTargetPreparationRequestV1['checkoutCreationDraft'];
    context?: ActionExecutorContext;
    signal?: AbortSignal;
  }>): Promise<SessionSpawnTargetPreparation> => {
    if (!params.credentials) {
      return {
        ok: false,
        result: { type: 'error', code: 'permission_denied', retryable: false },
      };
    }
    if (input.signal?.aborted) {
      return {
        ok: false,
        result: { type: 'error', code: 'cancelled', retryable: true },
      };
    }

    const directTargetTransport = params.sessionSpawnDirectTargetTransport?.machineId === input.executionTarget.machineId
      ? params.sessionSpawnDirectTargetTransport : undefined;

    let rawPreparedTarget: unknown;
    try {
      rawPreparedTarget = directTargetTransport && !needsSessionCreationDirectoryApprovalPreflightV1(input)
        ? await directTargetTransport.prepare(
          {
            directory: input.directory,
            ...(input.sessionCreationTag ? { sessionCreationTag: input.sessionCreationTag } : {}),
            ...(input.checkoutCreationDraft !== undefined
              ? { checkoutCreationDraft: input.checkoutCreationDraft }
              : {}),
          },
          input.signal ? { signal: input.signal } : undefined,
        )
        : await callMachineAction({
            machineId: input.executionTarget.machineId,
            exactMachine: true,
            ...(input.context ? { context: input.context, effectActionId: 'session.spawn_new' } : {}),
            method: needsSessionCreationDirectoryApprovalPreflightV1(input)
              ? RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT : RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE,
            request: {
              directory: input.directory,
              ...(needsSessionCreationDirectoryApprovalPreflightV1(input) ? { prepareAgentIsolationMember: true as const } : {}),
              ...(input.sessionCreationTag ? { sessionCreationTag: input.sessionCreationTag } : {}),
              ...(input.checkoutCreationDraft !== undefined
                ? { checkoutCreationDraft: input.checkoutCreationDraft }
                : {}),
            },
            ...(input.signal ? { signal: input.signal } : {}),
          });
    } catch (error) {
      if (input.signal?.aborted) {
        return {
          ok: false,
          result: { type: 'error', code: 'cancelled', retryable: true },
        };
      }
      const refusal = projectSessionCreationTargetPreparationRpcFailureV1(error);
      if (refusal) return { ok: false, result: refusal };
      if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        return {
          ok: false,
          result: incompatibleSessionSpawnTarget('target_preparation_rpc_unavailable'),
        };
      }
      const [{ MachineRpcTargetNotCurrentError }, { projectSessionSpawnFailure }] = await Promise.all([
        import('@/session/transport/rpc/machineRpc'), import('./projectSessionSpawnFailure'),
      ]);
      const targetRefusal = error instanceof MachineRpcTargetNotCurrentError ? error : null;
      const targetRpcCause = readSessionCreationTargetRpcCause(error);
      const failure = projectSessionSpawnFailure({
        errorCode: targetRefusal?.code ?? targetRpcCause?.code ?? 'SPAWN_FAILED',
        errorMessage: targetRefusal?.reason ?? targetRpcCause?.message ?? 'Session target preparation failed',
        ...(targetRpcCause ? { errorDetail: {
          kind: 'launch_error', code: targetRpcCause.code, message: targetRpcCause.message,
          ...(targetRpcCause.rpcErrorCode ? { rpcErrorCode: targetRpcCause.rpcErrorCode } : {}),
        } } : {}),
      });
      return {
        ok: false,
        // The strict update-required refusal carries no lower-layer cause.
        result: failure.code === 'update_required' ? failure
          : { ...failure, failureCause: projectActionFailureCauseV1(error, 'session.target_preparation') },
      };
    }

    return readSessionCreationTargetPreparationResultV1(rawPreparedTarget);
  };
  return {
    prepareSessionSpawnNewInput: createPrepareSessionSpawnInput(params, {
      serverId: projectHomeId, serverHttpBaseUrl: machineReferenceServerUrl,
    }, { spawnConnectedServicesList }),
    sessionSpawnNewDirectoryApprovalPreflight: async ({ input, context, signal }) => {
      if (!params.credentials) {
        return {
          type: 'error' as const,
          result: { type: 'error' as const, code: 'permission_denied' as const, retryable: false },
        };
      }
      if (signal?.aborted) {
        return {
          type: 'error' as const,
          result: { type: 'error' as const, code: 'cancelled' as const, retryable: true },
        };
      }
      if (!isCurrentSessionSpawnExecutionTarget(input.executionTarget)) {
        return {
          type: 'error' as const,
          result: { type: 'error' as const, code: 'target_unavailable' as const, retryable: false },
        };
      }
      if (!needsSessionCreationDirectoryApprovalPreflightV1(input)) {
        // A worktree is materialized by the SCM owner, not by the raw
        // directory-creation authorization path.
        return { type: 'not_required' as const };
      }

      const preparation = await prepareSessionSpawnTarget({
        executionTarget: input.executionTarget,
        directory: input.directory,
        ...(context ? { context } : {}),
        ...(signal ? { signal } : {}),
      });
      if (!preparation.ok) {
        return { type: 'error' as const, result: preparation.result };
      }
      const approval = projectSessionCreationDirectoryApprovalV1(input.executionTarget, preparation.preparedTarget);
      const preparedTarget = preparation.preparedTarget;
      return approval ? { type: 'approval_required' as const, approval, preparedTarget }
        : { type: 'not_required' as const, preparedTarget };
    },
    sessionSpawnNew: async (input, continuation) => {
      const reviewedOpinionSpawn = input.context?.externalActionExecutionAuthorization?.binding.actionId === 'discussion.second_opinion.start';
      if (!continuation && input.admittedInput && params.credentials
        && params.credentials.credentialProvenance !== 'api_token'
        && isSameActionHomeId(input.admittedInput.executionTarget.serverId)
        && (reviewedOpinionSpawn || params.sessionSpawnDirectTargetTransport?.machineId !== input.executionTarget.machineId)) {
        const { resolveLiveDaemonControlTargetForServer } = await import("@/daemon/multiDaemon");
        const localDaemon = reviewedOpinionSpawn ? null
          : await resolveLiveDaemonControlTargetForServer(projectHomeId).catch(() => null);
        const ownsRequestedMachine = localDaemon?.accountId === readAccountIdFromToken(params.credentials.token)
          && localDaemon?.machineId === input.executionTarget.machineId;
        if (!ownsRequestedMachine) {
          try {
            const { dispatchRequesterSessionSpawnNewRpc } = await import("@/session/transport/rpc/machineRpc");
            const dispatched = await dispatchRequesterSessionSpawnNewRpc({ credentials: params.credentials, input: input.admittedInput,
              context: input.context, serverId: input.admittedInput.executionTarget.serverId, serverUrl: machineReferenceServerUrl,
              serverIdentityId: params.serverIdentityId ?? input.context?.serverIdentityId,
              ...(params.externalActionMachineInstallationId
                ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId } : {}),
              ...(params.externalActionMachineRequestPrivateKey
                ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey } : {}),
              ...(params.onRequesterSessionCredentialDisclosure
                ? { onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure } : {}),
            });
            if (dispatched) return dispatched.ok ? dispatched.result : dispatched;
          } catch (error) {
            const errorCode = input.signal?.aborted ? 'cancelled' : 'target_unavailable';
            return { ok: false, errorCode, error: errorCode,
              failureCause: projectActionFailureCauseV1(error, 'session.requester_dispatch') };
          }
        }
      }
      const {
      context,
      creationAuthorization: admittedCreationAuthorization,
      callerInputConstraints,
      executionTarget,
      directory,
      initialAccess,
      initialTriggers,
      initialSessionRolesV1: requestedInitialSessionRolesV1,
      roleId,
      manager,
      primaryTeamId,
      teamCredentialBindings,
      organizationPlacement,
      projectContext,
      placementOrigin,
      managedTargetPlacement: authoredManagedTargetPlacement,
      isolationOverride,
      authoringOrigin,
      agentTarget,
      modelSelection: requestedModelSelection,
      profileId,
      secretReferenceOverlay,
      permissionMode: requestedPermissionMode,
      allowedTools,
      unlistedTools,
      agentModeId,
      configuration: requestedConfigurationSnapshot,
      connectedServices: requestedConnectedServices,
      capabilitySelection,
      transcriptStorage,
      terminal,
      checkoutCreationDraft,
      title,
      identity,
      attestedContext,
      memoryEnabled,
      approvalProfileId,
      promptStack,
      managedCreation: authoredManagedCreation,
      discussionParticipant,
      discussionParticipantLaunch: admittedDiscussionLaunch,
      initialInput: authoredInitialInput,
      agentSessionStartupInstructionsV1,
      environmentVariables,
      sessionCreationTag: requestedSessionCreationTag,
      sourceContext,
      legacyMetadataLabel,
      actionCaller,
      callerSurface,
      actionRequestId,
      resumeActionRequest,
      sessionCreationDirectoryApproval,
      workDepth,
      originKind,
      originSessionId,
      originRunId,
      signal,
      } = input;
      const managedTargetPlacement = authoredManagedTargetPlacement;
      const managedCreation = authoredManagedCreation;
      const onboardingInput = continuation?.hostOnboarding
        ? buildHostOnboardingInput(continuation.hostOnboarding) : null;
      const initialInput = onboardingInput?.initialInput ?? authoredInitialInput;
      const prepareSpawn = context?.externalActionExecutionAuthorization?.binding.actionId === 'deployments.prepare';
      const creationAuthorization = prepareSpawn
        ? input.admittedInput && params.externalActionMachineInstallationId && params.externalActionMachineRequestPrivateKey
          ? createPrepareSessionCreationAuthorization({ context: context!, publicInput: input.admittedInput,
            installationId: params.externalActionMachineInstallationId, privateKey: params.externalActionMachineRequestPrivateKey })
          : null
        : context?.externalActionExecutionAuthorization?.binding.actionId === 'discussion.second_opinion.start'
        ? input.admittedInput && params.externalActionMachineInstallationId && params.externalActionMachineRequestPrivateKey
          ? createReviewedSecondOpinionSessionCreationAuthorization({ context, publicInput: input.admittedInput,
            installationId: params.externalActionMachineInstallationId, privateKey: params.externalActionMachineRequestPrivateKey })
          : null
        : admittedCreationAuthorization;
      if ((prepareSpawn || context?.externalActionExecutionAuthorization?.binding.actionId === 'discussion.second_opinion.start') && !creationAuthorization) {
        return { ok: false, errorCode: 'permission_denied', error: 'permission_denied', effectAttempted: false,
          failureCause: projectActionFailureCauseV1({ name: 'Error', code: 'permission_denied' }, 'session.creation.authorization') };
      }
      const birthContext = params.sessionSpawnBirthContext;
      const sessionCreationTag = birthContext?.sessionCreationTag ?? requestedSessionCreationTag;
      let initialSessionRolesV1 = birthContext?.initialSessionRolesV1 ?? requestedInitialSessionRolesV1;
      let configurationSnapshot = requestedConfigurationSnapshot;
      const discussionParticipantLaunch = discussionParticipant
        ? admittedDiscussionLaunch ?? projectDiscussionModelParticipantLaunchV1(input)
        : undefined;
      const sessionAllowedTools = allowedTools ?? configurationSnapshot?.allowedTools;
      const sessionUnlistedTools = unlistedTools ?? configurationSnapshot?.unlistedTools;
      if (!params.credentials) {
        return { type: 'error', code: 'permission_denied', retryable: false };
      }
      const requesterHttpAuthorization = onboardingInput && context?.externalActionCredential
        && context.externalActionExecutionAuthorization?.binding.actionId === BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1
        ? (request: Readonly<{ method: string; path: string; body?: unknown }>) => {
            const headers = resolveServerRequestHeaders(context, BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1, request);
            if (!headers) throw Object.assign(new Error('Requester HTTP authorization unavailable'), { code: 'permission_denied' });
            return headers;
          }
        : undefined;
      const requesterAccountId = context?.externalActionExecutionAuthorization?.binding.accountId
        ?? context?.externalActionCredential?.accountId;
      const requesterCurrentnessCredentials = requesterAccountId !== readAccountIdFromToken(params.credentials.token)
        ? { ...params.credentials, encryption: null }
        : params.credentials;
      const requesterCredentials = requesterHttpAuthorization ? requesterCurrentnessCredentials : params.credentials;
      const templateOnboardingAdmission = onboardingInput
        ? createTemplateHostOnboardingAdmissionTransport({ credentials: params.credentials,
          ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
          ...(requesterHttpAuthorization ? { authorizeRequest: requesterHttpAuthorization } : {}) })
        : undefined;
      const machineAdmissionTransport = templateOnboardingAdmission ?? params.machineAdmissionTransport;
      if (signal?.aborted) {
        return { type: 'error', code: 'cancelled', retryable: true };
      }
      if ((initialInput?.attachments?.length ?? 0) > 0 && actionCaller.kind !== 'plugin') {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      const externalRequest = context?.externalActionCredential !== undefined
        || context?.externalActionExecutionAuthorization !== undefined;
      let accountEncryptionCurrentness = readRequesterAccountActionContext(context?.externalActionExecutionAuthorization)
        ?.accountEncryptionCurrentness;
      if (externalRequest && !accountEncryptionCurrentness) {
        const authorizationHeaders = requesterHttpAuthorization
          ? requesterHttpAuthorization({ method: 'GET', path: '/v1/account/encryption/currentness' })
          : onboardingInput ? { Authorization: `Bearer ${params.credentials.token}` }
          : resolveServerRequestHeaders(context, 'session.spawn_new', {
          method: 'GET', path: '/v1/account/encryption/currentness',
        });
        if (!authorizationHeaders) {
          return { type: 'error', code: 'permission_denied', retryable: false };
        }
        accountEncryptionCurrentness = await fetchAccountEncryptionCurrentness({
          // A signed requester read cannot borrow the installed custodian's
          // custody. Prepared requester material is already admitted above.
          credentials: requesterCurrentnessCredentials,
          token: params.credentials.token,
          ...(params.serverHttpBaseUrl ? { serverBaseUrl: params.serverHttpBaseUrl } : {}),
          authorizationHeaders,
          ...(signal ? { signal } : {}),
        });
      }
      if (initialInput && !machineAdmissionTransport) {
        // New Sessions use persisted Account mode, never the parent's mode or
        // credential key presence. Existing Session sends read their own mode.
        const { buildSessionSpawnInitialInputAdmissionForLocalIdV1, requiresMachineAdmissionForSessionInput } = await import("@/session/services/sessionInputAdmissionIdentity");
        accountEncryptionCurrentness ??= await fetchAccountEncryptionCurrentness({
          credentials: params.credentials, token: params.credentials.token,
          ...(params.serverHttpBaseUrl ? { serverBaseUrl: params.serverHttpBaseUrl } : {}),
          ...(signal ? { signal } : {}),
        });
        const { inputAdmission } = onboardingInput?.buildInitialInputHandoff?.(sessionCreationTag)
          ?? buildSessionSpawnInitialInputAdmissionForLocalIdV1({
          actionCaller,
          callerSurface,
          callerAuthority: context?.authority,
          ...(context?.actionRequestAttributionV1 ? { actionRequestAttributionV1: context.actionRequestAttributionV1 } : {}),
          // Only admission facts are inspected here; the creator owns the
          // actual first-input local id after settling the Session identity.
          localId: sessionCreationTag,
        });
        if (requiresMachineAdmissionForSessionInput({
          request: inputAdmission.request,
          mode: accountEncryptionCurrentness.mode,
          ...(context?.externalActionExecutionAuthorization
            ? { callerInputAuthorization: context.externalActionExecutionAuthorization }
            : {}),
        })) {
          const [{ MachineAdmissionTransportUnavailableError }, { SPAWN_SESSION_ERROR_CODES }] = await Promise.all([import("@/daemon/machineAdmissionTransport"), import("@/session/shared/spawnSessionContract")]);
          const cause = new MachineAdmissionTransportUnavailableError();
          // Refuse unadmittable protected input before a Session exists.
          throw Object.assign(new Error(cause.message, { cause }), {
            code: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
          });
        }
      }

      if (!isCurrentSessionSpawnExecutionTarget(executionTarget,
        birthContext?.sessionPlacement?.kind === 'machine' ? birthContext.sessionPlacement.target : undefined)) {
        return { type: 'error', code: 'target_unavailable', retryable: false };
      }
      if (managedCreation) {
        // The retained resource is a private preset fact. A public read may
        // establish placement but cannot prove this Session may use it.
        if (!params.credentials) {
          return { type: 'error', code: 'target_unavailable', retryable: false };
        }
        try {
          const { readManagedMachineFull } = await import("@/machines/managed/readManagedMachine");
          const retained = await readManagedMachineFull({ credentials: params.credentials,
            serverHttpBaseUrl: machineReferenceServerUrl, homeId: managedCreation.homeId,
            managedId: managedCreation.managedId, signal,
            ...(context?.externalActionExecutionAuthorization
              ? { authorization: context.externalActionExecutionAuthorization } : {}),
          });
          if (retained.homeId !== managedCreation.homeId || retained.id !== managedCreation.managedId
            || !sameStrictJsonValue(retained.controller, managedCreation.controller)
            || retained.creationState !== 'active' || retained.archivedAt !== undefined
            || retained.allocation !== 'bound' || !retained.resource
            || (retained.enrolledMachineId !== executionTarget.machineId
              && !(retained.acquisitionMode === 'resource-bound'
                && retained.controller?.machineId === executionTarget.machineId
                && retained.custodianAccountId === (context?.externalActionExecutionAuthorization?.binding.accountId
                  ?? readAccountIdFromToken(params.credentials.token))))) {
            return { type: 'error', code: 'invalid_input', retryable: false };
          }
        } catch (error) {
          const failureCause = projectActionFailureCauseV1(error, 'session.managed_target');
          return isAuthenticationError(error)
            ? { type: 'error', code: 'permission_denied', retryable: false, failureCause }
            : { type: 'error', code: 'spawn_failed', retryable: true, failureCause };
        }
      }
      const normalizedActionRequestId = normalizeStringValue(actionRequestId);
      if (resumeActionRequest === true && !normalizedActionRequestId) {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      const [{ createStableSpawnNonce }, { buildSessionCreationCorrespondence }] = await Promise.all([import("@/session/shared/spawnNonce"), import("@/session/shared/sessionCreationCorrespondence")]);
      const spawnNonce = birthContext?.spawnNonce ?? (normalizedActionRequestId
        ? createStableSpawnNonce('session.spawn_new.action', { actionRequestId: normalizedActionRequestId })
        : undefined);

      const directTargetTransport = params.sessionSpawnDirectTargetTransport?.machineId === executionTarget.machineId
        ? params.sessionSpawnDirectTargetTransport : undefined;
      let placementOriginSupported = Boolean(directTargetTransport);
      let authoringOriginSupported = Boolean(directTargetTransport);
      let secretReferenceOverlaySupported = Boolean(directTargetTransport);
      if (onboardingInput || !directTargetTransport) {
        let targetCapabilityProjection: Awaited<ReturnType<typeof readMachineOperationProtocolCapabilitiesV1>>;
        try {
          const { readMachineOperationProtocolCapabilitiesV1 } = await import("@/api/machine/machineOperationProtocolCapabilities");
          targetCapabilityProjection = await readMachineOperationProtocolCapabilitiesV1({
            credentials: params.credentials,
            machineId: executionTarget.machineId,
            ...(requesterHttpAuthorization ? { authorizeRequest: requesterHttpAuthorization } : {}),
            ...(signal ? { signal } : {}),
          });
        } catch (error) {
          const failureCause = projectActionFailureCauseV1(error, 'session.target_capabilities');
          const spawnMayHaveBeenAccepted = hasPossiblyAcceptedSpawnNonce(error);
          if (signal?.aborted) {
            if (spawnMayHaveBeenAccepted) {
              return {
                type: 'pending',
                retryWithSameCreationKey: true,
                outcome: 'unknown',
              };
            }
            return { type: 'error', code: 'cancelled', retryable: true, failureCause };
          }
          if (isAuthenticationError(error)) {
            return { type: 'error', code: 'permission_denied', retryable: false, failureCause };
          }
          return { type: 'error', code: 'machine_offline', retryable: true, failureCause };
        }
        if (
          !targetCapabilityProjection
          || !supportsMachineOperationProtocolCapabilityV1(
            targetCapabilityProjection.capabilities,
            'sessionSpawn',
          )
        ) {
          if (initialSessionRolesV1 !== undefined) {
            return {
              type: 'error', code: 'update_required', retryable: false,
              details: {
                kind: 'update_required', operation: 'session.spawn_new', component: 'daemon',
                reason: 'session_roles_snapshot_update_required',
              },
            };
          }
          if (initialAccess !== undefined || primaryTeamId !== undefined) {
            return {
              type: 'error', code: 'update_required', retryable: false,
              details: new SessionInitialAccessUpdateRequiredError('daemon').details,
            };
          }
          return incompatibleSessionSpawnTarget('session_spawn_protocol_unavailable');
        }
        placementOriginSupported = supportsMachineOperationProtocolCapabilityV1(
          targetCapabilityProjection.capabilities,
          'sessionSpawnPlacementOrigin',
        );
        authoringOriginSupported = supportsMachineOperationProtocolCapabilityV1(
          targetCapabilityProjection.capabilities,
          'sessionSpawnAuthoringOrigin',
        );
        secretReferenceOverlaySupported = supportsMachineSessionSpawnProtocolVersionV1(
          targetCapabilityProjection.capabilities,
          2,
        );
      }
      if (authoringOrigin !== undefined && !authoringOriginSupported) {
        return { type: 'error', code: 'update_required', retryable: false,
          details: { kind: 'update_required', operation: 'session.spawn_new', component: 'daemon',
            reason: 'session_spawn_authoring_origin_update_required' } };
      }
      if (secretReferenceOverlay && !secretReferenceOverlaySupported) {
        return {
          type: 'error',
          code: 'update_required',
          retryable: false,
          details: {
            kind: 'update_required',
            operation: 'session.spawn_new',
            component: 'daemon',
            reason: 'session_secret_reference_overlay_update_required',
          },
        };
      }

      const { resolveSessionCreationAgentTarget } = await import("@/session/creation/resolveSessionCreationAgentTarget");
      const resolvedAgentTarget = resolveSessionCreationAgentTarget(agentTarget);
      if (!resolvedAgentTarget) {
        return { type: 'error', code: 'target_unavailable', retryable: false,
          failureCause: projectActionFailureCauseV1({ name: 'Error', code: 'agent_contribution_unavailable' }, 'session.agent_target') };
      }
      const { backendTarget } = resolvedAgentTarget;
      // The receiving daemon resolves unset facets once. UI preview values
      // already sent by New Session are explicit choices; file policy locks
      // still win at this canonical effect owner.
      const admittedRequester = readRequesterAccountActionContext(context?.externalActionExecutionAuthorization);
      if (externalRequest && !admittedRequester && requesterAccountId
        && requesterAccountId !== readAccountIdFromToken(params.credentials.token)) {
        return { type: 'error', code: 'permission_denied', retryable: false };
      }
      const defaultsCustody = resolveRequesterSavedSecretActionCustody({
        authorization: context?.externalActionExecutionAuthorization, credentials: params.credentials,
        operationContext: params.savedSecretOperationContext,
      });
      const defaultsCredentials = defaultsCustody.credentials;
      const defaultsOperation = defaultsCustody.operation;
      const retainedSettings = defaultsOperation?.readSnapshot();
      if (defaultsOperation && !retainedSettings) {
        return { type: 'error', code: 'permission_denied', retryable: false };
      }
      const defaultsContext = retainedSettings ?? await runWithServerHttpBaseUrl(machineReferenceServerUrl,
        () => bootstrapAccountSettingsContext({ credentials: defaultsCredentials, mode: 'blocking', publication: 'invocation',
          deps: { applySideEffects: () => undefined }, ...(signal ? { signal } : {}) }));
      const operation = defaultsOperation ?? createInvocationSavedSecretOperationContextV1({
        credentials: defaultsCredentials, snapshot: defaultsContext, serverHttpBaseUrl: machineReferenceServerUrl,
        isCurrent: async () => admittedRequester ? admittedRequester.isCurrent()
          : params.isCredentialCurrent ? params.isCredentialCurrent()
          : (await readStoredCredentials())?.token === defaultsCredentials.token,
      });
      const purposeCatalog = agentSupportsSpawnConnectedServicesDefaults(resolvedAgentTarget.agentId)
        ? defaultsContext.connectedPurposeCatalog?.status === 'ready' ? defaultsContext.connectedPurposeCatalog
          : await refreshConnectedAccountCatalogForAdmission({ credentials: defaultsCredentials, key: 'purposes',
            operationContext: operation, ...(signal ? { signal } : {}) })
        : undefined;
      if (purposeCatalog && purposeCatalog.status !== 'ready') {
        throw new ConnectedServicesDefaultUnavailableError('connected_account_purpose_catalog_unavailable', 'purpose_binding',
          purposeCatalog.status === 'unavailable' ? purposeCatalog.reason : undefined);
      }
      const defaultsSettings = operation.readSnapshot()?.settings ?? defaultsContext.settings;
      const homeActions = createAccountServerActionDeps({ token: defaultsCredentials.token, credentials: defaultsCredentials,
        serverId: executionTarget.serverId, serverHttpBaseUrl: machineReferenceServerUrl });
      const contextLoader = createCliManagedSessionDefaultsContextLoader({ credentials: defaultsCredentials,
        serverId: executionTarget.serverId, serverHttpBaseUrl: machineReferenceServerUrl, ...(signal ? { signal } : {}) });
      const { createSpawnConnectedServicesTeamResourceCatalogResolver } = await import('@/session/services/spawnConnectedServicesDefaults');
      let openedMachineMetadata: unknown;
      if (!sourceContext && !configurationSnapshot?.providerSessionResume) {
        if (directTargetTransport?.readMachineMetadataSnapshot) {
          const snapshot = directTargetTransport.readMachineMetadataSnapshot();
          if (snapshot.status !== 'ready') return { type: 'error', code: 'target_unavailable', retryable: true };
          openedMachineMetadata = snapshot.metadata;
        } else {
          try {
            const { ApiClient } = await import('@/api/api');
            const api = await ApiClient.create(defaultsCredentials);
            const machine = await runWithServerHttpBaseUrl(machineReferenceServerUrl,
              () => api.getMachine(executionTarget.machineId, {
                ...(context?.externalActionExecutionAuthorization ? { authorization: context.externalActionExecutionAuthorization } : {}),
                effectActionId: 'session.spawn_new', ...(signal ? { signal } : {}),
              }));
            if (!machine) return { type: 'error', code: 'target_unavailable', retryable: true };
            openedMachineMetadata = machine.metadata;
            if (!openedMachineMetadata || typeof openedMachineMetadata !== 'object' || Array.isArray(openedMachineMetadata)) {
              return { type: 'error', code: 'target_unavailable', retryable: true };
            }
          } catch {
            signal?.throwIfAborted();
            return { type: 'error', code: 'target_unavailable', retryable: true };
          }
        }
      }
      const machineIsolation = readMachineIsolationV1(openedMachineMetadata);
      const defaults = await resolveSessionSpawnManagedDefaults({ executionTarget, agentTarget, projectContext,
        approvalProfileId, primaryTeamId, initialAccess, teamCredentialBindings,
        permissionMode: requestedPermissionMode, modelSelection: requestedModelSelection,
        configuration: configurationSnapshot,
        connectedServices: birthContext?.connectedServices === null ? null : requestedConnectedServices,
        identity, attestedContext, isolationOverride, sourceContext }, {
        agentId: resolvedAgentTarget.agentId, accountSettings: defaultsSettings,
        openedMachineMetadata, startContext: context,
        ...(context?.sessionCreationDefaults ? { capturedContext: context.sessionCreationDefaults.context,
          authoredChoices: context.sessionCreationDefaults.authoredChoices } : {}),
        ...(birthContext?.sessionPlacement ? { admittedWorkflowPlacement: birthContext.sessionPlacement } : {}),
        nativeSandboxAvailable: resolvedAgentTarget.nativeSandboxAvailable, machineIsolation,
        ...(purposeCatalog ? { purposeCatalog } : {}),
        organizationPolicy: configuration.organizationPolicy,
        ...contextLoader,
        resolveTeamCredentialResourceCatalog: createSpawnConnectedServicesTeamResourceCatalogResolver({
          homeDomainAction: homeActions.homeDomainAction!, serverId: executionTarget.serverId,
          accountId: readAccountIdFromToken(defaultsCredentials.token) ?? '',
        }),
        ...(signal ? { signal } : {}),
      });
      // The receiving daemon was admitted once; organization placement can refuse it.
      if (defaults.placement.lock && (defaults.placement.value?.kind === 'machine'
        ? !sameStrictJsonValue(defaults.placement.value.target, executionTarget)
        : !context?.sessionCreationDefaults?.managedPresetAcquisition)) {
        return { type: 'error', code: 'permission_denied', retryable: false };
      }
      const { permissionMode, modelSelection, connectedServices } = defaults;
      const retainsConfiguration = sourceContext !== undefined || configurationSnapshot?.providerSessionResume !== undefined;
      const selectedApprovalProfileId = retainsConfiguration ? approvalProfileId : defaults.approvalProfileId;
      const selectedApprovalProfileTeamOrGroupDerived = retainsConfiguration ? undefined : defaults.approvalProfileTeamOrGroupDerived;
      const selectedPrimaryTeamId = primaryTeamId ?? defaults.primaryTeamId;
      const configurationWithNativeSandbox = (nativeSandbox: typeof defaults.nativeSandbox) =>
        withSessionNativeSandbox(configurationSnapshot, nativeSandbox);
      configurationSnapshot = configurationWithNativeSandbox(defaults.nativeSandbox);
      // Root starts have no lead snapshot. Bind the selected Account role at
      // the native spawn owner before the launch contract drops Action roleId.
      if (roleId && initialSessionRolesV1 === undefined) {
        await prepareAccountRoleOverrides(signal);
        const inventory = await readRoleSources(signal);
        const overrides = readAccountRoleOverrides();
        if (overrides.status !== 'ready') return { ok: false, errorCode: 'account_role_overrides_unavailable', error: 'account_role_overrides_unavailable' };
        if (inventory.status !== 'ready') return { ok: false, errorCode: 'role_source_incomplete', error: 'role_source_incomplete' };
        const roles = resolveRolesSnapshotV1({ roleSourceInventory: inventory, settingsOverrides: overrides.overrides,
          defaultEngine: { agentTargetKey: buildBackendTargetKeyV2(agentTarget),
            ...(modelSelection?.ref.modelId ? { modelId: modelSelection.ref.modelId } : {}) },
        });
        if (!roles[roleId]) return { ok: false, errorCode: 'role_target_unavailable', error: 'role_target_unavailable' };
        initialSessionRolesV1 = { roleId, overrides: {}, sessionRoles: roles, notes: '' };
      }
      if (signal?.aborted) {
        return { type: 'error', code: 'cancelled', retryable: true };
      }
      const resolvedConnectedServices = connectedServices;
      const resolvedConnectedServicesUpdatedAt = defaults.connectedServicesUpdatedAt;
      const resolvedTeamCredentialBindings = defaults.teamCredentialBindings;
      const normalizedPlacement =
        normalizeSessionCreationOrganizationPlacementV1(organizationPlacement);
      const normalizedTerminal = terminal === undefined
        ? undefined
        : SessionAuthoringTerminalV1Schema.safeParse(terminal);
      if (normalizedTerminal !== undefined && !normalizedTerminal.success) {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      const spawnTerminal = projectSessionAuthoringTerminalForSpawn(normalizedTerminal?.data);
      const windowsTerminal = normalizedTerminal?.data.windows;
      const normalizedConfigurationOverrides = configurationSnapshot
        ? buildAcpConfigOptionOverridesV1({
            updatedAt: Math.max(
              configurationSnapshot.mode.updatedAtMs,
              configurationSnapshot.model.updatedAtMs,
              configurationSnapshot.permissionIntent.updatedAtMs,
              ...Object.values(configurationSnapshot.options).map((entry) => entry.updatedAtMs),
            ),
            overrides: Object.fromEntries(
              Object.entries(configurationSnapshot.options).map(([key, entry]) => [
                key,
                { updatedAt: entry.updatedAtMs, value: entry.value },
              ]),
            ),
          })
        : undefined;
      const resolvedModelSelection = modelSelection;
      const resolvedPermissionMode = permissionMode;
      const resolvedAgentModeId = agentModeId
        ?? configurationSnapshot?.mode.value
        ?? undefined;
      const startupInstructionsMarker = agentSessionStartupInstructionsV1
        ? {
            v: agentSessionStartupInstructionsV1.v,
            id: agentSessionStartupInstructionsV1.id,
            revision: agentSessionStartupInstructionsV1.revision,
          }
        : null;
      const targetPreparation: SessionSpawnTargetPreparation = context?.sessionCreationPreparedTarget
        ? { ok: true, preparedTarget: context.sessionCreationPreparedTarget }
        : await prepareSessionSpawnTarget({
          executionTarget,
          directory,
          sessionCreationTag,
          ...(context ? { context } : {}),
          ...(checkoutCreationDraft !== undefined ? { checkoutCreationDraft } : {}),
          ...(signal ? { signal } : {}),
        });
      if (!targetPreparation.ok) return targetPreparation.result;
      const preparedTarget = targetPreparation.preparedTarget;
      // A created receipt is not current exclusive custody. Pre-spawn failures
      // retain the checkout; deleting files remains an explicit SCM operation.
      if (signal?.aborted) {
        return { type: 'error', code: 'cancelled', retryable: true };
      }
      const directoryApproval = SessionCreationDirectoryApprovalV1Schema.safeParse(
        sessionCreationDirectoryApproval,
      );
      if (
        preparedTarget.directoryCreationRequired
        && (
          !directoryApproval.success
          || directoryApproval.data.executionTarget.serverId !== executionTarget.serverId
          || directoryApproval.data.executionTarget.machineId !== executionTarget.machineId
          || directoryApproval.data.directory !== preparedTarget.directory
        )
      ) {
        return { type: 'error', code: 'permission_denied', retryable: false };
      }
      const normalizedDirectory = preparedTarget.directory;
      if (input.machineSetupPlanInput) {
        const children = SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1;
        const planInput = { ...input.machineSetupPlanInput, mode: 'effects' as const };
        const setupFailure = await applyMachineSetupBeforeAgent({
          planInput,
          plan: () => context!.hostReviewedChild!.invoke({ ...children.plan,
            input: projectNativeJsonValueForTransport(planInput) }),
          apply: operand => context!.hostReviewedChild!.invoke({ ...children.apply,
            input: projectNativeJsonValueForTransport(operand) }),
          observe: request => params.machineActionDirectTargetTransport!.invoke(ACTION_OPERATION_RPC_METHODS_V2.get, request,
            { ...(signal ? { signal } : {}), rpcContext: context }),
        });
        if (setupFailure) return setupFailure;
      }
      const agentReadiness = await prepareSessionAgentReadiness({
        machineId: executionTarget.machineId, serverId: executionTarget.serverId, agentId: resolvedAgentTarget.agentId,
        ...(agentTarget.definitionId === undefined ? {} : { definitionId: agentTarget.definitionId }),
        ...(input.agentInstallConsent === undefined ? {} : { consent: input.agentInstallConsent }),
        ...(normalizedActionRequestId ? { requestId: normalizedActionRequestId } : {}),
        invoke: input.invokeAgentReadinessAction, ...(signal ? { signal } : {}),
      });
      if (agentReadiness && 'result' in agentReadiness) return agentReadiness.result;
      const initialTriggerPreparationState: { failure?: unknown } = {};
      let cleanupInitialTriggerCustody: (() => Promise<void>) | undefined;
      const prepareInitialTriggers: Parameters<typeof createSpawnedSession>[0]['prepareInitialTriggers'] =
        !discussionParticipant && (identity?.bot?.kind === 'bot' || (initialTriggers && initialTriggers.length > 0)) ? async () => {
          try {
            const preparedDrafts = [...(initialTriggers ?? [])];
            if (identity?.bot?.kind === 'bot') {
              const settings = roleSettingsProvider.getAccountSettings?.();
              if (!settings) throw Object.assign(new Error('account_settings_content_unavailable'), { code: 'account_settings_content_unavailable' });
              if (settings.memoryUpkeepInNewBots) {
                const upkeep = getWorkflowStarterExamplesV1().find((example) => example.key === 'memory-upkeep-in-session');
                if (upkeep?.triggerSeed?.kind !== 'schedule') throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
                preparedDrafts.push({ target: { kind: 'inline', definition: upkeep.definition },
                  executionTarget: { kind: 'session' }, trigger: upkeep.triggerSeed });
              }
            }
            if (preparedDrafts.length === 0) return [];
            if (!workflowTriggers) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
            const prepared = await workflowTriggers.prepareSessionInitialTriggers({
              project: { machineId: executionTarget.machineId, directory: normalizedDirectory },
              initialTriggers: preparedDrafts,
              caller: {
                ...context,
                approvalProfileId: resolveInheritedApprovalProfileIdV1(selectedApprovalProfileId, context?.approvalProfileId),
                ...(actionCaller ? { actionCaller } : {}),
                ...(callerSurface ? { surface: callerSurface } : {}),
                ...(signal ? { signal } : {}),
              },
            });
            const retained = await params.workflowRequesterCustody?.retainInitialTriggers?.(prepared);
            cleanupInitialTriggerCustody = retained?.cleanupOnFailure;
            return prepared;
          } catch (error) {
            initialTriggerPreparationState.failure = error;
            throw error;
          }
        } : undefined;
      const immutableCheckout = preparedTarget.checkout
        ? {
            kind: preparedTarget.checkout.kind,
            finalDirectory: preparedTarget.checkout.finalDirectory,
            baseRef: preparedTarget.checkout.baseRef,
            branchMode: preparedTarget.checkout.branchMode,
            ...(preparedTarget.checkout.branchName !== undefined ? { branchName: preparedTarget.checkout.branchName } : {}),
          }
        : null;
      const correspondence = buildSessionCreationCorrespondence({
        identity: { sessionCreationTag },
        recipe: {
          execution: {
            machineId: executionTarget.machineId,
            directory: directory.kind === 'managed' ? directory : { kind: 'path', path: normalizedDirectory },
          },
          organization: normalizedPlacement,
          agentTarget,
          modelSelection: resolvedModelSelection ?? null,
          profileId: profileId ?? null,
          ...(identity !== undefined ? { identity } : {}),
          ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
          ...(selectedApprovalProfileId !== undefined ? { approvalProfileId: selectedApprovalProfileId,
            approvalProfileTeamOrGroupDerived: selectedApprovalProfileTeamOrGroupDerived ?? false } : {}),
          ...(promptStack !== undefined ? { promptStack } : {}),
          ...(managedCreation ? { managedCreation } : {}),
          ...(discussionParticipant ? { discussionParticipant } : {}),
          ...(secretReferenceOverlay ? { secretReferenceOverlay } : {}),
          ...(onboardingInput && checkoutCreationDraft ? { checkoutCreationDraft } : {}),
          requestedPermissionMode: resolvedPermissionMode ?? null,
          ...(sessionAllowedTools !== undefined ? { allowedTools: sessionAllowedTools } : {}),
          ...(sessionUnlistedTools !== undefined ? { unlistedTools: sessionUnlistedTools } : {}),
          agentModeId: resolvedAgentModeId ?? null,
          configuration: configurationSnapshot ?? null,
          connectedServices: resolvedConnectedServices ?? null,
          capabilitySelection: capabilitySelection ?? null,
          transcriptStorage: transcriptStorage ?? null,
          terminal: normalizedTerminal?.data ?? null,
          agentSessionStartupInstructionsMarkerV1: startupInstructionsMarker,
          checkout: immutableCheckout,
        },
      });
      const prepareSessionIsolation: Parameters<typeof createSpawnedSession>[0]['prepareSessionIsolation'] = async () => {
        const isolation = defaults.resolveIsolation();
        const sandboxChoice = isolation?.choice.kind === 'sandbox' ? isolation.choice : undefined;
        const resolveNativeSandbox = (sandboxTypeSupportsNativeSandbox?: boolean) => {
          const agentSandbox = resolveManagedAgentSandbox({
            machineIsolation: sandboxChoice && isolation?.configuredSandbox ? { environment: 'managed-guest',
              provisionerId: buildQualifiedPluginContributionKey(isolation.configuredSandbox.provisioner) } : machineIsolation,
            machineIsolationPolicy: isolation?.policy,
            sandboxTypeSupportsNativeSandbox,
            nativeSandboxAvailable: resolvedAgentTarget.nativeSandboxAvailable,
            explicitAgentSandbox: requestedConfigurationSnapshot?.nativeSandbox,
            retainedNativeProfile: requestedConfigurationSnapshot?.providerSessionResume !== undefined,
          });
          if (agentSandbox.availability?.status === 'unavailable') {
            const failure = { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
              failureCause: { phase: 'session.spawn_new', errorClass: 'Error', errorCode: 'target_unavailable', httpStatus: null,
                nativeErrorReason: agentSandbox.availability.reason } } satisfies ActionExecuteFailure;
            throw Object.assign(new Error('Agent native sandbox is unavailable', { cause: failure }), {
              code: failure.errorCode, failureCause: failure.failureCause,
            });
          }
          return agentSandbox.value;
        };
        let acquired: Awaited<ReturnType<NonNullable<typeof params.acquireSessionIsolationSandbox>>> | undefined;
        const presetAcquisition = context?.sessionCreationDefaults?.managedPresetAcquisition;
        if (presetAcquisition) {
          if (!isManagedPresetAcquireInputV1(presetAcquisition) || !context || !params.acquireSessionIsolationSandbox
            || !input.admittedInput || !input.executeSessionIsolationAcquire) {
            throw Object.assign(new Error('Selected preset acquisition is unavailable'), { code: 'target_unavailable' });
          }
          acquired = await params.acquireSessionIsolationSandbox({ acquisition: presetAcquisition,
            executeSessionIsolationAcquire: input.executeSessionIsolationAcquire,
            parent: { actionId: SESSION_SPAWN_NEW_ACTION_ID_V1, input: input.admittedInput },
            resolveNativeSandbox, context, ...(signal ? { signal } : {}),
          });
        } else if (sandboxChoice) {
          if (authoredManagedCreation) {
            throw Object.assign(new Error('Authored managed placement conflicts with Machine sandbox policy'),
              { code: 'target_unavailable' });
          }
          if (!isolation?.configuredSandbox || !context || !params.acquireSessionIsolationSandbox
            || !input.admittedInput || !input.executeSessionIsolationAcquire) {
            throw Object.assign(new Error('Machine sandbox acquisition is unavailable'), { code: 'target_unavailable' });
          }
          acquired = await params.acquireSessionIsolationSandbox({
            executeSessionIsolationAcquire: input.executeSessionIsolationAcquire,
            parent: { actionId: SESSION_SPAWN_NEW_ACTION_ID_V1, input: input.admittedInput },
            configuredSandbox: isolation.configuredSandbox, lifecycle: sandboxChoice.lifecycle,
            resolveNativeSandbox,
            context, ...(signal ? { signal } : {}),
          });
        }
        const nativeSandbox = acquired ? acquired.nativeSandbox : resolveNativeSandbox();
        return {
          sessionCreationCorrespondence: { ...correspondence, recipe: { ...correspondence.recipe,
            ...(acquired ? { managedCreation: acquired.managedCreation,
              managedCreationOrigin: presetAcquisition ? 'session_defaults' as const : 'machine_policy' as const } : {}),
            ...(nativeSandbox !== undefined && requestedConfigurationSnapshot?.nativeSandbox === undefined
              && (acquired || machineIsolation) ? {
                nativeSandboxOrigin: presetAcquisition ? 'session_defaults' as const : 'machine_policy' as const } : {}),
            configuration: configurationWithNativeSandbox(nativeSandbox) ?? null,
          } },
          ...(acquired ? { managedTargetPlacement: {
            managedId: acquired.managedCreation.managedId, workspaceRoot: normalizedDirectory } } : {}),
          ...(nativeSandbox !== undefined ? { nativeSandbox } : {}),
        };
      };
      // A source recipe is required semantics, not a hint: it is resolved to an
      // exact cutoff before any Session row exists, and a failure creates no
      // child so the authoring draft and its chip stay intact.
      let replaySeededCreation: ReplaySeededSessionCreationV1 | undefined;
      let managedDirectorySeed: Parameters<typeof createSpawnedSession>[0]['managedDirectorySeed'];
      if (sourceContext && resumeActionRequest !== true) {
        let sourceAuthority: Awaited<ReturnType<typeof resolveReplaySourceContextAuthority>>;
        try {
          const { resolveReplaySourceContextAuthority } = await import("@/session/replay/resolveReplaySourceContextAuthority");
          sourceAuthority = await resolveReplaySourceContextAuthority({
            credentials: params.credentials,
            sourceSessionId: sourceContext.sourceSessionId,
          });
        } catch (error) {
          const failureCause = projectActionFailureCauseV1(error, 'session.source_authority');
          return isAuthenticationError(error)
            ? { type: 'error', code: 'permission_denied', retryable: false, failureCause }
            : { type: 'error', code: 'spawn_failed', retryable: true, failureCause };
        }
        if (sourceAuthority.status !== 'owned') {
          return sourceAuthority.status === 'not_owned'
            ? { type: 'error', code: 'permission_denied', retryable: false }
            : { type: 'error', code: 'spawn_failed', retryable: true };
        }
        const sameMachine = sourceAuthority.sourceMachineId === executionTarget.machineId;
        if (directory.kind === 'managed' && sourceAuthority.managedSource && (
          sourceAuthority.sourceMachineId === null || (sameMachine && !sourceAuthority.managedDirectorySeed)
        )) {
          // A managed fork promises proven local file continuity or an explicit
          // cross-machine empty folder. Unknown locality cannot satisfy either.
          return { type: 'error', code: 'spawn_failed', retryable: true };
        }
        if (directory.kind === 'managed' && sameMachine) managedDirectorySeed = sourceAuthority.managedDirectorySeed;
        const filesNotCopied = directory.kind === 'managed' && sourceAuthority.sourceMachineId !== null && !sameMachine
          ? { reason: 'cross_machine' as const } : undefined;
        const { buildReplaySeededSpawnRecipe } = await import("@/session/replay/buildReplaySeededSpawnRecipe");
        const recipeResult = await buildReplaySeededSpawnRecipe({
          credentials: params.credentials,
          cwd: normalizedDirectory,
          source: {
            sourceSessionId: sourceContext.sourceSessionId,
            forkPoint: sourceContext.forkPoint,
          },
          agentHintAgentId: resolvedAgentTarget.agentId,
          // Source-local media survives only when the source and selected child
          // target are proven to be the same exact machine and this process is
          // directly preparing that target. A replacement relation or a direct
          // transport alone does not make an old workspace path usable.
          mediaContinuityUsableOnCreatingMachine:
            Boolean(directTargetTransport)
            && sourceAuthority.sourceMachineId === executionTarget.machineId,
        });
        if (!recipeResult.ok) {
          // The two recipe failures — an unhydratable source and an empty seed —
          // are not distinguishable at this owner, and neither created a child.
          // Report the retryable form so a transient source read does not strand
          // an otherwise valid authoring attempt.
          return { type: 'error', code: 'spawn_failed', retryable: true };
        }
        replaySeededCreation = {
          tag: sessionCreationTag,
          flavor: resolvedAgentTarget.agentId,
          metadata: {
            ...recipeResult.recipe.metadata,
            ...(filesNotCopied ? { forkV1: {
              ...(recipeResult.recipe.metadata.forkV1 && typeof recipeResult.recipe.metadata.forkV1 === 'object'
                ? recipeResult.recipe.metadata.forkV1 : {}),
              filesNotCopied,
            } } : {}),
            sessionCreationCorrespondenceV1: correspondence,
          },
          sourceRecipe: {
            sourceSessionId: sourceContext.sourceSessionId,
            cutoffSeqInclusive: recipeResult.recipe.cutoffSeqInclusive,
          },
        };
      }
      try {
        const [{ createSpawnedSession }, { buildSessionSpawnInitialInputAdmissionForLocalIdV1 }, { buildPluginSessionInputAttachmentDraftsV1 }] = await Promise.all([import("@/session/services/createSpawnedSession"), import("@/session/services/sessionInputAdmissionIdentity"), import("@/session/composer/admitPluginSessionInputAttachmentsV1")]);
        const created = await createSpawnedSession({
          ...(context?.operationAcceptance?.actionId === 'session.spawn_new'
            && context.operationAcceptance.previousSessionCreationFailure
            ? { previousSessionCreationFailure: context.operationAcceptance.previousSessionCreationFailure } : {}),
          ...(creationAuthorization ? { creationAuthorization } : {}),
          ...(callerInputConstraints ? { callerInputConstraints } : {}),
          credentials: requesterCredentials,
          ...(requesterHttpAuthorization ? { authorizeRequest: requesterHttpAuthorization } : {}),
          ...(accountEncryptionCurrentness ? { accountEncryptionCurrentness } : {}),
          serverId: executionTarget.serverId,
          serverIdentityId: context?.serverIdentityId ?? params.serverIdentityId,
          accountSettings: defaultsSettings,
          ...(workDepth !== undefined ? { workDepth } : {}),
          ...(discussionParticipant ? { originKind: 'discussion' as const, discussionParticipant, discussionParticipantLaunch }
            : originKind !== undefined ? { originKind, originSessionId, originRunId } : {}),
          directory: normalizedDirectory,
          directoryKind: preparedTarget.directoryKind,
          ...(managedDirectorySeed ? { managedDirectorySeed } : {}),
          ...(initialAccess !== undefined ? { initialAccess } : {}),
          ...(prepareInitialTriggers ? { prepareInitialTriggers } : {}),
          ...((promptStack?.length ?? 0) > 0 ? { preparePromptStack: async () => {
            const { resolveCliPromptStackSystemAppendBlocks } = await import("@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks");
            await resolveCliPromptStackSystemAppendBlocks({ surface: 'coding', sessionEntries: promptStack,
              credentials: params.credentials, serverId: executionTarget.serverId, ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
              ...(signal ? { signal } : {}) });
          } } : {}),
          ...(initialSessionRolesV1 !== undefined ? { initialSessionRolesV1 } : {}),
          ...(manager !== undefined ? { manager } : {}),
          ...(selectedPrimaryTeamId !== undefined ? { primaryTeamId: selectedPrimaryTeamId } : {}),
          ...(resolvedTeamCredentialBindings !== undefined
            ? { teamCredentialBindings: resolvedTeamCredentialBindings }
            : {}),
          machineId: executionTarget.machineId,
          backendTarget,
          ...(input.agentArgs !== undefined ? { agentArgs: input.agentArgs } : {}),
          ...(birthContext?.runtimeDescriptorV1 ? { runtimeDescriptorV1: birthContext.runtimeDescriptorV1 } : {}),
          sessionCreationTag,
          ...(replaySeededCreation ? { replaySeededCreation } : {}),
          ...(sourceContext ? { sourceContext } : {}),
          approvedNewDirectoryCreation: preparedTarget.directoryCreationRequired,
          ...(legacyMetadataLabel ? { legacyMetadataLabel } : {}),
          sessionCreationCorrespondence: correspondence,
          ...(requestedConfigurationSnapshot?.nativeSandbox !== undefined
            ? { authoredNativeSandbox: requestedConfigurationSnapshot.nativeSandbox } : {}),
          prepareSessionIsolation,
          organizationPlacement: normalizedPlacement,
          ...(placementOrigin && placementOriginSupported ? { placementOrigin } : {}),
          ...(managedTargetPlacement ? { managedTargetPlacement } : {}),
          ...(authoringOrigin !== undefined ? { authoringOrigin } : {}),
          ...(resolvedModelSelection ? { modelSelection: resolvedModelSelection } : {}),
          ...(profileId ? { profileId } : {}),
          ...(secretReferenceOverlay ? { secretReferenceOverlay } : {}),
          // Raw launch environment is deliberately absent from the
          // server-visible creation correspondence above; it reaches only this
          // direct-to-daemon spawn.
          ...(environmentVariables ? { environmentVariables } : {}),
          ...(resolvedPermissionMode ? { permissionMode: resolvedPermissionMode } : {}),
          ...(sessionAllowedTools !== undefined ? { allowedTools: sessionAllowedTools } : {}),
          ...(sessionUnlistedTools !== undefined ? { unlistedTools: sessionUnlistedTools } : {}),
          ...(configurationSnapshot?.workspaceWrites !== undefined ? { workspaceWrites: configurationSnapshot.workspaceWrites } : {}),
          ...(defaults.nativeSandbox !== undefined ? { nativeSandbox: defaults.nativeSandbox } : {}),
          ...(resolvedAgentModeId ? { agentModeId: resolvedAgentModeId } : {}),
          ...(normalizedConfigurationOverrides
            ? { sessionConfigOptionOverrides: normalizedConfigurationOverrides }
            : {}),
          ...(resolvedConnectedServices ? { connectedServices: resolvedConnectedServices } : {}),
          ...(resolvedConnectedServicesUpdatedAt !== undefined
            ? { connectedServicesUpdatedAt: resolvedConnectedServicesUpdatedAt }
            : {}),
          ...(capabilitySelection ? { capabilitySelection } : {}),
          ...(transcriptStorage ? { transcriptStorage } : {}),
          ...(spawnTerminal ? { terminal: spawnTerminal } : {}),
          ...(windowsTerminal?.launchMode
            ? { windowsRemoteSessionLaunchMode: windowsTerminal.launchMode }
            : {}),
          ...(windowsTerminal?.console
            ? { windowsRemoteSessionConsole: windowsTerminal.console }
            : {}),
          ...(windowsTerminal?.windowName
            ? { windowsTerminalWindowName: windowsTerminal.windowName }
            : {}),
          ...(configurationSnapshot?.providerSessionResume
            ? { resume: configurationSnapshot.providerSessionResume.providerSessionId }
            : {}),
          ...(title ? { initialTitle: title } : {}),
          ...(selectedApprovalProfileId !== undefined ? { approvalProfileId: selectedApprovalProfileId,
            approvalProfileTeamOrGroupDerived: selectedApprovalProfileTeamOrGroupDerived ?? false } : {}),
          ...(identity !== undefined ? { identity } : {}),
          ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
          ...(promptStack !== undefined ? { promptStack } : {}),
          ...(initialInput ? { initialInput } : {}),
          ...(continuation ? { beforeLaunch: continuation.beforeLaunch } : {}),
          ...(attestedContext !== undefined ? { attestedContext } : {}),
          ...(initialInput
            ? {
                buildInitialInputHandoff: (localId: string) => {
                  if (onboardingInput?.buildInitialInputHandoff) return onboardingInput.buildInitialInputHandoff(localId);
                  const admission = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
                    actionCaller,
                    callerSurface,
                    callerAuthority: context?.authority,
                    localId,
                    ...(context?.actionRequestAttributionV1 ? { actionRequestAttributionV1: context.actionRequestAttributionV1 } : {}),
                  });
                  const attachments = initialInput.attachments ?? [];
                  const authoredComposerAttachments = attachments.length > 0 && actionCaller.kind === 'plugin'
                    ? buildPluginSessionInputAttachmentDraftsV1({
                        caller: actionCaller,
                        attachments: params.resolveComposerAttachmentSendPreparation?.() ?? null,
                        messageLocalId: localId,
                        authored: attachments,
                      })
                    : [];
                  const structuredInput = initialInput.structuredInput;
                  if (!structuredInput && authoredComposerAttachments.length === 0) {
                    return admission;
                  }
                  return {
                    ...admission,
                    meta: {
                      [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
                        ...(structuredInput ?? { v: 1 }),
                        ...(authoredComposerAttachments.length > 0
                          ? { composerAttachments: [
                              ...(structuredInput?.composerAttachments ?? []),
                              ...authoredComposerAttachments,
                            ] }
                          : {}),
                      },
                    },
                  };
                },
              }
            : {}),
          ...(machineAdmissionTransport
            ? { machineAdmissionTransport }
            : {}),
          ...(directTargetTransport
            ? { directTransport: { ...directTargetTransport.spawnedSession,
                spawn: (request, options) => directTargetTransport.spawnedSession.spawn(request, {
                  ...options, ...(context ? { localActionContext: { ...context,
                    ...(input.admittedInput ? { setupAutostart: {
                      parent: { actionId: SESSION_SPAWN_NEW_ACTION_ID_V1, input: input.admittedInput }, context,
                    } } : {}),
                  } } : {}),
                }),
              } }
            : {}),
          machineActionTransport: (method, request, options) => callMachineAction({
            machineId: executionTarget.machineId,
            exactMachine: true,
            serverId: executionTarget.serverId,
            method,
            request,
            ...(context ? { context, effectActionId: 'session.spawn_new' } : {}),
            timeoutMs: DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS,
            ...(options?.signal ? { signal: options.signal } : {}),
          }),
          ...(agentSessionStartupInstructionsV1
            ? { agentSessionStartupInstructionsV1 }
            : {}),
          ...(context?.operationAcceptance?.actionId === 'session.spawn_new'
            ? { observeSessionBirth: context.operationAcceptance.observeSessionBirth } : {}),
          ...(spawnNonce ? { spawnNonce } : {}),
          ...(resumeActionRequest === true || birthContext?.resumeOnly === true ? { resumeOnly: true } : {}),
          ...(signal ? { signal } : {}),
        });
        const committed: Extract<SessionSpawnNewResultV1, { type: 'success' }> = {
          type: 'success',
          disposition: created.disposition,
          sessionId: created.sessionId,
          executionTarget,
          organizationPlacement: created.organizationPlacement,
          initialInput: created.initialInput,
          ...(agentReadiness ? { agentUpdate: agentReadiness.agentUpdate } : {}),
          ...(created.attestedContext ? { attestedContext: created.attestedContext } : {}),
          ...(created.filesNotCopied ? { filesNotCopied: created.filesNotCopied } : {}),
        };
        if (!manager) return committed;
        const preparation = await prepareSourceKeyAfterCommit({ effectActionId: 'session.spawn_new',
          sourceSessionId: created.sessionId, destinationSessionId: manager.sessionId,
          ...(context ? { context } : {}), ...(signal ? { signal } : {}) });
        // The Session and manager edge are already committed. Keep the
        // independent preparation outcome visible without turning creation
        // into an error that invites another spawn.
        return { ...committed, sourceKeyPreparation: preparation };
      } catch (error) {
        if (isActionExecuteFailure(error)) throw error;
        if (birthContext?.projectCreationFailure) return birthContext.projectCreationFailure(error);
        // A proven pre-persistence failure creates no Session, but does not
        // establish that the checkout still has no other consumer.
        if (error instanceof PromptStackPreparationError) throw error;
        if ('failure' in initialTriggerPreparationState && initialTriggerPreparationState.failure === error) {
          const code = readRecord(error).code;
          if (signal?.aborted || code === 'cancelled') {
            return { type: 'error', code: 'cancelled', retryable: true };
          }
          const { projectSessionSpawnFailure } = await import("@/session/creation/projectSessionSpawnFailure");
          if (isAuthenticationError(error) || code === 'permission_denied' || code === 'run_access_denied'
            || code === 'visible_team_not_granted') {
            return { type: 'error', code: 'permission_denied', retryable: false };
          }
          if (code === 'invalid_input') {
            return { type: 'error', code: 'invalid_input', retryable: false };
          }
          const policyRefusal = AgentStartRefusalV1Schema.safeParse({ code });
          if (policyRefusal.success && code !== 'target_unavailable' && code !== 'role_target_unavailable') {
            return { type: 'error', code: 'permission_denied', retryable: false };
          }
          if (code === 'source_unavailable' || code === 'content_unavailable' || code === 'target_unavailable'
            || code === 'role_target_unavailable' || code === 'feature_disabled'
            || code === 'account_settings_content_unavailable') {
            return { type: 'error', code: 'target_unavailable', retryable: false };
          }
          return projectSessionSpawnFailure({ errorCode: typeof code === 'string' ? code : '',
            errorMessage: readRecord(error).message });
        }
        const details = readRecord(readRecord(error).details);
        const [{ readSessionCreationTerminalSpawnErrorDetail }, { SPAWN_SESSION_ERROR_CODES }, { readMachineRpcRequestDisposition }, { projectSessionSpawnFailure }] = await Promise.all([import("@/api/session/sessionCreationTerminalSpawnErrorDetail"), import("@/session/shared/spawnSessionContract"), import("@/session/transport/rpc/machineRpc"), import("@/session/creation/projectSessionSpawnFailure")]);
        const spawnErrorDetails = [readSessionCreationTerminalSpawnErrorDetail(error), details, details.errorDetail, readRecord(details.spawnResponse).errorDetail]
          .map(normalizeSpawnSessionErrorDetail);
        if (spawnErrorDetails.some(detail => SessionCreationTerminalSpawnErrorDetailSchema.safeParse(detail).success)) {
          await cleanupInitialTriggerCustody?.();
        }
        const initialTriggerRefusal = spawnErrorDetails.find(
          (detail) => detail?.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.SESSION_CREATION_INITIAL_TRIGGER_REFUSED,
        );
        // This typed witness proves no Session was born, even when caller
        // cancellation arrives with the response. Unknown outcomes retain checkout custody.
        if (initialTriggerRefusal?.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.SESSION_CREATION_INITIAL_TRIGGER_REFUSED) {
          return { type: 'error', code: initialTriggerRefusal.code === 'feature_disabled' ? 'target_unavailable' : initialTriggerRefusal.code, retryable: false };
        }
        const initialAccessFailure = projectSessionInitialAccessEnvelopeHostErrorResult(error);
        if (initialAccessFailure) return initialAccessFailure;
        const code = error && typeof error === 'object'
          && typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : '';
        if (code === 'target_unavailable') {
          return { type: 'error', code: 'target_unavailable', retryable: false,
            failureCause: projectActionFailureCauseV1(error, 'session.spawn_new') };
        }
        if (code === 'session_input_invalid') {
          return { type: 'error', code: 'invalid_input', retryable: false };
        }
        if (code === 'session_input_target_unavailable') {
          return { type: 'error', code: 'target_unavailable', retryable: false };
        }
        if (isAuthenticationError(error)) {
          return { type: 'error', code: 'permission_denied', retryable: false };
        }
        if (hasSessionCreationOrganizationInvalidDetail(error)) {
          return { type: 'error', code: 'organization_invalid', retryable: false };
        }
        if (code === SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST
          && !spawnErrorDetails.some(detail => detail?.kind === 'launch_error')) {
          return { type: 'error', code: 'invalid_input', retryable: false };
        }
        if (code === 'creation_conflict' || hasSessionCreationCorrespondenceConflictDetail(error)) {
          return { type: 'error', code: 'creation_conflict', retryable: false };
        }
        const requestDisposition = readMachineRpcRequestDisposition(error);
        if (
          code === 'outcome_unknown'
          || code === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
          || requestDisposition === 'outcomeUnknown'
          || requestDisposition === null && code === 'MACHINE_RPC_TIMEOUT'
        ) {
          return {
            type: 'pending',
            retryWithSameCreationKey: true,
            outcome: 'unknown',
          };
        }
        if (signal?.aborted) {
          return { type: 'error', code: 'cancelled', retryable: true };
        }
        if (code === SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE) {
          if (spawnErrorDetails.some(detail => detail?.kind === 'requester_home_unavailable')) {
            return { type: 'error', code: 'target_unavailable', retryable: true };
          }
          const predicate = SessionSpawnNewIncompatibleTargetV1Schema.safeParse(
            details.incompatibleTarget ?? readRecord(details.spawnResponse).incompatibleTarget,
          );
          return incompatibleSessionSpawnTarget(predicate.success ? predicate.data.reason : 'daemon_rpc_unavailable');
        }
        for (const detail of spawnErrorDetails) {
          if (detail?.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.TERMINAL_HOST_UNAVAILABLE) {
            return { ...incompatibleSessionSpawnTarget('terminal_host_unavailable'), terminalHostError: detail };
          }
          if (detail?.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.SESSION_CREATION_ACCESS_REFUSED) {
            return { type: 'error', code: detail.code, retryable: false };
          }
          if (detail?.kind === 'update_required') {
            return { type: 'error', code: 'update_required', retryable: false, details: detail };
          }
          if (detail?.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.PROVIDER_ERROR) {
            return {
              type: 'error', code: 'spawn_failed',
              retryable: detail.providerError.retryable,
              providerError: detail.providerError,
            };
          }
        }
        return projectSessionSpawnFailure({
          errorCode: code, errorMessage: readRecord(error).message,
          agentId: details.agentId ?? readRecord(details.spawnResponse).agentId,
          errorDetail: spawnErrorDetails.find(detail => detail?.kind === 'launch_error'
            || detail?.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.SESSION_CREATION_CURRENTNESS_UNAVAILABLE
            || detail?.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC),
        });
      }
    },
  };
}
