import { afterEach, describe, expect, it } from 'vitest';

import { storage } from '../state/storage';
import { t } from '@/text';

describe('suggestionCommands', () => {
    afterEach(() => {
        // Keep tests isolated; reset to an empty-ish state.
        storage.setState({ sessions: {} } as any);
    });

    it('merges pre-session native commands with provider commands while preserving local built-in and template precedence', async () => {
        storage.setState({ sessions: {}, settings: { promptInvocationsV1: { v: 1, entries: [{
            id: 'local-template', token: '/template', title: 'Local template',
            target: { kind: 'doc', artifactId: 'local-doc' }, behavior: 'insert', allowArgs: false, availableIn: 'global',
        }] } } } as any);
        const { searchCommands } = await import('./suggestionCommands');
        const nativeCommands = [
            { command: 'project-check', description: 'Check this project' },
            { command: 'init', description: 'Initialize this project' },
            { command: 'template', description: 'Provider template' },
            { command: 'clear', description: 'Provider clear' },
            { command: 'memory', description: 'Open project memory' },
        ];

        expect(await searchCommands(null, 'project-check', { nativeCommands }))
            .toEqual([{ command: 'project-check', description: 'Check this project' }]);
        const commands = await searchCommands(null, '', { nativeCommands, limit: 100 });
        expect(commands.filter((command) => command.command === 'clear')).toEqual([
            { command: 'clear', description: 'Clear the conversation' },
        ]);
        expect(commands.filter((command) => command.command === 'init')).toEqual([
            { command: 'init', description: 'Initialize this project' },
        ]);
        expect(commands.filter((command) => command.command === 'template')).toEqual([
            expect.objectContaining({ command: 'template', description: 'Local template', promptInvocation: expect.any(Object) }),
        ]);
        expect(commands.filter((command) => command.command === 'memory')).toEqual([
            { command: 'memory', description: 'Open project memory' },
        ]);
        storage.setState({ sessions: { live: { metadata: { slashCommandDetails: nativeCommands } } } } as any);
        const liveCommands = await searchCommands('live', '', { limit: 100 });
        expect(liveCommands).toEqual(commands);

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
        expect(commands.find((c) => c.command === 'pet')?.description).toBe(t('commandPalette.pets.chooseSubtitle'));
        expect(commands.find((c) => c.command === 'h.pet')?.description).toBe(t('commandPalette.pets.chooseSubtitle'));
        expect(commands.find((c) => c.command === 'goal')?.description).toBe(t('session.workState.commandDescription'));
        expect(commands.some((c) => c.command === 'clear')).toBe(true);
    });

    it('omits execution-run slash commands when the execution runs feature is disabled', async () => {
        storage.setState({
            sessions: { s1: { metadata: undefined } },
            settings: { experiments: false, featureToggles: { 'execution.runs': false } },
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
        expect(commands.find((c) => c.command === 'foo')).toMatchObject({
            command: 'foo',
            promptInvocation: {
                invocationId: 't1',
                token: '/foo',
                targetArtifactId: 'a1',
                behavior: 'insert',
                allowArgs: true,
            },
        });
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
