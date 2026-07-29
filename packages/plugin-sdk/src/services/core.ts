import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue, PluginContributionRef, PluginJsonSchema } from '../identity.js';
import type { Disposable } from '../lifecycle.js';

export interface PluginLoggerService {
    debug(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
    info(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
    warn(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
    error(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
    diagnostic(data: PluginDiagnosticData): void;
}

export type PluginStorageConsistency =
    | Readonly<{ kind: 'authoritativeSerializable' }>
    | Readonly<{ kind: 'localReplicaSerializable'; remoteConflicts: 'hostMergeAfterCommit' }>;

export interface PluginStorageTransaction {
    get<T extends JsonValue = JsonValue>(key: string, options?: { signal?: AbortSignal }): Promise<T | null>;
    set(key: string, value: JsonValue, options?: { signal?: AbortSignal }): Promise<void>;
    delete(key: string, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface PluginStorageScopeService extends PluginStorageTransaction {
    consistency(): PluginStorageConsistency;
    list(options?: { cursor?: string; limit?: number; prefix?: string; signal?: AbortSignal }): Promise<{
        items: readonly Readonly<{ key: string }>[];
        nextCursor?: string;
    }>;
    transaction<T>(operation: (transaction: PluginStorageTransaction) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
}

export interface PluginStorageService {
    readonly ephemeral: PluginStorageScopeService;
    readonly session: PluginStorageScopeService;
    readonly local: PluginStorageScopeService;
    readonly synced: PluginStorageScopeService;
}

export type PluginSettingDescriptorBase = Readonly<{
    id: string;
    title: string;
    description?: string;
    target: Readonly<{ kind: 'plugin' }> | Readonly<{ kind: 'agent'; agent: PluginContributionRef }>;
    scope: 'local' | 'synced' | 'project' | 'session';
    schema: PluginJsonSchema;
    readOnly?: boolean;
}>;
export type PluginSettingDescriptor = PluginSettingDescriptorBase & (
    | Readonly<{ secret?: false; default?: JsonValue }>
    | Readonly<{ secret: true; default?: never }>
);

export type PluginSettingsChange = Readonly<{
    revision: string;
    changedIds: readonly string[];
    values: Readonly<Record<string, JsonValue>>;
}>;

export interface PluginSettingsService {
    snapshot(options?: { signal?: AbortSignal }): Promise<{ revision: string; values: Readonly<Record<string, JsonValue>> }>;
    get<T extends JsonValue = JsonValue>(id: string, options?: { signal?: AbortSignal }): Promise<T | null>;
    set(id: string, value: JsonValue, options?: { expectedRevision?: string; signal?: AbortSignal }): Promise<{ revision: string }>;
    reset(id: string, options?: { expectedRevision?: string; signal?: AbortSignal }): Promise<{ revision: string }>;
    describe(): readonly PluginSettingDescriptor[];
    watch(listener: (change: PluginSettingsChange) => void): Disposable;
}

export type PluginSecretStatus = Readonly<{
    state: 'configured' | 'missing' | 'denied' | 'unavailable';
    revision: string;
}>;
export type PluginSecretMutationResult = Readonly<{ revision: string }>;

export interface PluginSecretsService {
    status(id: string): Promise<PluginSecretStatus>;
    get(id: string, options?: { reason?: string; signal?: AbortSignal }): Promise<string>;
    set(id: string, value: string, options?: { expectedRevision?: string; signal?: AbortSignal }): Promise<PluginSecretMutationResult>;
    delete(id: string, options?: { expectedRevision?: string; signal?: AbortSignal }): Promise<PluginSecretMutationResult>;
}

export type PluginEventRef = PluginContributionRef;
export type PluginEventEmitResult = Readonly<{ status: 'admitted'; sequence: number; subscriberCount: number }>;

export interface PluginEventsService {
    emit<T extends JsonValue>(eventId: string, payload: T, options?: { signal?: AbortSignal }): Promise<PluginEventEmitResult>;
    subscribe<T extends JsonValue>(
        event: PluginEventRef,
        listener: (event: Readonly<{ ref: PluginEventRef; payload: T; sequence: number }>) => void | Promise<void>,
    ): Disposable;
}
