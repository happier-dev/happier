import { afterEach, describe, expect, it } from 'vitest';

import { storage } from '../state/storage';

describe('suggestionCommands', () => {
    afterEach(() => {
        // Keep tests isolated; reset to an empty-ish state.
        storage.setState({ sessions: {} } as any);
    });

    it('includes UI action-registry slash commands even when the session has no metadata', async () => {
        storage.setState({ sessions: { s1: { metadata: undefined } } } as any);
        const { getAllCommands } = await import('./suggestionCommands');
        const commands = getAllCommands('s1');
        expect(commands.some((c) => c.command === 'h.review')).toBe(true);
        expect(commands.some((c) => c.command === 'clear')).toBe(true);
    });

    it('omits disabled UI action-registry slash commands', async () => {
        storage.setState({
            sessions: { s1: { metadata: undefined } },
            settings: { actionsSettingsV1: { v: 1, disabledActionIds: ['review.start'] } },
        } as any);
        const { getAllCommands } = await import('./suggestionCommands');
        const commands = getAllCommands('s1');
        expect(commands.some((c) => c.command === 'h.review')).toBe(false);
        expect(commands.some((c) => c.command === 'clear')).toBe(true);
    });

    it('dedupes action-registry slash commands against session-provided commands', async () => {
        storage.setState({
            sessions: {
                s1: {
                    metadata: {
                        slashCommands: ['h.review'],
                    },
                },
            },
        } as any);

        const { getAllCommands } = await import('./suggestionCommands');
        const commands = getAllCommands('s1').filter((c) => c.command === 'h.review');
        expect(commands.length).toBe(1);
    });
});
