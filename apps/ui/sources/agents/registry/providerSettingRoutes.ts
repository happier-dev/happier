import type { AgentId } from '@/agents/catalog/catalog';

import { providerSettingDefinitionsById, type ProviderSettingId } from './providerSettingDefinitions';

export const SETTINGS_ROUTE_PREFIX = '/(app)/settings' as const;

export const providerSettingRoutes = {
    acpCatalog: `${SETTINGS_ROUTE_PREFIX}/acp-catalog`,
    machines: `${SETTINGS_ROUTE_PREFIX}/machines`,
    sessionHandoffs: `${SETTINGS_ROUTE_PREFIX}/session-handoffs`,
    providers: `${SETTINGS_ROUTE_PREFIX}/providers`,
} as const;

export function getProviderSettingsRoute(providerId: AgentId): string {
    const normalizedProviderId = String(providerId ?? '').trim().toLowerCase() as ProviderSettingId;
    if (!(normalizedProviderId in providerSettingDefinitionsById)) {
        return providerSettingRoutes.providers;
    }
    return providerSettingDefinitionsById[normalizedProviderId].routes.settings;
}

export function getProviderSettingsAuthRoute(providerId: AgentId): string {
    const normalizedProviderId = String(providerId ?? '').trim().toLowerCase() as ProviderSettingId;
    if (!(normalizedProviderId in providerSettingDefinitionsById)) {
        return providerSettingRoutes.providers;
    }
    return providerSettingDefinitionsById[normalizedProviderId].routes.auth;
}

export function getProviderSettingsTerminalRoute(providerId: AgentId): string {
    const normalizedProviderId = String(providerId ?? '').trim().toLowerCase() as ProviderSettingId;
    if (!(normalizedProviderId in providerSettingDefinitionsById)) {
        return providerSettingRoutes.providers;
    }
    return providerSettingDefinitionsById[normalizedProviderId].routes.terminal;
}

export function getProviderSettingsContextRoute(providerId: AgentId): string {
    const normalizedProviderId = String(providerId ?? '').trim().toLowerCase() as ProviderSettingId;
    if (!(normalizedProviderId in providerSettingDefinitionsById)) {
        return providerSettingRoutes.providers;
    }
    return providerSettingDefinitionsById[normalizedProviderId].routes.context;
}
