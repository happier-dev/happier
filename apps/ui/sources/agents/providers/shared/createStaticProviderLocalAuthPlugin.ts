import type { AgentId } from '@/agents/catalog/catalog';

import type { ProviderLocalAuthLaunch, ProviderLocalAuthPlugin, ProviderLocalAuthSupport } from './providerLocalAuthPlugin';

export function createStaticProviderLocalAuthPlugin(params: Readonly<{
    providerId: AgentId;
    support: ProviderLocalAuthSupport;
    docsUrl?: string | null;
    buildLoginLaunch?: (params: Readonly<{
        resolvedPath?: string | null;
        resolvedCommand?: string | null;
        platform?: NodeJS.Platform | string | null;
    }>) => ProviderLocalAuthLaunch | null;
    statusHelpText?: string;
}>): ProviderLocalAuthPlugin {
    return {
        providerId: params.providerId,
        support: params.support,
        ...(params.docsUrl !== undefined ? { docsUrl: params.docsUrl } : {}),
        ...(params.buildLoginLaunch ? { buildLoginLaunch: params.buildLoginLaunch } : {}),
        ...(params.statusHelpText ? { statusHelpText: params.statusHelpText } : {}),
    };
}
