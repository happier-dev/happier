import { describe, expect, it, vi } from 'vitest';

// Locale is an environment boundary; section ownership and activation remain real.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import type { SelectionListDynamicSection, SelectionListSectionDescriptor } from '@/components/ui/selectionList';

import {
    buildUniversalSearchSections,
    type BuildUniversalSearchSectionsInput,
} from './buildUniversalSearchSections';
import { buildUniversalSearchScopeKey } from './universalSearchResult';
import type { UniversalSearchResult } from './universalSearchResult';

function input(
    overrides: Partial<BuildUniversalSearchSectionsInput> = {},
): BuildUniversalSearchSectionsInput {
    return {
        query: '',
        commands: [],
        sessions: [],
        projects: [],
        searchSettingsPages: () => [],
        transcript: { status: 'absent' },
        files: { status: 'absent' },
        commits: { status: 'absent' },
        pluginSections: [],
        onCommitResult: () => {},
        ...overrides,
    };
}

function dynamicSections(
    sections: ReadonlyArray<SelectionListSectionDescriptor>,
): ReadonlyArray<SelectionListDynamicSection> {
    return sections.filter((section): section is SelectionListSectionDescriptor & SelectionListDynamicSection & { kind: 'dynamic' } => (
        section.kind === 'dynamic'
    ));
}

function sessionEntity(id: string, updatedAt: number, serverId = 'home-a') {
    return { sessionId: id, serverId, accountId: `account-${serverId}`, title: `Session ${id}`, updatedAt };
}

function staticOptionIds(
    sections: ReadonlyArray<SelectionListSectionDescriptor>,
    id: string,
): readonly string[] {
    const section = sections.find((candidate) => candidate.id === id);
    return section && 'options' in section ? section.options.map((option) => option.id) : [];
}

