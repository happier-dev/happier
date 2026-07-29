import type {
  AgentAcpRuntimeDefinition,
  AgentAcpRuntimeOptions,
  AgentExecutionRunOpenRequest,
  AgentLaunchEnvironment,
  AgentProviderBindingAdapter,
  AgentProviderBindingCredential,
  AgentProviderBindingMaterializeInput,
  AgentProviderBindingPrepareInput,
  AgentProviderBindingPrepared,
  AgentProviderBindingResolvedFacts,
  AgentRuntime,
  AgentRuntimeFactoryContext,
  AgentSessionControlContext,
  AgentSessionConfigurationSnapshot,
  AgentSessionConfigurationUpdate,
  AgentSessionConversationRollbackRequest,
  AgentSessionOpenRequest,
  AgentSessionAuthRefreshRequest,
  AgentSessionHooksService,
  AgentSessionHostServices,
  AgentSessionMcpServer,
  AgentSessionMcpLaunchConfig,
  AgentSessionMcpService,
  AgentSessionRuntimeContext,
  AgentSessionRuntime,
  AgentSessionRuntimeFactory,
  AgentSessionRuntimeEvent,
  AgentSessionSendRequest,
  AgentSessionSendResult,
  AgentTerminalControlPresentation,
  AgentTerminalLaunchPlan,
  AgentTerminalSurface,
  AgentTranscriptFileFollowService,
} from './agent-runtime.js';
import type { AgentSessionStartupInstructionsV1 } from '@happier-dev/protocol';
import type { PluginAgentAcpTransport } from '@happier-dev/protocol';
import type {
  ProviderAccountUsageRecordKeyV1,
  ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import type { JsonValue, PluginApi } from './index.js';
import type {
  AgentAccountUsageRecordKey,
  AgentAccountUsageSnapshot,
} from './agentRuntime/accountUsage.js';
import type {
  AgentProviderBindingAdapter as ExperimentalAgentProviderBindingAdapterV1,
  AgentProviderBindingMaterializeInput as ExperimentalAgentProviderBindingMaterializeInputV1,
} from './agentRuntime/providerBinding.js';

// These imports are deliberate compile-time negatives. Runtime namespace tests
// cannot detect type-only exports, so each retired public name needs its own
// expected failure to prevent a legacy type from silently reappearing in the
// curated `agent-runtime` declaration surface.
// @ts-expect-error CORE.T2A: RuntimeCoreV1 is a retired shadow runtime ABI.
import type { RuntimeCoreV1 } from './agent-runtime.js';
// @ts-expect-error CORE.T2A: RuntimeCore is a retired shadow runtime ABI.
import type { RuntimeCore } from './agent-runtime.js';
// @ts-expect-error CORE.T2A: SessionRuntimeV1 is a retired shadow runtime ABI.
import type { SessionRuntimeV1 } from './agent-runtime.js';
// @ts-expect-error CORE.T2A: AcpSessionRuntimeV1 is replaced by the common ACP composer.
import type { AcpSessionRuntimeV1 } from './agent-runtime.js';
// @ts-expect-error CORE.T2A: ExecutionRunBackendV1 is replaced by AgentExecutionRunRuntime.
import type { ExecutionRunBackendV1 } from './agent-runtime.js';
// @ts-expect-error CORE.T2A: ExecutionRunBackend is replaced by AgentExecutionRunRuntime.
import type { ExecutionRunBackend } from './agent-runtime.js';
// @ts-expect-error CORE.T2A: ExecutionRunHostBackendV1 is host-private migration state.
import type { ExecutionRunHostBackendV1 } from './agent-runtime.js';
// @ts-expect-error CORE.T2A: ExecutionRunHostBackend is host-private migration state.
import type { ExecutionRunHostBackend } from './agent-runtime.js';
// @ts-expect-error CORE.T2A: RuntimeEventV1 is replaced by AgentSessionRuntimeEvent.
import type { RuntimeEventV1 } from './agent-runtime.js';
// @ts-expect-error CORE.T2A: RuntimeEventKindV1 is not a stable generic escape hatch.
import type { RuntimeEventKindV1 } from './agent-runtime.js';
// @ts-expect-error CORE.T2A: RuntimeEventEnvelopeV1 is not a stable generic escape hatch.
import type { RuntimeEventEnvelopeV1 } from './agent-runtime.js';
// @ts-expect-error CORE.T2A: RuntimeControlContribution is a retired private corridor.
import type { RuntimeControlContribution } from './agent-runtime.js';
// @ts-expect-error CORE.T2A: HostRuntimeControlServiceV1 is a retired private corridor.
import type { HostRuntimeControlServiceV1 } from './agent-runtime.js';
// @ts-expect-error CORE.T2A: AgentRuntimeFacets is replaced by the closed runtime shape.
import type { AgentRuntimeFacets } from './agent-runtime.js';
// @ts-expect-error G6: AgentRuntimeV1 is replaced by the native AgentRuntime contract.
import type { AgentRuntimeV1 } from './agent-runtime.js';
// @ts-expect-error G5/G6: V1 compatibility factory typing is experimental-only.
import type { AgentRuntimeV1CompatibilityFactory } from './agent-runtime.js';
// @ts-expect-error G5: provider-binding drafts are graduated under unsuffixed names.
import type { AgentProviderBindingAdapterV1 } from './agent-runtime.js';
// @ts-expect-error G5: provider-binding drafts are graduated under unsuffixed names.
import type { AgentProviderBindingPrepareInputV1 } from './agent-runtime.js';
// @ts-expect-error G5: provider-binding drafts are graduated under unsuffixed names.
import type { AgentProviderBindingPreparedV1 } from './agent-runtime.js';
// @ts-expect-error G5: provider-binding drafts are graduated under unsuffixed names.
import type { AgentProviderBindingCredentialV1 } from './agent-runtime.js';
// @ts-expect-error G5: provider-binding drafts are graduated under unsuffixed names.
import type { AgentProviderBindingResolvedFactsV1 } from './agent-runtime.js';
// @ts-expect-error G5: provider-binding drafts are graduated under unsuffixed names.
import type { AgentProviderBindingMaterializeInputV1 } from './agent-runtime.js';
// @ts-expect-error CORE.T2A: native session MCP belongs only to `/agent-runtime`.
import type { AgentSessionMcpServer as RootAgentSessionMcpServer } from './index.js';
// @ts-expect-error CORE.T2A: native session MCP belongs only to `/agent-runtime`.
import type { AgentSessionMcpService as RootAgentSessionMcpService } from './index.js';
// @ts-expect-error CORE.T2A: native session MCP belongs only to `/agent-runtime`.
import type { AgentSessionMcpTransport as RootAgentSessionMcpTransport } from './index.js';
// @ts-expect-error CORE.T2A: native session MCP is not part of the generic `/runtime` service seam.
import type { AgentSessionMcpServer as RuntimeAgentSessionMcpServer } from './runtime/index.js';
// @ts-expect-error CORE.T2A: native session MCP is not part of the generic `/runtime` service seam.
import type { AgentSessionMcpService as RuntimeAgentSessionMcpService } from './runtime/index.js';
// @ts-expect-error CORE.T2A: native session MCP is not part of the generic `/runtime` service seam.
import type { AgentSessionMcpTransport as RuntimeAgentSessionMcpTransport } from './runtime/index.js';

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;
type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends
  (<T>() => T extends TRight ? 1 : 2) ? true : false;

type AgentAccountUsageService = AgentSessionHostServices['accountUsage'];
type AgentSessionAuthService = AgentSessionHostServices['auth'];
type AgentSessionMcpTransport = AgentSessionMcpServer['transport'];
type AgentTerminalLaunchRequest =
  Parameters<AgentTerminalSurface['resolveLaunch']>[0];

type _AcpComposerMustConsumeManifestTransport = AssertTrue<
  Equal<AgentAcpRuntimeOptions['transport'], PluginAgentAcpTransport>
>;

type _PublicAcpComposerMustRejectLiteralExecutables = AssertNever<
  Extract<
    Extract<PluginAgentAcpTransport, { kind: 'stdio' }>['executable'],
    Readonly<{ kind: 'literal' }>
  >
>;

type _AcpDefinitionAuthMustStayNarrow = AssertTrue<
  Equal<
    NonNullable<AgentAcpRuntimeDefinition['auth']>,
    | Readonly<{ methodId: string }>
    | Readonly<{
        selectMethod(
          context: import('./agent-runtime.js').AgentAcpAuthenticationContext,
        ):
          | import('./agent-runtime.js').AgentAcpAuthenticationSelection
          | null
          | Promise<import('./agent-runtime.js').AgentAcpAuthenticationSelection | null>;
      }>
  >
>;

type _AcpDefinitionMustExposeOnlyClosedProtocolMetadata = AssertTrue<
  Equal<
    Extract<keyof AgentAcpRuntimeDefinition, 'parameterizedModelPicker' | 'metadata' | 'initializeMeta'>,
    'parameterizedModelPicker'
  >
>;

type _AcpDefinitionMustExposeNarrowToolHooks = AssertTrue<
  Equal<
    Extract<keyof AgentAcpRuntimeDefinition, 'toolNameResolver' | 'sanitizeToolUpdateContent'>,
    'toolNameResolver' | 'sanitizeToolUpdateContent'
  >
>;

type _AcpGeneratedMediaMustStayPureAndBounded = AssertTrue<
  Equal<
    NonNullable<AgentAcpRuntimeDefinition['generatedMedia']>,
    Readonly<{
      projectTerminalOutput(input: Readonly<{
        rawOutput: unknown;
        toolCallId: string;
        toolName: string;
      }>): readonly Readonly<{ rootPath: string; path: string }>[] | null;
    }>
  >
>;

type _FactoryContextMustBeServiceFree = AssertNever<
  Extract<keyof AgentRuntimeFactoryContext, 'services' | 'session' | 'protocols' | 'workState'>
>;
type _FactoryContextIdentityMustBeExact = AssertTrue<
  Equal<keyof AgentRuntimeFactoryContext, 'plugin' | 'agent' | 'signal'>
>;

type _RuntimeMustNotExposeShadowLifecycle = AssertNever<
  Extract<
    keyof AgentSessionRuntime,
    | 'identity'
    | 'events'
    | 'setOnPromptAcceptedByProvider'
    | 'setOnPromptTerminallyRejectedBeforeProvider'
    | 'beginTurnLifecycle'
    | 'startOrLoadSession'
    | 'waitForTurnCompletion'
    | 'supportsInFlightSteer'
    | 'isTurnInFlight'
    | 'canSteerPrompt'
    | 'applyConfigDeltaInFlight'
    | 'runtimeControl'
    | 'controls'
    | 'sessionControls'
  >
>;

type _ProviderBindingMustExposeOnlyUnsuffixedAuthorContracts = AssertTrue<
  AgentProviderBindingAdapter extends Readonly<{
    prepare(input: AgentProviderBindingPrepareInput): AgentProviderBindingPrepared;
    materialize(
      input: AgentProviderBindingMaterializeInput,
    ): unknown | Promise<unknown>;
  }>
    ? AgentProviderBindingMaterializeInput extends Readonly<{
        binding: AgentProviderBindingResolvedFacts;
        prepared: AgentProviderBindingPrepared;
        credential: AgentProviderBindingCredential;
      }>
      ? true
      : false
    : false
>;

type AgentRegistrationOptionsFromPluginApi = Parameters<PluginApi['agents']['register']>[2];
type _PluginApiAgentRegistrationMustExposeTheProviderBindingContract = AssertTrue<
  NonNullable<AgentRegistrationOptionsFromPluginApi> extends Readonly<{
    providerBinding?: AgentProviderBindingAdapter;
  }> ? true : false
>;

type _ExperimentalProviderBindingV1MustRemainAvailableOffTheNormalPath = AssertTrue<
  ExperimentalAgentProviderBindingAdapterV1 extends Readonly<{
    materialize(input: ExperimentalAgentProviderBindingMaterializeInputV1): unknown;
  }> ? true : false
>;

type _SessionOpenKindsAreClosed = AssertTrue<
  Equal<AgentSessionOpenRequest['kind'], 'create' | 'resume' | 'fork'>
>;

type _SessionOpenMustNotExposeOpaqueOrAttachState = AssertNever<
  Extract<keyof AgentSessionOpenRequest, 'initialRuntimeState' | 'resume' | 'attach'>
>;

type _SessionOpenMustCarryOnlyTheBoundedVB4Inputs = AssertTrue<
  Equal<
    Extract<keyof AgentSessionOpenRequest, 'launchEnvironment' | 'configuration'>,
    'launchEnvironment' | 'configuration'
  >
>;

type _CreateAndResumeMayCarryStartupInstructionsV1 = AssertTrue<
  Equal<
    NonNullable<
      Extract<
        AgentSessionOpenRequest,
        { kind: 'create' | 'resume' }
      >['startupInstructions']
    >,
    AgentSessionStartupInstructionsV1
  >
>;

type _ForkMustNotCarryStartupInstructions = AssertNever<
  Extract<
    keyof Extract<AgentSessionOpenRequest, { kind: 'fork' }>,
    'startupInstructions'
  >
>;

type _ExecutionRunOpenMustReuseTheBoundedLaunchEnvironment = AssertTrue<
  Equal<
    Extract<keyof AgentExecutionRunOpenRequest, 'launchEnvironment'>,
    'launchEnvironment'
  >
>;

type _ExecutionRunOpenMustNotExposeAnotherEnvironmentCarrier = AssertNever<
  Extract<keyof AgentExecutionRunOpenRequest, 'env' | 'environment' | 'unsetEnvKeys' | 'rawMetadata'>
>;

type _SessionOpenMustNotExposeASecondPermissionOrMcpOwner = AssertNever<
  Extract<
    keyof AgentSessionOpenRequest,
    'permissionMode' | 'permissionIntent' | 'permissionModeId' | 'mcp' | 'rawMetadata'
  >
>;

type _SessionMcpLaunchConfigMustStayDataOnly = AssertTrue<
  Equal<keyof AgentSessionMcpLaunchConfig, 'command' | 'args' | 'env'>
>;

type _SessionOpenMustCarryOnlyBoundedMcpLaunchConfigs = AssertTrue<
  Equal<
    NonNullable<AgentSessionOpenRequest['mcpServers']>,
    Readonly<Record<string, AgentSessionMcpLaunchConfig>>
  >
>;

type _LaunchEnvironmentShapeMustStayDataOnly = AssertTrue<
  Equal<keyof AgentLaunchEnvironment, 'values' | 'unset'>
>;

type _ConfigurationSnapshotShapeMustStayDataOnly = AssertTrue<
  Equal<keyof AgentSessionConfigurationSnapshot, 'mode' | 'model' | 'permissionIntent' | 'options'>
>;

type _PermissionIntentMustBeTheOneClosedDecision = AssertTrue<
  Equal<
    AgentSessionConfigurationSnapshot['permissionIntent']['value'],
    'default' | 'read-only' | 'safe-yolo' | 'yolo' | 'plan' | null
  >
>;

type _ConfigurationOptionsMustStayScalar = AssertTrue<
  Equal<
    AgentSessionConfigurationSnapshot['options'][string]['value'],
    string | number | boolean | null
  >
>;

type _ConfigurationUpdateMustReuseTheOneSnapshotShape = AssertTrue<
  Equal<
    Omit<AgentSessionConfigurationUpdate, 'providerBinding'>,
    AgentSessionConfigurationSnapshot
  >
>;

type _ConfigurationUpdateProviderBindingMustUseTheSessionBinding = AssertTrue<
  Equal<
    AgentSessionConfigurationUpdate['providerBinding'],
    AgentSessionOpenRequest['providerBinding']
  >
>;

type _InputTupleMustBeNonEmpty = AssertTrue<
  AgentSessionSendRequest['inputIds'] extends readonly [string, ...string[]] ? true : false
>;

type _AdmittedSendMustEchoNoIds = AssertTrue<
  Equal<keyof Extract<AgentSessionSendResult, { status: 'admitted' }>, 'status'>
>;

type _AgentRuntimeMustHavePrimaryExecutableSurface = AssertTrue<
  Record<never, never> extends AgentRuntime ? false : true
>;

type _AgentRuntimeMustNotExposeGenericControls = AssertNever<
  Extract<keyof AgentRuntime, 'controls' | 'runtimeControl' | 'facets' | 'attach'>
>;

type _TerminalLaunchRequestMustStayHostResolved = AssertTrue<
  Equal<keyof AgentTerminalLaunchRequest, 'sessionId' | 'cwd' | 'metadata'>
>;

type _TerminalLaunchPlanMustStayDataOnly = AssertTrue<
  Equal<
    keyof AgentTerminalLaunchPlan,
    'argv' | 'environment' | 'process' | 'presentation' | 'resultMetadata'
  >
>;

type _TerminalControlPresentationMustStayProviderNeutral = AssertTrue<
  Equal<keyof AgentTerminalControlPresentation, 'target' | 'reason'>
>;

type _TerminalSurfaceMustExposeOnlyLaunchResolution = AssertTrue<
  Equal<keyof AgentTerminalSurface, 'resolveLaunch'>
>;

type _SessionContextMustKeepHostServicesUnderTheBoundSession = AssertTrue<
  Equal<keyof AgentSessionRuntimeContext['session'], 'id' | 'services'>
>;

type _SessionControlContextMustNotExposeReflectiveRuntimeExtensions = AssertTrue<
  Equal<Extract<keyof AgentSessionControlContext['session'], 'requestExtension'>, never>
>;

type _SessionHostServicesMustStayNarrowAndProviderNeutral = AssertTrue<
  Equal<
    keyof AgentSessionHostServices,
    | 'sessionHooks'
    | 'transcripts'
    | 'accountUsage'
    | 'auth'
    | 'mcp'
    | 'features'
    | 'terminalHost'
    | 'models'
    | 'activeInput'
    | 'systemRecords'
    | 'workflowActivity'
  >
>;

type _SessionMcpTransportMustStayBounded = AssertTrue<
  Equal<
    AgentSessionMcpTransport,
    | Readonly<{ kind: 'http' | 'sse'; url: string }>
    | Readonly<{ kind: 'managed'; url?: string }>
    | Readonly<{ kind: 'hosted' | 'stdio' }>
  >
>;

type _SessionMcpServerMustStayDataOnly = AssertTrue<
  Equal<keyof AgentSessionMcpServer, 'id' | 'name' | 'transport'>
>;

type _SessionMcpServiceMustExposeOnlyServerResolution = AssertTrue<
  Equal<keyof AgentSessionMcpService, 'resolveServers'>
>;

type _SessionHookServiceMustExposeOnlyTheExistingLifecycleOwner = AssertTrue<
  Equal<
    keyof AgentSessionHooksService,
    | 'startServer'
    | 'resolveForwarderAssets'
    | 'createPluginDir'
    | 'disposePluginDir'
    | 'publishProviderTranscript'
  >
>;

type _SessionTranscriptServiceMustExposeOnlyFileFollow = AssertTrue<
  Equal<keyof AgentSessionHostServices['transcripts'], 'fileFollow'>
>;

type AgentSessionSystemRecordWriteRequest = Parameters<
  AgentSessionHostServices['systemRecords']['write']
>[0];

type AgentSessionSystemRecordReadRequest = Parameters<
  AgentSessionHostServices['systemRecords']['read']
>[0];

type AgentSessionSystemRecordReadResult = Exclude<
  Awaited<ReturnType<AgentSessionHostServices['systemRecords']['read']>>,
  null
>;

type _SessionSystemRecordWriteMustStaySessionScopedAndPayloadOnly = AssertTrue<
  Equal<
    keyof AgentSessionSystemRecordWriteRequest,
    'namespace' | 'kind' | 'localId' | 'payload'
  >
>;

type _SessionSystemRecordReadMustStayKeyedAndSessionScoped = AssertTrue<
  Equal<keyof AgentSessionSystemRecordReadRequest, 'namespace' | 'localId'>
>;

type _SessionSystemRecordReadResultMustNotExposeStorageEnvelope = AssertTrue<
  Equal<
    keyof AgentSessionSystemRecordReadResult,
    'namespace' | 'kind' | 'localId' | 'payload'
  >
>;

type _SessionWorkflowActivityServiceMustExposeOnlyTheCompactHeadlineProjection = AssertTrue<
  Equal<keyof AgentSessionHostServices['workflowActivity'], 'publishHeadline'>
>;

type _SessionWorkflowActivityPublicationMustAcceptOnlyTheCanonicalHeadline = AssertTrue<
  Equal<
    Parameters<AgentSessionHostServices['workflowActivity']['publishHeadline']>[0],
    JsonValue
  >
>;

type _SessionFileFollowMustNotPromoteTranscriptWrites = AssertTrue<
  Equal<keyof AgentTranscriptFileFollowService, 'follow'>
>;

type _SessionAccountUsageMustStayOnTheExistingOwner = AssertTrue<
  Equal<
    keyof AgentAccountUsageService,
    'resolveSourceContext' | 'recordSnapshot' | 'adoptProvisionalRecord'
  >
>;

type _ProtocolAccountUsageSnapshotMustSatisfyTheAuthorDto = AssertTrue<
  ProviderAccountUsageSnapshotV1 extends AgentAccountUsageSnapshot ? true : false
>;

type _AuthorAccountUsageSnapshotMustRemainProtocolCompatible = AssertTrue<
  AgentAccountUsageSnapshot extends ProviderAccountUsageSnapshotV1 ? true : false
>;

type _ProtocolAccountUsageRecordKeyMustSatisfyTheAuthorDto = AssertTrue<
  ProviderAccountUsageRecordKeyV1 extends AgentAccountUsageRecordKey ? true : false
>;

type _AuthorAccountUsageRecordKeyMustRemainProtocolCompatible = AssertTrue<
  AgentAccountUsageRecordKey extends ProviderAccountUsageRecordKeyV1 ? true : false
>;

type _SessionAuthMustExposeOnlyRuntimeRefresh = AssertTrue<
  Equal<keyof AgentSessionAuthService, 'refreshRuntimeAuth'>
>;

type _SessionAuthRequestMustNotExposeHostAgentIdentity = AssertNever<
  Extract<keyof AgentSessionAuthRefreshRequest, 'agentId'>
>;

type _RollbackRequestMustBeHostResolved = AssertTrue<
  Equal<
    keyof AgentSessionConversationRollbackRequest,
    | 'operationId'
    | 'target'
    | 'affectedTurns'
    | 'providerSessionId'
    | 'runtimeIncarnationId'
    | 'managedServerInstanceId'
  >
>;

type _RollbackSuffixMustBeNonEmpty = AssertTrue<
  AgentSessionConversationRollbackRequest['affectedTurns'] extends readonly [
    Readonly<{ turnId: string; providerCheckpoint?: JsonValue }>,
    ...Readonly<{ turnId: string; providerCheckpoint?: JsonValue }>[],
  ]
    ? true
    : false
>;

type _RollbackControlMustBeSessionScoped = AssertTrue<
  Equal<
    Extract<keyof AgentSessionRuntime, 'conversationRollback'>,
    'conversationRollback'
  >
>;

type _RollbackControlMustNotBeFactoryScoped = AssertNever<
  Extract<keyof AgentSessionRuntimeFactory, 'conversationRollback'>
>;

type RetiredOrHostDerivedRuntimeEventKind =
  | 'turn-input-appended'
  | 'transcript-user-text'
  | 'transcript-agent-message-committed'
  | 'turn-rollback-boundary-observed'
  | 'turn-rollback-applied'
  | 'session-ended'
  | 'runtime-status-change'
  | 'session-id-publish'
  | 'descriptor-update'
  | 'diff-emit'
  | 'backend-error'
  | 'token-count'
  | 'subagent-start'
  | 'subagent-status-change'
  | 'subagent-end';

type _RetiredAndHostDerivedWritersMustBeAbsent = AssertNever<
  Extract<AgentSessionRuntimeEvent['kind'], RetiredOrHostDerivedRuntimeEventKind>
>;

type _PublicAgentRuntimeMustNotPublishMeasuredLimits = AssertNever<
  Extract<
    keyof typeof import('./agent-runtime.js'),
    'AGENT_SESSION_RUNTIME_LIMITS_V1' | 'AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1'
  >
>;
