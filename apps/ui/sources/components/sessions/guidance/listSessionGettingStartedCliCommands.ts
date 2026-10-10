import { AGENT_CORE_CONFIGS, getAgentBehavior } from '@/agents/catalog/catalog';

export function listSessionGettingStartedCliCommands(invoker: string): readonly string[] {
    const base = String(invoker ?? '').trim() || 'happier';
    const commands = [base];

    for (const core of AGENT_CORE_CONFIGS) {
        if (!core.cli || getAgentBehavior(core.id).guidance?.includeInSessionGettingStartedCliExamples !== true) {
            continue;
        }

        commands.push(`${base} ${core.cli.detectKey}`);
    }

    return commands;
}
