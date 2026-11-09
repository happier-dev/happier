import type { DaemonTerminalLaunchIntent } from '@happier-dev/protocol/daemon/terminal';

export type AgentLocalAuthSupport = 'login_terminal' | 'status_only' | 'manual_only' | 'unsupported';
export type AgentLocalAuthLaunchKind = 'primary' | 'device_code';

export type AgentLocalAuthLaunch = Readonly<{ launch: Extract<DaemonTerminalLaunchIntent, { kind: 'agent_login' }> }>;

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
