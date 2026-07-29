import {
    readProviderSettingsFromAccountSettingsV1,
    type ProviderSettingsV1,
} from '@happier-dev/protocol';

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
