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
  AgentSessionAuthRefreshClassification,
  AgentSessionAuthRefreshError,
  AgentSessionAuthRefreshPayload,
  AgentSessionAuthRefreshRecovery,
  AgentSessionAuthRefreshRequest,
  AgentSessionAuthRefreshResult,
  AgentSessionAuthRefreshSelection,
  AgentSessionHooksService,
  AgentSessionHostServices,
  AgentSessionMcpServer,
  AgentSessionMcpLaunchConfig,
  AgentSessionMcpService,
  AgentSessionRuntimeContext,
  AgentSessionRuntime,
  AgentSessionRuntimeAuthApplyRequest,
  AgentSessionRuntimeAuthApplyResult,
  AgentSessionRuntimeAuthControl,
  AgentSessionRuntimeAuthIdentityRequest,
  AgentSessionRuntimeAuthIdentityResult,
  AgentSessionRuntimeFactory,
  AgentSessionRuntimeEvent,
  AgentSessionSendRequest,
  AgentSessionSendResult,
  AgentTerminalControlPresentation,
  AgentTerminalLaunchPlan,
  AgentTerminalSessionStateUpdate,
  AgentTerminalSurface,
  AgentToolExecutionLifecycle,
  AgentToolExecutionService,
  AgentTranscriptFileFollowService,
} from './agent-runtime.js';
import type {
  AgentSessionStartupInstructionsV1,
  TranscriptRawAgentEventV1,
} from '@happier-dev/protocol';
import type { SessionRuntimeAuthRefreshResultV1 } from '@happier-dev/agents';
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
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-63:Q09SRS5UMkE6IFJ1bnRpbWVDb3JlIGlzIGEgcmV0aXJlZCBzaGFkb3cgcnVudGltZSBBQkku:aW1wb3J0IHR5cGUgeyBSdW50aW1lQ29yZSB9IGZyb20gJy4vYWdlbnQtcnVudGltZS5qcyc7 */
type RuntimeCore = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-64:Q09SRS5UMkE6IFNlc3Npb25SdW50aW1lVjEgaXMgYSByZXRpcmVkIHNoYWRvdyBydW50aW1lIEFCSS4:aW1wb3J0IHR5cGUgeyBTZXNzaW9uUnVudGltZVYxIH0gZnJvbSAnLi9hZ2VudC1ydW50aW1lLmpzJzs */
type SessionRuntimeV1 = never; /* @sdk-negative-type-case-end */
// @ts-expect-error CORE.T2A: AcpSessionRuntimeV1 is replaced by the common ACP composer.
import type { AcpSessionRuntimeV1 } from './agent-runtime.js';
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-65:Q09SRS5UMkE6IEV4ZWN1dGlvblJ1bkJhY2tlbmRWMSBpcyByZXBsYWNlZCBieSBBZ2VudEV4ZWN1dGlvblJ1blJ1bnRpbWUu:aW1wb3J0IHR5cGUgeyBFeGVjdXRpb25SdW5CYWNrZW5kVjEgfSBmcm9tICcuL2FnZW50LXJ1bnRpbWUuanMnOw */
type ExecutionRunBackendV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-66:Q09SRS5UMkE6IEV4ZWN1dGlvblJ1bkJhY2tlbmQgaXMgcmVwbGFjZWQgYnkgQWdlbnRFeGVjdXRpb25SdW5SdW50aW1lLg:aW1wb3J0IHR5cGUgeyBFeGVjdXRpb25SdW5CYWNrZW5kIH0gZnJvbSAnLi9hZ2VudC1ydW50aW1lLmpzJzs */
type ExecutionRunBackend = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-67:Q09SRS5UMkE6IEV4ZWN1dGlvblJ1bkhvc3RCYWNrZW5kVjEgaXMgaG9zdC1wcml2YXRlIG1pZ3JhdGlvbiBzdGF0ZS4:aW1wb3J0IHR5cGUgeyBFeGVjdXRpb25SdW5Ib3N0QmFja2VuZFYxIH0gZnJvbSAnLi9hZ2VudC1ydW50aW1lLmpzJzs */
type ExecutionRunHostBackendV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-68:Q09SRS5UMkE6IEV4ZWN1dGlvblJ1bkhvc3RCYWNrZW5kIGlzIGhvc3QtcHJpdmF0ZSBtaWdyYXRpb24gc3RhdGUu:aW1wb3J0IHR5cGUgeyBFeGVjdXRpb25SdW5Ib3N0QmFja2VuZCB9IGZyb20gJy4vYWdlbnQtcnVudGltZS5qcyc7 */
type ExecutionRunHostBackend = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-69:Q09SRS5UMkE6IFJ1bnRpbWVFdmVudFYxIGlzIHJlcGxhY2VkIGJ5IEFnZW50U2Vzc2lvblJ1bnRpbWVFdmVudC4:aW1wb3J0IHR5cGUgeyBSdW50aW1lRXZlbnRWMSB9IGZyb20gJy4vYWdlbnRzL3J1bnRpbWUvaW5kZXguanMnOw== */
type RuntimeEventV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-70:Q09SRS5UMkE6IFJ1bnRpbWVFdmVudEtpbmRWMSBpcyBub3QgYSBzdGFibGUgZ2VuZXJpYyBlc2NhcGUgaGF0Y2gu:aW1wb3J0IHR5cGUgeyBSdW50aW1lRXZlbnRLaW5kVjEgfSBmcm9tICcuL2FnZW50LXJ1bnRpbWUuanMnOw */
type RuntimeEventKindV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-71:Q09SRS5UMkE6IFJ1bnRpbWVFdmVudEVudmVsb3BlVjEgaXMgbm90IGEgc3RhYmxlIGdlbmVyaWMgZXNjYXBlIGhhdGNoLg:aW1wb3J0IHR5cGUgeyBSdW50aW1lRXZlbnRFbnZlbG9wZVYxIH0gZnJvbSAnLi9hZ2VudC1ydW50aW1lLmpzJzs */
type RuntimeEventEnvelopeV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-72:Q09SRS5UMkE6IFJ1bnRpbWVDb250cm9sQ29udHJpYnV0aW9uIGlzIGEgcmV0aXJlZCBwcml2YXRlIGNvcnJpZG9yLg:aW1wb3J0IHR5cGUgeyBSdW50aW1lQ29udHJvbENvbnRyaWJ1dGlvbiB9IGZyb20gJy4vYWdlbnQtcnVudGltZS5qcyc7 */
type RuntimeControlContribution = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-73:Q09SRS5UMkE6IEhvc3RSdW50aW1lQ29udHJvbFNlcnZpY2VWMSBpcyBhIHJldGlyZWQgcHJpdmF0ZSBjb3JyaWRvci4:aW1wb3J0IHR5cGUgeyBIb3N0UnVudGltZUNvbnRyb2xTZXJ2aWNlVjEgfSBmcm9tICcuL2FnZW50LXJ1bnRpbWUuanMnOw */
type HostRuntimeControlServiceV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-74:Q09SRS5UMkE6IEFnZW50UnVudGltZUZhY2V0cyBpcyByZXBsYWNlZCBieSB0aGUgY2xvc2VkIHJ1bnRpbWUgc2hhcGUu:aW1wb3J0IHR5cGUgeyBBZ2VudFJ1bnRpbWVGYWNldHMgfSBmcm9tICcuL2FnZW50LXJ1bnRpbWUuanMnOw */
type AgentRuntimeFacets = never; /* @sdk-negative-type-case-end */
// @ts-expect-error G6: AgentRuntimeV1 is replaced by the native AgentRuntime contract.
import type { AgentRuntimeV1 } from './agent-runtime.js';
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-75:RzUvRzY6IFYxIGNvbXBhdGliaWxpdHkgZmFjdG9yeSB0eXBpbmcgaXMgZXhwZXJpbWVudGFsLW9ubHku:aW1wb3J0IHR5cGUgeyBBZ2VudFJ1bnRpbWVWMUNvbXBhdGliaWxpdHlGYWN0b3J5IH0gZnJvbSAnLi9hZ2VudC1ydW50aW1lLmpzJzs */
type AgentRuntimeV1CompatibilityFactory = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-76:RzU6IHByb3ZpZGVyLWJpbmRpbmcgZHJhZnRzIGFyZSBncmFkdWF0ZWQgdW5kZXIgdW5zdWZmaXhlZCBuYW1lcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFByb3ZpZGVyQmluZGluZ0FkYXB0ZXJWMSB9IGZyb20gJy4vYWdlbnQtcnVudGltZS5qcyc7 */
type AgentProviderBindingAdapterV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-77:RzU6IHByb3ZpZGVyLWJpbmRpbmcgZHJhZnRzIGFyZSBncmFkdWF0ZWQgdW5kZXIgdW5zdWZmaXhlZCBuYW1lcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFByb3ZpZGVyQmluZGluZ1ByZXBhcmVJbnB1dFYxIH0gZnJvbSAnLi9hZ2VudC1ydW50aW1lLmpzJzs */
type AgentProviderBindingPrepareInputV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-78:RzU6IHByb3ZpZGVyLWJpbmRpbmcgZHJhZnRzIGFyZSBncmFkdWF0ZWQgdW5kZXIgdW5zdWZmaXhlZCBuYW1lcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFByb3ZpZGVyQmluZGluZ1ByZXBhcmVkVjEgfSBmcm9tICcuL2FnZW50LXJ1bnRpbWUuanMnOw */
type AgentProviderBindingPreparedV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-79:RzU6IHByb3ZpZGVyLWJpbmRpbmcgZHJhZnRzIGFyZSBncmFkdWF0ZWQgdW5kZXIgdW5zdWZmaXhlZCBuYW1lcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFByb3ZpZGVyQmluZGluZ0NyZWRlbnRpYWxWMSB9IGZyb20gJy4vYWdlbnQtcnVudGltZS5qcyc7 */
type AgentProviderBindingCredentialV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-80:RzU6IHByb3ZpZGVyLWJpbmRpbmcgZHJhZnRzIGFyZSBncmFkdWF0ZWQgdW5kZXIgdW5zdWZmaXhlZCBuYW1lcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFByb3ZpZGVyQmluZGluZ1Jlc29sdmVkRmFjdHNWMSB9IGZyb20gJy4vYWdlbnQtcnVudGltZS5qcyc7 */
type AgentProviderBindingResolvedFactsV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-81:RzU6IHByb3ZpZGVyLWJpbmRpbmcgZHJhZnRzIGFyZSBncmFkdWF0ZWQgdW5kZXIgdW5zdWZmaXhlZCBuYW1lcy4:aW1wb3J0IHR5cGUgeyBBZ2VudFByb3ZpZGVyQmluZGluZ01hdGVyaWFsaXplSW5wdXRWMSB9IGZyb20gJy4vYWdlbnQtcnVudGltZS5qcyc7 */
type AgentProviderBindingMaterializeInputV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-82:Q09SRS5UMkE6IG5hdGl2ZSBzZXNzaW9uIE1DUCBiZWxvbmdzIG9ubHkgdG8gYC9hZ2VudC1ydW50aW1lYC4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25NY3BTZXJ2ZXIgYXMgUm9vdEFnZW50U2Vzc2lvbk1jcFNlcnZlciB9IGZyb20gJy4vaW5kZXguanMnOw */
type RootAgentSessionMcpServer = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-83:Q09SRS5UMkE6IG5hdGl2ZSBzZXNzaW9uIE1DUCBiZWxvbmdzIG9ubHkgdG8gYC9hZ2VudC1ydW50aW1lYC4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25NY3BTZXJ2aWNlIGFzIFJvb3RBZ2VudFNlc3Npb25NY3BTZXJ2aWNlIH0gZnJvbSAnLi9pbmRleC5qcyc7 */
type RootAgentSessionMcpService = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-84:Q09SRS5UMkE6IG5hdGl2ZSBzZXNzaW9uIE1DUCBiZWxvbmdzIG9ubHkgdG8gYC9hZ2VudC1ydW50aW1lYC4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25NY3BUcmFuc3BvcnQgYXMgUm9vdEFnZW50U2Vzc2lvbk1jcFRyYW5zcG9ydCB9IGZyb20gJy4vaW5kZXguanMnOw */
type RootAgentSessionMcpTransport = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-85:Q09SRS5UMkE6IG5hdGl2ZSBzZXNzaW9uIE1DUCBpcyBub3QgcGFydCBvZiB0aGUgZ2VuZXJpYyBgL3J1bnRpbWVgIHNlcnZpY2Ugc2VhbS4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25NY3BTZXJ2ZXIgYXMgUnVudGltZUFnZW50U2Vzc2lvbk1jcFNlcnZlciB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type RuntimeAgentSessionMcpServer = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-86:Q09SRS5UMkE6IG5hdGl2ZSBzZXNzaW9uIE1DUCBpcyBub3QgcGFydCBvZiB0aGUgZ2VuZXJpYyBgL3J1bnRpbWVgIHNlcnZpY2Ugc2VhbS4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25NY3BTZXJ2aWNlIGFzIFJ1bnRpbWVBZ2VudFNlc3Npb25NY3BTZXJ2aWNlIH0gZnJvbSAnLi9ydW50aW1lL2luZGV4LmpzJzs */
type RuntimeAgentSessionMcpService = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-agentRuntimeSurfaceContract-ts-87:Q09SRS5UMkE6IG5hdGl2ZSBzZXNzaW9uIE1DUCBpcyBub3QgcGFydCBvZiB0aGUgZ2VuZXJpYyBgL3J1bnRpbWVgIHNlcnZpY2Ugc2VhbS4:aW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb25NY3BUcmFuc3BvcnQgYXMgUnVudGltZUFnZW50U2Vzc2lvbk1jcFRyYW5zcG9ydCB9IGZyb20gJy4vcnVudGltZS9pbmRleC5qcyc7 */
type RuntimeAgentSessionMcpTransport = never; /* @sdk-negative-type-case-end */

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;
type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends
  (<T>() => T extends TRight ? 1 : 2) ? true : false;

