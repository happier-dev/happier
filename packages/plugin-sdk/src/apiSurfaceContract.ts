import type {
  PluginApiHookRegistrationV1,
  PluginApiActionRegistrationV1,
  PluginApiCommandRegistrationV1,
  PluginApiLifecycleHandlerRegistrationV1,
  PluginApiMcpDiscoveryProviderRegistrationV1,
  PluginApiMcpServerRegistrationV1,
  PluginApiNotificationCategoryRegistrationV1,
  PluginApiNotificationChannelRegistrationV1,
  PluginApiRegisterMethodV1,
  PluginApiToolRegistrationV1,
  PluginApiV1,
  PluginActionSurface,
  PluginHookHandler,
  PluginHookHandlerContextV1,
  PluginHookPayloadMapV1,
  PluginHookResultMapV1,
  PluginActionHandlerRequest,
  ScmBackendRuntimeRegistration,
} from './api.js';
import {
  CHANGE_TITLE_TOOL_NAME_ALIASES,
  isChangeTitleToolNameAlias,
} from './acp/index.js';
import {
  AGENT_MODEL_CONFIG,
  CANONICAL_AGENTS_CORE,
} from './agents.js';
import * as AgentsPublicSurface from './agents.js';
import type { AcpToolNameResolverV1 } from './acp/types.js';
import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceCredentialRecordV1Schema,
  ConnectedServiceProfileIdSchema,
  ConnectedServiceQuotaSnapshotV1Schema,
  buildConnectedServiceCredentialRecord,
  normalizeConnectedServiceLimitCategoryV1,
  readSessionMetadataConnectedServiceBindings,
  resolveConnectedServicesProviderStateSharingPolicyV1,
} from './cloud/auth.js';
import {
  ConnectedServiceUsageSourceV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionRuntimeIssueV1Schema,
  SessionUsageLimitRecoveryV1Schema,
  buildProviderAccountUsageOpaqueLocalCredentialRef,
  buildProviderAccountUsageRecordId,
} from './cloud/usage.js';
import type {
  AcpSessionRuntimeConfigUpdateV1,
  PluginHandlerServicesV1,
  PluginContextV1,
} from './context.js';
import type { AgentProviderBindingAdapterV1, RegisterAgentRuntimeV1 } from './engine.js';
import type { RegisterDaemonAuthBridgeV1 } from './agentRuntime/authBridge.js';
import type {
  AccountSettings,
  ConnectedServiceAuthGroupId,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
  ConnectedServiceLimitCategoryV1,
  ConnectedServiceProfileId,
  ConnectedServiceQuotaMeterV1,
  ConnectedServiceQuotaSnapshotV1,
  ConnectedServicesProviderStateSharingPolicyV1,
  SessionMetadataConnectedServiceBinding,
} from './cloud/auth.js';
import type {
  ConnectedServiceUsageSourceV1,
  ProviderAccountUsageRecordKeyV1,
  ProviderAccountUsageSnapshotV1,
  SessionUsageLimitRecoveryV1,
} from './cloud/usage.js';
import {
  redactBugReportSensitiveText,
  trimBugReportTextToMaxBytes,
} from './diagnostics.js';
import {
  PLUGIN_HOOK_CATALOG_V1,
  getPluginHookDefinitionV1,
} from './events.js';
import type { AIBackendProfile } from './manifest.js';
import type {
  DaemonMcpServersDetectWarningV1,
  DetectedMcpServerV1,
} from './mcp.js';
import type { PromptAssetTypeDescriptorV1 } from './manifest.js';
import type {
  SkillCatalogItemV1,
  VendorPluginCatalogItemV1,
} from './runtime/catalog.js';
import {
  buildSessionRuntimeIssueV1,
  readHappierStructuredInputV1FromMeta,
  resolveRecoverableTurnFailureRetryDecision,
} from './runtime/session.js';
import type {
  BuildSessionRuntimeIssueV1Input,
  CreateSessionRuntimeParamsV1,
  HappierStructuredInputV1,
  SessionRuntimeMcpServerConfigV1,
  SessionRuntimeIssueV1,
  SessionRuntimeUsageLimitDetailsV1,
} from './runtime/session.js';
import type {
  SessionStateProviderFieldHandler,
  ParticipantMessageV1,
  SubagentCommandV1,
  SubagentLaunchV1,
  SessionPermissionDecisionResultV1,
  SessionPermissionFollowUpPromptIntentV1,
  SessionPermissionPersistAllowRuleV1,
} from './sessions/index.js';
import {
  LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
  SESSION_CONFIG_OPTIONS_STATE_KEY,
  SESSION_CONFIG_OPTION_OVERRIDES_KEY,
  readMetadataAliasValue,
} from './sessions/index.js';
import {
  isGenericSubAgentToolName,
  parseParticipantMessageV1,
  parseSubagentCommandV1,
  parseSubagentLaunchV1,
} from './sessions/subagents.js';
import { buildUsageObservationEffect } from './usage.js';
import type {
  SessionContextUsageSnapshotV1,
  UsageObservationContext,
  UsageObservationCost,
  UsageObservationEffectV1,
  UsageObservationScope,
  UsageObservationTokens,
} from './usage.js';
import type { PluginHookIdV1 } from '@happier-dev/protocol';
import type {
  ScmHostingProviderRuntimeAdapter,
  ScmHostingProviderRuntimeServices,
} from './scm/hostingProvider.js';

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;
type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends
  (<T>() => T extends TRight ? 1 : 2) ? true : false;

