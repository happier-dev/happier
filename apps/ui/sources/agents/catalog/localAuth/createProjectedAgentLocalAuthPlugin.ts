import type { PluginAgentCliMetadata } from '@happier-dev/protocol';

import type { AgentLocalAuthPlugin } from './agentLocalAuthPlugin';
import { createAgentLocalAuthPluginFromLaunches } from './createAgentLocalAuthPluginFromLaunches';

export function createProjectedAgentLocalAuthPlugin(params: Readonly<{
    agentId: string;
    cli: PluginAgentCliMetadata;
}>): AgentLocalAuthPlugin {
    return createAgentLocalAuthPluginFromLaunches({
        agentId: params.agentId,
        support: params.cli.auth.support,
        docsUrl: params.cli.install.docsUrl,
        fallbackCommand: params.cli.executable.binaryName,
        loginLaunches: params.cli.auth.loginLaunches,
    });
}