type AgentAccountUsageService = AgentSessionHostServices['accountUsage'];
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

type _AgentToolLifecycleMustAdvertiseHonestBoundaryCapability = AssertTrue<
  Equal<
    AgentToolExecutionLifecycle['capability'],
    'interceptable' | 'observable'
  >
>;
type _AgentRuntimeMustProjectToolLifecycleCapability = AssertTrue<
  Equal<NonNullable<AgentRuntime['toolExecution']>, AgentToolExecutionLifecycle>
>;

type _SessionRuntimeAuthMustBeOneSemanticFacet = AssertTrue<
  Equal<NonNullable<AgentSessionRuntime['runtimeAuth']>, AgentSessionRuntimeAuthControl>
>;

type _SessionRuntimeAuthControlMustExposeOnlySemanticOperations = AssertTrue<
  Equal<keyof AgentSessionRuntimeAuthControl, 'apply' | 'readIdentity'>
>;

type _SessionRuntimeAuthApplyMustBeTyped = AssertTrue<
  AgentSessionRuntimeAuthControl['apply'] extends (
    request: AgentSessionRuntimeAuthApplyRequest,
  ) => Promise<AgentSessionRuntimeAuthApplyResult>
    ? true
    : false
>;

type _SessionRuntimeAuthApplyRequestMustBeBounded = AssertTrue<
  Equal<
    keyof AgentSessionRuntimeAuthApplyRequest,
    | 'serviceId'
    | 'reason'
    | 'requireDirectLiveHotApply'
    | 'expected'
    | 'authGeneration'
  >