type IsUnknown<T> = unknown extends T
  ? keyof T extends never
    ? true
    : false
  : false;

type LegacyStaticRegistrationKeys = Extract<
  keyof PluginApiV1,
  `${'register'}Provider` | `${'register'}Backend` | `${'register'}Runtime${'Adapter'}`
>;

type _PluginApiMustNotExposeLegacyStaticRegistration = AssertNever<LegacyStaticRegistrationKeys>;

type _PluginApiMustExposeAgentRuntimeRegistration = AssertTrue<
  PluginApiV1 extends Readonly<{
    registerAgentRuntime: PluginApiRegisterMethodV1<RegisterAgentRuntimeV1>;
  }> ? true : false
>;

type _PluginApiMustExposeDaemonAuthBridgeRegistration = AssertTrue<
  PluginApiV1 extends Readonly<{
    registerDaemonAuthBridge: PluginApiRegisterMethodV1<RegisterDaemonAuthBridgeV1>;
  }> ? true : false
>;

type _PluginApiMustNotExposeBackendEngineRegistration = AssertTrue<
  Extract<keyof PluginApiV1, `register${'BackendEngine'}`> extends never ? true : false
>;

type _PluginApiMustNotExposeRegisterDisposableAlias = AssertTrue<
  Extract<keyof PluginApiV1, 'registerDisposable'> extends never ? true : false
>;

type _PluginActionSurfaceMustUseFinalAgentLiteral = AssertTrue<
  Equal<PluginActionSurface, 'cli' | 'mcp' | 'agent'>
>;

type _PluginHandlerServicesMustMatchContextServiceInstances = AssertTrue<
  Equal<
    PluginHandlerServicesV1,
    Readonly<{
      storage: PluginContextV1['storage'];
      settings: PluginContextV1['settings'];
      logger: PluginContextV1['logger'];
      events: PluginContextV1['events'];
    }>
  >
>;

type _PluginActionHandlerRequestMustExposeHandlerServices = AssertTrue<
  PluginActionHandlerRequest['context'] extends PluginHandlerServicesV1 ? true : false
>;

type _PluginHookHandlerContextMustExposeHandlerServices = AssertTrue<
  PluginHookHandlerContextV1 extends PluginHandlerServicesV1 ? true : false
>;

