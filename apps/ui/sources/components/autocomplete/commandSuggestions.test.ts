import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchCommandsMock = vi.hoisted(() => vi.fn());
const suggestionViewModuleImports = vi.hoisted(() => ({ count: 0 }));

vi.mock('@/sync/domains/input/suggestionCommands', () => ({
    searchCommands: searchCommandsMock,
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputSuggestionView', () => {
    suggestionViewModuleImports.count += 1;
    return {
        COMMAND_SUGGESTION_ROW_HEIGHT: 52,
    };
});

describe('command autocomplete suggestions', () => {
    beforeEach(() => {
        vi.resetModules();
        searchCommandsMock.mockReset();
        suggestionViewModuleImports.count = 0;
    });

    it('builds slash command suggestions without loading rendered suggestion components', async () => {
        searchCommandsMock.mockResolvedValue([
            { command: 'goal', description: 'Set or inspect the session goal' },
            {
                command: 'qa',
                description: 'QA prompt',
                promptInvocation: {
                    invocationId: 'tmpl_1',
                    token: '/qa',
                    targetArtifactId: 'artifact_prompt_1',
                    behavior: 'insert',
                    allowArgs: false,
                },
            },
        ]);

        const { getCommandSuggestions } = await import('./commandSuggestions');

        expect(suggestionViewModuleImports.count).toBe(0);

        const suggestions = await getCommandSuggestions('s1', '/go');

        expect(searchCommandsMock).toHaveBeenCalledWith('s1', 'go', { limit: 8 });
        expect(suggestions).toEqual([
            {
                key: 'cmd-goal',
                text: '/goal',
                label: '/goal',
                description: 'Set or inspect the session goal',
                rowHeight: 52,
            },
            {
                key: 'cmd-qa',
                text: '/qa',
                label: '/qa',
                description: 'QA prompt',
                rowHeight: 52,
                promptInvocation: {
                    invocationId: 'tmpl_1',
                    token: '/qa',
                    targetArtifactId: 'artifact_prompt_1',
                    behavior: 'insert',
                    allowArgs: false,
                },
            },
        ]);
        expect(suggestionViewModuleImports.count).toBe(0);
    });
});