>;

type _SessionRuntimeAuthExpectedBindingMustBeBounded = AssertTrue<
  Equal<
    keyof NonNullable<AgentSessionRuntimeAuthApplyRequest['expected']>,
    'profileId' | 'groupId' | 'generation' | 'credentialRevision'
  >
>;

type _SessionRuntimeAuthGenerationMustBeJsonSafe = AssertTrue<
  Equal<
    AgentSessionRuntimeAuthApplyRequest['authGeneration'],
    Readonly<Record<string, JsonValue>>
  >
>;

type _SessionRuntimeAuthApplyResultMustBeBounded = AssertTrue<
  Equal<
    keyof Extract<AgentSessionRuntimeAuthApplyResult, { ok: true }>,
    | 'ok'
    | 'appliedVia'
    | 'activeAccountId'
    | 'verification'
    | 'durability'
  >
>;

type _SessionRuntimeAuthApplyFailureMustBeBounded = AssertTrue<
  Equal<
    keyof Extract<AgentSessionRuntimeAuthApplyResult, { ok: false }>,
    | 'ok'
    | 'error'
    | 'errorCode'
    | 'appliedVia'
    | 'activeAccountId'
    | 'recovery'
    | 'verification'
    | 'durability'
  >
>;

type _SessionRuntimeAuthVerificationMustBeBounded = AssertTrue<
  Equal<
    keyof NonNullable<AgentSessionRuntimeAuthApplyResult['verification']>,
    | 'activeAccountId'
    | 'providerAccountId'
    | 'proofStrength'
    | 'source'
    | 'generationApplication'
  >
