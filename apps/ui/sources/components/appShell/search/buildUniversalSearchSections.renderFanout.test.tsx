import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import * as subscriptions from '@/sync/domains/state/storageSubscriptions';
import { SelectionList } from '@/components/ui/selectionList/SelectionList';
import type { SelectionListStep, SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import { buildUniversalSearchSections } from './buildUniversalSearchSections';
import type { UniversalSearchResult } from './universalSearchResult';

const counts = vi.hoisted(() => ({ rows: new Map<string, number>(), mounts: new Map<string, number>(),
    unmounts: new Map<string, number>(), textRenders: 0, textMounts: 0 }));

// Count the actual native host work below real PlanOptionRow/Item/AppText, rather than replacing them.
vi.mock('react-native', async () => {
    const React = await import('react');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const native = await createReactNativeWebMock();
    type HostProps = Readonly<{ testID?: string; children?: React.ReactNode }>;
    const Row = React.createContext(false);
    return { ...native,
        Pressable: React.forwardRef(function CountedPressable(props: HostProps, ref) {
            const id = props.testID?.startsWith('universal-search:option:') ? props.testID : undefined;
            if (id) counts.rows.set(id, (counts.rows.get(id) ?? 0) + 1);
            React.useLayoutEffect(() => {
                if (!id) return;
                counts.mounts.set(id, (counts.mounts.get(id) ?? 0) + 1);
                return () => { counts.unmounts.set(id, (counts.unmounts.get(id) ?? 0) + 1); };
            }, [id]);
            return <Row.Provider value={id !== undefined}><native.Pressable {...props} ref={ref} /></Row.Provider>;
        }),
        Text: React.forwardRef(function CountedText(props: HostProps, ref) {
            const row = React.useContext(Row);
            if (row) counts.textRenders += 1;
            React.useLayoutEffect(() => { if (row) counts.textMounts += 1; }, [row]);
            return <native.Text {...props} ref={ref} />;
        }),
    };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return await createLegendListModuleMock({ renderItems: true, memoizeItems: true });
});

const commit = vi.fn();
const select = vi.fn();
const close = vi.fn();
const absent = { status: 'absent' } as const;
// SEARCHCONT's real Account had 118 Sessions; its palette returned 20 Settings rows.
const sessions = Array.from({ length: 118 }, (_, i) => ({ sessionId: String(i), serverId: 'home', accountId: 'account',
    title: i === 0 ? 'release' : `Alpha ${i}`, searchText: 'release', updatedAt: i }));
const settings = Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: `Display ${i}`, route: `/settings/${i}` }));
const fileResults: readonly UniversalSearchResult[] = Array.from({ length: 80 }, (_, i) => ({ id: String(i), sourceId: 'files',
    scopeKey: 'folder', kind: 'workspaceFile', title: `config-${i}.ts`, target: { kind: 'workspaceFile',
        scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: `config-${i}.ts`,
        workspaceRefId: null, sessionId: null, serverId: 'home', accountId: 'account' } }));
const files = { status: 'ready', resolverKey: 'folder', resolve: async () => fileResults } as const;
const searchSettingsPages = () => settings;

function Host({ query, sessionRows = sessions }: Readonly<{ query: string; sessionRows?: typeof sessions }>) {
    const previous = React.useRef<readonly SelectionListSectionDescriptor[]>([]);
    const sections = React.useMemo(() => {
        const next = buildUniversalSearchSections({ query, sessions: sessionRows, commands: [], projects: [],
            previousSections: previous.current,
            searchSettingsPages, transcript: absent, files, commits: absent, pluginSections: [], onCommitResult: commit });
        previous.current = next;
        return next;
    }, [query, sessionRows]);
    const rootStep: SelectionListStep = { id: 'search', sections, inputPlaceholder: 'Search' };
    return <SelectionList rootStep={rootStep} inputValue={query} onSelect={select} onRequestClose={close}
        disableTransitions keyboardHintsEnabled={false} optionPresentation="menu" testID="fanout" maxHeight={500} />;
}

function resetCounts() {
    counts.rows.clear(); counts.mounts.clear(); counts.unmounts.clear(); counts.textRenders = 0; counts.textMounts = 0;
}

async function settle() {
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); resetCounts(); });

