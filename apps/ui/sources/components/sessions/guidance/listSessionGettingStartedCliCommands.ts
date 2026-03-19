import { AGENT_IDS, getAgentBehavior, getAgentCore } from '@/agents/catalog/catalog';

export function listSessionGettingStartedCliCommands(): readonly string[] {
    const commands = ['happier'];

    for (const agentId of AGENT_IDS) {
        if (getAgentBehavior(agentId).guidance?.includeInSessionGettingStartedCliExamples !== true) {
            continue;
        }

        commands.push(`happier ${getAgentCore(agentId).cli.detectKey}`);
    }

    return commands;
}
