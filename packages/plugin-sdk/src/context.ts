import type { AcpBackendSpecV1 } from './acp/types';
import type { BackendEngineV1 } from './engine';
import type { FetchRuntimeServiceV1 } from './fetch';
import type { PluginActionsServiceV1 } from './generated/actions';
import type { PluginSessionsServiceV1 } from './sessions';
import type { AccountSettings, ProjectKeyV1, WorkspaceRefV1 } from '@happier-dev/protocol';

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