>;

type _SessionRuntimeAuthGenerationProofMustBeBounded = AssertTrue<
  Equal<
    keyof NonNullable<
      NonNullable<AgentSessionRuntimeAuthApplyResult['verification']>['generationApplication']
    >,
    | 'serviceId'
    | 'groupId'
    | 'profileId'
    | 'generation'
    | 'credentialRevision'
    | 'credentialFingerprint'
  >
>;

type _SessionRuntimeAuthDurabilityMustBeBounded = AssertTrue<
  Equal<
    keyof NonNullable<AgentSessionRuntimeAuthApplyResult['durability']>,
    'persisted' | 'errorCode'
  >
>;

type _SessionRuntimeAuthIdentityMustBeTyped = AssertTrue<
  AgentSessionRuntimeAuthControl['readIdentity'] extends (
    request: AgentSessionRuntimeAuthIdentityRequest,
  ) => Promise<AgentSessionRuntimeAuthIdentityResult>
    ? true
    : false
>;

type _SessionRuntimeAuthIdentityRequestMustBeBounded = AssertTrue<
  Equal<
    keyof AgentSessionRuntimeAuthIdentityRequest,
    'serviceId' | 'reason' | 'requireExactProof' | 'expected'
  >
>;

type _SessionRuntimeAuthIdentityResultMustBeBounded = AssertTrue<
  Equal<
    keyof Extract<AgentSessionRuntimeAuthIdentityResult, { ok: true }>,
    'ok' | 'serviceId' | 'identity' | 'runtime'
  >
