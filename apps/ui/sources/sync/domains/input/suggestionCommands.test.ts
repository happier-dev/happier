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
            settings: { experiments: true, featureToggles: { 'execution.runs': true, 'pets.companion': true } },
        } as any);
        const { getAllCommands } = await import('./suggestionCommands');
        const commands = getAllCommands('s1');
        expect(commands.some((c) => c.command === 'review')).toBe(true);
        expect(commands.some((c) => c.command === 'h.review')).toBe(true);
        expect(commands.some((c) => c.command === 'pet')).toBe(true);
        expect(commands.some((c) => c.command === 'h.pet')).toBe(true);
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
                actionsSettingsV1: { v: 1, actions: { 'review.start': { disabledSurfaces: ['ui'] } } },
            },
        } as any);
        const { getAllCommands } = await import('./suggestionCommands');
        const commands = getAllCommands('s1');
        expect(commands.some((c) => c.command === 'review')).toBe(false);
        expect(commands.some((c) => c.command === 'h.review')).toBe(false);
        expect(commands.some((c) => c.command === 'clear')).toBe(true);
    });

    it('keeps goal available as a built-in slash command before session metadata loads', async () => {
        storage.setState({
            sessions: { s1: { metadata: undefined } },
            settings: { experiments: false, featureToggles: {} },
        } as any);
        const { searchCommands } = await import('./suggestionCommands');
        const commands = await searchCommands('s1', 'go');
        expect(commands.some((c) => c.command === 'goal')).toBe(true);
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

    it('includes built-in prompt commands when the session has no metadata', async () => {
        storage.setState({
            sessions: {},
            settings: { experiments: false, featureToggles: {} },
        } as any);

        const { getAllCommands } = await import('./suggestionCommands');
        const commands = getAllCommands('__new_session__');
        expect(commands.some((c) => c.command === 'happier-diagnose')).toBe(true);
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

    it('keeps one deterministic qualified row per contributed Action when several raw aliases collide', async () => {
        const directReview = {
            identity: { pluginId: 'acme.alpha', localId: 'review' },
            qualifiedActionId: 'acme.alpha/review',
            title: 'Run Alpha review',
            description: 'Review the current workspace with Alpha.',
            icon: null,
            priority: 0,
            placement: 'primary' as const,
            scope: 'session' as const,
            scopes: ['session'] as const,
            slash: { tokens: ['/review', '/review-alias'] },
            inputHints: null,
            kind: 'direct' as const,
        };
        const formReview = {
            identity: { pluginId: 'acme.beta', localId: 'configure' },
            qualifiedActionId: 'acme.beta/configure',
            title: 'Configure Beta',
            description: 'Choose options for Beta.',
            icon: null,
            priority: 0,
            placement: 'secondary' as const,
            scope: 'session' as const,
            scopes: ['session'] as const,
            slash: { tokens: ['/review', '/review-alias'] },
            inputHints: {
                fields: [{ path: 'depth', title: 'Depth', widget: 'integer' as const }],
            },
            kind: 'form' as const,
        };
        const nativeCollision = {
            identity: { pluginId: 'acme.clear', localId: 'clear' },
            qualifiedActionId: 'acme.clear/clear',
            title: 'Clear through Acme',
            description: null,
            icon: null,
            priority: 0,
            placement: 'primary' as const,
            scope: 'session' as const,
            scopes: ['session'] as const,
            slash: { tokens: ['/clear'] },
            inputHints: null,
            kind: 'direct' as const,
        };
        const uniqueAction = {
            identity: { pluginId: 'acme.launch', localId: 'launch' },
            qualifiedActionId: 'acme.launch/launch',
            title: 'Launch Acme',
            description: null,
            icon: null,
            priority: 0,
            placement: 'primary' as const,
            scope: 'session' as const,
            scopes: ['session'] as const,
            slash: { tokens: ['/launch'] },
            inputHints: null,
            kind: 'direct' as const,
        };
        const mixedAliasesAction = {
            identity: { pluginId: 'acme.mixed', localId: 'run' },
            qualifiedActionId: 'acme.mixed/run',
            title: 'Run mixed aliases',
            description: null,
            icon: null,
            priority: 0,
            placement: 'primary' as const,
            scope: 'session' as const,
            scopes: ['session'] as const,
            // The unique alias sorts first. A row whose display name depends on
            // the first alias would wrongly expose `alpha-review` instead of
            // the stable qualified spelling once `/review` collides.
            slash: { tokens: ['/review', '/alpha-review'] },
            inputHints: null,
            kind: 'direct' as const,
        };
        const contributedActions = [
            directReview,
            formReview,
            nativeCollision,
            uniqueAction,
            mixedAliasesAction,
        ];

        storage.setState({
            sessions: { s1: { metadata: undefined } },
            settings: { experiments: false, featureToggles: {} },
        } as any);

        const { searchCommands } = await import('./suggestionCommands');
        // The picker receives controller-admitted Actions as one source beside
        // native commands and prompt invocations; they must not become a second
        // command registry or lose their exact Action identity during search.
        const options = { limit: 100, contributedActions };
        const commands = await searchCommands('s1', '', options);
        const actionRows = commands.filter((command) => command.pluginContributedAction);

        expect(actionRows.map((command) => ({
            command: command.command,
            key: command.key,
            searchTerms: command.searchTerms,
            action: command.pluginContributedAction,
        }))).toEqual([
            {
                command: 'acme.alpha/review',
                key: 'plugin-action:acme.alpha/review',
                searchTerms: ['review', 'review-alias', 'acme.alpha/review'],
                action: directReview,
            },
            {
                command: 'acme.beta/configure',
                key: 'plugin-action:acme.beta/configure',
                searchTerms: ['review', 'review-alias', 'acme.beta/configure'],
                action: formReview,
            },
            {
                command: 'acme.clear/clear',
                key: 'plugin-action:acme.clear/clear',
                searchTerms: ['clear', 'acme.clear/clear'],
                action: nativeCollision,
            },
            {
                command: 'launch',
                key: 'plugin-action:acme.launch/launch',
                searchTerms: ['launch', 'acme.launch/launch'],
                action: uniqueAction,
            },
            {
                command: 'acme.mixed/run',
                key: 'plugin-action:acme.mixed/run',
                searchTerms: ['alpha-review', 'review', 'acme.mixed/run'],
                action: mixedAliasesAction,
            },
        ]);
        // The contributor never wins a registration-order race against the
        // incumbent native handler.
        expect(commands.filter((command) => command.command === 'clear')).toHaveLength(1);

        // Qualification changes the displayed spelling, not the declared token
        // users type. This distinguishes the correct picker implementation from
        // one that preserves a collision row but makes it undiscoverable.
        const reviewMatches = await searchCommands('s1', 'review', options);
        expect(reviewMatches.filter((command) => command.pluginContributedAction).map(
            (command) => command.pluginContributedAction?.qualifiedActionId,
        )).toContain('acme.beta/configure');

        const aliasMatches = await searchCommands('s1', 'review-alias', options);
        expect(aliasMatches.filter((command) => command.pluginContributedAction).map(
            (command) => command.pluginContributedAction?.qualifiedActionId,
        )).toEqual(expect.arrayContaining([
            'acme.alpha/review',
            'acme.beta/configure',
        ]));

        const uniqueAliasMatches = await searchCommands('s1', 'alpha-review', options);
        expect(uniqueAliasMatches.filter((command) => command.pluginContributedAction).map(
            (command) => command.pluginContributedAction?.qualifiedActionId,
        )).toContain('acme.mixed/run');
    });
});
