import type { AcpBackendSpecV1 } from './acp/types';
import type { BackendEngineV1 } from './engine';
import type { FetchRuntimeServiceV1 } from './fetch';
import type { PluginActionsServiceV1 } from './generated/actions';
import type { PluginSessionsServiceV1 } from './sessions';
import type {
    AccountSettings,
    PluginSettingsFieldDescriptorV1,
    ProjectKeyV1,
    WorkspaceRefV1,
} from '@happier-dev/protocol';

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

export interface ManagedToolsServiceV1 {
    // Intentionally minimal: concrete spawn/resolve shapes are owned by the runtime lane.
    // This service exists to prevent plugins from importing host internals for tool resolution/spawn.
    resolve(toolId: string): Promise<unknown>;
    // Optional in V1: hosts may initially provide only resolution. When provided, this MUST be binary-safe
    // (must not assume a system Node/npm/yarn/etc exists) and must apply host policy.
    spawn?: (request: unknown) => Promise<unknown>;
}

export type SessionClientServiceV1 = PluginSessionsServiceV1;

export interface TranscriptWriterServiceV1 {
    // Narrow streaming write port.
    append(turn: unknown): Promise<void>;
}

export interface PermissionsServiceV1 {
    requestDecision(request: unknown): Promise<unknown>;
    getEffectiveMode(): unknown;
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

export interface AbortServiceV1 {
    readonly signal: AbortSignal;
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

export type PluginEventListenerV1 = (event: Readonly<{ name: string; payload: unknown }>) => void | Promise<void>;

export interface PluginEventsServiceV1 {
    emit(name: string, payload?: unknown): Promise<void>;
    subscribe(name: string, listener: PluginEventListenerV1): SubscriptionV1;
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
}>;

export type AcpRuntimeHandleV1 = Readonly<{
    runtime: unknown;
    dispose(reason?: string): Promise<void>;
}>;

export type AcpPermissionHandlerHelpersV1 = Readonly<{
    codexLikeOpenCode(params: Readonly<{
        providerId: string;
        writeLikeKinds?: readonly string[];
    }>): unknown;
}>;

export interface AcpAuthoringServiceV1 {
    defineAcpBackend(spec: AcpBackendSpecV1): BackendEngineV1;
    createRuntime(spec: AcpBackendSpecV1, params: CreateAcpRuntimeParamsV1): Promise<AcpRuntimeHandleV1>;
    readonly permissionHandlers?: AcpPermissionHandlerHelpersV1;
}

export interface PluginContextV1 {
    readonly logger: LoggerServiceV1;
    readonly config: ConfigSnapshotServiceV1;
    readonly features: FeaturesServiceV1;
    readonly managedTools: ManagedToolsServiceV1;
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
    readonly sessions: PluginSessionsServiceV1;
    readonly transcripts: TranscriptWriterServiceV1;
    readonly permissions: PermissionsServiceV1;
    readonly telemetry: TelemetryServiceV1;
    readonly artifacts: ArtifactSinkServiceV1;
    readonly notifications: NotificationsServiceV1;
    readonly abort: AbortServiceV1;
}
