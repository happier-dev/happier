import { PluginError, type Disposable, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { createPluginAccountActionSettingsService } from '@happier-dev/cli-common/plugins/registration/accountActionSettings';
import { createStablePluginSettingsModel } from '@happier-dev/protocol/plugins/contributions/ui/settingsDescriptors';
import { isBoundedPluginPerActiveServerValueV1 } from '@happier-dev/protocol/plugins/contributions/settings';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { SettingsSnapshot } from '@happier-dev/plugin-sdk/settings';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { scopedPluginSettingsAdapter, resolveScopedPluginSettingsServerIdentity } from './scopedPluginSettingsRuntime';
import { formatPluginSettingsAdministrationRevision } from './scopedPluginSettingsAdapter';

/** Portable reads adapt the same declaration model, scoped record and AccountChange owner as Settings UI. */
export function createUiAccountActionSettingsService(input: Readonly<{
    pluginId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal: AbortSignal;
    isCurrent(): boolean;
}>): PluginAccountActionContext['services']['settings'] {
    return createPluginAccountActionSettingsService({ forScope() {
        const assertCurrent = () => {
            if (input.signal.aborted || !input.accountLifetime.isCurrent() || !input.isCurrent()) {
                throw new PluginError({ code: 'plugin_action_generation_retired' });
            }
        };
        assertCurrent();
        const selected = readPluginAccountAvailability(input.accountLifetime.scope).readCurrentAccountExecution(input.pluginId);
        const serverIdentityId = resolveScopedPluginSettingsServerIdentity(input.accountLifetime.scope.serverId);
        const contributions = selected.kind === 'available'
            ? selected.manifest.contributes.settings.filter(row => row.scope === 'account') : [];
        if (!serverIdentityId || contributions.length === 0) throw new PluginError({ code: 'plugin_settings_scope_unavailable' });
        const model = createStablePluginSettingsModel({ pluginId: input.pluginId, contributions });
        const target = { kind: 'account' as const, serverIdentityId };
        const scope = { kind: 'account' as const };
        const fields = model.fields.map(field => ({ key: field.id, redacted: field.descriptor.secret === true,
            binding: { kind: 'direct' as const, settingId: field.id } }));
        const perServerFields = new Set(contributions.flatMap(row => row.fields.flatMap(field =>
            field.presentation?.binding?.kind === 'perActiveServer' ? [field.presentation.binding.byServerIdSettingId] : [])));
        const readers = new Map(model.fields.filter(field => field.descriptor.secret !== true).map(field => {
            const validator = createPluginJsonSchemaZodValueAdapter(field.descriptor.schema);
            if (field.descriptor.default !== undefined && (!validator.safeParse(field.descriptor.default).success
                || perServerFields.has(field.id) && !isBoundedPluginPerActiveServerValueV1(field.descriptor.default))) {
                throw new PluginError({ code: 'plugin_settings_invalid_default' });
            }
            return [field.id, createStoredReadSchema(validator)] as const;
        }));
        const snapshot = async (options?: { signal?: AbortSignal }): Promise<SettingsSnapshot> => {
            assertCurrent();
            const cancellation = mergeAbortSignals([input.signal, options?.signal]);
            try {
                cancellation.signal.throwIfAborted();
                const result = await scopedPluginSettingsAdapter.read({ pluginId: input.pluginId, scope, target, fields,
                    signal: cancellation.signal });
                assertCurrent();
                cancellation.signal.throwIfAborted();
                if (result.status !== 'ready') throw new PluginError({ code: 'plugin_settings_scope_unavailable' });
                const values: Record<string, JsonValue> = {};
                for (const [id, value] of Object.entries(result.snapshot.values)) {
                    const parsed = readers.get(id)?.safeParse(value);
                    if (!parsed?.success || perServerFields.has(id) && !isBoundedPluginPerActiveServerValueV1(parsed.data)) {
                        throw new PluginError({ code: 'plugin_settings_record_invalid' });
                    }
                    values[id] = parsed.data;
                }
                return { scope, revision: formatPluginSettingsAdministrationRevision(result.snapshot.revision), values };
            } finally { cancellation.dispose(); }
        };
        return {
            snapshot,
            async get<T extends JsonValue = JsonValue>(id: string, options?: { signal?: AbortSignal }): Promise<T | null> {
                const field = model.fields.find(row => row.id === id);
                if (!field) throw new PluginError({ code: 'plugin_settings_unknown_id' });
                if (field.descriptor.secret === true) throw new PluginError({ code: 'plugin_settings_secret_materialization_required' });
                const current = await snapshot(options);
                // The declaration and stored-value validators establish the generic Settings contract.
                const value = Object.hasOwn(current.values, id) ? current.values[id] : field.descriptor.default ?? null;
                return normalizeStrictJsonValue(value) as T | null;
            },
            describe() { assertCurrent(); return model.descriptors; },
            watch(listener): Disposable {
                assertCurrent();
                let disposed = false;
                let previous: SettingsSnapshot | null = null;
                const baseline = snapshot().then(current => { if (!disposed) previous = current; }).catch(() => {});
                let serial = Promise.resolve();
                const subscription = scopedPluginSettingsAdapter.watch?.({ pluginId: input.pluginId, scope, target,
                    onInvalidated() {
                        // Keep only this watcher's previous observation, never a Settings authority.
                        // Content-free hints read through the incumbent owner in arrival order.
                        serial = serial.then(async () => {
                            await baseline;
                            if (disposed) return;
                            const current = await snapshot();
                            if (disposed) return;
                            assertCurrent();
                            const before = previous?.values ?? {};
                            previous = current;
                            const changedIds = model.fields.filter(field => field.descriptor.secret !== true).filter(field => {
                                const left = before[field.id];
                                const right = current.values[field.id];
                                return left === undefined ? right !== undefined
                                    : right === undefined || !pluginJsonValuesEqual(left, right);
                            }).map(field => field.id).sort();
                            if (changedIds.length === 0) return;
                            const values = Object.fromEntries(Object.entries(current.values).map(([id, value]) =>
                                [id, normalizeStrictJsonValue(value)] as const));
                            listener({ ...current, changedIds, values });
                        }).catch(() => { /* Retired/unavailable reads cannot disclose another Account's values. */ });
                    } });
                if (!subscription) throw new PluginError({ code: 'plugin_settings_scope_unavailable' });
                let retirement: Disposable | undefined;
                const dispose = () => {
                    if (disposed) return;
                    disposed = true;
                    previous = null;
                    input.signal.removeEventListener('abort', dispose);
                    subscription?.dispose();
                    retirement?.dispose();
                };
                retirement = input.accountLifetime.onRetire(dispose);
                input.signal.addEventListener('abort', dispose, { once: true });
                if (input.signal.aborted || !input.accountLifetime.isCurrent()) dispose();
                return { dispose };
            },
        };
    } });
}
