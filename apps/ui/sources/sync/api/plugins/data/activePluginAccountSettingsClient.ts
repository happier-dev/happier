import {
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
    type PluginJsonSchemaValidator,
} from '@happier-dev/protocol';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { ScopedSettingsService } from '@happier-dev/plugin-sdk/settings';

import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { projectAccountDeclaredPluginSettingsGroups } from '@/sync/domains/plugins/settings/accountDeclaredPluginSettings';
import {
    resolveScopedPluginSettingsTarget,
    type ScopedPluginSettingsAdapter,
    type ScopedPluginSettingsField,
    type ScopedPluginSettingsScope,
    type ScopedPluginSettingsSnapshot,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import {
    resolveScopedPluginSettingsServerIdentity,
    scopedPluginSettingsAdapter,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';

/**
 * The plugin's own Account Settings scope, reached from a mounted surface with
 * no daemon in the path.
 *
 * This is a binding, not a second Settings system. Every decision it makes is
 * already owned somewhere else and is consumed here unchanged:
 *
 *  - the declared fields come from the Account-admitted normalized manifest
 *    through `projectAccountDeclaredPluginSettingsGroups`, the same projection
 *    the Settings page's Account route uses;
 *  - the record read, the read-before-write merge, the `expectedRevision` CAS,
 *    the Account encryption envelope and the Account request authority all stay
 *    inside `scopedPluginSettingsAdapter`;
 *  - the value admission is the field's own declared JSON schema, compiled by
 *    the Protocol owner the daemon compiles it with.
 *
 * The contract it presents is the daemon's `ScopedSettingsService` for the
 * account scope, member for member, because the plugin code above it is the
 * same code. A record key is the DECLARED field id — the id the daemon service
 * reads and writes — never a presentation binding's storage id, which is how a
 * Settings-page control addresses a value and is not the plugin's own record
 * view.
 *
 * It owns no cache, no watch, no optimistic value and no queue. A revision is
 * read from the record every time, and a write that cannot be proven applied is
 * reported as unavailable rather than as applied.
 */

const ACCOUNT_SCOPE: ScopedPluginSettingsScope = Object.freeze({ kind: 'account' });
const ACCOUNT_SCOPE_REF = Object.freeze({ kind: 'account' as const });

const PERSISTENCE_UNAVAILABLE_CODE = 'plugin_settings_persistence_unavailable';
const UNKNOWN_ID_CODE = 'plugin_settings_unknown_id';
const SECRET_CODE = 'plugin_settings_secret_materialization_required';
const VALIDATION_CODE = 'plugin_settings_validation_failed';
const CONFLICT_CODE = 'plugin_settings_revision_conflict';
const CANCELLED_CODE = 'plugin_settings_cancelled';

function settingsError(code: string, message: string, details?: JsonValue): PluginError {
    return new PluginError({
        code,
        message,
        ...(code === PERSISTENCE_UNAVAILABLE_CODE ? { retryable: true } : {}),
        ...(details === undefined ? {} : { details }),
    });
}

/** One declared account-scoped field, in the two shapes this client needs. */
type DeclaredAccountSetting = Readonly<{
    id: string;
    secret: boolean;
    validate: PluginJsonSchemaValidator | null;
    default: JsonValue | undefined;
}>;

/**
 * A stored revision of `0` is the absent record.
 *
 * The daemon's account-backed store reads an absent record as revision `0` with
 * an empty value map and CASes it with `'absent'`; the server never issues row
 * revision `0`. Both realms therefore spell "nothing has been written yet" the
 * same way, which is what lets a plugin pass a revision it read here straight
 * back into a write on either side.
 */
const ABSENT_RECORD_REVISION = 0;

function assertCurrent(
    lifetime: ActiveServerAccountScopeLifetime,
    signal?: AbortSignal,
): void {
    if (signal?.aborted) {
        throw settingsError(CANCELLED_CODE, 'Plugin Account Settings operation was cancelled');
    }
    if (!lifetime.isCurrent()) {
        throw settingsError(
            PERSISTENCE_UNAVAILABLE_CODE,
            'Plugin Account Settings are unavailable for the current Account',
        );
    }
}

function toRevisionNumber(snapshot: ScopedPluginSettingsSnapshot): number {
    if (snapshot.revision.kind !== 'account') {
        throw settingsError(
            PERSISTENCE_UNAVAILABLE_CODE,
            'Plugin Account Settings returned a non-Account revision',
        );
    }
    return snapshot.revision.value === 'absent' ? ABSENT_RECORD_REVISION : snapshot.revision.value;
}

export type ActivePluginAccountSettingsClientInputV1 = Readonly<{
    pluginId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    availabilityReader: PluginAccountAvailabilityReader;
    /**
     * The one host Settings record owner. It is a parameter so a test can drive
     * this exact client over a fixture record boundary; production always binds
     * the live runtime adapter.
     */
    adapter?: Pick<ScopedPluginSettingsAdapter, 'read' | 'write'>;
    /** The active Account server's portable identity. */
    resolveAccountServerIdentityId?: () => string | null;
}>;

export function createActivePluginAccountSettingsClient(
    input: ActivePluginAccountSettingsClientInputV1,
): Pick<ScopedSettingsService, 'snapshot' | 'get' | 'set' | 'reset'> {
    const adapter = input.adapter ?? scopedPluginSettingsAdapter;
    const resolveServerIdentityId = input.resolveAccountServerIdentityId
        ?? (() => resolveScopedPluginSettingsServerIdentity(getActiveServerSnapshot().serverId));

    /**
     * The declared account fields for the release the Account currently admits.
     *
     * It is re-read per operation rather than captured: a release change moves
     * the declaration, and a client holding the old one would validate a write
     * against a contract the record no longer has.
     */
    function declared(): readonly DeclaredAccountSetting[] {
        const admission = input.availabilityReader.readCurrentSettingsDeclaration({
            pluginId: input.pluginId,
        });
        if (admission.kind !== 'available') {
            throw settingsError(
                PERSISTENCE_UNAVAILABLE_CODE,
                'The current Account release does not admit this plugin\'s Settings declaration',
            );
        }
        const groups = projectAccountDeclaredPluginSettingsGroups({
            pluginId: input.pluginId,
            declaration: admission.declaration,
        });
        const settings: DeclaredAccountSetting[] = [];
        for (const group of groups) {
            for (const field of group.fields) {
                let validate: PluginJsonSchemaValidator | null = null;
                try {
                    validate = compilePluginJsonSchema(field.valueSchema);
                } catch {
                    // An uncompilable declared schema admits no value rather
                    // than admitting every value.
                    validate = null;
                }
                settings.push(Object.freeze({
                    id: field.key,
                    secret: field.secretCustody !== null && field.secretCustody !== undefined,
                    validate,
                    default: field.defaultValue as JsonValue | undefined,
                }));
            }
        }
        return Object.freeze(settings);
    }

    /**
     * The adapter's field list is the declared record view, deliberately
     * carrying no presentation binding: a plugin reading its own Settings
     * addresses the ids its daemon side writes.
     */
    function adapterFields(settings: readonly DeclaredAccountSetting[]): readonly ScopedPluginSettingsField[] {
        return settings.map((setting) => Object.freeze({
            key: setting.id,
            redacted: setting.secret,
        }));
    }

    function target() {
        const resolved = resolveScopedPluginSettingsTarget({
            scope: ACCOUNT_SCOPE,
            serverIdentityId: resolveServerIdentityId(),
        });
        if (!resolved || resolved.kind !== 'account') {
            throw settingsError(
                PERSISTENCE_UNAVAILABLE_CODE,
                'No Account server identity is available for plugin Settings',
            );
        }
        return resolved;
    }

    function settingOrThrow(
        settings: readonly DeclaredAccountSetting[],
        id: string,
    ): DeclaredAccountSetting {
        const setting = settings.find((candidate) => candidate.id === id);
        if (!setting) {
            throw settingsError(UNKNOWN_ID_CODE, `Plugin setting '${id}' is not declared`);
        }
        if (setting.secret) {
            throw settingsError(SECRET_CODE, `Plugin setting '${id}' is owned by services.secrets`);
        }
        return setting;
    }

    async function readRecord(
        settings: readonly DeclaredAccountSetting[],
        signal?: AbortSignal,
    ): Promise<ScopedPluginSettingsSnapshot> {
        assertCurrent(input.accountLifetime, signal);
        const result = await adapter.read({
            pluginId: input.pluginId,
            scope: ACCOUNT_SCOPE,
            target: target(),
            fields: adapterFields(settings),
        });
        assertCurrent(input.accountLifetime, signal);
        if (result.status !== 'ready') {
            throw settingsError(
                PERSISTENCE_UNAVAILABLE_CODE,
                'Account plugin settings persistence is unavailable',
            );
        }
        return result.snapshot;
    }

    async function mutate(request:
        | Readonly<{ id: string; reset: true; expectedRevision?: string; signal?: AbortSignal }>
        | Readonly<{
            id: string;
            reset: false;
            value: JsonValue;
            expectedRevision?: string;
            signal?: AbortSignal;
        }>
    ): Promise<Readonly<{ scope: typeof ACCOUNT_SCOPE_REF; revision: string }>> {
        assertCurrent(input.accountLifetime, request.signal);
        const settings = declared();
        const setting = settingOrThrow(settings, request.id);
        if (!request.reset) {
            if (setting.validate === null
                || !isValidPluginJsonSchemaValue(setting.validate, request.value)) {
                throw settingsError(
                    VALIDATION_CODE,
                    `Plugin setting '${request.id}' failed schema validation`,
                );
            }
        }
        const current = await readRecord(settings, request.signal);
        const currentRevision = toRevisionNumber(current);
        if (request.expectedRevision !== undefined
            && request.expectedRevision !== String(currentRevision)) {
            throw settingsError(
                CONFLICT_CODE,
                'Plugin settings revision does not match the current Account revision',
                { currentRevision: String(currentRevision) },
            );
        }
        const result = await adapter.write({
            pluginId: input.pluginId,
            scope: ACCOUNT_SCOPE,
            target: target(),
            fields: adapterFields(settings),
            fieldId: request.id,
            mutation: request.reset
                ? { kind: 'delete' as const }
                : { kind: 'set' as const, value: request.value },
            expectedRevision: {
                kind: 'account',
                value: currentRevision === ABSENT_RECORD_REVISION ? 'absent' : currentRevision,
            },
        });
        assertCurrent(input.accountLifetime, request.signal);
        if (result.status === 'conflict') {
            throw settingsError(
                CONFLICT_CODE,
                'Plugin settings revision does not match the current Account revision',
                { currentRevision: String(toRevisionNumber(result.snapshot)) },
            );
        }
        if (result.status !== 'ready') {
            // `outcomeUnknown` reaches the caller as unavailable, exactly as it
            // does on the daemon path: an unproven write is never reported as
            // applied, and this client replays nothing.
            throw settingsError(
                PERSISTENCE_UNAVAILABLE_CODE,
                'Account plugin settings persistence is unavailable',
            );
        }
        return Object.freeze({
            scope: ACCOUNT_SCOPE_REF,
            revision: String(toRevisionNumber(result.snapshot)),
        });
    }

    return Object.freeze({
        async snapshot(options?: { signal?: AbortSignal }) {
            assertCurrent(input.accountLifetime, options?.signal);
            const settings = declared();
            const record = await readRecord(settings, options?.signal);
            return Object.freeze({
                scope: ACCOUNT_SCOPE_REF,
                revision: String(toRevisionNumber(record)),
                values: Object.freeze({ ...record.values }) as Readonly<Record<string, JsonValue>>,
            });
        },
        async get<T extends JsonValue = JsonValue>(id: string, options?: { signal?: AbortSignal }) {
            assertCurrent(input.accountLifetime, options?.signal);
            const settings = declared();
            const setting = settingOrThrow(settings, id);
            const record = await readRecord(settings, options?.signal);
            if (Object.prototype.hasOwnProperty.call(record.values, id)) {
                return record.values[id] as T;
            }
            return setting.default === undefined ? null : setting.default as T;
        },
        async set(
            id: string,
            value: JsonValue,
            options?: { expectedRevision?: string; signal?: AbortSignal },
        ) {
            return await mutate({ id, value, reset: false, ...options });
        },
        async reset(id: string, options?: { expectedRevision?: string; signal?: AbortSignal }) {
            return await mutate({ id, reset: true, ...options });
        },
    });
}
