import type { ConnectedServiceId } from '@happier-dev/protocol';

export type ConnectedServiceDisplayNameKey =
    | 'connectedServices.serviceNames.claudeSubscription'
    | 'connectedServices.serviceNames.openaiCodex'
    | 'connectedServices.serviceNames.openai'
    | 'connectedServices.serviceNames.anthropic'
    | 'connectedServices.serviceNames.gemini'
    | 'connectedServices.serviceNames.antigravity'
    | 'connectedServices.serviceNames.github'
    | 'connectedServices.fallbackName';

export function resolveConnectedServiceDisplayNameKey(serviceId: ConnectedServiceId): ConnectedServiceDisplayNameKey {
    switch (serviceId) {
        case 'claude-subscription':
            return 'connectedServices.serviceNames.claudeSubscription';
        case 'openai-codex':
            return 'connectedServices.serviceNames.openaiCodex';
        case 'openai':
            return 'connectedServices.serviceNames.openai';
        case 'anthropic':
            return 'connectedServices.serviceNames.anthropic';
        case 'gemini':
            return 'connectedServices.serviceNames.gemini';
        case 'github':
            return 'connectedServices.serviceNames.github';
        case 'antigravity':
            return 'connectedServices.serviceNames.antigravity';
        default:
            return 'connectedServices.fallbackName';
    }
}

export function resolveConnectedServiceDisplayName(
    serviceId: ConnectedServiceId,
    translate: (key: ConnectedServiceDisplayNameKey) => string,
): string {
    return translate(resolveConnectedServiceDisplayNameKey(serviceId));
}

/**
 * Short, brand-only names for compact surfaces (the agent-input auth chip and the account-switch
 * transcript event), so they read "Codex: <group> (1)" / "Switched Codex account ..." instead of the
 * longer canonical service titles ("OpenAI Codex", "Claude subscription"). These are product/brand
 * proper nouns that are identical across every locale (same rationale the i18n guidance gives for
 * keeping "CLI"/"API"/"JSON" untranslated), so they are intentionally not routed through `t(...)`.
 * Unknown services fall back to the full localized display name.
 */
const CONNECTED_SERVICE_SHORT_NAME_BY_ID: Partial<Record<ConnectedServiceId, string>> = {
    'claude-subscription': 'Claude',
    'openai-codex': 'Codex',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    gemini: 'Gemini',
    github: 'GitHub',
    antigravity: 'AGY',
};

export function resolveConnectedServiceShortName(
    serviceId: ConnectedServiceId,
    translate: (key: ConnectedServiceDisplayNameKey) => string,
): string {
    return CONNECTED_SERVICE_SHORT_NAME_BY_ID[serviceId] ?? resolveConnectedServiceDisplayName(serviceId, translate);
}