>;

type _SessionRuntimeAuthIdentityFailureMustBeBounded = AssertTrue<
  Equal<
    keyof Extract<AgentSessionRuntimeAuthIdentityResult, { ok: false }>,
    'ok' | 'error' | 'errorCode'
  >
>;

type _SessionRuntimeAuthIdentityMustBeBounded = AssertTrue<
  Equal<
    keyof Extract<AgentSessionRuntimeAuthIdentityResult, { ok: true }>['identity'],
    | 'strategy'
    | 'proofStrength'
    | 'providerAccountId'
    | 'sharedAuthSurfaceId'
    | 'accountLabel'
    | 'source'
  >
>;

type _SessionRuntimeAuthRuntimeFactsMustBeBounded = AssertTrue<
  Equal<
    keyof NonNullable<Extract<AgentSessionRuntimeAuthIdentityResult, { ok: true }>['runtime']>,
    | 'safeToProbe'
    | 'safeToApply'
    | 'inProviderTurn'
    | 'profileId'
    | 'groupId'
    | 'generation'
    | 'credentialRevision'
  >
>;

type _SessionRuntimeAuthMustNotExposeTransportMethodNames = AssertNever<
  Extract<
    keyof AgentSessionRuntime,
    'applyConnectedServiceAuthGeneration' | 'readConnectedServiceRuntimeIdentity'
  >
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

