import type {
    AgentRuntimeFactory,
    AgentSessionOpenRequest,
    AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type {
    NormalizedPluginDeclarativeAcpRuntime,
} from '@/agent/acp/runtime/definition/plugin';

export function createHostDeclarativeAcpAgentRuntimeFactory(
    runtime: NormalizedPluginDeclarativeAcpRuntime,
): AgentRuntimeFactory {
    return async () => Object.freeze({
        sessions: Object.freeze({
            async open(
                request: AgentSessionOpenRequest,
                context: AgentSessionRuntimeContext,
            ) {
                return await context.protocols.acp.open(request, runtime);
            },
        }),
    });
}
