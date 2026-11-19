import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderHook, renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { useSelectionListKeyboardNav, useSelectionListRovingFocus } from '@/components/ui/selectionList/useSelectionListKeyboardNav';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// Locale is an environment boundary; section ownership and activation remain real.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import type { SelectionListDynamicSection, SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import { PlanOptionRow } from '@/components/ui/selectionList/SelectionListOptionRow';

import {
    buildUniversalSearchSections,
    type BuildUniversalSearchSectionsInput,
} from './buildUniversalSearchSections';
import { buildUniversalSearchOptionId, buildUniversalSearchScopeKey } from './universalSearchResult';
import type { UniversalSearchResult } from './universalSearchResult';
import { describeConversationSearchCoverage } from './conversationSearchCoverage';
import { synthesizeSelectionListRenderPlan } from '@/components/ui/selectionList/SelectionListRenderPlan';

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
    it('keeps unchanged producer options across refinements while updating highlights and activation targets', async () => {
        const onCommitResult = vi.fn();
        const command = { id: 'release', title: 'Release', icon: 'file' as const, action: vi.fn() };
        const unmarked = { id: 'pin-tabs', title: 'Pin tabs', icon: 'file' as const, action: vi.fn() };
        const sessionRows = [{ ...sessionEntity('visible', 1), title: 'release' },
            { ...sessionEntity('hidden', 2), title: 'Alpha', searchText: 'release' }];
        const settings = [{ id: 'display', title: 'Display', route: '/settings/display' }];
        const base = input({ commands: [command, unmarked], sessions: sessionRows, searchSettingsPages: () => settings, onCommitResult });
        const before = buildUniversalSearchSections({ ...base, query: 'r' });
        const refined = { ...base, query: 're', previousSections: before };
        const after = buildUniversalSearchSections(refined);
        const rows = (sections: readonly SelectionListSectionDescriptor[]) => sections.flatMap(section =>
            section.kind === 'static' && section.id === 'sessions' ? section.options : []);
        expect(rows(after)[1]).toBe(rows(before)[1]);
        expect(rows(after)[0]).not.toBe(rows(before)[0]);
        expect(rows(after)[0]?.labelHighlightQuery).toBe('re');
        const commandRows = (sections: readonly SelectionListSectionDescriptor[]) => sections.flatMap(section =>
            section.kind === 'static' && section.id.startsWith('commands:') ? section.options : []);
        // A command whose name shows the query is redrawn with the new marks; one whose marks are unchanged is kept.
        expect(commandRows(after)[0]).not.toBe(commandRows(before)[0]);
        expect(commandRows(after)[0]?.labelHighlightQuery).toBe('re');
        expect(commandRows(after)[1]).toBe(commandRows(before)[1]);
        const settingsBefore = dynamicSections(before).find(section => section.id === 'settings')!;
        const first = await settingsBefore.resolve('r', new AbortController().signal);
        const settingsAfter = dynamicSections(after).find(section => section.id === 'settings')!;
        const second = await settingsAfter.resolve('re', new AbortController().signal, undefined, first.options);
        expect(second.options[0]).toBe(first.options[0]);
        const retargeted = { ...base, query: 're', previousSections: after,
            sessions: sessionRows.map(row => row.sessionId === 'hidden' ? { ...row, serverId: 'other-home' } : row) };
        const changed = buildUniversalSearchSections(retargeted);
        const changedRow = rows(changed)[1]!;
        expect(changedRow).not.toBe(rows(after)[1]);
        await changedRow.onSelect?.();
        expect(onCommitResult).toHaveBeenLastCalledWith(expect.objectContaining({
            target: expect.objectContaining({ sessionId: 'hidden', serverId: 'other-home' }),
        }));
    });

    it('materializes only requested quick-open options from 54,935 Changed files and keeps the last row activatable', async () => {
        let projectedTitles = 0;
        let projectedResults = 0;
        const changedFiles: UniversalSearchResult[] = Array.from({ length: 54_935 }, (_, index) => ({
            id: `src/file-${index}.ts`, scopeKey: 'workspace', sourceId: 'files', kind: 'workspaceFile',
            get title() { projectedTitles += 1; return `file-${index}.ts`; },
            target: { kind: 'workspaceFile', scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' },
                path: `src/file-${index}.ts`, workspaceRefId: 'workspace-a', sessionId: null, serverId: 'home-a', accountId: 'account-a' },
        }));
        const onCommitResult = vi.fn();
        const projection = buildUniversalSearchSections(input({ source: 'files', changedFiles, onCommitResult,
            changedFileSource: {
                count: changedFiles.length,
                getOptionId: index => {
                    const result = changedFiles[index]!;
                    return buildUniversalSearchOptionId(result.sourceId, result.scopeKey, result.id);
                },
                getResult: index => { projectedResults += 1; return changedFiles[index]!; },
            },
            filesStatusHint: 'offline' }), 'virtualized');
        expect(projectedTitles).toBe(0);
        expect(projectedResults).toBe(0);
        const source = projection.virtualizedOptionSource!;
        expect(projection.sections).toEqual([]);
        expect(source.optionCount).toBe(54_935);
        expect(source.getHeader(0).resultHint).toBe('offline');
        for (let index = 0; index < 12; index += 1) expect(source.getOption(index).label).toBe(`file-${index}.ts`);
        expect(projectedTitles).toBe(12);
        expect(projectedResults).toBe(12);
        const lastIndex = source.optionCount - 1;
        const lastId = source.getOptionId(lastIndex);
        expect(source.findOptionIndexById(lastId)).toBe(lastIndex);
        let structuralReads = 0;
        for (const item of source.items) {
            const kind = item.kind;
            Object.defineProperty(item, 'kind', { get: () => { structuralReads += 1; return kind; } });
        }
        expect(source.findItemIndexByOptionIndex(lastIndex)).toBe(source.items.length - 2);
        expect(structuralReads).toBe(0);
        expect(source.getNextFocusableOptionIndex(lastIndex - 1, 1)).toBe(lastIndex);
        const keyboard = await renderHook(() => {
            const params = { flatVisibleOptionIds: [], virtualizedOptionSource: source, inputValue: '' };
            const focus = useSelectionListRovingFocus(params);
            return useSelectionListKeyboardNav({ ...params, focus,
                onActivate: id => source.getOption(source.findOptionIndexById(id)).onSelect?.(),
                canPopStep: false, onPopStep: () => {}, onClearInput: () => {}, quickActionShortcuts: [] });
        });
        try {
            const event = (key: string) => ({ key, preventDefault: () => {}, stopPropagation: () => {} });
            await act(async () => { keyboard.getCurrent().handleKey(event('End')); });
            expect(keyboard.getCurrent().focusedOptionId).toBe(lastId);
            await act(async () => { keyboard.getCurrent().handleKey(event('Enter')); });
        } finally { await keyboard.unmount(); }
        expect(onCommitResult).toHaveBeenCalledWith(changedFiles[lastIndex]);
        const changed = [...changedFiles];
        changed[lastIndex] = { ...changedFiles[lastIndex]!, title: 'fresh.ts', fileChange: { added: 9, removed: 2 } };
        const refreshed = buildUniversalSearchSections(input({ source: 'files', changedFiles: changed }), 'virtualized');
        expect(refreshed.virtualizedOptionSource!.getOption(lastIndex).label).toBe('fresh.ts');
        expect(refreshed.virtualizedOptionSource!.getOption(lastIndex).rightAccessory).toBeDefined();
    });

    it('leaves Settings matching to the query resolver instead of rebuilding it for each result batch', async () => {
        const queries: string[] = [];
        const searchSettingsPages = (query: string) => {
            queries.push(query);
            return [{ id: 'appearance', route: '/settings/appearance', title: 'Appearance' }];
        };
        const builds = Array.from({ length: 4 }, (_, batch) => buildUniversalSearchSections(input({
            query: 'theme', searchSettingsPages, sessions: [sessionEntity(`arrival-${batch}`, batch)],
        })));
        expect(queries).toEqual([]);
        const settings = dynamicSections(builds[3]!).find(section => section.id === 'settings');
        expect(settings).toBeDefined();
        const page = await settings!.resolve('security', new AbortController().signal);
        expect(queries).toEqual(['security']);
        expect(page.options.map(option => option.label)).toEqual(['Appearance']);
        expect(settings?.resultFiltering).toBe('provider');
    });

    it('shows a Settings group only once the catalog has rows for the query, never an empty header while matching is pending', async () => {
        const sections = buildUniversalSearchSections(input({
            query: 'zzq',
            searchSettingsPages: (query) => query === 'theme'
                ? [{ id: 'appearance', route: '/settings/appearance', title: 'Appearance' }]
                : [],
        }));
        const settings = dynamicSections(sections).find(section => section.id === 'settings')!;
        const planFor = (state: Parameters<typeof synthesizeSelectionListRenderPlan>[0]['dynamicSectionStates'] extends ReadonlyMap<string, infer S> ? S : never) =>
            synthesizeSelectionListRenderPlan({
                sections, inputValue: 'zzq', filterQuery: 'zzq',
                dynamicSectionStates: new Map([['settings', state]]),
            }).find(section => section.id === 'settings');

        expect(planFor({ status: 'idle', options: [] })).toBeUndefined();
        expect(planFor({ status: 'loading', options: [], seed: 'zzq' })).toBeUndefined();
        const none = await settings.resolve('zzq', new AbortController().signal);
        expect(planFor({ status: 'success', seed: 'zzq', ...none })).toBeUndefined();

        const found = await settings.resolve('theme', new AbortController().signal);
        expect(planFor({ status: 'success', seed: 'theme', ...found })).toMatchObject({
            title: expect.any(String),
            options: [expect.objectContaining({ label: 'Appearance' })],
        });
    });

    it('consumes the existing unsaved symbol source and opens the committed outline row beside at its line', async () => {
        const { createWorkspaceSymbolSearchSource } = await import('./workspaceSymbolSearchSource');
        const { activateUniversalSearchResult } = await import('./activateUniversalSearchResult');
        let text = 'class SavedSymbol {}';
        const scope = { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' };
        const symbols = createWorkspaceSymbolSearchSource({
            target: { kind: 'workspaceFile', scope, path: 'src/a.ts', accountId: 'account-a',
                serverId: scope.serverId, workspaceRefId: 'workspace-a', sessionId: null },
            resolverKey: 'active-holder', language: 'typescript', isDark: false, unavailableHint: 'Unavailable',
            accountLifetime: { scope: { serverId: scope.serverId, accountId: 'account-a' },
                isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            isCurrent: () => true,
            getText: () => text,
            flushPendingChange: () => { text = '// unsaved\nclass LiveSymbol {}'; },
        });
        const committed: UniversalSearchResult[] = [];
        const sections = buildUniversalSearchSections(input({ source: 'symbols', query: 'LiveSymbol', symbols,
            onCommitResult: result => { committed.push(result); } }));
        expect(sections.map(section => section.id)).toEqual(['symbols']);
        const page = await dynamicSections(sections)[0]!.resolve('LiveSymbol', new AbortController().signal);
        expect(page.options.map(option => option.label)).toEqual(['LiveSymbol']);
        page.options[0]!.onSelect?.();
        const result = committed[0];
        if (!result) throw new Error('Symbol row did not commit a target');
        const openFile = vi.fn(async () => true);
        expect(await activateUniversalSearchResult(result.target, {
            navigateToSession: vi.fn(), push: vi.fn(), openProject: async () => false, openFile,
        }, { intent: 'beside' })).toEqual({ ok: true });
        expect(openFile).toHaveBeenCalledWith({ kind: 'project', workspaceRefId: 'workspace-a',
            ...scope, path: 'src/a.ts' }, { intent: 'beside', anchor: { kind: 'fileLine', startLine: 2 } });
    });

    it('keeps Files focused and makes every file in a supplied page selectable', async () => {
        const results: UniversalSearchResult[] = Array.from({ length: 35 }, (_, i) => ({
            id: `${i}.ts`, scopeKey: 'workspace', sourceId: 'files', kind: 'workspaceFile', title: `${i}.ts`,
            target: { kind: 'workspaceFile', scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' },
                path: `${i}.ts`, workspaceRefId: 'workspace-a', sessionId: null, serverId: 'home-a', accountId: 'account-a' },
        }));
        const sections = buildUniversalSearchSections(input({ query: 'file', source: 'files',
            sessions: [sessionEntity('elsewhere', 1)],
            files: { status: 'ready', resolverKey: 'workspace', resolve: async () => results } }));
        expect(sections.map(section => section.id)).toEqual(['files']);
        const page = await dynamicSections(sections)[0]!.resolve('file', new AbortController().signal);
        expect(page.options).toHaveLength(35);
    });
    it('answers a quick-open query with no file match by one way out, then Recent (lab FB2n)', async () => {
        const recent: UniversalSearchResult = { id: 'DESIGN.md', scopeKey: 'workspace', sourceId: 'files', kind: 'workspaceFile', title: 'DESIGN.md',
            target: { kind: 'workspaceFile', scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' },
                path: 'DESIGN.md', workspaceRefId: 'workspace-a', sessionId: null, serverId: 'home-a', accountId: 'account-a' } };
        const onSearchEverything = vi.fn();
        const build = (results: UniversalSearchResult[]) => buildUniversalSearchSections(input({ query: 'settingsdrawer', source: 'files',
            recentFiles: [recent], filesNoMatch: { scopeLabel: 'happier', onSearchEverything },
            files: { status: 'ready', resolverKey: 'workspace', resolve: async () => results } }));
        const empty = await dynamicSections(build([]))[0]!.resolve('settingsdrawer', new AbortController().signal);
        expect(empty.options.map(option => option.id)).toEqual(['files:no-match', 'files:no-match:recent', expect.stringContaining('DESIGN.md')]);
        expect(empty.options[1]!.disabled).toBe(true);
        empty.options[0]!.onSelect?.();
        expect(onSearchEverything).toHaveBeenCalledTimes(1);
        // A real match never shows the no-match line or the Recent fallback.
        const found = await dynamicSections(build([{ ...recent, id: 'drawer.ts', title: 'drawer.ts' }]))[0]!.resolve('settingsdrawer', new AbortController().signal);
        expect(found.options.map(option => option.id).some(id => id.startsWith('files:no-match'))).toBe(false);
    });
    it('opens an empty quick open on the folder\'s own files when nothing is recent or changed, and shows a changed file\'s lines (lab FB2)', async () => {
        const file = (path: string, fileChange?: Readonly<{ added: number; removed: number }>): UniversalSearchResult => ({
            id: path, scopeKey: 'workspace', sourceId: 'files', kind: 'workspaceFile', title: path, ...(fileChange ? { fileChange } : {}),
            target: { kind: 'workspaceFile', scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' },
                path, workspaceRefId: 'workspace-a', sessionId: null, serverId: 'home-a', accountId: 'account-a' } });
        const resolve = vi.fn(async () => [file('README.md'), file('src/retry.ts', { added: 4, removed: 2 })]);
        const fresh = buildUniversalSearchSections(input({ query: '', source: 'files', recentFiles: [], changedFiles: [],
            files: { status: 'ready', resolverKey: 'workspace', resolve } }));
        expect(fresh.map(section => section.id)).toEqual(['files']);
        const page = await dynamicSections(fresh)[0]!.resolve('', new AbortController().signal);
        expect(page.options.map(option => option.label)).toEqual(['README.md', 'src/retry.ts']);
        expect(page.options[0]!.rightAccessory).toBeUndefined();
        expect(page.options[1]!.rightAccessory).toBeDefined();
        // Once something is recent, the empty query lists Recent and never asks the folder.
        const withRecent = buildUniversalSearchSections(input({ query: '', source: 'files', recentFiles: [file('DESIGN.md')], changedFiles: [],
            files: { status: 'ready', resolverKey: 'workspace', resolve } }));
        expect(withRecent.map(section => section.id)).toEqual(['files:recent']);
    });
    it.each(['cedar', 'A cedar', 'A cedar choice'])('puts content title matches ahead of settings and commands for %s', (query) => {
        const sections = buildUniversalSearchSections(input({ query,
            sessions: [{ ...sessionEntity('cedar', 1), title: 'A cedar choice' }],
            projects: [{ workspaceRefId: 'cedar-project', accountId: 'account-home-a', serverId: 'home-a',
                machineId: 'machine-a', rootPath: '/cedar', title: 'A cedar project', lastOpenedAtMs: 1 }],
            commands: [{ id: 'theme', title: 'Dark mode', subtitle: 'cedar', action: () => {} }],
            searchSettingsPages: () => [{ id: 'appearance', route: '/settings/appearance', title: 'Appearance' }],
        }));
        const ids = sections.map(section => section.id);
        expect(ids.indexOf('sessions')).toBeLessThan(ids.indexOf('commands:'));
        expect(ids.indexOf('sessions')).toBeLessThan(ids.indexOf('settings'));
        if (query !== 'A cedar choice') expect(ids.indexOf('projects')).toBeLessThan(ids.indexOf('settings'));
    });

    it('does not promote a content section on hidden metadata alone', () => {
        const sections = buildUniversalSearchSections(input({ query: 'cedar',
            sessions: [{ ...sessionEntity('other', 1), searchText: 'cedar' }],
            searchSettingsPages: () => [{ id: 'appearance', route: '/settings/appearance', title: 'Appearance' }],
        }));
        const ids = sections.map(section => section.id);
        expect(ids.indexOf('settings')).toBeLessThan(ids.indexOf('sessions'));
    });
    it('omits the explicit scan row when standard search is disabled', () => {
        const sections = buildUniversalSearchSections(input({ query: 'quartz', externalConversationSearch: {
            machineLabel: 'Laptop', standardSearchEnabled: false, onSearch: () => {},
        } }));
        expect(staticOptionIds(sections, 'externalConversations')).toEqual([]);
    });
    it('offers text-in-files for one character and an actionable full-results scope for an incomplete page', async () => {
        const onShowAllFileMatches = vi.fn();
        const source = {
            status: 'ready' as const,
            resolverKey: 'workspace-content',
            resolve: async () => ({ results: [], hasMore: true }),
        };
        const sections = buildUniversalSearchSections(input({
            query: 'needle',
            source: 'fileContent',
            fileContent: source,
            onShowAllFileMatches,
        }));
        expect(sections.map((section) => section.id)).toEqual(['fileContent']);
        const content = dynamicSections(sections)[0]!;
        expect(content.visibleWhen?.('')).toBe(false);
        expect(content.visibleWhen?.('n')).toBe(true);
        expect(content.visibleWhen?.(' ')).toBe(true);
        expect(content.visibleWhen?.('ne')).toBe(true);
        expect(content.visibleWhen?.(' a')).toBe(true);
        // An empty incomplete page names only what was searched (r11 F2); it cannot promise more hits.
        const page = await content.resolve('needle', new AbortController().signal);
        expect(page.options).toHaveLength(0);
        expect(page.emptyHint).toBe('universalSearch.noMatchesInSearchedResults');
        expect(page.resultHint).toBeUndefined();
        // Inline, the incomplete group leads into the scope.
        const inline = dynamicSections(buildUniversalSearchSections(input({ query: 'needle', fileContent: source, onShowAllFileMatches })))
            .find((section) => section.id === 'fileContent')!;
        const inlinePage = await inline.resolve('needle', new AbortController().signal);
        expect(inlinePage.options).toHaveLength(1);
        inlinePage.options[0]?.onSelect?.();
        expect(onShowAllFileMatches).toHaveBeenCalledOnce();
        expect(inlinePage.resultHint).toBeUndefined();
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
        expect(page.options[0]?.labelContent).toBeTypeOf('function');
        // The context opens inside the active row in place of its one-line snippet, never as a block below it.
        expect(page.options[0]?.expandedContent).toBeUndefined();
        const option = page.options[0]!;
        const screen = await renderScreen(<PlanOptionRow option={option} rootTestID="search" stepId="root"
            isSelected={false} isFocused onSelect={() => {}} onPushStep={() => {}} />);
        expect(screen.findByTestId('file-content-preview')).not.toBeNull();
        // The matching line appears once: as part of the context, not also as the snippet.
        expect(screen.getTextContent().split('literal').length - 1).toBe(1);
        expect(screen.getTextContent()).toContain('before');
        expect(screen.getTextContent()).toContain('after');
        expect(screen.getTextContent()).toContain('literal');
        expect(commit).not.toHaveBeenCalled();
        await screen.update(<PlanOptionRow option={option} rootTestID="search" stepId="root"
            isSelected={false} isFocused={false} onSelect={() => {}} onPushStep={() => {}} />);
        expect(screen.findByTestId('file-content-preview')).toBeNull();
        expect(screen.getTextContent()).not.toContain('before');
        expect(screen.getTextContent()).toContain('literal');
        await screen.unmount();
        page.options[1]?.onSelect?.();
        expect(commit).toHaveBeenCalledWith(expect.objectContaining({
            target: expect.objectContaining({ anchor: { kind: 'fileLine', startLine: 9 } }),
        }));
    });
    // Find lab G1 / G1s: one row per matching line (every match on it marked), the inline group shows the
    // best few lines then "All N matches", and the Text in files scope groups lines under their file.
    function contentHit(path: string, line: number, column16: number): UniversalSearchResult {
        return { id: `${path}:${line}:${column16}`, sourceId: 'fileContent', scopeKey: 'ws', kind: 'workspaceFile', title: path,
            fileContent: { path, line, column16, length16: 8, text: 'const routeKey = routeKey;', before: [], after: [] },
            target: { kind: 'workspaceFile', scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' }, path,
                workspaceRefId: null, sessionId: null, serverId: 'home-a', accountId: 'account-a', anchor: { kind: 'fileLine', startLine: line } } };
    }
    const hits = [contentHit('src/a.ts', 5, 7), contentHit('src/a.ts', 5, 18), contentHit('src/a.ts', 9, 7),
        contentHit('src/b.ts', 2, 7), contentHit('docs/c.md', 12, 7)];
    it('shows one row per matching line and only the best few lines inline', async () => {
        const sections = dynamicSections(buildUniversalSearchSections(input({ query: 'routeKey', onShowAllFileMatches: vi.fn(),
            fileContent: { status: 'ready', resolverKey: 'ws', resolve: async () => hits } })));
        const page = await sections.find((section) => section.id === 'fileContent')!.resolve('routeKey', new AbortController().signal);
        expect(page.options.map((option) => option.label)).toEqual(['src/a.ts:5', 'src/a.ts:9', 'src/b.ts:2', 'universalSearch.content.allMatches(matches=5,files=3)']);
    });
    it('groups every matching line under its file in the Text in files scope', async () => {
        const sections = dynamicSections(buildUniversalSearchSections(input({ query: 'routeKey', source: 'fileContent',
            fileContent: { status: 'ready', resolverKey: 'ws', resolve: async () => hits } })));
        const page = await sections[0]!.resolve('routeKey', new AbortController().signal);
        const rows = page.options.map((option) => [option.label, option.disabled === true]);
        expect(rows).toEqual([
            ['universalSearch.content.matchesInFiles(matches=5,files=3)', true],
            ['src/a.ts', true], ['src/a.ts:5', false], ['src/a.ts:9', false],
            ['src/b.ts', true], ['src/b.ts:2', false],
            ['docs/c.md', true], ['docs/c.md:12', false],
        ]);
    });
    it('keeps a context-free matching line in its row without duplicating it in an expanded preview', async () => {
        const result: UniversalSearchResult = { id: 'a:4', sourceId: 'fileContent', scopeKey: 'ws', kind: 'workspaceFile', title: 'a.ts',
            fileContent: { path: 'a.ts', line: 4, column16: 1, length16: 6, text: 'needle', before: [], after: [] },
            target: { kind: 'workspaceFile', scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' }, path: 'a.ts',
                workspaceRefId: null, sessionId: null, serverId: 'home-a', accountId: 'account-a' } };
        const sections = dynamicSections(buildUniversalSearchSections(input({ query: 'needle', fileContent: {
            status: 'ready', resolverKey: 'ws', resolve: async () => [result],
        } })));
        const page = await sections.find(section => section.id === 'fileContent')!.resolve('needle', new AbortController().signal);
        expect(page.options[0]?.subtitleContent).toBeDefined();
        expect(page.options[0]?.expandedContent).toBeUndefined();
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

    // Lab H1: the row sits under its own group that names where it searches; the row is the one action.
    it('names where the scan runs in the group title, for one machine or every machine', () => {
        const group = (search: { machineLabel?: string }) => buildUniversalSearchSections(input({ query: 'quartz', externalConversationSearch: { ...search, onSearch: () => {} } }))
            .find((entry) => entry.id === 'externalConversations');
        expect(group({ machineLabel: 'Work machine' })?.title).toBe('externalSessions.browseContentOnMachine(machine=Work machine)');
        expect(group({})?.title).toBe('conversationSearch.scopeAllMachinesSubtitle');
        const row = group({ machineLabel: 'Work machine' });
        expect(row && 'options' in row ? row.options[0]?.subtitle : 'missing').toBeUndefined();
        // The explicit scan follows the Messages already in Happier (lab H1: Sessions, Messages, then Conversations).
        const ids = buildUniversalSearchSections(input({ query: 'quartz', externalConversationSearch: { machineLabel: 'Work machine', onSearch: () => {} },
            transcript: { status: 'ready', resolverKey: 'm', resolve: async () => [] } })).map((section) => section.id);
        expect(ids.indexOf('externalConversations')).toBeGreaterThan(ids.indexOf('transcript'));
    });

    it('presents a conversation hit by what it matched and whose conversation it is', async () => {
        const hit = (id: string, conversation: UniversalSearchResult['conversation']): UniversalSearchResult => ({
            id, scopeKey: 'home', sourceId: 'transcript', kind: 'externalConversation', title: id, conversation,
            target: { kind: 'session', serverId: 'home', accountId: 'account', sessionId: id },
        });
        const sections = buildUniversalSearchSections(input({
            query: 'flaky',
            transcript: { status: 'ready', resolverKey: 'all', resolve: async () => [
                hit('Claude Code', { snippet: 'the flaky e2e is the settings sheet', query: 'flaky', agentId: 'claude', machineLabel: 'Studio', atMs: 1 }),
                hit('Docs search index', { snippet: 'skip the flaky e2e for now', query: 'flaky' }),
                { ...hit('Plain', undefined), subtitle: 'plain subtitle' },
                hit('**flaky** title', { snippet: '**flaky** title', query: 'flaky' }),
            ] },
        }));
        const page = await dynamicSections(sections).find((section) => section.id === 'transcript')!.resolve('flaky', new AbortController().signal);
        const [native, session, plain, titleHit] = page.options;
        // The matched text is the row's searchable subtitle and its spoken name, with the machine it lives on.
        expect(native?.subtitle).toBe('the flaky e2e is the settings sheet');
        expect(native?.accessibilityLabel).toBe('Claude Code, the flaky e2e is the settings sheet, Studio');
        expect(native?.subtitleContent).toBeTypeOf('function');
        expect(session?.accessibilityLabel).toBe('Docs search index, skip the flaky e2e for now');
        // Only a conversation from an Agent's own history carries that Agent's mark.
        expect(native?.icon).not.toBe(session?.icon);
        expect(plain?.subtitle).toBe('plain subtitle');
        expect(plain?.subtitleContent).toBeUndefined();
        expect(plain?.accessibilityLabel).toBeUndefined();
        if (!titleHit) throw new Error('Missing title hit');
        expect(titleHit.label).toBe('flaky title');
        const row = await renderScreen(<PlanOptionRow option={titleHit} stepId="root" rootTestID="palette"
            isSelected={false} isFocused={false} onSelect={() => {}} onPushStep={() => {}} />);
        // The duplicate snippet is suppressed, so the visible title must carry the only match.
        expect(row.findAllHostsByTestId('find-match-all').map(mark => mark.children.join(''))).toEqual(['flaky']);
    });

    it('renders indexed role-labelled Markdown as plain message text without changing its raw search target', async () => {
        const summary = 'User: # A harbor note\n**violet harbor lantern** and [the link](https://example.test)\nAssistant: ## Keep issue #42 and C# literal';
        const result: UniversalSearchResult = {
            id: 'indexed-message', scopeKey: 'home', sourceId: 'transcript', kind: 'session', title: 'A conversation',
            conversation: { snippet: summary, query: 'violet harbor lantern' },
            target: { kind: 'session', serverId: 'home', accountId: 'account', sessionId: 'indexed-message' },
        };
        const sections = buildUniversalSearchSections(input({ query: 'violet harbor lantern',
            transcript: { status: 'ready', resolverKey: 'indexed', resolve: async () => [result] } }));
        const page = await dynamicSections(sections).find(section => section.id === 'transcript')!
            .resolve('violet harbor lantern', new AbortController().signal);
        const option = page.options[0]!;
        const plain = 'A harbor note violet harbor lantern and the link Keep issue #42 and C# literal';
        expect(option.subtitle).toBe(plain);
        expect(option.accessibilityLabel).toBe(`A conversation, ${plain}`);
        const row = await renderScreen(<PlanOptionRow option={option} stepId="root" rootTestID="palette"
            isSelected={false} isFocused={false} onSelect={() => {}} onPushStep={() => {}} />);
        expect(row.findAllHostsByTestId('find-match-all').map(mark => mark.children.join(''))).toEqual(['violet harbor lantern']);
        expect(result.conversation?.snippet).toBe(summary);
        expect(result.target).toEqual({ kind: 'session', serverId: 'home', accountId: 'account', sessionId: 'indexed-message' });
    });

    it('keeps a late numbered-message match visible through excerpt and Markdown presentation', async () => {
        const { createMemorySearchSnippet } = await import('@happier-dev/protocol/memory/memorySearchText');
        const text = `${'Amber orchard and silver meadow observations. '.repeat(80)}\n554. Keep the matching observation visible.\n${'More observations. '.repeat(30)}`;
        const summary = createMemorySearchSnippet(text, '554', 240);
        expect(summary).toContain('554.');
        expect(summary.startsWith('…')).toBe(true);
        expect(summary.endsWith('…')).toBe(true);
        const result: UniversalSearchResult = {
            id: 'numbered-message', scopeKey: 'home', sourceId: 'transcript', kind: 'message', title: 'Orchard and meadow',
            conversation: { snippet: summary, query: '554' },
            target: { kind: 'session', serverId: 'home', accountId: 'account', sessionId: 'numbered-message' },
        };
        const sections = buildUniversalSearchSections(input({ query: '554',
            transcript: { status: 'ready', resolverKey: 'numbered', resolve: async () => [result] } }));
        const page = await dynamicSections(sections).find(section => section.id === 'transcript')!
            .resolve('554', new AbortController().signal);
        const row = await renderScreen(<PlanOptionRow option={page.options[0]!} stepId="root" rootTestID="palette"
            isSelected={false} isFocused={false} onSelect={() => {}} onPushStep={() => {}} />);
        expect(row.findAllHostsByTestId('find-match-all').map(mark => mark.children.join(''))).toEqual(['554']);
        expect(page.options[0]?.accessibilityLabel).toContain('554');
        expect(result.conversation?.snippet).toBe(summary);
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

    it('tints the typed query in every row whose title is the text that matched', async () => {
        const sections = buildUniversalSearchSections(input({
            query: ' cedar ',
            sessions: [{ ...sessionEntity('cedar', 1), title: 'A cedar choice' }],
            projects: [{ workspaceRefId: 'cedar-project', accountId: 'account-home-a', serverId: 'home-a',
                machineId: 'machine-a', rootPath: '/cedar', title: 'A cedar project', lastOpenedAtMs: 1 }],
            files: {
                status: 'ready',
                resolverKey: 'workspace-a',
                resolve: async () => [{
                    id: 'src/cedar.ts',
                    scopeKey: buildUniversalSearchScopeKey(['home-a', 'machine-a', '/repo']),
                    sourceId: 'files',
                    kind: 'workspaceFile',
                    title: 'cedar.ts',
                    subtitle: 'src/cedar.ts',
                    target: { kind: 'workspaceFile', scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' },
                        path: 'src/cedar.ts', workspaceRefId: 'workspace-a', sessionId: null, serverId: 'home-a', accountId: 'account-a' },
                }],
            },
        }));
        const staticOptions = (id: string) => {
            const section = sections.find((candidate) => candidate.id === id);
            if (!section || section.kind !== 'static') throw new Error(`${id} section missing`);
            return section.options;
        };
        expect(staticOptions('sessions')[0]?.labelHighlightQuery).toBe('cedar');
        expect(staticOptions('projects')[0]?.labelHighlightQuery).toBe('cedar');
        const files = dynamicSections(sections).find((section) => section.id === 'files');
        const resolved = await files!.resolve('cedar', new AbortController().signal);
        expect(resolved.options[0]?.labelHighlightQuery).toBe('cedar');
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

    it('leads the empty query with pinned Sessions in pin order and keeps them out of Recent (lab palette Pinned)', () => {
        const sessions = Array.from({ length: 12 }, (_, index) => sessionEntity(`s${11 - index}`, 11 - index));
        const empty = buildUniversalSearchSections(input({ query: '', sessions, pinnedSessionIds: ['s2', 'gone', 's10'] }));
        expect(empty.map(section => section.id).slice(0, 2)).toEqual(['sessions:pinned', 'sessions']);
        expect(staticOptionIds(empty, 'sessions:pinned').map(id => id.split(':').at(-1))).toEqual(['s2', 's10']);
        expect(staticOptionIds(empty, 'sessions').map(id => id.split(':').at(-1))).toEqual(['s11', 's9', 's8', 's7', 's6']);

        const typed = buildUniversalSearchSections(input({ query: 'Session', sessions, pinnedSessionIds: ['s2'] }));
        expect(typed.some(section => section.id === 'sessions:pinned')).toBe(false);
        expect(staticOptionIds(typed, 'sessions')).toHaveLength(12);
    });

    it('marks a Session result with its Agent and tints the typed query in command names (palette lab rows)', () => {
        const sessions = [{ ...sessionEntity('s1', 1), agentId: 'claude' }, sessionEntity('s2', 0)];
        const command = { id: 'choose-model', title: 'Choose a model…', category: 'Actions', action: () => {} };
        const typed = buildUniversalSearchSections(input({ query: 'model', sessions: [], commands: [command] }));
        const commandOption = typed.flatMap(section => 'options' in section ? section.options : []).find(option => option.label === 'Choose a model…');
        expect(commandOption?.labelHighlightQuery).toBe('model');

        const empty = buildUniversalSearchSections(input({ query: '', sessions }));
        const rows = empty.flatMap(section => 'options' in section ? section.options : []);
        const marked = rows.find(option => option.label === 'Session s1');
        const unknown = rows.find(option => option.label === 'Session s2');
        const iconProps = (option: typeof marked) => (option?.icon as (() => { props: Record<string, unknown> }) | undefined)?.().props;
        expect(iconProps(marked)?.agentId).toBe('claude');
        expect(iconProps(unknown)?.name).toBe('chats-circle');
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
            transcript: { status: 'ready', resolverKey: 'home-b',
                resolve: async () => ({ results, resultHint: 'Partial coverage' }) },
        }));
        const transcript = dynamicSections(sections).find((section) => section.id === 'transcript');
        expect(transcript?.resultFiltering).toBe('provider');

        const resolved = await transcript!.resolve('rollback', new AbortController().signal);
        expect(resolved.options).toHaveLength(1);
        expect(resolved.options[0]?.id)
            .toBe(`transcript::${buildUniversalSearchScopeKey(['home-b'])}::m1`);
        const plan = synthesizeSelectionListRenderPlan({
            sections, inputValue: 'rollback', filterQuery: 'rollback',
            dynamicSectionStates: new Map([['transcript', { status: 'success' as const, ...resolved }]]),
        });
        expect(plan.find(section => section.id === 'transcript'))
            .toMatchObject({ options: resolved.options, resultHint: 'Partial coverage' });
        expect(resolved.emptyHint).toBeUndefined();
    });

    it.each(['source', 'page'] as const)('keeps empty Messages coverage visible through the real section render owner (%s)', async (owner) => {
        const coverage = describeConversationSearchCoverage({
            machines: [{ machineId: 'machine-a', status: 'partial', standardSearchEnabled: true }],
            machineName: () => 'Laptop',
        });
        const sections = buildUniversalSearchSections(input({
            query: 'older work',
            transcript: {
                status: 'ready',
                resolverKey: 'daemon:home-a:machine-a',
                ...(owner === 'source' ? { resultHint: coverage } : {}),
                resolve: async () => owner === 'page' ? { results: [], resultHint: coverage } : [],
            },
        }));

        const transcript = dynamicSections(sections).find((section) => section.id === 'transcript');
        const resolved = await transcript!.resolve('older work', new AbortController().signal);
        const plan = synthesizeSelectionListRenderPlan({
            sections, inputValue: 'older work', filterQuery: 'older work',
            dynamicSectionStates: new Map([['transcript', { status: 'success' as const, ...resolved }]]),
        });
        expect(plan.find(section => section.id === 'transcript'))
            .toMatchObject({ dynamicState: 'empty', options: [], hint: coverage });
    });

    it('preserves an explicit empty source status ahead of its coverage hint', async () => {
        const sections = buildUniversalSearchSections(input({ query: 'older work', transcript: {
            status: 'ready', resolverKey: 'exact-status',
            resolve: async () => ({ results: [], emptyHint: 'Exact source status', resultHint: 'Partial coverage' }),
        } }));
        const transcript = dynamicSections(sections).find(section => section.id === 'transcript')!;
        const resolved = await transcript.resolve('older work', new AbortController().signal);
        const plan = synthesizeSelectionListRenderPlan({
            sections, inputValue: 'older work', filterQuery: 'older work',
            dynamicSectionStates: new Map([['transcript', { status: 'success' as const, ...resolved }]]),
        });
        expect(plan.find(section => section.id === 'transcript'))
            .toMatchObject({ dynamicState: 'empty', options: [], hint: 'Exact source status' });
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

    it('offers recent folders under Text in files when no folder is in scope, and choosing one scopes the search there', async () => {
        const onSelectHappier = vi.fn();
        const sections = buildUniversalSearchSections(input({
            query: 'routeKey',
            fileContent: { status: 'absent' },
            fileContentFolders: [
                { id: 'happier', name: 'happier', subtitle: '~/code/happier · MacBook Pro', onSelect: onSelectHappier },
                { id: 'website', name: 'website', subtitle: '~/code/website · MacBook Pro', onSelect: vi.fn() },
            ],
        }));
        const group = dynamicSections(sections).find((section) => section.id === 'fileContent');
        expect(group).toBeDefined();
        expect(group!.visibleWhen?.('')).toBe(false);
        const resolved = await group!.resolve('routeKey', new AbortController().signal);
        expect(resolved.options.map((option) => option.subtitle)).toEqual(['~/code/happier · MacBook Pro', '~/code/website · MacBook Pro']);
        expect(resolved.options[0]!.label).toContain('happier');
        resolved.options[0]!.onSelect?.();
        expect(onSelectHappier).toHaveBeenCalledTimes(1);

        // A folder in scope searches it; the suggestions never compete with real matches.
        const scoped = buildUniversalSearchSections(input({
            query: 'routeKey',
            fileContent: { status: 'unavailable', resolverKey: 'w|offline', hint: 'offline' },
            fileContentFolders: [{ id: 'happier', name: 'happier', onSelect: vi.fn() }],
        }));
        const scopedGroup = dynamicSections(scoped).find((section) => section.id === 'fileContent');
        expect((await scopedGroup!.resolve('routeKey', new AbortController().signal)).options).toHaveLength(0);
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
        // A plugin group that fails says so in host copy, like every built-in group (no plugin branch).
        expect(projected?.errorHint).toBe('universalSearch.groupFailed(group=Acme issues)');
        // Its failure line offers a real Retry, like every built-in group's.
        expect(projected?.retryLabel).toBe('common.retry');
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
            // The first load is one quiet line, not placeholder bars.
            expect(section.loadingHint).toBe('universalSearch.searchingGroup');
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
        expect(empty.map((section) => section.id)).toEqual(['sessions', 'commands:Actions']);

        const typed = buildUniversalSearchSections(input({ query: 'new', commands, sessions, searchSettingsPages }));
        expect(typed.map((section) => section.id)).toEqual(['commands:Actions', 'settings', 'sessions']);
    });
});
