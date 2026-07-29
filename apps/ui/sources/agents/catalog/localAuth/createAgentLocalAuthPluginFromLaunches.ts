import type { AgentLocalAuthLaunchKind, AgentLocalAuthPlugin, AgentLocalAuthSupport } from './agentLocalAuthPlugin';
import { createStaticAgentLocalAuthPlugin } from './createStaticAgentLocalAuthPlugin';
import {
    formatAgentLocalAuthShellArgument,
    resolveAgentLocalAuthBaseCommand,
} from './resolveAgentLocalAuthBaseCommand';

export type AgentLocalAuthLaunchDeclaration = Readonly<{
    kind: AgentLocalAuthLaunchKind;
    args: readonly string[];
    initialInput?: string | null;
    fallbackCommand?: string;
}>;

export function createAgentLocalAuthPluginFromLaunches(params: Readonly<{
    agentId: string;
    support: AgentLocalAuthSupport;
    docsUrl?: string | null;
    fallbackCommand: string;
    loginLaunches: readonly AgentLocalAuthLaunchDeclaration[];
}>): AgentLocalAuthPlugin {
    return createStaticAgentLocalAuthPlugin({
        agentId: params.agentId,
        support: params.support,
        ...(params.docsUrl !== undefined ? { docsUrl: params.docsUrl } : {}),
        ...(params.loginLaunches.length > 0
            ? {
                loginLaunchKinds: params.loginLaunches.map((launch) => launch.kind),
                buildLoginLaunch: ({ kind = 'primary', resolvedPath, resolvedCommand, platform }) => {
                    const launch = params.loginLaunches.find((candidate) => candidate.kind === kind);
                    if (!launch) return null;
                    const baseCommand = resolveAgentLocalAuthBaseCommand({
                        resolvedPath,
                        resolvedCommand,
                        fallbackCommand: launch.fallbackCommand ?? params.fallbackCommand,
                        platform,
                    });
                    return {
                        initialCommand: launch.args.length > 0
                            ? [
                                baseCommand,
                                ...launch.args.map((arg) => formatAgentLocalAuthShellArgument(arg, platform)),
                            ].join(' ')
                            : baseCommand,
                        ...(launch.initialInput ? { initialInput: launch.initialInput } : {}),
                    };
                },
            }
            : {}),
    });
}
