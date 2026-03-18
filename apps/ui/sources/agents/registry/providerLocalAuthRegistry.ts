import { providerSettingDefinitionsById } from './providerSettingDefinitions';

export type ProviderLocalAuthRegistryEntry = Readonly<{
    enabled: boolean;
    route: string;
    terminalRoute: string;
    contextRoute: string;
}>;

export const providerLocalAuthRegistry = {
    claude: {
        enabled: providerSettingDefinitionsById.claude.localAuth.enabled,
        route: providerSettingDefinitionsById.claude.routes.auth,
        terminalRoute: providerSettingDefinitionsById.claude.routes.terminal,
        contextRoute: providerSettingDefinitionsById.claude.routes.context,
    },
    codex: {
        enabled: providerSettingDefinitionsById.codex.localAuth.enabled,
        route: providerSettingDefinitionsById.codex.routes.auth,
        terminalRoute: providerSettingDefinitionsById.codex.routes.terminal,
        contextRoute: providerSettingDefinitionsById.codex.routes.context,
    },
    opencode: {
        enabled: providerSettingDefinitionsById.opencode.localAuth.enabled,
        route: providerSettingDefinitionsById.opencode.routes.auth,
        terminalRoute: providerSettingDefinitionsById.opencode.routes.terminal,
        contextRoute: providerSettingDefinitionsById.opencode.routes.context,
    },
    gemini: {
        enabled: providerSettingDefinitionsById.gemini.localAuth.enabled,
        route: providerSettingDefinitionsById.gemini.routes.auth,
        terminalRoute: providerSettingDefinitionsById.gemini.routes.terminal,
        contextRoute: providerSettingDefinitionsById.gemini.routes.context,
    },
    kiro: {
        enabled: providerSettingDefinitionsById.kiro.localAuth.enabled,
        route: providerSettingDefinitionsById.kiro.routes.auth,
        terminalRoute: providerSettingDefinitionsById.kiro.routes.terminal,
        contextRoute: providerSettingDefinitionsById.kiro.routes.context,
    },
} as const satisfies Readonly<Record<keyof typeof providerSettingDefinitionsById, ProviderLocalAuthRegistryEntry>>;

export type ProviderLocalAuthRegistry = typeof providerLocalAuthRegistry;

export function getProviderLocalAuthRegistryEntry(providerId: keyof ProviderLocalAuthRegistry): ProviderLocalAuthRegistryEntry {
    return providerLocalAuthRegistry[providerId];
}