type _PluginRuntimeRegistrationsMustOnlyBindHandlers = AssertTrue<
  Equal<keyof PluginApiActionRegistrationV1, 'id' | 'handler'>
>;

type _PluginToolRegistrationsMustOnlyBindHandlers = AssertTrue<
  Equal<keyof PluginApiToolRegistrationV1, 'id' | 'handler'>
>;

type _PluginCommandRegistrationsMustOnlyBindHandlers = AssertTrue<
  Equal<keyof PluginApiCommandRegistrationV1, 'id' | 'handler'>
>;

type _PluginContextMustExposePermissionsFacet = AssertTrue<
  PluginContextV1 extends Readonly<{
    permissions: Readonly<{
      isGranted(id: string): boolean;
      list(): readonly string[];
    }>;
  }> ? true : false
>;

type _PluginContextMustNotExposeCapabilitiesFacet = AssertTrue<
  Extract<keyof PluginContextV1, 'capabilities'> extends never ? true : false
>;

type _PluginContextMustFoldCurrentSessionIntoSessions = AssertTrue<
  PluginContextV1 extends Readonly<{
    sessions: Readonly<{
      current: unknown;
    }>;
  }> ? true : false
>;

type _PluginContextMustNotExposeTopLevelSession = AssertTrue<
  Extract<keyof PluginContextV1, 'session'> extends never ? true : false
>;

type _PluginContextMustExposeAgentRuntimeFacet = AssertTrue<
  PluginContextV1 extends Readonly<{
    agentRuntime: Readonly<{
      exec: unknown;
      acp: unknown;
      terminalHost: unknown;
      sessionHooks: unknown;
      transcripts: unknown;
      agents: unknown;
      accountUsage: unknown;
    }>;
  }> ? true : false
>;

type _PluginContextMustNotExposeFlatAgentRuntimeFacetServices = AssertTrue<
  Extract<
    keyof PluginContextV1,
    'exec' | 'acp' | 'terminalHost' | 'sessionHooks' | 'transcripts' | 'agents' | 'accountUsage'
  > extends never ? true : false
>;

type SiblingRegisterMethods = Readonly<{
  registerScmHostingProvider: PluginApiRegisterMethodV1<Readonly<{ id: string }>>;
}>;

type _PluginApiMustSupportSiblingRegisterMethods = AssertTrue<
  PluginApiV1<SiblingRegisterMethods> extends Readonly<{
    registerScmHostingProvider: PluginApiRegisterMethodV1<Readonly<{ id: string }>>;
  }> ? true : false
>;

type _PluginApiMustExposeNotificationRegistration = AssertTrue<
  PluginApiV1 extends Readonly<{
    registerNotificationCategory: PluginApiRegisterMethodV1<PluginApiNotificationCategoryRegistrationV1>;
    registerNotificationChannel: PluginApiRegisterMethodV1<PluginApiNotificationChannelRegistrationV1>;
  }> ? true : false
>;

type DescriptorOnlyRegistrationKeys = 'registerResource' | 'registerUiDescriptor' | 'registerExecutionRunProfile';

type _PluginApiMustNotExposeDescriptorOnlyRegistration = AssertTrue<
  Extract<keyof PluginApiV1, DescriptorOnlyRegistrationKeys> extends never ? true : false
>;

type _PluginApiMustExposeScmBackendRegistration = AssertTrue<
  PluginApiV1 extends Readonly<{
    registerScmBackend: PluginApiRegisterMethodV1<ScmBackendRuntimeRegistration>;
  }> ? true : false
>;

type _ScmHostingProviderRuntimeRegistryMustExposeAdapters = AssertTrue<
  Awaited<ReturnType<NonNullable<ScmHostingProviderRuntimeServices['resolveScmHostingProviderRegistry']>>> extends Readonly<{
    getAdapter: (id: string) => ScmHostingProviderRuntimeAdapter | undefined;
  }> ? true : false
>;

