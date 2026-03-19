import type { HappierToolsShellBridgeCommand } from '@happier-dev/protocol';

export function getHappierToolsShellBridgeDisplay(command: HappierToolsShellBridgeCommand): {
    titleCommand: string;
    description: string;
    subtitle: string;
} {
    if (command.kind === 'list') {
        return {
            titleCommand: 'list',
            description: 'happier.tools',
            subtitle: 'happier.tools.list',
        };
    }

    return {
        titleCommand: command.tool,
        description: `${command.source}.${command.tool}`,
        subtitle: `${command.source}.${command.tool}`,
    };
}
