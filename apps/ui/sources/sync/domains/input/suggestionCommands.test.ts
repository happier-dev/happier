import { afterEach, describe, expect, it } from 'vitest';

import { storage } from '../state/storage';

describe('suggestionCommands', () => {
    afterEach(() => {
        // Keep tests isolated; reset to an empty-ish state.
        storage.setState({ sessions: {} } as any);
    });

    it('includes UI action-registry slash commands even when the session has no metadata', async () => {
        storage.setState({
            sessions: { s1: { metadata: undefined } },
            settings: { experiments: true, featureToggles: { 'execution.runs': true } },
        } as any);
        const { getAllCommands } = await import('./suggestionCommands');
        const commands = getAllCommands('s1');
        expect(commands.some((c) => c.command === 'review')).toBe(true);
        expect(commands.some((c) => c.command === 'h.review')).toBe(true);
        expect(commands.some((c) => c.command === 'clear')).toBe(true);
    });

    it('omits execution-run slash commands when the execution runs feature is disabled', async () => {
        storage.setState({
            sessions: { s1: { metadata: undefined } },
            settings: { experiments: false, featureToggles: {} },
        } as any);
        const { getAllCommands } = await import('./suggestionCommands');
        const commands = getAllCommands('s1');
        expect(commands.some((c) => c.command === 'review')).toBe(false);
        expect(commands.some((c) => c.command === 'h.review')).toBe(false);
        expect(commands.some((c) => c.command === 'h.plan')).toBe(false);
        expect(commands.some((c) => c.command === 'h.delegate')).toBe(false);
        expect(commands.some((c) => c.command === 'clear')).toBe(true);
    });

    it('omits disabled UI action-registry slash commands', async () => {
        storage.setState({
            sessions: { s1: { metadata: undefined } },
            settings: {
                experiments: true,
                featureToggles: { 'execution.runs': true },
                actionsSettingsV1: { v: 1, actions: { 'review.start': { disabledSurfaces: ['ui_slash_command'] } } },
            },
        } as any);
        const { getAllCommands } = await import('./suggestionCommands');
        const commands = getAllCommands('s1');
        expect(commands.some((c) => c.command === 'review')).toBe(false);
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
            settings: { experiments: true, featureToggles: { 'execution.runs': true } },
        } as any);

        const { getAllCommands } = await import('./suggestionCommands');
        const commands = getAllCommands('s1').filter((c) => c.command === 'h.review');
        expect(commands.length).toBe(1);
    });

    it('includes configured prompt template invocations', async () => {
        storage.setState({
            sessions: { s1: { metadata: undefined } },
            settings: {
                experiments: true,
                featureToggles: { 'execution.runs': true },
                promptInvocationsV1: {
                    v: 1,
                    entries: [
                        {
                            id: 't1',
                            token: '/foo',
                            title: 'Foo template',
                            target: { kind: 'doc', artifactId: 'a1' },
                            behavior: 'insert',
                            allowArgs: true,
                            availableIn: 'global',
                        },
                    ],
                },
            },
        } as any);

        const { getAllCommands } = await import('./suggestionCommands');
        const commands = getAllCommands('s1');
        expect(commands.some((c) => c.command === 'foo')).toBe(true);
    });

    it('dedupes prompt template tokens against existing action/default commands', async () => {
        storage.setState({
            sessions: { s1: { metadata: undefined } },
            settings: {
                experiments: true,
                featureToggles: { 'execution.runs': true },
                promptInvocationsV1: {
                    v: 1,
                    entries: [
                        {
                            id: 't1',
                            token: '/clear',
                            title: 'Clear template',
                            target: { kind: 'doc', artifactId: 'a1' },
                            behavior: 'insert',
                            allowArgs: false,
                            availableIn: 'global',
                        },
                        {
                            id: 't2',
                            token: '/h.review',
                            title: 'Review template',
                            target: { kind: 'doc', artifactId: 'a2' },
                            behavior: 'insert',
                            allowArgs: true,
                            availableIn: 'global',
                        },
                    ],
                },
            },
        } as any);

        const { getAllCommands } = await import('./suggestionCommands');
        const commands = getAllCommands('s1');
        expect(commands.filter((c) => c.command === 'clear').length).toBe(1);
        expect(commands.filter((c) => c.command === 'h.review').length).toBe(1);
    });
});
