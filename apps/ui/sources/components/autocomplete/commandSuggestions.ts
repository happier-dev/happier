import { searchCommands, type CommandItem } from '@/sync/domains/input/suggestionCommands';
import type { AutocompleteSuggestion } from './autocompleteTypes';
import { COMMAND_SUGGESTION_ROW_HEIGHT } from './commandSuggestionConstants';

export async function getCommandSuggestions(
    sessionId: string | null,
    query: string,
    options?: Readonly<{ limit?: number }>,
): Promise<AutocompleteSuggestion[]> {
    const searchTerm = query.startsWith('/') ? query.slice(1) : query;

    // Failures propagate. A `catch { return [] }` here made a rejected command-search
    // RPC indistinguishable from "no command matches that prefix" — the same silent
    // shape that let a completely dead `@` look like an empty repository. The
    // dispatcher already turns a rejected kind into "no rows plus one diagnostic"
    // (`suggestions.ts`), and it is the single place that decision belongs.
    const commands = await searchCommands(sessionId, searchTerm, { limit: options?.limit ?? 8 });

    return commands.map((cmd: CommandItem) => ({
        kind: 'slashCommand' as const,
        key: `cmd-${cmd.command}`,
        text: `/${cmd.command}`,
        label: `/${cmd.command}`,
        ...(cmd.description ? { description: cmd.description } : {}),
        rowHeight: COMMAND_SUGGESTION_ROW_HEIGHT,
        ...(cmd.promptInvocation ? { promptInvocation: cmd.promptInvocation } : {}),
    }));
}