type _PluginApiMustExposeMcpRegistration = AssertTrue<
  PluginApiV1 extends Readonly<{
    registerMcpServer: PluginApiRegisterMethodV1<PluginApiMcpServerRegistrationV1>;
    registerMcpDiscoveryProvider: PluginApiRegisterMethodV1<PluginApiMcpDiscoveryProviderRegistrationV1>;
  }> ? true : false
>;

type RetiredMcpRegistrationKeys = 'registerMcpBackendClient' | 'registerMcpTool';

type _PluginApiMustNotExposeRetiredMcpRegistration = AssertTrue<
  Extract<keyof PluginApiV1, RetiredMcpRegistrationKeys> extends never ? true : false
>;

type HookPayload<THookId extends PluginHookIdV1> =
  PluginApiHookRegistrationV1<THookId>['handler'] extends (
    payload: infer TPayload,
    context: PluginHookHandlerContextV1<THookId>,
  ) => unknown ? TPayload : never;

type _PluginHookPayloadMapMustBeConcrete = AssertTrue<
  IsUnknown<PluginHookPayloadMapV1['agent.spawnEnv.augment']> extends false ? true : false
>;

type _PluginHookPayloadMustComeFromHookId = AssertTrue<
  HookPayload<'agent.spawnEnv.augment'> extends Readonly<{
    agentId: string;
    timestampMs: number;
  }> ? true : false
>;

type _PluginHookRegistrationMustNotUseUnknownRestArgs = AssertTrue<
  PluginHookHandler<'agent.spawnEnv.augment'> extends (
    payload: PluginHookPayloadMapV1['agent.spawnEnv.augment'],
    context: PluginHookHandlerContextV1<'agent.spawnEnv.augment'>,
  ) => PluginHookResultMapV1['agent.spawnEnv.augment'] | Promise<PluginHookResultMapV1['agent.spawnEnv.augment']>
    ? true
    : false
>;

type _PluginHookResultMapMustCoverEveryHookId = AssertTrue<
  PluginHookIdV1 extends keyof PluginHookResultMapV1 ? true : false
>;

type _AcpToolNameResolverMustNotExposeTitleChangeHeuristic = AssertTrue<
  AcpToolNameResolverV1 extends (request: infer TRequest) => unknown
    ? TRequest extends Readonly<{
      context: infer TContext;
    }>
      ? Extract<keyof TContext, 'recentPromptHadChangeTitle'> extends never ? true : false
      : false
    : false
>;

type _AcpSurfaceMustExposeTitleChangeAliases = AssertTrue<
  typeof CHANGE_TITLE_TOOL_NAME_ALIASES extends readonly string[] ? true : false
>;

type _AcpSurfaceMustExposeTitleChangeAliasPredicate = AssertTrue<
  ReturnType<typeof isChangeTitleToolNameAlias> extends boolean ? true : false
>;

type _AcpRuntimeConfigUpdateMustNotExposePluralAlias = AssertTrue<
  Extract<keyof AcpSessionRuntimeConfigUpdateV1, 'configOptions'> extends never ? true : false
>;

type _LifecycleHandlerRegistrationMustRequireStableId = AssertTrue<
  PluginApiLifecycleHandlerRegistrationV1 extends Readonly<{
    id: string;
  }> ? true : false
>;

type _SessionPermissionDecisionMustExposeFollowUpPrompt = AssertTrue<
  SessionPermissionDecisionResultV1 extends Readonly<{
    followUpPrompt?: SessionPermissionFollowUpPromptIntentV1;
  }> ? true : false
>;

type _SessionPermissionDecisionMustExposePersistAllowRule = AssertTrue<
  SessionPermissionDecisionResultV1 extends Readonly<{
    persistAllowRule?: SessionPermissionPersistAllowRuleV1;
  }> ? true : false
>;

type _ManifestSurfaceMustExposeBuiltInBackendProfiles = AssertTrue<
  AIBackendProfile extends Readonly<{
    id: string;
    name: string;
    isBuiltIn: boolean;
  }> ? true : false
>;

