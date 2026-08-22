import type {
    AgentRuntimeFactory,
    AgentSessionOpenRequest,
    AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginAgentAcpTransport } from '@happier-dev/protocol';

export function createHostDeclarativeAcpAgentRuntimeFactory(
    transport: PluginAgentAcpTransport,
): AgentRuntimeFactory {
    return async () => Object.freeze({
        sessions: Object.freeze({
            async open(
                request: AgentSessionOpenRequest,
                context: AgentSessionRuntimeContext,
            ) {
                return await context.protocols.acp.open(request, { transport });
            },
        }),
    });
}