type _ExecutionRunOpenMustCarryTheBoundedLaunchEnvironment = AssertTrue<
  AgentExecutionRunOpenRequest extends Readonly<{
    launchEnvironment?: AgentLaunchEnvironment;
  }> ? true : false
>;

type _ExecutionRunOpenMustCarryProviderBoundLaunchInputs = AssertTrue<
  Equal<
    Extract<
      keyof AgentExecutionRunOpenRequest,
      'modelSelection' | 'configuration' | 'providerBinding'
    >,
    'modelSelection' | 'configuration' | 'providerBinding'
  >
>;

type _ExecutionRunOpenMustNotExposeAnotherEnvironmentCarrier = AssertNever<
  Extract<keyof AgentExecutionRunOpenRequest, 'env' | 'environment' | 'unsetEnvKeys' | 'rawMetadata'>
>;

type _ExecutionRunOpenMustNotBecomeAPersistentSessionCarrier = AssertNever<
  Extract<
    keyof AgentExecutionRunOpenRequest,
    'connectedAccounts' | 'mcpServers' | 'startupInstructions'
  >
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
  Equal<
    keyof AgentTerminalLaunchRequest,
    'sessionId' | 'cwd' | 'metadata' | 'modelSelection'
  >
>;

type _TerminalLaunchPlanMustStayDataOnly = AssertTrue<
  Equal<
    keyof AgentTerminalLaunchPlan,
    'argv' | 'environment' | 'process' | 'presentation' | 'resultMetadata'
  >
>;

type _TerminalResultUpdatesMustStayIdentityOnly = AssertTrue<
  Equal<
    AgentTerminalSessionStateUpdate['fieldId'],
    'identity.runtimeDescriptor' | 'identity.providerSessionId'
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
    | 'mcp'
    | 'features'
    | 'terminalHost'
    | 'models'
    | 'activeInput'
    | 'workflowActivity'
    | 'toolExecution'
  >
>;

type _AgentToolExecutionServiceMustExposeOnlyThePreEffectBoundary = AssertTrue<
  Equal<keyof AgentToolExecutionService, 'before'>
>;

type _SessionMcpTransportMustStayBounded = AssertTrue<
  Equal<
    AgentSessionMcpTransport,
    | Readonly<{ kind: 'http' | 'sse'; url: string }>
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

type _SessionTranscriptServiceMustExposeOnlyDurableHostOwnedOperations = AssertTrue<
  Equal<
    keyof AgentSessionHostServices['transcripts'],
    'fileFollow' | 'markSourceFactConsumed' | 'publishSessionEvent'
  >
>;

type _SessionEventPublicationMustAwaitDurableCustody = AssertTrue<
  Equal<
    AgentSessionHostServices['transcripts']['publishSessionEvent'],
    (
      event: TranscriptRawAgentEventV1,
    ) => Promise<Readonly<{ status: 'custodied' }>>
  >
>;

type _SessionWorkflowActivityServiceMustExposeOnlyTheCompactHeadlineProjection = AssertTrue<
  Equal<keyof AgentSessionHostServices['workflowActivity'], 'publishHeadlines'>
>;

type _SessionWorkflowActivityPublicationMustAcceptOnlyTheCanonicalHeadline = AssertTrue<
  Equal<
    Parameters<AgentSessionHostServices['workflowActivity']['publishHeadlines']>[0],
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

