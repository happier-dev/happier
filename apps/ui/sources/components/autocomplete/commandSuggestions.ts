import { searchCommands, type CommandItem } from '@/sync/domains/input/suggestionCommands';
import type { PluginContributedActionDescriptor } from '@/components/plugins/actions/pluginContributedActionController';
import type { AutocompleteSuggestion } from './autocompleteTypes';
import { COMMAND_SUGGESTION_ROW_HEIGHT } from './commandSuggestionConstants';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { getPromptLibraryCatalogValue } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { refreshPromptLibraryCatalog } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';

export async function getCommandSuggestions(
    sessionId: string | null,
    query: string,
    options?: Readonly<{
        limit?: number;
        serverId?: string | null;
        nativeCommands?: readonly Pick<CommandItem, 'command' | 'description'>[];
        contributedActions?: readonly PluginContributedActionDescriptor[];
    }>,
): Promise<AutocompleteSuggestion[]> {
    const searchTerm = query.startsWith('/') ? query.slice(1) : query;
    const scope = selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), options?.serverId ?? null);
    if (scope) {
        await refreshPromptLibraryCatalog(scope);
        if (!areServerAccountScopesEqual(scope, getActiveServerAccountScope())) return [];
    }

    // Failures propagate. A `catch { return [] }` here made a rejected command-search
    // RPC indistinguishable from "no command matches that prefix" — the same silent
    // shape that let a completely dead `@` look like an empty repository. The
    // dispatcher already turns a rejected kind into "no rows plus one diagnostic"
    // (`suggestions.ts`), and it is the single place that decision belongs.
    const commands = await searchCommands(sessionId, searchTerm, {
        ...(scope ? { invocations: getPromptLibraryCatalogValue(scope, 'invocations').value } : {}),
        limit: options?.limit ?? 8,
        contributedActions: options?.contributedActions,
        ...(options?.nativeCommands ? { nativeCommands: options.nativeCommands } : {}),
    });

    return commands.map((cmd: CommandItem) => ({
        kind: 'slashCommand' as const,
        key: `cmd-${cmd.key ?? cmd.command}`,
        text: `/${cmd.command}`,
        label: `/${cmd.command}`,
        ...(cmd.description ? { description: cmd.description } : {}),
        rowHeight: COMMAND_SUGGESTION_ROW_HEIGHT,
        ...(cmd.promptInvocation ? { promptInvocation: { ...cmd.promptInvocation,
            ...(cmd.promptInvocation.targetServerId ? {} : scope ? { targetServerId: scope.serverId } : {}),
        } } : {}),
        ...(cmd.pluginContributedAction ? { pluginContributedAction: cmd.pluginContributedAction } : {}),
    }));
}