describe('Universal Search mounted refinement cost', () => {
    it('does no row or text work for unchanged settings and hidden-metadata matches while real highlights advance', async () => {
        vi.useFakeTimers();
        const bindings = vi.spyOn(subscriptions, 'subscribeStoragePaths');
        const screen = await renderScreen(<Host query="r" />);
        await settle();
        expect(counts.mounts.size).toBeGreaterThan(118);
        for (const query of ['re', 'rel']) {
            resetCounts(); bindings.mockClear();
            await screen.update(<Host query={query} />);
            await settle();
            const changed = 'universal-search:option:sessions:0';
            const unchangedRenders = [...counts.rows].filter(([id]) => id !== changed).reduce((sum, [, count]) => sum + count, 0);
            console.info('SEARCHFANOUT', JSON.stringify({ query, unchangedRenders, changedRenders: counts.rows.get(changed) ?? 0,
                rowMounts: [...counts.mounts.values()].reduce((a, b) => a + b, 0), textRenders: counts.textRenders,
                textMounts: counts.textMounts, fontBindings: bindings.mock.calls.filter(([paths]) => paths.some(path => path.includes('uiFontScale'))).length }));
            expect.soft(unchangedRenders).toBe(0);
            expect(counts.rows.get(changed)).toBeGreaterThan(0);
            expect(counts.mounts.size).toBe(0);
            expect(counts.textMounts).toBe(0);
            const row = screen.findAllByTestId(changed).find(node => node.props.titleHighlightQuery !== undefined);
            expect(row?.props.titleHighlightQuery).toBe(query);
        }
    });

    it('keeps pointer and keyboard focus through refinements and applies changed membership and activation', async () => {
        vi.useFakeTimers();
        const screen = await renderScreen(<Host query="r" />);
        await settle();
        const focused = 'universal-search:option:sessions:1';
        resetCounts();
        const root = screen.findAllByTestId('fanout').find(node => typeof node.props.onMouseMove === 'function');
        await act(async () => { root!.props.onMouseMove(); });
        const row = screen.findAllByTestId(focused).find(node => typeof node.props.onHoverIn === 'function');
        await act(async () => { row!.props.onHoverIn(); });
        const activeDescendant = () => screen.findAllByTestId('fanout:header')
            .map(node => node.props.activeDescendantId).find(value => typeof value === 'string');
        expect(activeDescendant()).toBe(focused);
        expect([...counts.rows].filter(([id]) => id !== focused && id !== 'universal-search:option:sessions:0')
            .reduce((sum, [, count]) => sum + count, 0)).toBe(0);
        await screen.update(<Host query="re" />);
        await settle();
        expect(activeDescendant()).toBe(focused);
        const header = screen.findAllByTestId('fanout:header').find(node => typeof node.props.onKeyPress === 'function');
        await act(async () => { header!.props.onKeyPress({ key: 'ArrowDown', nativeEvent: { key: 'ArrowDown' },
            preventDefault() {}, stopPropagation() {} }); });
        expect(activeDescendant()).toBe('universal-search:option:sessions:2');

        const position = (id: string) => screen.findAllByTestId(`universal-search:option:sessions:${id}`)
            .find(node => node.props['aria-posinset'] !== undefined)?.props['aria-posinset'];
        expect(position('1')).toBe(2);
        resetCounts();
        // Keep the arrival in the hidden-metadata match tier: a title match would move every
        // intervening row and require their aria-posinset to update, not represent unrelated work.
        const updated = [...sessions.slice(0, -1), { ...sessions[1]!, sessionId: 'new', title: 'Alpha new' }];
        await screen.update(<Host query="re" sessionRows={updated} />);
        await settle();
        expect(counts.mounts.get('universal-search:option:sessions:new')).toBe(1);
        expect(counts.unmounts.get('universal-search:option:sessions:117')).toBe(1);
        const unchangedRenders = [...counts.rows].filter(([id]) => id !== 'universal-search:option:sessions:new')
            .reduce((sum, [, count]) => sum + count, 0);
        expect(unchangedRenders).toBe(0);
        expect(activeDescendant()).toBe('universal-search:option:sessions:2');
        expect(position('1')).toBe(2);
        expect(position('new')).toBe(118);
        // A genuine title-match promotion must update the intervening accessibility positions
        // without remounting retained rows. Re-aim after the preceding result-set change:
        // the roving-focus owner deliberately consumes explicit action intent on new results.
        const updatedHeader = screen.findAllByTestId('fanout:header').find(node => typeof node.props.onKeyPress === 'function');
        for (const key of ['ArrowUp', 'ArrowDown']) {
            await act(async () => { updatedHeader!.props.onKeyPress({ key, nativeEvent: { key },
                preventDefault() {}, stopPropagation() {} }); });
        }
        expect(activeDescendant()).toBe('universal-search:option:sessions:2');
        resetCounts();
        const promoted = updated.map(session => session.sessionId === 'new' ? { ...session, title: 'New release' } : session);
        await screen.update(<Host query="re" sessionRows={promoted} />);
        await settle();
        expect(position('new')).toBe(2);
        expect(position('1')).toBe(3);
        expect(activeDescendant()).toBe('universal-search:option:sessions:2');
        expect(counts.mounts.size).toBe(0);
        expect(counts.unmounts.size).toBe(0);
        const added = screen.findAllByTestId('universal-search:option:sessions:new')
            .find(node => typeof node.props.onPress === 'function');
        await act(async () => { added!.props.onPress(); });
        expect(commit).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'New release',
            target: expect.objectContaining({ sessionId: 'new', serverId: 'home', accountId: 'account' }) }));
    });
});