describe('buildUniversalSearchSections', () => {
    it('offers text-in-files for one character with a non-activatable refinement hint for an incomplete page', async () => {
        const source = {
            status: 'ready' as const,
            resolverKey: 'workspace-content',
            resolve: async () => ({ results: [], hasMore: true }),
        };
        const sections = buildUniversalSearchSections(input({
            query: 'needle',
            source: 'fileContent',
            fileContent: source,
        }));
        expect(sections.map((section) => section.id)).toEqual(['fileContent']);
        const content = dynamicSections(sections)[0]!;
        expect(content.visibleWhen?.('')).toBe(false);
        expect(content.visibleWhen?.('n')).toBe(true);
        expect(content.visibleWhen?.(' ')).toBe(true);
        expect(content.visibleWhen?.('ne')).toBe(true);
        expect(content.visibleWhen?.(' a')).toBe(true);
        const page = await content.resolve('needle', new AbortController().signal);
        expect(page.options).toHaveLength(0);
        expect(page.resultHint).toBe('universalSearch.content.refineSearch');
        const unavailable = dynamicSections(buildUniversalSearchSections(input({
            source: 'fileContent', fileContent: { status: 'unavailable', resolverKey: 'offline', hint: 'unavailable' },
        })))[0]!;
        expect(unavailable.visibleWhen?.('n')).toBe(true);
    });

    it('keeps multiple content hits grouped by file and preserves literal query whitespace', async () => {
        const resolve = vi.fn(async (_query: string) => ({
            results: [4, 9].map((line) => ({
                id: `src/a.ts:${line}:2`,
                sourceId: 'fileContent', scopeKey: 'exact-workspace', kind: 'workspaceFile',
                title: `src/a.ts:${line}`, subtitle: ' literal ',
                fileContent: { path: 'src/a.ts', line, column16: 2, length16: 9, text: '  literal ', before: ['before'], after: ['after'] },
                target: {
                    kind: 'workspaceFile' as const,
                    scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' },
                    path: 'src/a.ts', workspaceRefId: 'workspace-a', sessionId: null,
                    serverId: 'home-a', accountId: 'account-a',
                    anchor: { kind: 'fileLine' as const, startLine: line },
                },
            })),
        }));
        const commit = vi.fn();
        const sections = buildUniversalSearchSections(input({
            query: ' literal ',
            fileContent: { status: 'ready', resolverKey: 'scope-a', resolve },
            onCommitResult: commit,
        }));
        const content = dynamicSections(sections).find((section) => section.id === 'fileContent')!;
        expect(content).toBeDefined();
        const page = await content.resolve(' literal ', new AbortController().signal);
        // Each hit names its file and line (Find lab G1: `path:line`); the head ellipsizes so the file name stays.
        expect(page.options.map((option) => option.label)).toEqual(['src/a.ts:4', 'src/a.ts:9']);
        expect(page.options.map((option) => option.labelEllipsizeMode)).toEqual(['head', 'head']);
        expect(page.options[1]?.accessibilityLabel).toContain('src/a.ts:9');
        expect(resolve.mock.calls[0]?.[0]).toBe(' literal ');
        expect(page.options.map((option) => option.id)).toEqual([
            'fileContent::exact-workspace::src/a.ts:4:2', 'fileContent::exact-workspace::src/a.ts:9:2',
        ]);
        expect(page.options[0]?.subtitleContent).toBeDefined();
        page.options[1]?.onSelect?.();
        expect(commit).toHaveBeenCalledWith(expect.objectContaining({
            target: expect.objectContaining({ anchor: { kind: 'fileLine', startLine: 9 } }),
        }));
    });
    it('names the line a `path:line` file hit opens at', async () => {
        const target = {
            kind: 'workspaceFile' as const,
            scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' },
            path: 'src/settings/SettingsModal.tsx', workspaceRefId: null, sessionId: null,
            serverId: 'home-a', accountId: 'account-a',
        };
        const results: UniversalSearchResult[] = [
            { id: 'a', sourceId: 'files', scopeKey: 'ws', kind: 'workspaceFile', title: 'SettingsModal.tsx', subtitle: 'src/settings', target: { ...target, anchor: { kind: 'fileLine', startLine: 23 } } },
            { id: 'b', sourceId: 'files', scopeKey: 'ws', kind: 'workspaceFile', title: 'Other.tsx', subtitle: 'src/settings', target: { ...target, path: 'src/settings/Other.tsx' } },
        ];
        const sections = buildUniversalSearchSections(input({
            query: 'SettingsModal.tsx:23',
            files: { status: 'ready', resolverKey: 'ws', resolve: async () => results },
        }));
        const files = dynamicSections(sections).find((section) => section.id === 'files')!;
        const page = await files.resolve('SettingsModal.tsx:23', new AbortController().signal);
        expect(page.options.map((option) => option.label)).toEqual(['SettingsModal.tsx:23', 'Other.tsx']);
    });
    it('offers external conversation search only as an explicit activation for the machine in scope', () => {
        const onSearch = vi.fn();
        const base = {
            externalConversationSearch: { machineLabel: 'Work machine', onSearch },
        };
        expect(buildUniversalSearchSections(input(base)).some((section) => section.id === 'externalConversations')).toBe(false);
        const sections = buildUniversalSearchSections(input({ ...base, query: 'body-only phrase' }));
        const section = sections.find((entry) => entry.id === 'externalConversations');
        expect(section).toMatchObject({ kind: 'static', options: [expect.objectContaining({ id: 'external-conversations:search' })] });
        expect(onSearch).not.toHaveBeenCalled();
        if (!section || section.kind !== 'static') throw new Error('Missing explicit conversation search row');
        section.options[0]!.onSelect?.();
        expect(onSearch).toHaveBeenCalledWith('body-only phrase');
    });

    it('projects complete-inventory progress and failure through the real Sessions section', () => {
        const loading = buildUniversalSearchSections(input({
            query: 'missing session',
            sessionInventoryStatus: 'loading',
        })).find((section) => section.id === 'sessions');
        expect(loading).toMatchObject({
            kind: 'static',
            options: [],
            resultHint: expect.any(String),
        });

        const failed = buildUniversalSearchSections(input({
            query: 'missing session',
            sessionInventoryStatus: 'error',
        })).find((section) => section.id === 'sessions');
        expect(failed).toMatchObject({
            kind: 'static',
            options: [],
            resultHint: expect.any(String),
        });
        expect(failed && 'resultHint' in failed ? failed.resultHint : undefined)
            .not.toBe(loading && 'resultHint' in loading ? loading.resultHint : undefined);
    });

    it('uses start ellipsis for project and file path subtitles', async () => {
        const sections = buildUniversalSearchSections(input({
            query: 'repo',
            projects: [{
                workspaceRefId: 'workspace-a',
                serverId: 'home-a',
                accountId: 'account-a',
                machineId: 'machine-a',
                rootPath: '/very/long/path/to/repository',
                title: 'Repository',
                subtitle: '/very/long/path/to/repository',
                lastOpenedAtMs: 1,
            }],
            files: {
                status: 'ready',
                resolverKey: 'workspace-a',
                resolve: async () => [{
                    id: 'src/deep/file.ts',
                    scopeKey: buildUniversalSearchScopeKey(['home-a', 'machine-a', '/repo']),
                    sourceId: 'files',
                    kind: 'workspaceFile',
                    title: 'file.ts',
                    subtitle: 'src/deep/file.ts',
                    target: {
                        kind: 'workspaceFile',
                        scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' },
                        path: 'src/deep/file.ts',
                        workspaceRefId: 'workspace-a',
                        sessionId: null,
                        serverId: 'home-a',
                        accountId: 'account-a',
                    },
                }],
            },
        }));

        const projects = sections.find((section) => section.id === 'projects');
        expect(projects?.kind).toBe('static');
        if (!projects || projects.kind !== 'static') throw new Error('Projects section missing');
        expect(projects.options[0]?.subtitleEllipsizeMode).toBe('head');

        const files = dynamicSections(sections).find((section) => section.id === 'files');
        const resolvedFiles = await files!.resolve('repo', new AbortController().signal);
        expect(resolvedFiles.options[0]?.subtitleEllipsizeMode).toBe('head');
    });

    it('issues no remote request on an empty query: every corpus section is gated off', () => {
        const transcriptResolve = vi.fn(async () => []);
        const filesResolve = vi.fn(async () => []);
        const commitsResolve = vi.fn(async () => []);
        const sections = buildUniversalSearchSections(input({
            query: '',
            transcript: { status: 'ready', resolverKey: 'home-a', resolve: transcriptResolve },
            files: { status: 'ready', resolverKey: 'ws', resolve: filesResolve },
            commits: { status: 'ready', resolverKey: 'ws', resolve: commitsResolve },
        }));

        for (const section of dynamicSections(sections)) {
            expect(section.visibleWhen?.('')).toBe(false);
            expect(section.visibleWhen?.('   ')).toBe(false);
            expect(section.visibleWhen?.('needle')).toBe(true);
        }
        expect(transcriptResolve).not.toHaveBeenCalled();
        expect(filesResolve).not.toHaveBeenCalled();
        expect(commitsResolve).not.toHaveBeenCalled();
    });

    it('bounds empty-query local recents and offers the complete candidate set to the host matcher once a query is typed', () => {
        const sessions = Array.from({ length: 25 }, (_, index) => ({
            ...sessionEntity(`s${index}`, index),
            title: index === 24 ? 'Exact hidden needle' : `Unrelated session ${index}`,
        }));

        const empty = buildUniversalSearchSections(input({ query: '', sessions }));
        const emptySection = empty.find((section) => section.id === 'sessions');
        expect(emptySection?.kind).toBe('static');
        expect(emptySection && 'options' in emptySection ? emptySection.options.length : -1).toBe(5);

        const typed = buildUniversalSearchSections(input({ query: 'Exact hidden needle', sessions }));
        const typedSection = typed.find((section) => section.id === 'sessions');
        expect(typedSection && 'options' in typedSection ? typedSection.options.length : -1).toBe(25);
        expect(typedSection && 'options' in typedSection
            ? typedSection.options.some((option) => option.label === 'Exact hidden needle')
            : false).toBe(true);

        const projects = Array.from({ length: 25 }, (_, index) => ({
            workspaceRefId: `wr-${index}`,
            serverId: 'home-a',
            accountId: 'account-a',
            machineId: 'machine-a',
            rootPath: `/repo/${index}`,
            title: index === 24 ? 'Exact project needle' : `Unrelated project ${index}`,
            lastOpenedAtMs: index,
        }));
        const typedProjects = buildUniversalSearchSections(input({
            query: 'Exact project needle',
            projects,
        }));
        const projectSection = typedProjects.find((section) => section.id === 'projects');
        expect(projectSection && 'options' in projectSection ? projectSection.options.length : -1).toBe(25);
        expect(projectSection && 'options' in projectSection
            ? projectSection.options.some((option) => option.label === 'Exact project needle')
            : false).toBe(true);
    });

    it('presents recent sessions only through the canonical Session section for empty and typed queries', () => {
        const recentCommand = {
            id: 'session-s1',
            kind: 'recentSession' as const,
            title: 'Recent session',
            category: 'Recent Sessions',
            action: () => {},
        };
        const empty = buildUniversalSearchSections(input({
            commands: [recentCommand],
            sessions: [sessionEntity('s1', 1)],
        }));
        expect(empty.flatMap((section) => 'options' in section ? section.options : [])
            .filter((option) => option.label === 'Recent session')).toHaveLength(0);
        expect(staticOptionIds(empty, 'sessions')).toHaveLength(1);

        const typed = buildUniversalSearchSections(input({
            query: 'Recent session',
            commands: [recentCommand],
            sessions: [sessionEntity('s1', 1)],
        }));
        const typedOptions = typed.flatMap((section) => 'options' in section ? section.options : []);
        expect(typedOptions.some((option) => option.id === 'command:session-s1')).toBe(false);
        expect(staticOptionIds(typed, 'sessions')).toHaveLength(1);
    });

    it('shows only intentionally suggested commands before a query, then exposes the full command catalog', () => {
        const commands = Array.from({ length: 8 }, (_, index) => ({
            id: `command-${index}`,
            title: `Command ${index}`,
            category: 'Commands',
            ...(index < 6 ? { emptyQuerySuggested: true } : {}),
            action: () => {},
        }));

        const empty = buildUniversalSearchSections(input({ commands }));
        const emptyCommandIds = empty.flatMap((section) => 'options' in section ? section.options : [])
            .filter((option) => option.id.startsWith('command:'))
            .map((option) => option.id);
        expect(emptyCommandIds).toEqual(commands.slice(0, 6).map((command) => `command:${command.id}`));

        const typed = buildUniversalSearchSections(input({ query: 'command', commands }));
        const typedCommandIds = typed.flatMap((section) => 'options' in section ? section.options : [])
            .filter((option) => option.id.startsWith('command:'))
            .map((option) => option.id);
        expect(typedCommandIds).toEqual(commands.map((command) => `command:${command.id}`));
    });

    it('preserves provider order for corpus sections instead of re-running the host matcher', async () => {
        const results: UniversalSearchResult[] = [
            {
                id: 'm1',
                scopeKey: buildUniversalSearchScopeKey(['home-b']),
                sourceId: 'transcript',
                kind: 'message',
                // Deliberately does NOT contain the query: an FTS/semantic hit
                // whose displayed label lacks the literal term must survive.
                title: 'Deployment postmortem',
                target: { kind: 'session', sessionId: 'sess-1', serverId: 'home-b', accountId: 'account-b', seq: 42 },
            },
        ];
        const sections = buildUniversalSearchSections(input({
            query: 'rollback',
            transcript: { status: 'ready', resolverKey: 'home-b', resolve: async () => results },
        }));
        const transcript = dynamicSections(sections).find((section) => section.id === 'transcript');
        expect(transcript?.resultFiltering).toBe('provider');

        const resolved = await transcript!.resolve('rollback', new AbortController().signal);
        expect(resolved.options).toHaveLength(1);
        expect(resolved.options[0]?.id)
            .toBe(`transcript::${buildUniversalSearchScopeKey(['home-b'])}::m1`);
    });

    it('projects a source-owned bounded-coverage hint through the canonical section status', async () => {
        const sections = buildUniversalSearchSections(input({
            query: 'older work',
            transcript: {
                status: 'ready',
                resolverKey: 'daemon:home-a:machine-a',
                resultHint: 'Local memory storage limits can make older coverage partial.',
                resolve: async () => [],
            },
        }));

        const transcript = dynamicSections(sections).find((section) => section.id === 'transcript');
        const resolved = await transcript!.resolve('older work', new AbortController().signal);
        expect(resolved.resultHint)
            .toBe('Local memory storage limits can make older coverage partial.');
    });

    it('namespaces option ids by source so two providers cannot collide on the same row id', async () => {
        const sections = buildUniversalSearchSections(input({
            query: 'x',
            transcript: {
                status: 'ready',
                resolverKey: 'home-a',
                resolve: async () => [{
                    id: '1',
                    scopeKey: buildUniversalSearchScopeKey(['home-a']),
                    sourceId: 'transcript',
                    kind: 'message',
                    title: 'Transcript one',
                    target: { kind: 'session', sessionId: 's', serverId: 'home-a', accountId: 'account-a' },
                }],
            },
            files: {
                status: 'ready',
                resolverKey: 'ws',
                resolve: async () => [{
                    id: '1',
                    scopeKey: buildUniversalSearchScopeKey(['home-a', 'm', '/repo']),
                    sourceId: 'files',
                    kind: 'file',
                    title: 'File one',
                    target: {
                        kind: 'workspaceFile',
                        scope: { serverId: 'home-a', machineId: 'm', rootPath: '/repo' },
                        path: 'a.ts',
                        workspaceRefId: null,
                        sessionId: 's',
                        serverId: 'home-a',
                        accountId: 'account-a',
                    },
                }],
            },
        }));
        const signal = new AbortController().signal;
        const byId = dynamicSections(sections);
        const transcript = await byId.find((s) => s.id === 'transcript')!.resolve('x', signal);
        const files = await byId.find((s) => s.id === 'files')!.resolve('x', signal);
        expect(transcript.options[0]?.id).not.toBe(files.options[0]?.id);
    });

    it('binds an unavailable source to a truthful empty hint, never an activatable row or an error', async () => {
        const sections = buildUniversalSearchSections(input({
            query: 'anything',
            transcript: { status: 'unavailable', resolverKey: 'home-a|indexing', hint: 'Still indexing' },
        }));
        const transcript = dynamicSections(sections).find((section) => section.id === 'transcript');
        expect(transcript).toBeDefined();
        const resolved = await transcript!.resolve('anything', new AbortController().signal);
        expect(resolved.options).toHaveLength(0);
        expect(resolved.emptyHint).toBe('Still indexing');
    });

    it('omits an absent source entirely rather than rendering an empty group for it', () => {
        const sections = buildUniversalSearchSections(input({ query: 'q', files: { status: 'absent' } }));
        expect(sections.some((section) => section.id === 'files')).toBe(false);
    });

    it('keys sensitive resolvers by their target so a superseded scope cannot replay cached rows', () => {
        const build = (accountScope: string) => dynamicSections(buildUniversalSearchSections(input({
            query: 'q',
            transcript: {
                status: 'ready',
                resolverKey: `${accountScope}|home-a`,
                resolve: async () => [],
            },
        }))).find((section) => section.id === 'transcript')?.resolverKey;

        expect(build('account-1')).not.toBe(build('account-2'));
    });

    it('records the selected identity without navigating, so the surface owns dismiss-then-activate', async () => {
        const onCommitResult = vi.fn();
        const sections = buildUniversalSearchSections(input({
            query: 'x',
            onCommitResult,
            files: {
                status: 'ready',
                resolverKey: 'ws',
                resolve: async () => [{
                    id: 'a.ts',
                    scopeKey: buildUniversalSearchScopeKey(['home-a', 'm', '/repo']),
                    sourceId: 'files',
                    kind: 'file',
                    title: 'a.ts',
                    target: {
                        kind: 'workspaceFile',
                        scope: { serverId: 'home-a', machineId: 'm', rootPath: '/repo' },
                        path: 'a.ts',
                        workspaceRefId: null,
                        sessionId: 'sess',
                        serverId: 'home-a',
                        accountId: 'account-a',
                    },
                }],
            },
        }));
        const files = dynamicSections(sections).find((section) => section.id === 'files')!;
        const resolved = await files.resolve('x', new AbortController().signal);
        resolved.options[0]?.onSelect?.();
        expect(onCommitResult).toHaveBeenCalledTimes(1);
        expect(onCommitResult.mock.calls[0]?.[0]?.target).toMatchObject({ kind: 'workspaceFile', path: 'a.ts' });
    });

    it('scopes local session row identity by Home, so the same session id on two Homes is two rows', () => {
        const homeA = buildUniversalSearchSections(input({
            query: 'session',
            sessions: [sessionEntity('sess-1', 1, 'home-a')],
        }));
        const homeB = buildUniversalSearchSections(input({
            query: 'session',
            sessions: [sessionEntity('sess-1', 1, 'home-b')],
        }));

        const idA = staticOptionIds(homeA, 'sessions')[0];
        const idB = staticOptionIds(homeB, 'sessions')[0];
        expect(idA).toBeDefined();
        expect(idA).not.toBe(idB);

        // Both Homes projected at once: two distinct rows, not one merged row.
        const both = buildUniversalSearchSections(input({
            query: 'session',
            sessions: [sessionEntity('sess-1', 1, 'home-a'), sessionEntity('sess-1', 2, 'home-b')],
        }));
        expect(new Set(staticOptionIds(both, 'sessions')).size).toBe(2);
    });

    it('drops a held selection on a target switch instead of retaining it onto another target\u2019s row', async () => {
        const buildFor = (scope: Readonly<{ serverId: string; machineId: string; rootPath: string }>) =>
            buildUniversalSearchSections(input({
                query: 'readme',
                files: {
                    status: 'ready',
                    resolverKey: `${scope.serverId}|${scope.machineId}|${scope.rootPath}`,
                    resolve: async () => [{
                        id: 'README.md',
                        scopeKey: buildUniversalSearchScopeKey([
                            scope.serverId,
                            scope.machineId,
                            scope.rootPath,
                        ]),
                        sourceId: 'files',
                        kind: 'file',
                        title: 'README.md',
                        target: {
                            kind: 'workspaceFile',
                            scope,
                            path: 'README.md',
                            workspaceRefId: null,
                            sessionId: 'sess',
                            serverId: scope.serverId,
                            accountId: 'account-a',
                        },
                    }],
                },
            }));

        const signal = new AbortController().signal;
        const before = dynamicSections(buildFor({ serverId: 'home-a', machineId: 'm1', rootPath: '/a' }))
            .find((section) => section.id === 'files')!;
        const after = dynamicSections(buildFor({ serverId: 'home-a', machineId: 'm2', rootPath: '/b' }))
            .find((section) => section.id === 'files')!;

        const beforeRows = await before.resolve('readme', signal);
        const afterRows = await after.resolve('readme', signal);

        // Same repo-relative path in two checkouts is two identities, and the
        // resolver rebinding is what drops the superseded target's in-flight work.
        expect(beforeRows.options[0]?.id).not.toBe(afterRows.options[0]?.id);
        expect(before.resolverKey).not.toBe(after.resolverKey);
    });

    it('projects plugin provider sections through without adding host plugin policy', () => {
        const pluginSection: SelectionListDynamicSection = {
            id: 'plugin-search:acme:issues',
            title: 'Acme issues',
            resolverKey: 'plugin-search:acme:issues|gen-3',
            resultFiltering: 'provider',
            resolve: async () => ({ options: [] }),
        };
        const sections = buildUniversalSearchSections(input({ query: 'x', pluginSections: [pluginSection] }));
        const projected = dynamicSections(sections).find((section) => section.id === pluginSection.id);
        expect(projected?.resolverKey).toBe(pluginSection.resolverKey);
        expect(projected?.resultFiltering).toBe('provider');
        expect(projected?.showSkeletonsOnFirstLoad).toBe(true);
        expect(projected?.resultTransition).toBe('none');
    });

    it('uses truthful first-load status without applying directory-drill motion to typed queries', () => {
        const source = { status: 'ready' as const, resolverKey: 'target', resolve: async () => [] };
        const sections = buildUniversalSearchSections(input({
            query: 'needle',
            transcript: source,
            files: source,
            commits: source,
        }));
        const remote = dynamicSections(sections).filter((section) => (
            section.id === 'transcript'
            || section.id === 'files'
            || section.id === 'commits'
        ));

        expect(remote.length).toBeGreaterThan(0);
        for (const section of remote) {
            expect(section.showSkeletonsOnFirstLoad).toBe(true);
            expect(section.resultTransition).toBe('none');
        }
    });

    it('orders groups by what the user reaches for: recents first when empty, then commands, settings and sessions for a query', () => {
        const commands = [{
            id: 'new-session',
            emptyQuerySuggested: true,
            title: 'New session',
            category: 'Actions',
            action: () => {},
        }];
        const sessions = [sessionEntity('s1', 1)];
        const searchSettingsPages = () => [{ id: 'appearance', route: '/settings/appearance', title: 'New session defaults' }];

        const empty = buildUniversalSearchSections(input({ commands, sessions, searchSettingsPages }));
        expect(empty.map((section) => section.id)).toEqual(['sessions', 'commands:0']);

        const typed = buildUniversalSearchSections(input({ query: 'new', commands, sessions, searchSettingsPages }));
        expect(typed.map((section) => section.id)).toEqual(['commands:0', 'settings', 'sessions']);
    });
});
