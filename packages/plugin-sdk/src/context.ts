import type { AcpBackendSpecV1 } from './acp/types.js';
import type { AbortServiceV1 } from './abort.js';
import type { AgentsRuntimeServiceV1 } from './agents.js';
import type { AgentRuntimeV1 } from './engine.js';
import type { EnvRuntimeServiceV1 } from './env.js';
import type { ErrorRuntimeServiceV1 } from './errors.js';
import type {
    ExecClientHandleV1,
    ExecJsonRpcClientSpecV1,
    ExecRuntimeServiceV1,
    JsonRpcClientV1,
} from './exec.js';
import type { FetchRuntimeServiceV1 } from './fetch.js';
import type { FsRuntimeServiceV1 } from './fs.js';
import type { PluginActionsServiceV1 } from './generated/actions.js';
import type { ManagedServerRuntimeServiceV1 } from './managedServer.js';
import type { LocalServicesRuntimeServiceV1 } from './localServices.js';
import type { McpRuntimeServiceV1 } from './mcp.js';
import type { ProgressRuntimeServiceV1 } from './progress.js';
import type { PluginReviewCommentsServiceV1 } from './reviews/comments.js';
import type { RetryRuntimeServiceV1 } from './retry.js';
import type { PluginSessionsServiceV1 } from './sessions/index.js';
import type { SessionScopedServicesV1 } from './sessions/scoped.js';
import type { TimeoutRuntimeServiceV1 } from './timeout.js';
import type { TerminalHostRuntimeServiceV1 } from './terminalHost.js';
import type { SessionHooksRuntimeServiceV1 } from './sessionHooks.js';
import type { TranscriptsRuntimeServiceV1 } from './transcripts.js';
import type {
    AccountSettings,
    ConnectedServiceUsageSourceV1,
    ConnectedServiceId,
    EventSelectorV1,
    PluginSettingsFieldDescriptorV1,
    ProviderAccountUsageRecordId,
    ProviderAccountUsageRecordKeyV1,
    ProviderAccountUsageSnapshotV1,
    ProjectKeyV1,
    RuntimeEventV1,
    TypedEventV1,
    WorkspaceRefV1,
} from '@happier-dev/protocol';

export type {
    AgentCliReadinessDiagnosticV1,
    AgentCliReadinessEntryV1,
    AgentCliLaunchableEntryV1,
    AgentCliReadinessQueryV1,
    AgentCliReadinessRequirementV1,
    AgentCliReadinessResultV1,
    AgentCliReadinessChecksV1,
    AgentCliReadinessScopeV1,
    AgentCliReadinessSourceV1,
    AgentCliReadinessStatusV1,
    AgentCliUnavailableEntryV1,
    AgentCliRuntimeServiceV1,
    AgentsRuntimeServiceV1,
} from './agents.js';

