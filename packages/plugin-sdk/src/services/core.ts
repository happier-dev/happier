/** @moduleRealm daemon */
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue, PluginContributionRef, PluginJsonSchema } from '../identity.js';
import type { Disposable } from '../lifecycle.js';

export interface LoggerService {
    debug(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
    info(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
    warn(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
    error(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
    diagnostic(data: PluginDiagnosticData): void;
}

export type PluginLoggerService = LoggerService;

export type PluginSettingDescriptor = Readonly<{
    id: string;
    title: string;
    description?: string;
    target: Readonly<{ kind: 'plugin' }> | Readonly<{ kind: 'agent'; agent: PluginContributionRef }>;
    scope: 'account' | 'daemon';
    schema: PluginJsonSchema;
    readOnly?: boolean;
}> & (
    | Readonly<{ secret?: false; default?: JsonValue }>
    | Readonly<{ secret: true; default?: never }>
);
export type PluginSettingDescriptorBase = Omit<
    PluginSettingDescriptor,
    'secret' | 'default'
>;

export type PluginSettingsChange = Readonly<{
    /** Identifies the one natural record that produced this change. */
    scope: SettingsScopeRef;
    revision: string;
    changedIds: readonly string[];
    values: Readonly<Record<string, JsonValue>>;
}>;

export type PluginSettingsSnapshot = Readonly<{
    /** Identifies the one natural record represented by this snapshot. */
    scope: SettingsScopeRef;
    revision: string;
    values: Readonly<Record<string, JsonValue>>;
}>;

export type PluginSettingsMutationResult = Readonly<{
    /** Identifies the one natural record that accepted this mutation. */
    scope: SettingsScopeRef;
    revision: string;
}>;

/** A Settings operation is always bound to exactly one declaration scope. */
export type SettingsScopeRef =
    | Readonly<{ kind: 'account' }>
    | Readonly<{ kind: 'daemon' }>;

export interface ScopedSettingsService {
    snapshot(options?: { signal?: AbortSignal }): Promise<PluginSettingsSnapshot>;
    get<T extends JsonValue = JsonValue>(id: string, options?: { signal?: AbortSignal }): Promise<T | null>;
    set(id: string, value: JsonValue, options?: { expectedRevision?: string; signal?: AbortSignal }): Promise<PluginSettingsMutationResult>;
    reset(id: string, options?: { expectedRevision?: string; signal?: AbortSignal }): Promise<PluginSettingsMutationResult>;
    describe(): readonly PluginSettingDescriptor[];
    watch(listener: (change: PluginSettingsChange) => void): Disposable;
}

/**
 * Selects the only Settings scope that a call may read or mutate. There is no
 * unscoped operation and no account/daemon fallback or merged revision view.
 */
export interface SettingsService {
    forScope(scope: SettingsScopeRef): ScopedSettingsService;
}