type _AgentAccountUsageSnapshotMustNotExposeHostCustody = AssertNever<
  Extract<keyof AgentAccountUsageSnapshot, 'recordId' | 'persisted'>
>;

type _AgentAccountUsageSnapshotMustRemainAProtocolObservation = AssertTrue<
  AgentAccountUsageSnapshot extends Omit<ProviderAccountUsageSnapshotV1, 'recordId'> ? true : false
>;

type _ProtocolAccountUsageRecordKeyMustSatisfyTheAuthorDto = AssertTrue<
  ProviderAccountUsageRecordKeyV1 extends AgentAccountUsageRecordKey ? true : false
>;

type _AuthorAccountUsageRecordKeyMustRemainProtocolCompatible = AssertTrue<
  AgentAccountUsageRecordKey extends ProviderAccountUsageRecordKeyV1 ? true : false
>;

type _AgentAccountUsageSourceAddressMustAcceptExternalServices = AssertTrue<
  'third-party.example/usage' extends Parameters<AgentAccountUsageService['resolveSourceContext']>[0]['serviceId']
    ? true
    : false
>;

type _AgentAccountUsageRecordMustUseTheSemanticSourceAddress = AssertTrue<
  Equal<
    NonNullable<Parameters<AgentAccountUsageService['recordSnapshot']>[0]['source']>,
    Parameters<AgentAccountUsageService['resolveSourceContext']>[0]
  >
>;

type _AgentAccountUsageSourceContextMustNotExposeHostWitnesses = AssertNever<
  Extract<
    keyof NonNullable<Awaited<ReturnType<AgentAccountUsageService['resolveSourceContext']>>>,
    'groupGeneration' | 'credentialFingerprint'
  >
>;

type _AgentAccountUsageRecordResultMustStaySemantic = AssertTrue<
  Equal<
    Awaited<ReturnType<AgentAccountUsageService['recordSnapshot']>>,
    | Readonly<{ status: 'recorded' }>
    | Readonly<{ status: 'unavailable'; reason: 'session_scope_unavailable' | 'daemon_unavailable' }>
    | Readonly<{ status: 'rejected'; reason: 'invalid_snapshot' | 'session_mismatch' | 'daemon_rejected' }>
  >
>;

type _AgentAccountUsageAdoptionProofMustStayProviderOwned = AssertTrue<
  Equal<
    Parameters<AgentAccountUsageService['adoptProvisionalRecord']>[0]['adoption']['proof']['kind'],
    'id_token_account_id' | 'provider_account_id_match' | 'provider_owned_subject_proof'
  >
>;

type _AgentAccountUsageAdoptionResultMustNotEchoHostCustody = AssertTrue<
  Equal<
    Awaited<ReturnType<AgentAccountUsageService['adoptProvisionalRecord']>>,
    | Readonly<{ status: 'adopted' | 'already_adopted' }>
    | Readonly<{ status: 'unavailable'; reason: 'session_scope_unavailable' | 'daemon_unavailable' }>
    | Readonly<{ status: 'rejected'; reason: 'invalid_adoption' | 'session_mismatch' | 'daemon_rejected' }>
  >
>;

type _SessionAuthRequestMustNotExposeHostAgentIdentity = AssertNever<
  Extract<keyof AgentSessionAuthRefreshRequest, 'agentId'>
>;

type _SessionAuthRequestMustUseNamedBoundedContracts = AssertTrue<
  Equal<
    Pick<AgentSessionAuthRefreshRequest, 'selection' | 'classification'>,
    Readonly<{
      selection?: AgentSessionAuthRefreshSelection;
      classification?: AgentSessionAuthRefreshClassification;
    }>
  >
>;

type _SessionAuthResultMustUseCanonicalRuntimeContract = AssertTrue<
  Equal<AgentSessionAuthRefreshResult, SessionRuntimeAuthRefreshResultV1>
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
