import { buildBuiltInAccountSettingMutationV1, readBuiltInSettingDeclarationV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';

import type { Settings, SettingsWriteDelta } from '@/sync/domains/settings/settings';
import type { SettingValue } from '@/components/settings/catalog/settingDeclarations';

/** Field intents use the persisted CAS winner, not its known-fields-only read projection. */
export function reduceAccountSettingIntent(params: Readonly<{
    anchor: string;
    raw: Readonly<Record<string, unknown>>;
    settings: Settings;
    value: SettingValue;
    mutate(settings: Settings): SettingsWriteDelta | null;
}>): SettingsWriteDelta | null {
    const declaration = readBuiltInSettingDeclarationV1(params.anchor);
    if (declaration?.storage?.scope === 'account' && declaration.storage.kind === 'field') {
        // The canonical declaration admits the exact key, field and containing value.
        return buildBuiltInAccountSettingMutationV1(declaration, params.raw, params.value) as SettingsWriteDelta | null;
    }
    return params.mutate(params.settings);
}