export interface LoggerServiceV1 {
    debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
    info(message: string, fields?: Readonly<Record<string, unknown>>): void;
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
    error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface ConfigSnapshotServiceV1 {
    // Read-only view. The host may choose to expose only a safe subset.
    readonly values: Readonly<Record<string, unknown>>;
}

export interface FeaturesServiceV1 {
    isEnabled(featureId: string): boolean;
}

export type SessionClientServiceV1 = PluginSessionsServiceV1;

export interface PluginPermissionsServiceV1 {
    isGranted(id: string): boolean;
    list(): readonly string[];
}

export interface TelemetryServiceV1 {
    emit(observation: unknown): void;
}

export interface ArtifactSinkServiceV1 {
    write(record: unknown): Promise<void>;
}

export interface PluginExperimentalContextV1 {
    readonly telemetry: TelemetryServiceV1;
    readonly artifacts: ArtifactSinkServiceV1;
}

export type NotificationDeliveryChannelV1 = string;

export type NotificationSendParamsV1 = Readonly<{
    categoryId: string;
    title: string;
    body?: string | null;
    channelIds?: readonly string[];
    payload?: unknown;
}>;

export type NotificationCategoryDescriptorV1 = Readonly<{
    id: string;
    kind: 'activity' | 'approval' | 'plugin';
    title: string;
    description?: string | null;
    eventIds?: readonly string[];
    defaultChannelIds?: readonly string[];
}>;

export type NotificationChannelDescriptorV1 = Readonly<{
    id: string;
    kind: string;
    title: string;
    description?: string | null;
    configurable?: boolean;
    defaultEnabled?: boolean;
}>;

export type NotificationPreferencesV1 = Readonly<{
    categoryId: string;
    channels: readonly Readonly<{
        channelId: string;
        delivery: 'deliver' | 'silent' | 'suppress';
        enabled: boolean;
    }>[];
}>;

export interface NotificationsServiceV1 {
    send(params: NotificationSendParamsV1): Promise<{ delivered: readonly NotificationDeliveryChannelV1[] }>;
    listChannels(): Promise<readonly NotificationChannelDescriptorV1[]>;
    listCategories(): Promise<readonly NotificationCategoryDescriptorV1[]>;
    getUserPreferences(categoryId: string): Promise<NotificationPreferencesV1>;
}

export interface SubscriptionV1 {
    unsubscribe(): void;
}

export type PluginStorageScopeV1 = 'ephemeral' | 'session' | 'local' | 'synced';

export interface PluginStorageScopeServiceV1 {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    listKeys(): Promise<readonly string[]>;
}

export interface PluginStorageServiceV1 {
    readonly ephemeral: PluginStorageScopeServiceV1;
    readonly session: PluginStorageScopeServiceV1;
    readonly local: PluginStorageScopeServiceV1;
    readonly synced: PluginStorageScopeServiceV1;
}

export type PluginSettingsChangeListenerV1 = (settings: Readonly<Record<string, unknown>>) => void;

export type PluginSettingsFormFieldV1 = Readonly<
    Pick<
        PluginSettingsFieldDescriptorV1,
        | 'id'
        | 'kind'
        | 'version'
        | 'valueSchema'
        | 'control'
        | 'displayKey'
        | 'descriptionKey'
        | 'groupId'
        | 'order'
        | 'redaction'
        | 'hidden'
        | 'defaultValue'
        | 'defaultBooleanValue'
        | 'clearWhenEmpty'
    > & {
        readonly capabilityGates: readonly string[];
        readonly permissionGates: readonly string[];
    }
>;

export type PluginSettingsStorageScopeV1 = 'pluginLocal';

export type PluginSettingsFormProjectionV1 = Readonly<{
    /**
     * Generic `contributes.settings` are plugin-local in SDK v1. They are stored in the
     * plugin namespace on this machine and are not account-synced.
     */
    storageScope: PluginSettingsStorageScopeV1;
    fields: readonly PluginSettingsFormFieldV1[];
}>;

export interface PluginSettingsServiceV1 {
    get(): Promise<Readonly<Record<string, unknown>>>;
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    /**
     * Fires for writes made through this service instance. SDK v1 does not subscribe to
     * external storage writes or plugin reloads.
     */
    onChange(listener: PluginSettingsChangeListenerV1): SubscriptionV1;
    describeFields(): readonly PluginSettingsFieldDescriptorV1[];
    projectForm(): PluginSettingsFormProjectionV1;
}

export type PluginSecretListEntryV1 = Readonly<{
    name: string;
}>;

export interface PluginSecretsServiceV1 {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
    list(): Promise<readonly PluginSecretListEntryV1[]>;
}

export type PluginEventEmitInputV1<TPayload = unknown> = Readonly<{
    id: string;
    payload?: TPayload;
}>;

export type PluginEventListenerV1<TPayload = unknown> = (event: TypedEventV1<TPayload>) => void | Promise<void>;

export interface PluginEventsServiceV1 {
    emit<TPayload = unknown>(event: PluginEventEmitInputV1<TPayload>): Promise<void>;
    subscribe(selector: string | EventSelectorV1, listener: PluginEventListenerV1): SubscriptionV1;
}

export type PluginHandlerServicesV1 = Readonly<{
    readonly storage: PluginStorageServiceV1;
    readonly settings: PluginSettingsServiceV1;
    readonly logger: LoggerServiceV1;
    readonly events: PluginEventsServiceV1;
}>;

export type PluginAuthIdentityV1 = Readonly<{
    accountId: string | null;
    email?: string | null;
    profileId?: string | null;
}>;

export type PluginAuthMaterializeRequestV1 = Readonly<{
    serviceId: string;
    profileId?: string | null;
    reason?: string | null;
}>;

export type PluginAuthMaterializedServiceV1 = Readonly<{
    env?: Readonly<Record<string, string>>;
    headers?: Readonly<Record<string, string>>;
    files?: Readonly<Record<string, string>>;
    metadata?: Readonly<Record<string, unknown>>;
}>;

export type PluginAuthChangeListenerV1 = (identity: PluginAuthIdentityV1 | null) => void;

export interface PluginAuthServiceV1 {
    getIdentity(): Promise<PluginAuthIdentityV1 | null>;
    onChange(listener: PluginAuthChangeListenerV1): SubscriptionV1;
    readonly services: Readonly<{
        materialize(request: PluginAuthMaterializeRequestV1): Promise<PluginAuthMaterializedServiceV1 | null>;
    }>;
}

export type ProjectsChangeListenerV1 = (workspaceRefs: readonly WorkspaceRefV1[]) => void;

export interface ProjectsServiceV1 {
    listAll(): Promise<readonly WorkspaceRefV1[]>;
    listForCurrentMachine(): Promise<readonly WorkspaceRefV1[]>;
    listForMachine(machineId: string): Promise<readonly WorkspaceRefV1[]>;
    get(key: ProjectKeyV1): Promise<WorkspaceRefV1 | null>;
    getActive(): Promise<WorkspaceRefV1 | null>;
    watch(listener: ProjectsChangeListenerV1): SubscriptionV1;
}

export type AccountSettingsChangeListenerV1 = (settings: AccountSettings) => void;

export interface AccountSettingsServiceV1 {
    get(): Promise<AccountSettings>;
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    onChange(listener: AccountSettingsChangeListenerV1): SubscriptionV1;
}

export interface AccountServiceV1 {
    readonly settings: AccountSettingsServiceV1;
}

export type ProviderAccountUsageRecordSnapshotInputV1 = Readonly<{
    sessionId?: string | null;
    snapshot: ProviderAccountUsageSnapshotV1;
    source?: ProviderAccountUsageSourceContextV1 | null;
}>;

export type ProviderAccountUsageRecordSnapshotResultV1 =
    | Readonly<{ status: 'recorded'; recordId: ProviderAccountUsageRecordId; persisted?: boolean }>
    | Readonly<{ status: 'unavailable'; reason: 'session_scope_unavailable' | 'daemon_unavailable' }>
    | Readonly<{ status: 'rejected'; reason: 'invalid_snapshot' | 'session_mismatch' | 'daemon_rejected' }>;

export type ProviderAccountUsageAdoptionProofV1 =
    | Readonly<{ kind: 'opaque_local_credential_ref_match'; localCredentialRef: string }>
    | Readonly<{ kind: 'session_subject_match'; sessionId?: string | null }>
    | Readonly<{ kind: 'id_token_account_id'; issuer?: string }>
    | Readonly<{ kind: 'provider_account_id_match' }>
    | Readonly<{ kind: 'provider_owned_subject_proof'; detail?: string }>;

export type ProviderAccountUsageAdoptProvisionalRecordInputV1 = Readonly<{
    sessionId?: string | null;
    adoption: Readonly<{
        providerId: string;
        fromRecordId: ProviderAccountUsageRecordId;
        toRecordId: ProviderAccountUsageRecordId;
        stableRecordKey: ProviderAccountUsageRecordKeyV1;
        proof: ProviderAccountUsageAdoptionProofV1;
        observedAtMs: number;
    }>;
}>;

export type ProviderAccountUsageAdoptProvisionalRecordResultV1 =
    | Readonly<{ status: 'adopted' | 'already_adopted'; fromRecordId: ProviderAccountUsageRecordId; toRecordId: ProviderAccountUsageRecordId; persisted?: boolean }>
    | Readonly<{ status: 'unavailable'; reason: 'session_scope_unavailable' | 'daemon_unavailable' }>
    | Readonly<{ status: 'rejected'; reason: 'invalid_adoption' | 'session_mismatch' | 'daemon_rejected' }>;

export type ProviderAccountUsageSourceContextInputV1 = Readonly<{
    serviceId: ConnectedServiceId;
    env?: Readonly<Record<string, string | undefined>>;
}>;

export type ProviderAccountUsageSourceContextV1 = ConnectedServiceUsageSourceV1;

export interface ProviderAccountUsageRuntimeServiceV1 {
    resolveSourceContext(
        input: ProviderAccountUsageSourceContextInputV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ProviderAccountUsageSourceContextV1 | null>;
    recordSnapshot(
        input: ProviderAccountUsageRecordSnapshotInputV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ProviderAccountUsageRecordSnapshotResultV1>;
    adoptProvisionalRecord(
        input: ProviderAccountUsageAdoptProvisionalRecordInputV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ProviderAccountUsageAdoptProvisionalRecordResultV1>;
}

export interface PluginReviewsServiceV1 {
    readonly comments: PluginReviewCommentsServiceV1;
}

export type ConnectionPhaseV1 =
    | 'idle'
    | 'connecting'
    | 'online'
    | 'offline'
    | 'auth_failed'
    | 'shutting_down';

export type ConnectionStateV1 = Readonly<{
    phase: ConnectionPhaseV1;
    reason: string | null;
    attempt: number;
    nextRetryAt: number | null;
    lastConnectedAt: number | null;
    lastDisconnectedAt: number | null;
    lastErrorMessage: string | null;
}>;

export type ConnectionStateListenerV1 = (state: ConnectionStateV1) => void;

export interface ConnectionRuntimeServiceV1 {
    getDaemonLinkState(): ConnectionStateV1;
    watchDaemonLink(listener: ConnectionStateListenerV1): SubscriptionV1;
    isDaemonOnline(): boolean;
}

export type CreateAcpRuntimeParamsV1 = Readonly<{
    sessionId: string;
    cwd: string;
    permissionMode?: string;
    metadata?: Readonly<Record<string, unknown>>;
    agentName?: string;
    client?: ExecClientHandleV1<JsonRpcClientV1>;
    clientSpec?: ExecJsonRpcClientSpecV1;
    extensions?: AcpRuntimeExtensionsV1;
    lifecycle?: AcpRuntimeLifecycleV1;
}>;

export type AcpRuntimeExtensionHandlerContextV1 = Readonly<{
    method: string;
    requestId?: string;
    sessionId: string;
    agentId: string;
    agentName?: string;
    signal: AbortSignal;
}>;

export type AcpRuntimeRequestHandlerV1<TParams = unknown, TResult extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> = (
    params: TParams,
    context: AcpRuntimeExtensionHandlerContextV1,
) => TResult | Promise<TResult>;

export type AcpRuntimeNotificationHandlerV1<TParams = unknown> = (
    params: TParams,
    context: AcpRuntimeExtensionHandlerContextV1,
) => void | Promise<void>;

export type AcpRuntimeExtensionsV1 = Readonly<{
    requests?: Readonly<Record<string, AcpRuntimeRequestHandlerV1>>;
    notifications?: Readonly<Record<string, AcpRuntimeNotificationHandlerV1>>;
}>;

export type AcpRuntimeInitializeV1 = Readonly<{
    protocolVersion?: number | string;
    clientCapabilities?: Readonly<Record<string, unknown>>;
}>;

export type AcpRuntimeAuthenticateV1 = Readonly<{
    methodId: string;
    meta?: Readonly<Record<string, unknown>>;
}>;

export type AcpRuntimeLifecycleV1 = Readonly<{
    signal?: AbortSignal;
    initializeMeta?: Readonly<Record<string, unknown>>;
    initialize?: AcpRuntimeInitializeV1;
    authenticate?: AcpRuntimeAuthenticateV1;
}>;

export type AcpComposedRuntimeV1 = Readonly<{
    agentId: string;
    sessionId: string;
    client: JsonRpcClientV1;
    request<TParams = unknown, TResult = unknown>(method: string, params?: TParams): Promise<TResult>;
    notify<TParams = unknown>(method: string, params?: TParams): Promise<void>;
}>;

export type AcpSessionMcpServerV1 = Readonly<Record<string, unknown>>;

export type AcpSessionStartParamsV1 = Readonly<{
    providerSessionId?: string | null;
    mcpServers?: readonly AcpSessionMcpServerV1[] | null;
}>;

export type AcpSessionRuntimeConfigOptionUpdateV1 = Readonly<{
    id: string;
    value: string | number | boolean | null;
}>;

export type AcpSessionRuntimeConfigUpdateV1 = Readonly<{
    modeId?: string | null;
    modelId?: string | null;
    configOption?: AcpSessionRuntimeConfigOptionUpdateV1 | null;
}>;

export type AcpSessionRuntimeCompletionOptionsV1 = Readonly<{
    timeoutMs?: number | null;
}>;

export type AcpSessionRuntimeV1 = Readonly<{
    beginTurnLifecycle(): void;
    startOrLoadSession(params?: AcpSessionStartParamsV1): Promise<string>;
    sendTurnPrompt(prompt: string): Promise<void>;
    waitForTurnCompletion(opts?: AcpSessionRuntimeCompletionOptionsV1): Promise<void>;
    subscribeRuntimeEvents(handler: (event: RuntimeEventV1) => void): () => void;
    cancelTurn(): Promise<void>;
    updateSessionRuntimeConfig(update: AcpSessionRuntimeConfigUpdateV1): Promise<void>;
}>;

export type AcpRuntimeHandleV1 = Readonly<{
    runtime: AcpComposedRuntimeV1;
    sessionRuntime: AcpSessionRuntimeV1;
    dispose(reason?: string): Promise<void>;
}>;

export interface AcpAuthoringServiceV1 {
    defineAcpBackend(spec: AcpBackendSpecV1): AgentRuntimeV1;
    createRuntime(spec: AcpBackendSpecV1, params: CreateAcpRuntimeParamsV1): Promise<AcpRuntimeHandleV1>;
}

export interface PluginAgentRuntimeContextV1 {
    readonly exec: ExecRuntimeServiceV1;
    readonly acp: AcpAuthoringServiceV1;
    readonly terminalHost: TerminalHostRuntimeServiceV1;
    readonly sessionHooks: SessionHooksRuntimeServiceV1;
    readonly transcripts: TranscriptsRuntimeServiceV1;
    readonly agents: AgentsRuntimeServiceV1;
    readonly accountUsage: ProviderAccountUsageRuntimeServiceV1;
}

export interface PluginContextV1 {
    readonly logger: LoggerServiceV1;
    readonly config: ConfigSnapshotServiceV1;
    readonly features: FeaturesServiceV1;
    readonly permissions: PluginPermissionsServiceV1;
    readonly agentRuntime: PluginAgentRuntimeContextV1;
    readonly managedServer: ManagedServerRuntimeServiceV1;
    readonly localServices: LocalServicesRuntimeServiceV1;
    readonly mcp: McpRuntimeServiceV1;
    readonly errors: ErrorRuntimeServiceV1;
    readonly retry: RetryRuntimeServiceV1;
    readonly env: EnvRuntimeServiceV1;
    readonly fs: FsRuntimeServiceV1;
    readonly actions: PluginActionsServiceV1;
    readonly connection: ConnectionRuntimeServiceV1;
    readonly fetch: FetchRuntimeServiceV1;
    readonly storage: PluginStorageServiceV1;
    readonly settings: PluginSettingsServiceV1;
    readonly secrets: PluginSecretsServiceV1;
    readonly events: PluginEventsServiceV1;
    readonly auth: PluginAuthServiceV1;
    readonly projects: ProjectsServiceV1;
    readonly account: AccountServiceV1;
    readonly reviews: PluginReviewsServiceV1;
    readonly sessions: PluginSessionsServiceV1;
    readonly experimental: PluginExperimentalContextV1;
    readonly notifications: NotificationsServiceV1;
    readonly abort: AbortServiceV1;
    readonly timeout: TimeoutRuntimeServiceV1;
    readonly progress: ProgressRuntimeServiceV1;
}
