import type { ConnectedServiceAccountEncryptionMode } from '@/api/client/connectedServiceCredentialApi';
import type { RpcLocalActionContext } from '@/api/rpc/types';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { UsageLimitContinuationResult } from '@/daemon/connectedServices/continuation/continueSessionAfterUsageLimitReset';
import type { RequesterAgentStartPolicyV1 } from '@/daemon/sessionEncryption/requesterAgentStartPolicy';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { SessionUpdatePostInputV1 } from '@happier-dev/protocol';
import type { createCliProviderActionExecuteV1 } from './createCliProviderActionDeps';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { SessionActionRpcOriginV1 } from '@happier-dev/protocol/socketRpc';
import type { ResolvedRolesSnapshotV1, PluginRoleContributionV1, SessionUsageLimitRecoveryV1, ActionExecutorDeps, BackendTargetRefV2, SessionCreationTargetPreparationRequestV1, SessionCreationTargetPreparationResultV1 } from '@happier-dev/protocol';
import type { SessionSkillReadItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import type { RoleWorkspaceWritesPolicyPreparer } from '../roleActions';
import type { RoleSourceReader } from '@/session/roles/roleSources';
import type { StoredCredentials } from '@/persistence';
import type { CredentialedConnectedAccountAuthenticationHost } from '@/plugins/runtime/connectedAccounts/authenticationHost';
import type { DirectSpawnedSessionTransport } from '@/session/services/createSpawnedSession';
import type { ResolveSpawnConnectedServicesTeamResourceCatalog } from '@/session/services/spawnConnectedServicesDefaults';
import type { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import type { dispatchOriginalAccountAction, ExternalActionHomeBinding } from '@/api/externalActionExecutionAuthorization';
import type { ComposerAttachmentSendPreparationRegistryV1 } from '@/session/composer/prepareComposerAttachmentDraftsForSendV1';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionStoredContentCodec';
import type { SessionTransportEncryptionMaterial } from '@/session/transport/encryption/sessionEncryptionContext';
import type { DaemonPluginChangeService } from '@/plugins/daemon/changeService';
import type { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { ResolveAutomationEventAdoptedDefinitionSetV1 } from '@/plugins/runtime/automations/automationEventActionExecutor';
import type { RevalidatePluginActionCallerOccurrence, RevalidatePluginActionCallerMaterialization } from '@/plugins/runtime/invocation/services/actionCaller';
import type { ExternalSessionPluginAdmissionOwner } from '../externalSessions/pluginExternalSessionAdmissionOwner';
import type { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import type { SessionRoleContext } from '@/session/roles/sessionRoleContext';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
export type ResumeInactiveSessionWhenUsageLimitReady = (input: Readonly<{
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  readiness?: 'provider_ready';
}>) => Promise<boolean | UsageLimitContinuationResult>;

export type ScheduleInactiveSessionUsageLimitRecoveryCheck = (input: Readonly<{
  sessionId: string;
  recovery: SessionUsageLimitRecoveryV1;
  runCheckNow: () => Promise<unknown>;
}>) => Promise<void> | void;

export type CancelInactiveSessionUsageLimitRecoveryCheck = (input: Readonly<{
  sessionId: string;
  issueFingerprint: string;
  armedAtMs: number;
  runtimeAuthRecoveryAttemptId?: string;
}>) => Promise<void> | void;

/**
 * Reads the current record from the inactive usage-limit recovery lifecycle owner so an
 * in-flight readiness probe can be fenced against a cancellation, exhaustion or replacement
 * that landed while it was running.
 */
export type ReadInactiveSessionUsageLimitRecovery = (input: Readonly<{
  sessionId: string;
}>) => SessionUsageLimitRecoveryV1 | null;

export type CancelConnectedServiceRuntimeAuthRecovery = (input: Readonly<{
  sessionId: string;
  attemptId: string;
}>) => Promise<unknown> | unknown;

export type RetryTemporaryThrottleNow = (input: Readonly<{
  sessionId: string;
}>) => Promise<unknown> | unknown;

/**
 * Host-private exact-daemon path used only after the public V2 Action owner
 * has admitted an already server-stamped request. It replaces transport, not
 * Session creation policy, normalization, or lifecycle ownership.
 */
export type SessionSpawnDirectTargetTransport = Readonly<{
  machineId: string;
  prepare: (
    request: SessionCreationTargetPreparationRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<SessionCreationTargetPreparationResultV1>;
  spawnedSession: DirectSpawnedSessionTransport;
}>;

/** The daemon's already authenticated Machine socket; never the Account user socket. */
export type SessionActionRpcTransport = (request: Readonly<{
  sessionId: string;
  method: string;
  input: unknown;
  content: import('@happier-dev/sync-client').SocketRpcContent;
  signal?: AbortSignal;
}> & (Readonly<{ origin: SessionActionRpcOriginV1; executionAuthorization?: never }>
  | Readonly<{ origin?: never; executionAuthorization: NonNullable<ActionExecutorContext['externalActionExecutionAuthorization']> }>)) => Promise<unknown>;

export type MachineServiceActionDirectTargetInvocation = Parameters<NonNullable<ActionExecutorDeps['machineServiceAction']>>[0] & Readonly<{
  /** Captured requester read fact; never a serialized Action operand. */
  canReadEnvironment(environmentId: string): Promise<boolean>;
  requesterAccountId: string | null;
}>;

export type MachineActionDirectTargetTransport = Readonly<{
  machineId: string;
  /** Exact receiving daemon's native setup leaf; composition stays at the Action owner. */
  machineSetupApply?: NonNullable<ActionExecutorDeps['machineSetupApply']>;
  /** Exact receiving daemon's declared-removal leaf. */
  machineSetupRemove?: NonNullable<ActionExecutorDeps['machineSetupRemove']>;
  machineSetupUpdatesApply?: NonNullable<ActionExecutorDeps['machineSetupUpdatesApply']>;
  /** Only the installed registered owner consumes an already Home-admitted Project root. */
  openProject?: NonNullable<ActionExecutorDeps['projectsOpen']>;
  /** Exact installed service owner; never re-enter its receiving Machine RPC dispatcher. */
  machineServiceAction?: (request: MachineServiceActionDirectTargetInvocation) => ReturnType<NonNullable<ActionExecutorDeps['machineServiceAction']>>;
  /** Same receiving daemon lifecycle owner; never recursively invoke Machine RPC. */
  machineReboot?: (request: import('@/daemon/lifecycle/machineReboot').MachineRebootDirectTargetInvocation) => Promise<unknown>;
  invoke: (
    method: string,
    request: unknown,
    options?: Readonly<{
      signal?: AbortSignal;
      executionRunPermissionRequestStore?: unknown;
      executionRunWorkflowObservationSink?: unknown;
      executionRunWorkflowRunId?: string;
      executionRunWorkflowScope?: RpcLocalActionContext['executionRunWorkflowScope'];
      localActionContext?: RpcLocalActionContext;
      /** Existing admitted requester custody; never serialized in Machine RPC input. */
      rpcContext?: NonNullable<Parameters<RpcHandlerManager['invokeLocal']>[2]>['rpcContext'];
      /** Exact native effect already admitted by the receiving Action owner. */
      admissionResult?: NonNullable<Parameters<RpcHandlerManager['invokeLocal']>[2]>['admissionResult'];
    }>,
  ) => Promise<unknown>;
}>;

export type CurrentMachineControlIdentity = Readonly<{
  machineId: string | null;
  host: string | null;
  homeDir: string | null;
}>;

export type PendingAgentRequestKind = 'permission' | 'user_action';

/**
 * The Action-executor dependency contract owns the V2-only capability
 * requirement; this transport only consumes it, so it is read back from that
 * declaration instead of being restated here.
 */
export type ExecutionRunProtocolV2Requirement = Parameters<
  NonNullable<ActionExecutorDeps['executionRunCheckProtocolV2']>
>[1];

/**
 * An exact Action Home is one target: its server id and its base URL are bound
 * together or not at all. The Home-bound dependency owners already refuse a
 * half-bound target, so callers express the same pair here instead of letting
 * one half reach an owner that would fall back to the configured active Home.
 */
export type CliActionExactHomeTarget =
  | Readonly<{ serverId?: undefined; serverHttpBaseUrl?: undefined }>
  | Readonly<{ serverId: string; serverHttpBaseUrl: string }>;
export type CliActionDepsParams = Readonly<{
  token: string;
  /** Local delivery only; a host without a link consumer refuses creation before HTTP. */
  onPublicLinkIssued?: (link: import('@happier-dev/protocol').ArtifactPublicLinkIssuedV1) => void | Promise<void>;
  consumeArtifactSignedInLinkSecret?: (lookupId: string) => Promise<string | null>;
  onArtifactSignedInLinkOpened?: (opened: import('@happier-dev/protocol/actions/executor/artifactPublicLinkActions').ArtifactSignedInLinkOpenedV1) => void | Promise<void>;
  credentials?: StoredCredentials;
  connectedAccountAuthenticationHost?: CredentialedConnectedAccountAuthenticationHost;
  /** Immutable Account mode from finite requester admission, including unavailable. */
  admittedAccountEncryptionMode?: ConnectedServiceAccountEncryptionMode;
  /** Daemon startup already owns this service; do not loop through its not-yet-open control transport. */
  pluginChangeService?: DaemonPluginChangeService;
  /** Canonical private-secret Action adapter supplied by the captured Account host. */
  personalSavedSecretActionExecute?: ActionExecutorDeps['personalSavedSecretActionExecute'];
  /** Standalone input choices use the authenticated built-in Action owner. */
  readAdmittedInputTypeOptions?: ActionExecutorDeps['readAdmittedInputTypeOptions'];
  /** Cold recipe read supplied only by the admitted receiving daemon. */
  machineRecipesRead?: ActionExecutorDeps['machineRecipesRead'];
  /** Currentness of this composition's already-captured credential. */
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  onRequesterSessionCredentialDisclosure?: Parameters<typeof dispatchOriginalAccountAction>[0]['onRequesterSessionCredentialDisclosure'];
  requesterSessionBootstrap?: AdmittedRequesterSessionBootstrap;
  /** Private invocation custody, never a daemon Account snapshot or a fake Session. */
  savedSecretOperationContext?: SavedSecretOperationContextV1;
  /** Live Session Role admission shares its retained Account demand and holder. */
  getSessionRoleContext?: () => SessionRoleContext;
  /** Memory-only prompted Provider credential, promoted only by the admitted connection owner. */
  providerPreparedSavedSecret?: Parameters<typeof createCliProviderActionExecuteV1>[0]['preparedSavedSecret'];
  projectModelsForAccount?: Parameters<typeof createCliProviderActionExecuteV1>[0]['projectModelsForAccount'];
  /** Installed exact-target Project producer; absent hosts retain Trust-only behavior. */
  projectAction?: ActionExecutorDeps['projectAction'];
  /** Receiving daemon's storage carrier and admitted target executor. */
  deploymentAction?: ActionExecutorDeps['deploymentAction'];
  resolveEnvironmentApprovalScope?: ActionExecutorDeps['resolveEnvironmentApprovalScope'];
  prepareDeploymentAction?: ActionExecutorDeps['prepareDeploymentAction'];
  prepareHostReviewedChildren?: ActionExecutorDeps['prepareHostReviewedChildren'];
  prepareDeploymentPublish?: ActionExecutorDeps['prepareDeploymentPublish'];
  deploymentPublish?: ActionExecutorDeps['deploymentPublish'];
  deploymentPrepare?: ActionExecutorDeps['deploymentPrepare'];
  deploymentTemplateInstantiate?: ActionExecutorDeps['deploymentTemplateInstantiate'];
  prepareDeploymentTemplateInstantiation?: ActionExecutorDeps['prepareDeploymentTemplateInstantiation'];
  /** Receiving daemon's target-local Activity Undo owner; clients retain exact Machine transport. */
  machineGuardAction?: ActionExecutorDeps['machineGuardAction'];
  /** Machine-owned policy intersects the selected Session's confined SCM root. */
  scmFilesystemAccessPolicy?: FilesystemAccessPolicy;
  /** The daemon binds its canonical local file owner; clients use exact Machine transport. */
  projectDefinitionAction?: ActionExecutorDeps['projectDefinitionAction'];
  /** Account row/policy ports share the family with exact-Machine status and retirement. */
  projectWorkerAccountAction?: ActionExecutorDeps['projectWorkerAction'];
  stageWorkStateMutation?: (mutation: import('@/api/session/client/transport/mutations/sessionClientDurableMutationTypes').DaemonWorkStateFieldMutation, options?: Readonly<{ signal?: AbortSignal }>) => Promise<void>;
  stageSessionStateMutation?: (mutation: import('@/api/session/client/transport/mutations/sessionClientDurableMutationTypes').RegisteredSessionStateFieldMutationV1) => Promise<void>;
  postSessionUpdate?: (report: SessionUpdatePostInputV1) => Promise<Readonly<{ persisted: boolean; localId?: string }>>;
  sessionId: string;
  /** Current authenticated receiver/source socket; no authored destination override. */
  sessionMessageReplyPublisher?: Pick<ApiSessionClient, 'sessionId' | 'mutateSessionMessageReply' | 'publishSessionMessageReply'>;
  /** Current Session publisher supplied by the admitted host; never a human HTTP fallback. */
  postAgentDiscussionMessage?: Parameters<typeof createDiscussionActionDeps>[0]['postAgentMessage'];
  postWorkflowDiscussionMessage?: Parameters<typeof createDiscussionActionDeps>[0]['postWorkflowMessage'];
  /** Exact live RPC owner for this bound Session; absent on Account/daemon action hosts. */
  invokeBoundSessionRpc?: (method: string, input: unknown, signal?: AbortSignal, origin?: SessionActionRpcOriginV1) => Promise<unknown>;
  /** One-use transport already resolved by this Goal RPC's admission owner. */
  initialSessionGoalTransport?: Extract<Awaited<ReturnType<typeof resolveSessionTransportContext>>, { ok: true }>;
  rawSession?: Readonly<{
    metadata?: unknown;
    metadataLayoutVersion?: unknown;
    path?: unknown;
    host?: unknown;
    machineId?: unknown;
    workDepth?: unknown;
  }> | null;
  getCurrentSessionBackendTarget?: (() => BackendTargetRefV2 | null | undefined) | null;
  getCurrentSessionMetadata?: () => Readonly<Record<string, unknown>> | null;
  /** Current delivered plan of this runner; absent on a remote Account client. */
  getCurrentSessionSkillItems?: () => readonly SessionSkillReadItemV1[] | null;
  getCurrentAppliedChildSelection?: () => Promise<import('@/agent/runtime/bridges/executionRun/runtime/openInputs').ExecutionRunAppliedParentSelection> | import('@/agent/runtime/bridges/executionRun/runtime/openInputs').ExecutionRunAppliedParentSelection;
  getCurrentSessionWorkDepth?: () => number | undefined;
  getAgentStartRunCaller?: () => import('../resolveCliAgentStartContextV1').AgentStartRunCallerBinding | null;
  getCurrentTurnWorkDepth?: (expectedTurnId?: string) => number | undefined;
  getCurrentResolvedRoles?: () => ResolvedRolesSnapshotV1;
  getCurrentWorkspaceWrites?: () => 'allow' | 'deny' | undefined;
  readRoleSources?: RoleSourceReader;
  readPluginRoles?: () => readonly PluginRoleContributionV1[];
  /** Already-admitted declarations from this host's current executable registry lease; never wakes a daemon. */
  readPluginVoiceProviders?: () => readonly Readonly<{
    identity: Readonly<{ pluginId: string; localId: string }>;
    definition: unknown;
  }>[];
  prepareWorkspaceWritesPolicy?: RoleWorkspaceWritesPolicyPreparer;
  happyHomeDir?: string;
  resolveAutomationEventAdoptedDefinitionSet?: ResolveAutomationEventAdoptedDefinitionSetV1;
  revalidatePluginActionCallerMaterialization?: RevalidatePluginActionCallerMaterialization;
  revalidatePluginActionCallerOccurrence?: RevalidatePluginActionCallerOccurrence;
  isUsageLimitRecoveryEnabled?: (() => Promise<boolean> | boolean) | null;
  externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
  machineAdmissionTransport?: NonNullable<
    Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']
  >;
  sessionSpawnDirectTargetTransport?: SessionSpawnDirectTargetTransport;
  machineActionDirectTargetTransport?: MachineActionDirectTargetTransport;
  /** The CLI's explicit `--machine-id`; the one Machine an Account-owned read goes through when the host has no Session or daemon of its own. */
  explicitMachineId?: string;
  sessionActionRpcTransport?: SessionActionRpcTransport;
  /**
   * Read at dispatch time so the plugin runtime's declared Composer attachments
   * are reachable from the Session-input writer. It is absent for hosts that
   * run no plugin runtime, in which case a declared attachment is refused
   * rather than dropped.
   */
  resolveComposerAttachmentSendPreparation?: () => ComposerAttachmentSendPreparationRegistryV1 | null;
  /** Reads the daemon's already-retained snapshot for this exact Home. */
  resolveServerFeaturesSnapshot?: () =>
    | CliServerFeaturesSnapshot
    | undefined
    | Promise<CliServerFeaturesSnapshot | undefined>;
  /** Exact Home-bound policy/settings snapshot owned by the runtime constructor. */
  actionsSettingsProvider?: RuntimeActionSettingsProvider;
  /** Authenticated narrow policy for the constructor's exact origin Session. */
  readAgentStartPolicy?: (signal?: AbortSignal) => Promise<RequesterAgentStartPolicyV1 | null>;
  /** Existing Account workflow family owner, shared with notification link checks. */
  workflowAction?: ActionExecutorDeps['workflowAction'];
  /** Privately delivered requester credentials retained by the Machine custody owner. */
  workflowRequesterCustody?: import('@happier-dev/protocol').WorkflowAccountRunActionDeps['workflowRequesterCustody'];
  /** Exact committed contributed-Action owner supplied by this host constructor. */
  invokeContributedAction?: ActionExecutorDeps['invokeContributedAction'];
  /** Current plugin notification owner from this host's executable registry lease. */
  resolvePluginNotifications?: () => Parameters<typeof dispatchActivityNotificationAsync>[0]['pluginNotifications'];
  resolveTeamCredentialResourceCatalog?: ResolveSpawnConnectedServicesTeamResourceCatalog;
  /**
   * Stored-content material this composition already holds for one exact
   * Session, for a host whose credentials carry no Account encryption material.
   * Passed straight to the Session-scoped Action owners that need it.
   */
  resolveExactSessionEncryptionMaterial?: (sessionId: string) => SessionTransportEncryptionMaterial | null;
  /** Session bearer for content Actions only; never grants Account Artifact/settings authority. */
  sessionContentCredentials?: StoredCredentials;
  /** Existing daemon authority owner shared with coordinator effect currentness. */
  workflowAcceptedAuthorizationCurrentness?: (input: Readonly<{
    authorization: import('@happier-dev/protocol').WorkflowAcceptedAuthorizationV1;
    reservation?: import('@/daemon/workflows/recovery').WorkflowDiscussionModelReservationReplay;
    signal?: AbortSignal;
  }>) => boolean | Promise<boolean>;
}> & SessionStoredContentCryptoContext & ExternalActionHomeBinding & CliActionExactHomeTarget;


  export type ExecutionRunActionTransportOptions = Readonly<{
    surface?: ActionExecutorContext['surface'];
    authority?: ActionExecutorContext['authority'];
    actionCaller?: ActionExecutorContext['actionCaller'];
    actionRequestId?: ActionExecutorContext['actionRequestId'];
    workDepth?: number;
    workspaceWrites?: 'allow' | 'deny';
    agentStartContext?: ActionExecutorContext['agentStartContext'];
    sessionAgentSpawnPolicyV1?: unknown;
    causalPermissionAuthority?: ActionExecutorContext['causalPermissionAuthority'];
    effectiveCallerPermissionMode?: string;
    serverId?: string | null;
    originSessionId?: string | null;
    targetMachineId?: string | null;
    exactMachineId?: string | null;
    signal?: AbortSignal;
    permissionRequestStore?: unknown;
    workflowObservationSink?: unknown;
    workflowRunId?: string;
    workflowScope?: NonNullable<ActionExecutorContext['executionRunWorkflowScope']>;
    requesterWorkAttributionV1?: RpcLocalActionContext['requesterWorkAttributionV1'];
  }>;

export type ResolvedSessionTransport = Extract<
    Awaited<ReturnType<typeof resolveSessionTransportContext>>,
    Readonly<{ ok: true }>
  >;
