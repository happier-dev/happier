import type { ScmHostingProviderRegistryDiagnostic } from './types';

export function createMissingScmHostingProviderDescriptorDiagnostic(params: Readonly<{
    pluginId: string;
    providerId: string;
}>): ScmHostingProviderRegistryDiagnostic {
    return {
        code: 'scm_hosting_provider_registration_missing_descriptor',
        pluginId: params.pluginId,
        providerId: params.providerId,
        message: `Plugin '${params.pluginId}' registered SCM hosting provider '${params.providerId}' without a matching static descriptor`,
    };
}

export function createScmHostingProviderPluginMismatchDiagnostic(params: Readonly<{
    descriptorPluginId: string;
    registrationPluginId: string;
    providerId: string;
}>): ScmHostingProviderRegistryDiagnostic {
    return {
        code: 'scm_hosting_provider_registration_plugin_mismatch',
        pluginId: params.registrationPluginId,
        providerId: params.providerId,
        message: `Plugin '${params.registrationPluginId}' registered SCM hosting provider '${params.providerId}' declared by plugin '${params.descriptorPluginId}'`,
    };
}

export function createDuplicateScmHostingProviderDiagnostic(params: Readonly<{
    existingPluginId?: string;
    pluginId?: string;
    providerId: string;
}>): ScmHostingProviderRegistryDiagnostic {
    const pluginId = params.pluginId?.trim() || 'unknown';
    const existingPluginId = params.existingPluginId?.trim() || 'unknown';
    return {
        code: 'scm_hosting_provider_duplicate',
        pluginId,
        providerId: params.providerId,
        message: `Duplicate SCM hosting provider '${params.providerId}' from plugin '${pluginId}' conflicts with plugin '${existingPluginId}'`,
    };
}
