import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    searchFiles: vi.fn(async () => []),
}));

vi.mock('@/sync/domains/input/suggestionCommands', () => ({
    searchCommands: vi.fn(async () => [
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
    ]),
}));

describe('autocomplete suggestions', () => {
    it('uses a taller row height for slash commands with descriptions', async () => {
        const { getCommandSuggestions } = await import('./commandSuggestions');

        const suggestions = await getCommandSuggestions('s1', '/go');

        expect(suggestions[0]).toMatchObject({
            key: 'cmd-goal',
            text: '/goal',
            label: '/goal',
            description: 'Set or inspect the session goal',
            rowHeight: 52,
        });
    });

    it('carries prompt invocation metadata on slash command suggestions', async () => {
        const { getCommandSuggestions } = await import('./commandSuggestions');

        const suggestions = await getCommandSuggestions('s1', '/qa');

        expect(suggestions.find((suggestion) => suggestion.key === 'cmd-qa')).toMatchObject({
            key: 'cmd-qa',
            text: '/qa',
            promptInvocation: {
                invocationId: 'tmpl_1',
                token: '/qa',
                targetArtifactId: 'artifact_prompt_1',
                behavior: 'insert',
                allowArgs: false,
            },
        });
    });
});