type _CloudAuthSurfaceMustExposeCredentialRecords = AssertTrue<
  ReturnType<typeof buildConnectedServiceCredentialRecord> extends ConnectedServiceCredentialRecordV1 ? true : false
>;

type _CloudAuthSurfaceMustExposeCredentialRecordSchema = AssertTrue<
  ReturnType<typeof ConnectedServiceCredentialRecordV1Schema.parse> extends ConnectedServiceCredentialRecordV1 ? true : false
>;

type _CloudAuthSurfaceMustExposeServiceIds = AssertTrue<
  ConnectedServiceId extends string
    ? ConnectedServiceProfileId extends string
      ? ConnectedServiceAuthGroupId extends string
        ? true
        : false
      : false
    : false
>;

type _CloudAuthSurfaceMustExposeServiceIdSchemas = AssertTrue<
  ReturnType<typeof ConnectedServiceProfileIdSchema.parse> extends ConnectedServiceProfileId
    ? ReturnType<typeof ConnectedServiceAuthGroupIdSchema.parse> extends ConnectedServiceAuthGroupId
      ? true
      : false
    : false
>;

type _CloudAuthSurfaceMustExposeServiceBindingsSchema = AssertTrue<
  ReturnType<typeof ConnectedServiceBindingsV1Schema.safeParse> extends Readonly<{
    success: boolean;
  }> ? true : false
>;

type _CloudAuthSurfaceMustExposeLimitCategories = AssertTrue<
  ReturnType<typeof normalizeConnectedServiceLimitCategoryV1> extends ConnectedServiceLimitCategoryV1 ? true : false
>;

type _CloudAuthSurfaceMustExposeConnectedServiceStateSharingPolicy = AssertTrue<
  ReturnType<typeof resolveConnectedServicesProviderStateSharingPolicyV1> extends ConnectedServicesProviderStateSharingPolicyV1 ? true : false
>;

type _CloudAuthSurfaceMustExposeAccountSettingsType = AssertTrue<
  AccountSettings extends Readonly<{
    connectedServicesProviderStateSharingSettingsV1?: unknown;
  }> ? true : false
>;

type _CloudAuthSurfaceMustExposeSessionMetadataConnectedServiceBindings = AssertTrue<
  ReturnType<typeof readSessionMetadataConnectedServiceBindings> extends Readonly<Record<string, SessionMetadataConnectedServiceBinding>> ? true : false
>;

type _CloudAuthSurfaceMustExposeQuotaMeters = AssertTrue<
  ConnectedServiceQuotaMeterV1 extends Readonly<{
    meterId: string;
    status: string;
  }> ? true : false
>;

type _CloudAuthSurfaceMustExposeQuotaSnapshots = AssertTrue<
  ConnectedServiceQuotaSnapshotV1 extends Readonly<{
    serviceId: string;
    meters: readonly ConnectedServiceQuotaMeterV1[];
  }> ? true : false
>;

type _CloudAuthSurfaceMustExposeQuotaSnapshotSchema = AssertTrue<
  ReturnType<typeof ConnectedServiceQuotaSnapshotV1Schema.parse> extends ConnectedServiceQuotaSnapshotV1 ? true : false
>;

type _CloudUsageSurfaceMustExposeRecordIdBuilder = AssertTrue<
  ReturnType<typeof buildProviderAccountUsageRecordId> extends string ? true : false
>;

type _CloudUsageSurfaceMustExposeOpaqueLocalCredentialRefBuilder = AssertTrue<
  ReturnType<typeof buildProviderAccountUsageOpaqueLocalCredentialRef> extends string ? true : false
>;

type _CloudUsageSurfaceMustExposeSnapshotSchema = AssertTrue<
  ReturnType<typeof ProviderAccountUsageSnapshotV1Schema.parse> extends ProviderAccountUsageSnapshotV1 ? true : false
>;

