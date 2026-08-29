import type { AgentUiSettingReferenceV1 } from '@happier-dev/protocol';

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

/** Resolve a public setting reference against exactly its declared scope. */
export function readAgentUiSetting(
    settings: Settings | Readonly<Record<string, unknown>>,
    reference: AgentUiSettingReferenceV1 | undefined,
): unknown {
    const record = settings as Readonly<Record<string, unknown>>;
    if (!reference) return undefined;
    if (reference.scope === 'host') return record[reference.localId];
    const scoped = (settings as ScopedSettingsCarrier)[SCOPED_SETTINGS_VIEW];
    return scoped?.[reference.scope]?.[reference.localId];
}
