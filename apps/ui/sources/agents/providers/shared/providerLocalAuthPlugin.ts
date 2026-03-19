import type { AgentId } from '@/agents/catalog/catalog';

export type ProviderLocalAuthSupport = 'login_terminal' | 'status_only' | 'manual_only' | 'unsupported';

export type ProviderLocalAuthLaunch = Readonly<{
    initialCommand: string;
    initialInput?: string | null;
}>;

export type ProviderLocalAuthPlugin = Readonly<{
    providerId: AgentId;
    support: ProviderLocalAuthSupport;
    docsUrl?: string | null;
    buildLoginLaunch?: (params: Readonly<{
        resolvedPath?: string | null;
        resolvedCommand?: string | null;
        platform?: NodeJS.Platform | string | null;
    }>) => ProviderLocalAuthLaunch | null;
    statusHelpText?: string;
}>;
