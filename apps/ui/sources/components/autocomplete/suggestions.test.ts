import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    searchFiles: vi.fn(async () => []),
}));

vi.mock('@/sync/domains/input/suggestionCommands', () => ({
    searchCommands: vi.fn(async () => [
        { command: 'goal', description: 'Set or inspect the session goal' },
    ]),
}));

describe('autocomplete suggestions', () => {
    it('uses a taller row height for slash commands with descriptions', async () => {
        const { getCommandSuggestions } = await import('./suggestions');

        const suggestions = await getCommandSuggestions('s1', '/go');

        expect(suggestions[0]).toMatchObject({
            key: 'cmd-goal',
            text: '/goal',
            label: '/goal',
            description: 'Set or inspect the session goal',
            rowHeight: 52,
        });
    });
});