type _CloudUsageSurfaceMustExposeConnectedServiceUsageSourceSchema = AssertTrue<
  ReturnType<typeof ConnectedServiceUsageSourceV1Schema.parse> extends ConnectedServiceUsageSourceV1 ? true : false
>;

type _CloudUsageSurfaceMustExposeUsageLimitRecoveryMetadataKey = AssertTrue<
  typeof SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY extends string ? true : false
>;

type _CloudUsageSurfaceMustExposeRuntimeIssueSchema = AssertTrue<
  ReturnType<typeof SessionRuntimeIssueV1Schema.parse> extends SessionRuntimeIssueV1 ? true : false
>;

type _CloudUsageSurfaceMustExposeUsageLimitRecoverySchema = AssertTrue<
  ReturnType<typeof SessionUsageLimitRecoveryV1Schema.parse> extends SessionUsageLimitRecoveryV1 ? true : false
>;

type _CloudUsageSurfaceMustExposeRecordKeys = AssertTrue<
  ProviderAccountUsageRecordKeyV1 extends Readonly<{
    providerId: string;
    accountSubjectId: string;
  }> ? true : false
>;

type _RuntimeSessionSurfaceMustExposeRuntimeIssues = AssertTrue<
  SessionRuntimeIssueV1 extends Readonly<{
    code: string;
  }> ? true : false
>;

type _RuntimeSessionSurfaceMustExposeRuntimeIssueBuilder = AssertTrue<
  ReturnType<typeof buildSessionRuntimeIssueV1> extends SessionRuntimeIssueV1
    ? BuildSessionRuntimeIssueV1Input extends Readonly<{
      code: string;
      source: string;
    }> ? true : false
    : false
>;

type _RuntimeSessionSurfaceMustExposeUsageLimitDetails = AssertTrue<
  SessionRuntimeUsageLimitDetailsV1 extends Readonly<{
    limitCategory?: string;
  }> ? true : false
>;

type _AgentsSurfaceMustExposeStaticAgentCatalog = AssertTrue<
  typeof CANONICAL_AGENTS_CORE extends Readonly<Record<string, unknown>>
    ? typeof AGENT_MODEL_CONFIG extends Readonly<Record<string, unknown>>
      ? true
      : false
    : false
>;

type ProviderBrandedAgentsSurfaceKeys = Extract<
  keyof typeof AgentsPublicSurface,
  | `CLAUDE_${string}`
  | `CODEX_${string}`
  | `OPENCODE_${string}`
  | `OPEN_CODE_${string}`
  | `OHMYPI_${string}`
  | `PI_${string}`
  | `GEMINI_${string}`
  | `KIRO_${string}`
  | `normalizeClaude${string}`
  | `normalizeCodex${string}`
  | `normalizeOpenCode${string}`
  | `normalizeOhMyPi${string}`
  | `normalizePi${string}`
  | `normalizeGemini${string}`
  | `normalizeKiro${string}`
>;

type _AgentsSurfaceMustNotExposeProviderBrandedSymbols = AssertNever<ProviderBrandedAgentsSurfaceKeys>;

type _SessionsSurfaceMustExposeMetadataKeys = AssertTrue<
  typeof SESSION_CONFIG_OPTIONS_STATE_KEY extends string
    ? typeof SESSION_CONFIG_OPTION_OVERRIDES_KEY extends string
      ? typeof LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY extends string
        ? true
        : false
      : false
    : false
>;

type _SessionsSurfaceMustExposeMetadataAliasReader = AssertTrue<
  ReturnType<typeof readMetadataAliasValue<string>> extends string | undefined ? true : false
>;

type _SessionsSurfaceMustExposeStateFieldHandlers = AssertTrue<
  SessionStateProviderFieldHandler extends Readonly<{
    readField?: (...args: readonly never[]) => unknown;
  }> ? true : false
>;

type _McpSurfaceMustExposeDetectedServers = AssertTrue<
  DetectedMcpServerV1 extends Readonly<{
    provider: string;
    name: string;
  }> ? DaemonMcpServersDetectWarningV1 extends Readonly<{
    code: string;
  }> ? true : false : false
