export type AgentLocalAuthSupport = 'login_terminal' | 'status_only' | 'manual_only' | 'unsupported';
export type AgentLocalAuthLaunchKind = 'primary' | 'device_code';

export type AgentLocalAuthLaunch = Readonly<{
    initialCommand: string;
    initialInput?: string | null;
}>;

export type AgentLocalAuthPlugin = Readonly<{
    agentId: string;
    support: AgentLocalAuthSupport;
    docsUrl?: string | null;
    loginLaunchKinds?: readonly AgentLocalAuthLaunchKind[];
    buildLoginLaunch?: (params: Readonly<{
        kind?: AgentLocalAuthLaunchKind;
        resolvedPath?: string | null;
        resolvedCommand?: string | null;
        platform?: NodeJS.Platform | string | null;
    }>) => AgentLocalAuthLaunch | null;
    statusHelpText?: string;
}>;
