import { searchCommands, type CommandItem } from '@/sync/domains/input/suggestionCommands';
import type { AutocompleteSuggestion } from './autocompleteTypes';
import { COMMAND_SUGGESTION_ROW_HEIGHT } from './commandSuggestionConstants';

export async function getCommandSuggestions(
    sessionId: string,
    query: string,
): Promise<AutocompleteSuggestion[]> {
    const searchTerm = query.startsWith('/') ? query.slice(1) : query;

    try {
        const commands = await searchCommands(sessionId, searchTerm, { limit: 8 });

        return commands.map((cmd: CommandItem) => ({
            key: `cmd-${cmd.command}`,
            text: `/${cmd.command}`,
            label: `/${cmd.command}`,
            ...(cmd.description ? { description: cmd.description } : {}),
            rowHeight: COMMAND_SUGGESTION_ROW_HEIGHT,
            ...(cmd.promptInvocation ? { promptInvocation: cmd.promptInvocation } : {}),
        }));
    } catch {
        return [];
    }
}
