import type { AgentId } from '@/agents/catalog/catalog';

export type ProviderLocalAuthSupport = 'login_terminal' | 'status_only' | 'manual_only' | 'unsupported';

export type ProviderLocalAuthLaunch = Readonly<{
    kind: 'primary' | 'device_code';
    initialCommand: string;
    initialInput?: string | null;
}>;

export type ProviderLocalAuthPlugin = Readonly<{
    providerId: AgentId;
    support: ProviderLocalAuthSupport;
    docsUrl?: string | null;
    buildAuthLaunches?: (params: Readonly<{
        resolvedPath?: string | null;
        resolvedCommand?: string | null;
        platform?: NodeJS.Platform | string | null;
    }>) => ReadonlyArray<ProviderLocalAuthLaunch>;
    statusHelpText?: string;
}>;
