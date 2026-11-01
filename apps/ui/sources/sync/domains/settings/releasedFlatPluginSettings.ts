import { settingsDefaults } from './settings';

/**
 * Released Happier persisted plugin-declared **Account-scoped** settings as flat
 * root keys on the Account Settings document (`settings.codexBackendMode`). The
 * current owner of those values is the scoped plugin-settings record, and the
 * Account Settings parser keeps an unrecognized released root key as an opaque
 * forward-compatible value, so an upgraded Account still carries the choice the
 * user actually made.
 *
 * This module is the single owner of the question "may this released root key
 * supply a declared Account-scoped field?". Both readers that can answer with a
 * value — the declared-field reader that applies declaration defaults, and the
 * Agent UI setting reference reader — consume it, so neither can start
 * admitting a carrier the other refuses.
 *
 * A key that current host Settings own is never borrowed. Without that guard an
 * Agent could read unrelated Account Settings simply by naming a declared field
 * after one of them.
 */
export function isReleasedFlatPluginSettingKey(localId: string): boolean {
    return localId.trim().length > 0 && !Object.prototype.hasOwnProperty.call(settingsDefaults, localId.trim());
}

export function readReleasedFlatPluginSettingValue(params: Readonly<{
    settings: Readonly<Record<string, unknown>> | null | undefined;
    localId: string;
}>): unknown {
    const localId = params.localId.trim();
    if (!isReleasedFlatPluginSettingKey(localId)) return undefined;

    const settings = params.settings;
    if (!settings || typeof settings !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(settings, localId)) return undefined;
    return (settings as Readonly<Record<string, unknown>>)[localId];
}
