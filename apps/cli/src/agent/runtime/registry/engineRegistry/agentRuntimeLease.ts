import type { AgentRuntime } from '@happier-dev/plugin-sdk/agent-runtime';

import type { AgentRuntimeRegistrationLease } from '@/plugins/runtime/lifecycle/contributions/targetAgents';

export async function resolveLeasedAgentRuntime(params: Readonly<{
    lease: AgentRuntimeRegistrationLease;
}>): Promise<AgentRuntime> {
    if (!params.lease.hasPrimaryRuntime) {
        throw new Error(
            `Agent '${params.lease.agentId}' from plugin '${params.lease.pluginId}' does not register a primary runtime`,
        );
    }
    const retirementSignal = params.lease.retirementSignal;
    if (!(retirementSignal instanceof AbortSignal)) {
        throw new Error(
            `Agent '${params.lease.agentId}' runtime lease has no generation retirement signal`,
        );
    }
    return await params.lease.createRuntime({
        signal: retirementSignal,
    });
}
