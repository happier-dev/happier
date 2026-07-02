import type { AcpBackendSpecV1 } from './acp/types';
import type { AbortServiceV1 } from './abort';
import type { AgentsRuntimeServiceV1 } from './agents';
import type { BackendEngineV1 } from './engine';
import type { EnvRuntimeServiceV1 } from './env';
import type { ErrorRuntimeServiceV1 } from './errors';
import type {
    ExecClientHandleV1,
    ExecJsonRpcClientSpecV1,
    ExecRuntimeServiceV1,
    JsonRpcClientV1,
} from './exec';
import type { FetchRuntimeServiceV1 } from './fetch';
import type { FsRuntimeServiceV1 } from './fs';
import type { PluginActionsServiceV1 } from './generated/actions';
import type { ManagedServerRuntimeServiceV1 } from './managedServer';
import type { LocalServicesRuntimeServiceV1 } from './localServices';
import type { McpRuntimeServiceV1 } from './mcp';
import type { ProgressRuntimeServiceV1 } from './progress';
import type { PluginReviewCommentsServiceV1 } from './reviews/comments';
import type { RetryRuntimeServiceV1 } from './retry';
import type { PluginSessionsServiceV1 } from './sessions';
import type { SessionScopedServicesV1 } from './sessions/scoped';
import type { TimeoutRuntimeServiceV1 } from './timeout';
import type { TerminalHostRuntimeServiceV1 } from './terminalHost';
import type { SessionHooksRuntimeServiceV1 } from './sessionHooks';
import type { TranscriptsRuntimeServiceV1 } from './transcripts';
import type {
    AccountSettings,
    ConnectedServiceId,
    EventSelectorV1,
    PluginSettingsFieldDescriptorV1,
    ProviderAccountUsageAdoptionV1,
    ProviderAccountUsageRecordId,
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
} from './agents';

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

export interface CapabilityInventoryServiceV1 {
    has(capability: string): boolean;
    list(): readonly string[];
}

export interface TelemetryServiceV1 {
    emit(observation: unknown): void;
}

export interface ArtifactSinkServiceV1 {
    write(record: unknown): Promise<void>;
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

export type PluginSettingsFormProjectionV1 = Readonly<{
    fields: readonly PluginSettingsFormFieldV1[];
}>;

export interface PluginSettingsServiceV1 {
    get(): Promise<Readonly<Record<string, unknown>>>;
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
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
}>;

export type ProviderAccountUsageRecordSnapshotResultV1 =
    | Readonly<{ status: 'recorded'; recordId: ProviderAccountUsageRecordId; persisted?: boolean }>
    | Readonly<{ status: 'unavailable'; reason: 'session_scope_unavailable' | 'daemon_unavailable' }>
    | Readonly<{ status: 'rejected'; reason: 'invalid_snapshot' | 'session_mismatch' | 'daemon_rejected' }>;

export type ProviderAccountUsageAdoptProvisionalRecordInputV1 = Readonly<{
    sessionId?: string | null;
    adoption: ProviderAccountUsageAdoptionV1;
}>;

export type ProviderAccountUsageAdoptProvisionalRecordResultV1 =
    | Readonly<{ status: 'adopted' | 'already_adopted'; fromRecordId: ProviderAccountUsageRecordId; toRecordId: ProviderAccountUsageRecordId; persisted?: boolean }>
    | Readonly<{ status: 'unavailable'; reason: 'session_scope_unavailable' | 'daemon_unavailable' }>
    | Readonly<{ status: 'rejected'; reason: 'invalid_adoption' | 'session_mismatch' | 'daemon_rejected' }>;

export type ProviderAccountUsageAliasContextInputV1 = Readonly<{
    serviceId: ConnectedServiceId;
    env?: Readonly<Record<string, string | undefined>>;
}>;

export type ProviderAccountUsageAliasContextV1 = Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string | null;
    groupId: string | null;
}>;

export interface ProviderAccountUsageRuntimeServiceV1 {
    resolveAliasContext(
        input: ProviderAccountUsageAliasContextInputV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ProviderAccountUsageAliasContextV1 | null>;
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
    backendId: string;
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
    backendId: string;
    sessionId: string;
    client: JsonRpcClientV1;
    request<TParams = unknown, TResult = unknown>(method: string, params?: TParams): Promise<TResult>;
    notify<TParams = unknown>(method: string, params?: TParams): Promise<void>;
}>;

export type AcpSessionStartParamsV1 = Readonly<{
    providerSessionId?: string | null;
}>;

export type AcpSessionRuntimeConfigOptionUpdateV1 = Readonly<{
    id: string;
    value: string | number | boolean | null;
}>;

export type AcpSessionRuntimeConfigUpdateV1 = Readonly<{
    modeId?: string | null;
    modelId?: string | null;
    /**
     * Canonical single config-option update `{ id, value }` (matches the host runtime turn-config
     * shape). Singular wins; `configOptions` below is a legacy plural alias kept for back-compat.
     */
    configOption?: AcpSessionRuntimeConfigOptionUpdateV1 | null;
    /**
     * @deprecated Legacy plural config-option map. Prefer the singular `configOption`. Consumers
     * must still honor this for plugins that have not migrated.
     */
    configOptions?: Readonly<Record<string, unknown>>;
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
    defineAcpBackend(spec: AcpBackendSpecV1): BackendEngineV1;
    createRuntime(spec: AcpBackendSpecV1, params: CreateAcpRuntimeParamsV1): Promise<AcpRuntimeHandleV1>;
}

export interface PluginContextV1 {
    readonly logger: LoggerServiceV1;
    readonly config: ConfigSnapshotServiceV1;
    readonly features: FeaturesServiceV1;
    readonly capabilities: CapabilityInventoryServiceV1;
    readonly exec: ExecRuntimeServiceV1;
    readonly agents: AgentsRuntimeServiceV1;
    readonly managedServer: ManagedServerRuntimeServiceV1;
    readonly localServices: LocalServicesRuntimeServiceV1;
    readonly mcp: McpRuntimeServiceV1;
    readonly terminalHost: TerminalHostRuntimeServiceV1;
    readonly sessionHooks: SessionHooksRuntimeServiceV1;
    readonly errors: ErrorRuntimeServiceV1;
    readonly retry: RetryRuntimeServiceV1;
    readonly env: EnvRuntimeServiceV1;
    readonly fs: FsRuntimeServiceV1;
    readonly actions: PluginActionsServiceV1;
    readonly acp: AcpAuthoringServiceV1;
    readonly connection: ConnectionRuntimeServiceV1;
    readonly fetch: FetchRuntimeServiceV1;
    readonly storage: PluginStorageServiceV1;
    readonly settings: PluginSettingsServiceV1;
    readonly secrets: PluginSecretsServiceV1;
    readonly events: PluginEventsServiceV1;
    readonly auth: PluginAuthServiceV1;
    readonly projects: ProjectsServiceV1;
    readonly account: AccountServiceV1;
    readonly accountUsage: ProviderAccountUsageRuntimeServiceV1;
    readonly reviews: PluginReviewsServiceV1;
    readonly session: SessionScopedServicesV1;
    readonly sessions: PluginSessionsServiceV1;
    readonly transcripts: TranscriptsRuntimeServiceV1;
    readonly telemetry: TelemetryServiceV1;
    readonly artifacts: ArtifactSinkServiceV1;
    readonly notifications: NotificationsServiceV1;
    readonly abort: AbortServiceV1;
    readonly timeout: TimeoutRuntimeServiceV1;
    readonly progress: ProgressRuntimeServiceV1;
}
