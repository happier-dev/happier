import type { AgentUiSettingReferenceV1 } from '@happier-dev/protocol/plugins/contributions/agentUiGrammar';

import { isReleasedFlatPluginSettingKey, readReleasedFlatPluginSettingValue } from '@/sync/domains/settings/releasedFlatPluginSettings';
import type { Settings } from '@/sync/domains/settings/settings';

export type AgentPluginSettingsScope = 'account' | 'daemon';
export type AgentPluginSettingsSnapshot = Readonly<Partial<Record<
    AgentPluginSettingsScope,
    Readonly<Record<string, unknown>>
>>>;

export const SCOPED_SETTINGS_VIEW = Symbol('happier.agent.scopedSettingsView');

type ScopedSettingsView = AgentPluginSettingsSnapshot;
type ScopedSettingsCarrier = Settings & { [SCOPED_SETTINGS_VIEW]?: ScopedSettingsView };

/** Attach the exact scoped plugin records without flattening or deduping keys. */
export function attachAgentPluginSettings(
    settings: Settings | Readonly<Record<string, unknown>>,
    pluginSettings: AgentPluginSettingsSnapshot,
): Settings {
    const merged = { ...settings } as ScopedSettingsCarrier;
    Object.defineProperty(merged, SCOPED_SETTINGS_VIEW, {
        configurable: false,
        enumerable: false,
        value: pluginSettings,
        writable: false,
    });
    return merged;
}

/** Account carriers this exact reference can read; scoped daemon values never invalidate Account consumers. */
export function getAgentUiSettingAccountKeys(reference: AgentUiSettingReferenceV1 | undefined): readonly string[] {
    if (!reference) return [];
    if (reference.scope === 'host') return [reference.localId];
    return reference.scope === 'account' && isReleasedFlatPluginSettingKey(reference.localId) ? [reference.localId] : [];
}

/** Resolve a public setting reference against exactly its declared scope. */
export function readAgentUiSetting(
    settings: Settings | Readonly<Record<string, unknown>>,
    reference: AgentUiSettingReferenceV1 | undefined,
): unknown {
    const record = settings as Readonly<Record<string, unknown>>;
    if (!reference) return undefined;
    if (reference.scope === 'host') return record[reference.localId];
    const scoped = (settings as ScopedSettingsCarrier)[SCOPED_SETTINGS_VIEW];
    const scopedValue = scoped?.[reference.scope]?.[reference.localId];
    if (scopedValue !== undefined) return scopedValue;
    // A released Account carried this value as a flat Settings root before the
    // scoped record owned it. Availability is evaluated for every catalog Agent,
    // including ones whose scoped record was never loaded, so the released
    // carrier must still answer rather than silently reverting the user's
    // choice to a declaration default.
    if (reference.scope !== 'account') return undefined;
    return readReleasedFlatPluginSettingValue({ settings: record, localId: reference.localId });
}
