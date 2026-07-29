import type { AgentLocalAuthLaunch, AgentLocalAuthLaunchKind, AgentLocalAuthPlugin, AgentLocalAuthSupport } from './agentLocalAuthPlugin';

export function createStaticAgentLocalAuthPlugin(params: Readonly<{
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
}>): AgentLocalAuthPlugin {
    return {
        agentId: params.agentId,
        support: params.support,
        ...(params.docsUrl !== undefined ? { docsUrl: params.docsUrl } : {}),
        ...(params.loginLaunchKinds ? { loginLaunchKinds: params.loginLaunchKinds } : {}),
        ...(params.buildLoginLaunch ? { buildLoginLaunch: params.buildLoginLaunch } : {}),
        ...(params.statusHelpText ? { statusHelpText: params.statusHelpText } : {}),
    };
}
