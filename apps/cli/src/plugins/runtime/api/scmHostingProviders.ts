import type {
    PluginApiScmHostingProviderRegistration,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isPluginApiScmHostingProviderRegistration(
    value: unknown,
): value is PluginApiScmHostingProviderRegistration {
    return isRecord(value)
        && typeof value.id === 'string'
        && value.id.trim().length > 0
        && isRecord(value.adapter);
}
