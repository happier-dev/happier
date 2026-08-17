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
            {
                key: 'plugin-action:acme.review/run',
                command: 'acme.review/run',
                description: 'Run the external review',
                pluginContributedAction: {
                    identity: { pluginId: 'acme.review', localId: 'run' },
                    qualifiedActionId: 'acme.review/run',
                    title: 'Run the external review',
                    description: null,
                    placement: 'primary',
                    slash: { tokens: ['/review'] },
                    scope: 'session',
                    scopes: ['session'],
                    inputHints: null,
                    kind: 'direct',
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
                kind: 'slashCommand',
                text: '/goal',
                label: '/goal',
                description: 'Set or inspect the session goal',
                rowHeight: 52,
            },
            {
                key: 'cmd-qa',
                kind: 'slashCommand',
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
            {
                key: 'cmd-plugin-action:acme.review/run',
                kind: 'slashCommand',
                text: '/acme.review/run',
                label: '/acme.review/run',
                description: 'Run the external review',
                rowHeight: 52,
                pluginContributedAction: {
                    identity: { pluginId: 'acme.review', localId: 'run' },
                    qualifiedActionId: 'acme.review/run',
                    title: 'Run the external review',
                    description: null,
                    placement: 'primary',
                    slash: { tokens: ['/review'] },
                    scope: 'session',
                    scopes: ['session'],
                    inputHints: null,
                    kind: 'direct',
                },
            },
        ]);
        expect(suggestionViewModuleImports.count).toBe(0);
    });
});
