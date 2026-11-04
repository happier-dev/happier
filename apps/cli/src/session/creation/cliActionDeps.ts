import type { CliActionDepsParams } from '../actions/cliActionDeps/types';
import { incompatibleSessionSpawnTarget, projectSessionInitialAccessEnvelopeHostErrorResult } from '../actions/cliActionDeps/sessionSpawnErrors';
import { SessionSpawnNewIncompatibleTargetV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createReviewedSecondOpinionSessionCreationAuthorization } from '@/api/externalActionExecutionAuthorization';
import type { readManagedMachine } from '@/machines/managed/readManagedMachine';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { resolveCliPromptStackSystemAppendBlocks } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { AgentStartRefusalV1Schema } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import type { SessionFollowSourceKeyPreparationResultV1, ActionExecutorDeps, ActionExecutorContext, SessionSpawnNewResultV1, SessionCreationTargetPreparationRequestV1, SessionCreationTargetPreparationResultV1 } from '@happier-dev/protocol';
import { buildAcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { normalizeSessionCreationOrganizationPlacementV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import type { buildSessionCreationCorrespondence } from '@/session/shared/sessionCreationCorrespondence';
import { projectDiscussionModelParticipantLaunchV1 } from '@happier-dev/protocol/discussions/modelParticipantLaunch';
import { SessionCreationTargetPreparationResultV1Schema, SessionCreationDirectoryApprovalV1Schema, needsSessionCreationDirectoryApprovalPreflightV1, projectSessionCreationDirectoryApprovalV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { SessionAuthoringTerminalV1Schema } from '@happier-dev/protocol/sessions/authoring/creationFieldsV1';
import { normalizeSpawnSessionErrorDetail, SessionCreationTerminalSpawnErrorDetailSchema, SPAWN_SESSION_ERROR_DETAIL_KINDS, isSessionCreationCorrespondenceConflictSpawnErrorDetail, isSessionCreationOrganizationInvalidSpawnErrorDetail } from '@happier-dev/protocol/spawnSession';
import { supportsMachineOperationProtocolCapabilityV1, supportsMachineSessionSpawnProtocolVersionV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import type { SpawnSessionTerminalSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import type { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import type { createStableSpawnNonce } from '@/session/shared/spawnNonce';
import type { parsePermissionIntentAlias } from '@happier-dev/agents';
import { configuration } from '@/configuration';
import type { MachineAdmissionTransportUnavailableError } from '@/daemon/machineAdmissionTransport';
import type { isAuthenticationError } from '@/api/client/httpStatusError';
import type { readSessionCreationTerminalSpawnErrorDetail } from '@/api/session/sessionCreationTerminalSpawnErrorDetail';
import type { readMachineOperationProtocolCapabilitiesV1 } from '@/api/machine/machineOperationProtocolCapabilities';
import { SessionInitialAccessUpdateRequiredError } from '@/api/session/sessionCreationInitialAccess';
import type { createCliWorkflowTriggerActions } from '../actions/workflowTriggers';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { type RoleSourceReader } from '@/session/roles/roleSources';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import type { createSpawnedSession, ReplaySeededSessionCreationV1 } from '@/session/services/createSpawnedSession';
import type { buildReplaySeededSpawnRecipe } from '@/session/replay/buildReplaySeededSpawnRecipe';
import type { resolveReplaySourceContextAuthority } from '@/session/replay/resolveReplaySourceContextAuthority';
import type { ResolveSpawnConnectedServicesTeamResourceCatalog, mergeSessionTeamCredentialBindingIntents, resolveSessionSpawnConnectedServicesDefaultsPayload } from '@/session/services/spawnConnectedServicesDefaults';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { resolveRolesSnapshotV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { buildPluginSessionInputAttachmentDraftsV1 } from '@/session/composer/admitPluginSessionInputAttachmentsV1';
import type { buildSessionSpawnInitialInputAdmissionForLocalIdV1, requiresMachineAdmissionForSessionInput } from '@/session/services/sessionInputAdmissionIdentity';
import type { resolveSessionCreationAgentTarget } from '@/session/creation/resolveSessionCreationAgentTarget';
import type { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import type { dispatchRequesterSessionSpawnNewRpc, readMachineRpcRequestDisposition } from '@/session/transport/rpc/machineRpc';
import type { resolveLiveDaemonControlTargetForServer } from '@/daemon/multiDaemon';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { type RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import type { CliMachineActionCall } from '@/session/actions/cliActionDeps/machineTransport';
import type { AccountRoleOverridesReadV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';


async function resolveSpawnConnectedServicesDefaultPayload(params: Readonly<{
  backendTarget: NonNullable<ReturnType<typeof readBackendTargetRefV2>>;
  credentials: StoredCredentials;
  signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1;
  resolveTeamCredentialResourceCatalog?: ResolveSpawnConnectedServicesTeamResourceCatalog;
}>): Promise<Awaited<ReturnType<typeof resolveSessionSpawnConnectedServicesDefaultsPayload>>> {
  if (params.backendTarget.sourceKind !== 'built_in') return null;
  // ONE defaulting owner (QA2-F02): session spawn and execution-run start resolve defaults
  // through the same fresh-bootstrap owner; no local settings-snapshot path.
  const { resolveSessionSpawnConnectedServicesDefaultsPayload } = await import("@/session/services/spawnConnectedServicesDefaults");
  return await resolveSessionSpawnConnectedServicesDefaultsPayload({
    agentId: params.backendTarget.backendId,
    credentials: params.credentials,
    signal: params.signal,
    ...(params.operationContext ? { operationContext: params.operationContext } : {}),
    ...(params.resolveTeamCredentialResourceCatalog
      ? { resolveTeamCredentialResourceCatalog: params.resolveTeamCredentialResourceCatalog }
      : {}),
  });
}
type SpawnActionDeps = Pick<ActionExecutorDeps, 'sessionSpawnNewDirectoryApprovalPreflight'>
  & Required<Pick<ActionExecutorDeps, 'sessionSpawnNew'>>;

export function createCliSpawnActionDeps(
  params: CliActionDepsParams,
  { callMachineAction, isSameActionHomeId, machineReferenceServerUrl, normalizeStringValue, prepareAccountRoleOverrides, prepareSourceKeyAfterCommit, projectHomeId, readAccountRoleOverrides, readRecord, readRoleSources, resolveServerRequestHeaders, roleSettingsProvider, workflowTriggers }: Readonly<{
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
    workflowTriggers: ReturnType<typeof createCliWorkflowTriggerActions> | null;
  }>,
): SpawnActionDeps {

function hasPossiblyAcceptedSpawnNonce(error: unknown): boolean {
  const details = readRecord(readRecord(error).details);
  return typeof details.spawnNonce === 'string' && details.spawnNonce.trim().length > 0;
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
  const isCurrentSessionSpawnExecutionTarget = (executionTarget: Readonly<{
    serverId: string;
    machineId: string;
  }>): boolean => {
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

    const directTargetTransport = params.sessionSpawnDirectTargetTransport;
    if (
      directTargetTransport
      && directTargetTransport.machineId !== input.executionTarget.machineId
    ) {
      return {
        ok: false,
        result: { type: 'error', code: 'target_unavailable', retryable: false },
      };
    }

    let rawPreparedTarget: unknown;
    try {
      rawPreparedTarget = directTargetTransport
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
      if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        return {
          ok: false,
          result: incompatibleSessionSpawnTarget('target_preparation_rpc_unavailable'),
        };
      }
      const { isAuthenticationError } = await import("@/api/client/httpStatusError");
      if (isAuthenticationError(error) || readRpcErrorCode(error) === RPC_ERROR_CODES.FORBIDDEN) {
        return {
          ok: false,
          result: { type: 'error', code: 'permission_denied', retryable: false },
        };
      }
      return {
        ok: false,
        result: { type: 'error', code: 'spawn_failed', retryable: true },
      };
    }

    const preparedTarget = SessionCreationTargetPreparationResultV1Schema.safeParse(rawPreparedTarget);
    if (!preparedTarget.success) {
      return {
        ok: false,
        result: incompatibleSessionSpawnTarget('target_preparation_invalid_result'),
      };
    }
    if (!preparedTarget.data.ok) {
      if (preparedTarget.data.code === 'invalid_directory') {
        return {
          ok: false,
          result: { type: 'error', code: 'invalid_input', retryable: false },
        };
      }
      if (preparedTarget.data.code === 'checkout_unavailable') {
        return {
          ok: false,
          result: incompatibleSessionSpawnTarget('checkout_unavailable'),
        };
      }
      return {
        ok: false,
        result: { type: 'error', code: 'spawn_failed', retryable: true },
      };
    }
    return { ok: true, preparedTarget: preparedTarget.data };
  };
  return {
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
      return approval ? { type: 'approval_required' as const, approval } : { type: 'not_required' as const };
    },
    sessionSpawnNew: async (input) => {
      const reviewedOpinionSpawn = input.context?.externalActionExecutionAuthorization?.binding.actionId === 'discussion.second_opinion.start';
      if (input.admittedInput && params.credentials && params.credentials.credentialProvenance !== 'api_token'
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
          } catch {
            const errorCode = input.signal?.aborted ? 'cancelled' : 'target_unavailable';
            return { ok: false, errorCode, error: errorCode };
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
      placementOrigin,
      authoringOrigin,
      agentTarget,
      modelSelection,
      profileId,
      secretReferenceOverlay,
      permissionMode,
      allowedTools,
      unlistedTools,
      agentModeId,
      configuration: configurationSnapshot,
      connectedServices,
      capabilitySelection,
      transcriptStorage,
      terminal,
      checkoutCreationDraft,
      title,
      identity,
      attestedContext,
      memoryEnabled,
      promptStack,
      managedCreation,
      discussionParticipant,
      discussionParticipantLaunch: admittedDiscussionLaunch,
      initialInput,
      agentSessionStartupInstructionsV1,
      environmentVariables,
      sessionCreationTag,
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
      const creationAuthorization = context?.externalActionExecutionAuthorization?.binding.actionId === 'discussion.second_opinion.start'
        ? input.admittedInput && params.externalActionMachineInstallationId && params.externalActionMachineRequestPrivateKey
          ? createReviewedSecondOpinionSessionCreationAuthorization({ context, publicInput: input.admittedInput,
            installationId: params.externalActionMachineInstallationId, privateKey: params.externalActionMachineRequestPrivateKey })
          : null
        : admittedCreationAuthorization;
      if (context?.externalActionExecutionAuthorization?.binding.actionId === 'discussion.second_opinion.start' && !creationAuthorization) {
        return { type: 'error', code: 'permission_denied', retryable: false };
      }
      let initialSessionRolesV1 = requestedInitialSessionRolesV1;
      const discussionParticipantLaunch = discussionParticipant
        ? admittedDiscussionLaunch ?? projectDiscussionModelParticipantLaunchV1(input)
        : undefined;
      const sessionAllowedTools = allowedTools ?? configurationSnapshot?.allowedTools;
      const sessionUnlistedTools = unlistedTools ?? configurationSnapshot?.unlistedTools;
      if (!params.credentials) {
        return { type: 'error', code: 'permission_denied', retryable: false };
      }
      if (signal?.aborted) {
        return { type: 'error', code: 'cancelled', retryable: true };
      }
      if ((initialInput?.attachments?.length ?? 0) > 0 && actionCaller.kind !== 'plugin') {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      if (initialInput && !params.machineAdmissionTransport) {
        const externalRequest = context?.externalActionCredential !== undefined
          || context?.externalActionExecutionAuthorization !== undefined;
        const authorizationHeaders = externalRequest
          ? resolveServerRequestHeaders(context, 'session.spawn_new', {
              method: 'GET', path: '/v1/account/encryption/currentness',
            })
          : null;
        if (externalRequest && !authorizationHeaders) {
          return { type: 'error', code: 'permission_denied', retryable: false };
        }
        // New Sessions use persisted Account mode, never the parent's mode or
        // credential key presence. Existing Session sends read their own mode.
        const [{ fetchAccountEncryptionCurrentness }, { buildSessionSpawnInitialInputAdmissionForLocalIdV1, requiresMachineAdmissionForSessionInput }] = await Promise.all([import("@/api/client/connectedServiceCredentialApi"), import("@/session/services/sessionInputAdmissionIdentity")]);
        const currentness = await fetchAccountEncryptionCurrentness({
          token: params.credentials.token,
          ...(params.serverHttpBaseUrl ? { serverBaseUrl: params.serverHttpBaseUrl } : {}),
          ...(authorizationHeaders ? { authorizationHeaders } : {}),
          ...(signal ? { signal } : {}),
        });
        const { inputAdmission } = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
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
          mode: currentness.mode,
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

      if (!isCurrentSessionSpawnExecutionTarget(executionTarget)) {
        return { type: 'error', code: 'target_unavailable', retryable: false };
      }
      if (managedCreation) {
        try {
          const { readManagedMachine } = await import("@/machines/managed/readManagedMachine");
          const retained = await readManagedMachine({ credentials: params.credentials,
            serverHttpBaseUrl: machineReferenceServerUrl, homeId: managedCreation.homeId,
            managedId: managedCreation.managedId, signal,
            ...(context?.externalActionExecutionAuthorization
              ? { authorization: context.externalActionExecutionAuthorization } : {}),
          });
          if (retained.homeId !== managedCreation.homeId || retained.id !== managedCreation.managedId
            || retained.controller.machineId !== managedCreation.controller.machineId
            || retained.controller.installationId !== managedCreation.controller.installationId
            || retained.creationState !== 'active' || retained.archivedAt !== undefined
            || retained.allocation !== 'bound' || !retained.resource
            || retained.enrolledMachineId !== executionTarget.machineId) {
            return { type: 'error', code: 'invalid_input', retryable: false };
          }
        } catch (error) {
          const { isAuthenticationError } = await import("@/api/client/httpStatusError");
          return isAuthenticationError(error)
            ? { type: 'error', code: 'permission_denied', retryable: false }
            : { type: 'error', code: 'spawn_failed', retryable: true };
        }
      }
      const normalizedActionRequestId = normalizeStringValue(actionRequestId);
      if (resumeActionRequest === true && !normalizedActionRequestId) {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      const [{ createStableSpawnNonce }, { mergeSessionTeamCredentialBindingIntents }, { SpawnSessionTerminalSchema }, { buildSessionCreationCorrespondence }] = await Promise.all([import("@/session/shared/spawnNonce"), import("@/session/services/spawnConnectedServicesDefaults"), import("@/rpc/handlers/spawnSessionOptionsContract"), import("@/session/shared/sessionCreationCorrespondence")]);
      const spawnNonce = normalizedActionRequestId
        ? createStableSpawnNonce('session.spawn_new.action', { actionRequestId: normalizedActionRequestId })
        : undefined;

      const directTargetTransport = params.sessionSpawnDirectTargetTransport;
      let placementOriginSupported = Boolean(directTargetTransport);
      let authoringOriginSupported = Boolean(directTargetTransport);
      let secretReferenceOverlaySupported = Boolean(directTargetTransport);
      if (
        directTargetTransport
        && directTargetTransport.machineId !== executionTarget.machineId
      ) {
        return { type: 'error', code: 'target_unavailable', retryable: false };
      }
      if (!directTargetTransport) {
        let targetCapabilityProjection: Awaited<ReturnType<typeof readMachineOperationProtocolCapabilitiesV1>>;
        try {
          const { readMachineOperationProtocolCapabilitiesV1 } = await import("@/api/machine/machineOperationProtocolCapabilities");
          targetCapabilityProjection = await readMachineOperationProtocolCapabilitiesV1({
            credentials: params.credentials,
            machineId: executionTarget.machineId,
            ...(signal ? { signal } : {}),
          });
        } catch (error) {
          const spawnMayHaveBeenAccepted = hasPossiblyAcceptedSpawnNonce(error);
          if (signal?.aborted) {
            if (spawnMayHaveBeenAccepted) {
              return {
                type: 'pending',
                retryWithSameCreationKey: true,
                outcome: 'unknown',
              };
            }
            return { type: 'error', code: 'cancelled', retryable: true };
          }
          const { isAuthenticationError } = await import("@/api/client/httpStatusError");
          if (isAuthenticationError(error)) {
            return { type: 'error', code: 'permission_denied', retryable: false };
          }
          return { type: 'error', code: 'machine_offline', retryable: true };
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

      const [{ parsePermissionIntentAlias }, { resolveSessionCreationAgentTarget }] = await Promise.all([import("@happier-dev/agents"), import("@/session/creation/resolveSessionCreationAgentTarget")]);
      const resolvedAgentTarget = resolveSessionCreationAgentTarget(agentTarget);
      if (!resolvedAgentTarget) {
        return { type: 'error', code: 'target_unavailable', retryable: false };
      }
      const { backendTarget } = resolvedAgentTarget;
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
      const connectedServicesDefaults = connectedServices === undefined
        ? await resolveSpawnConnectedServicesDefaultPayload({
            credentials: params.credentials,
            backendTarget,
            signal,
            ...(params.savedSecretOperationContext ? { operationContext: params.savedSecretOperationContext } : {}),
            ...(params.resolveTeamCredentialResourceCatalog
              ? { resolveTeamCredentialResourceCatalog: params.resolveTeamCredentialResourceCatalog }
              : {}),
          })
        : null;
      if (signal?.aborted) {
        return { type: 'error', code: 'cancelled', retryable: true };
      }
      const resolvedConnectedServices = connectedServices
        ?? connectedServicesDefaults?.connectedServices;
      const resolvedConnectedServicesUpdatedAt = connectedServicesDefaults?.connectedServicesUpdatedAt;
      // Defaulted Team targets reach the Session only through its own Team
      // slot bindings; an explicit slot choice wins.
      const resolvedTeamCredentialBindings = mergeSessionTeamCredentialBindingIntents({
        explicit: teamCredentialBindings,
        admitted: connectedServicesDefaults?.teamCredentialBindings ?? null,
      });
      const normalizedPlacement =
        normalizeSessionCreationOrganizationPlacementV1(organizationPlacement);
      const normalizedTerminal = terminal === undefined
        ? undefined
        : SessionAuthoringTerminalV1Schema.safeParse(terminal);
      if (normalizedTerminal !== undefined && !normalizedTerminal.success) {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      const spawnTerminal = normalizedTerminal === undefined
        ? undefined
        : SpawnSessionTerminalSchema.safeParse(normalizedTerminal.data);
      if (spawnTerminal !== undefined && !spawnTerminal.success) {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
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
      const resolvedModelSelection = modelSelection
        ?? (configurationSnapshot?.model.value
          ? SessionModelSelectionV1Schema.parse({
              v: 1,
              updatedAt: configurationSnapshot.model.updatedAtMs,
              ref: {
                agentTargetKey: buildBackendTargetKeyV2(backendTarget),
                providerConnectionId: null,
                modelId: configurationSnapshot.model.value,
              },
            })
          : undefined);
      const requestedPermissionMode = permissionMode
        ?? configurationSnapshot?.permissionIntent.value
        ?? undefined;
      const resolvedPermissionMode = requestedPermissionMode
        ? parsePermissionIntentAlias(requestedPermissionMode)
        : undefined;
      if (requestedPermissionMode && !resolvedPermissionMode) {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
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
      const targetPreparation = await prepareSessionSpawnTarget({
        executionTarget,
        directory,
        sessionCreationTag,
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
          ...(promptStack !== undefined ? { promptStack } : {}),
          ...(managedCreation ? { managedCreation } : {}),
          ...(discussionParticipant ? { discussionParticipant } : {}),
          ...(secretReferenceOverlay ? { secretReferenceOverlay } : {}),
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
          const { isAuthenticationError } = await import("@/api/client/httpStatusError");
          return isAuthenticationError(error)
            ? { type: 'error', code: 'permission_denied', retryable: false }
            : { type: 'error', code: 'spawn_failed', retryable: true };
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
          credentials: params.credentials,
          serverId: executionTarget.serverId,
          ...(params.actionsSettingsProvider?.getAccountSettings
            ? { accountSettings: params.actionsSettingsProvider.getAccountSettings() ?? undefined } : {}),
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
          ...(primaryTeamId !== undefined ? { primaryTeamId } : {}),
          ...(resolvedTeamCredentialBindings !== undefined
            ? { teamCredentialBindings: resolvedTeamCredentialBindings }
            : {}),
          machineId: executionTarget.machineId,
          backendTarget,
          sessionCreationTag,
          ...(replaySeededCreation ? { replaySeededCreation } : {}),
          ...(sourceContext ? { sourceContext } : {}),
          approvedNewDirectoryCreation: preparedTarget.directoryCreationRequired,
          ...(legacyMetadataLabel ? { legacyMetadataLabel } : {}),
          sessionCreationCorrespondence: correspondence,
          organizationPlacement: normalizedPlacement,
          ...(placementOrigin && placementOriginSupported ? { placementOrigin } : {}),
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
          ...(spawnTerminal?.data ? { terminal: spawnTerminal.data } : {}),
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
          ...(identity !== undefined ? { identity } : {}),
          ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
          ...(promptStack !== undefined ? { promptStack } : {}),
          ...(initialInput ? { initialInput } : {}),
          ...(attestedContext !== undefined ? { attestedContext } : {}),
          ...(initialInput
            ? {
                buildInitialInputHandoff: (localId: string) => {
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
          ...(params.machineAdmissionTransport
            ? { machineAdmissionTransport: params.machineAdmissionTransport }
            : {}),
          ...(directTargetTransport
            ? { directTransport: { ...directTargetTransport.spawnedSession,
                spawn: (request, options) => directTargetTransport.spawnedSession.spawn(request, {
                  ...options, ...(context ? { localActionContext: context } : {}),
                }),
              } }
            : {}),
          ...(params.machineActionDirectTargetTransport?.machineId === executionTarget.machineId
            ? {
                machineActionTransport: params.machineActionDirectTargetTransport.invoke,
              }
            : {}),
          ...(agentSessionStartupInstructionsV1
            ? { agentSessionStartupInstructionsV1 }
            : {}),
          ...(spawnNonce ? { spawnNonce } : {}),
          ...(resumeActionRequest === true ? { resumeOnly: true } : {}),
          ...(signal ? { signal } : {}),
        });
        const committed: Extract<SessionSpawnNewResultV1, { type: 'success' }> = {
          type: 'success',
          disposition: created.disposition,
          sessionId: created.sessionId,
          executionTarget,
          organizationPlacement: created.organizationPlacement,
          initialInput: created.initialInput,
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
        // A proven pre-persistence failure creates no Session, but does not
        // establish that the checkout still has no other consumer.
        if (error instanceof PromptStackPreparationError) throw error;
        if ('failure' in initialTriggerPreparationState && initialTriggerPreparationState.failure === error) {
          const code = readRecord(error).code;
          if (signal?.aborted || code === 'cancelled') {
            return { type: 'error', code: 'cancelled', retryable: true };
          }
          const [{ isAuthenticationError }, { projectSessionSpawnFailure }] = await Promise.all([import("@/api/client/httpStatusError"), import("@/session/creation/projectSessionSpawnFailure")]);
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
        const [{ readSessionCreationTerminalSpawnErrorDetail }, { isAuthenticationError }, { SPAWN_SESSION_ERROR_CODES }, { readMachineRpcRequestDisposition }, { projectSessionSpawnFailure }] = await Promise.all([import("@/api/session/sessionCreationTerminalSpawnErrorDetail"), import("@/api/client/httpStatusError"), import("@/session/shared/spawnSessionContract"), import("@/session/transport/rpc/machineRpc"), import("@/session/creation/projectSessionSpawnFailure")]);
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
        if (code === SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST) {
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