>;

type _SubagentsSurfaceMustExposeStructuredParsers = AssertTrue<
  ReturnType<typeof parseSubagentLaunchV1> extends SubagentLaunchV1 | null
    ? ReturnType<typeof parseSubagentCommandV1> extends SubagentCommandV1 | null
      ? ReturnType<typeof parseParticipantMessageV1> extends ParticipantMessageV1 | null
        ? ReturnType<typeof isGenericSubAgentToolName> extends boolean ? true : false
        : false
      : false
    : false
>;

type _ManifestSurfaceMustExposePromptAssetDescriptors = AssertTrue<
  PromptAssetTypeDescriptorV1 extends Readonly<{
    id: string;
  }> ? true : false
>;

type _RuntimeSessionSurfaceMustExposeStructuredInput = AssertTrue<
  ReturnType<typeof readHappierStructuredInputV1FromMeta> extends HappierStructuredInputV1 | null ? true : false
>;

type _RuntimeSessionSurfaceMustExposeRecoverableFailurePolicy = AssertTrue<
  ReturnType<typeof resolveRecoverableTurnFailureRetryDecision> extends Readonly<{
    action: string;
  }> ? true : false
>;

type _RuntimeSessionSurfaceMustExposeMcpServers = AssertTrue<
  CreateSessionRuntimeParamsV1 extends Readonly<{
    mcpServers?: Readonly<Record<string, SessionRuntimeMcpServerConfigV1>> | null;
  }> ? true : false
>;

type _RuntimeSessionSurfaceMustExposeTransientProviderBinding = AssertTrue<
  CreateSessionRuntimeParamsV1 extends Readonly<{
    providerBindingMaterialization?: import('@happier-dev/protocol').AgentProviderBindingLaunchMaterializationV1;
  }> ? true : false
>;

type _AgentRuntimeRegistrationMustExposeTwoStageProviderBinding = AssertTrue<
  RegisterAgentRuntimeV1 extends Readonly<{
    providerBinding?: AgentProviderBindingAdapterV1;
  }> ? true : false
>;

type _RuntimeCatalogSurfaceMustExposeCatalogItems = AssertTrue<
  SkillCatalogItemV1 extends Readonly<{
    name: string;
  }> ? VendorPluginCatalogItemV1 extends Readonly<{
    displayName: string;
  }> ? true : false : false
>;

type _UsageSurfaceMustExposeObservationScope = AssertTrue<
  UsageObservationScope extends string
    ? UsageObservationTokens extends Readonly<{ total: number }>
      ? UsageObservationCost extends Readonly<{ currency: string }>
        ? UsageObservationContext extends Readonly<{
            usedTokens?: number | null;
            windowTokens?: number | null;
          }>
          ? SessionContextUsageSnapshotV1 extends Readonly<{
              v: 1;
              usedTokens: number;
              totalProcessedTokens: number | null;
            }>
            ? ReturnType<typeof buildUsageObservationEffect> extends UsageObservationEffectV1
              ? true
              : false
            : false
          : false
        : false
      : false
    : false
>;

type _UsageObservationEffectMustCarryCanonicalContextSnapshot = AssertTrue<
  'contextSnapshot' extends keyof UsageObservationEffectV1['observation'] ? true : false
>;

type _DiagnosticsSurfaceMustExposeBugReportRedaction = AssertTrue<
  ReturnType<typeof redactBugReportSensitiveText> extends string
    ? ReturnType<typeof trimBugReportTextToMaxBytes> extends string ? true : false
    : false
>;

type _EventsSurfaceMustExposeHookCatalogHelpers = AssertTrue<
  ReturnType<typeof getPluginHookDefinitionV1> extends Readonly<{
    id: string;
  }> | null
    ? typeof PLUGIN_HOOK_CATALOG_V1 extends readonly unknown[] ? true : false
    : false
>;
