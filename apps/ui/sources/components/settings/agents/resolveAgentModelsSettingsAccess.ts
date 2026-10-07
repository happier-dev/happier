import { readProviderSettingsFromAccountSettingsV1 } from '@happier-dev/protocol/providers/settings/readFromAccountSettingsV1';
import type { ProviderSettingsV1 } from '@happier-dev/protocol/providers/settings/v1';

export type AgentModelsSettingsAccess = Readonly<{
    writable: boolean;
    settings: ProviderSettingsV1;
}>;

export function resolveAgentModelsSettingsAccess(accountSettings: unknown): AgentModelsSettingsAccess {
    const result = readProviderSettingsFromAccountSettingsV1(accountSettings);
    return {
        writable: result.diagnostics.length === 0,
        settings: result.settings,
    };
}
