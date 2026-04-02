import { AGENT_IDS, getAgentBehavior, getAgentCore } from '@/agents/catalog/catalog';

export function listSessionGettingStartedCliCommands(invoker: string): readonly string[] {
    const base = String(invoker ?? '').trim() || 'happier';
    const commands = [base];

    for (const agentId of AGENT_IDS) {
        if (getAgentBehavior(agentId).guidance?.includeInSessionGettingStartedCliExamples !== true) {
            continue;
        }

        commands.push(`${base} ${getAgentCore(agentId).cli.detectKey}`);
    }

    return commands;
}
