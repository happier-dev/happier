import type {
    PluginContributionLocalId,
    PluginSettingFieldIdV2,
    PluginSettingsActionDeclarationV2,
} from '@happier-dev/protocol';

import type { JsonValue } from './identity.js';

export type PluginSettingsActionDeclaration = PluginSettingsActionDeclarationV2;

export type PluginSettingsActionInput = Readonly<{
    actionId: PluginContributionLocalId;
    settings: Readonly<Record<PluginSettingFieldIdV2, JsonValue>>;
}>;

export type PluginSettingsActionResult = Readonly<{
    patch: Readonly<Record<PluginSettingFieldIdV2, JsonValue>>;
}>;

export interface PluginSettingsActionRuntime<Context> {
    execute(
        input: PluginSettingsActionInput,
        context: Context,
    ): Promise<PluginSettingsActionResult>;
}
