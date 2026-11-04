import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// This suite's footer keeper exercises a finger's target floor, not a fine pointer's dense controls.
vi.hoisted(() => vi.stubGlobal('navigator', { maxTouchPoints: 1 }));
afterAll(() => vi.unstubAllGlobals());

// Third-party Markdown rendering is outside this filter editor contract.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';

import { createSessionListSpaceChromeFixture } from './sessionListSpaceChromeTestFixture';
import { createSessionListViewFilterDefaults, type SessionListViewFilters } from './sessionListViewFilters';
import { SessionListFilterEditor, type SessionListFilterEditorProps } from './SessionListFilterEditor';
import { clearSessionListViewFilterRetentionForTests, useSessionListViewFilters } from './useSessionListViewFilters';
import { buildSessionListConditionLabels, readSessionListWorkFilterSummary, SessionListFilterControl } from './SessionListFilterControl';
import type { SessionListViewFilterController } from './useSessionListViewFilterController';
import { SessionListSearchChrome } from './SessionListSearchChrome';
import { Text } from '@/components/ui/text/Text';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

afterEach(() => {
    standardCleanup();
    clearSessionListViewFilterRetentionForTests();
});

const labels = {
    search: 'Search filters', show: 'Show', myWork: 'My work', assignedToMe: 'Assigned to me',
    following: 'Following', involvingMe: 'Involving me', allAccessible: 'All accessible',
    attention: 'Attention', anyAttention: 'Any', needsMyAttention: 'Only sessions that need me',
    needsMeOnly: 'Needs me only', needsMeOnlyDescription: 'Sessions waiting on you',
    inactiveSessions: 'Inactive sessions', showInactive: 'Show', hideInactive: 'Hide', homes: 'Homes',
    sharedWith: 'Shared with', outsideTeams: 'Personal & direct', tags: 'Tags', source: 'Source',
    allSources: 'All', persistedSource: 'Happier', directSource: 'External', noOptions: 'No options',
    clear: 'Reset', done: 'Done', title: 'Session filters', archived: 'Archived',
    moreTags: (count: number) => `+ ${count} more`,
    resultCount: (count: number) => `${count} sessions`,
    conditions: { ...buildSessionListConditionLabels(), resultCount: (count: number) => `${count} sessions` },
    scope: 'Scope', sessions: 'Sessions', runs: 'Runs', both: 'Both', startedBy: 'Started by',
    startedByYou: 'You', startedByTriggers: 'Triggers', startedByAgents: 'Agents',
    runsNeedingYouAlwaysShow: 'Runs that need you always show',
    onlyCoordinators: 'Only coordinators', onlyCoordinatorsDescription: 'Sessions coordinating other work',
    status: 'Status', statusWorking: 'Working', statusNeedsYou: 'Needs you', statusFailed: 'Failed', statusIdle: 'Idle', statusOffline: 'Offline',
    project: 'Project', projectIs: 'Is', projectIsNot: "Isn't",
} as const;

type HarnessOverrides = Partial<SessionListFilterEditorProps>;

function editorProps(overrides: HarnessOverrides = {}): SessionListFilterEditorProps {
    return {
        filters: createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] }),
        includeInactive: true,
        queryEnabled: true,
        followingAvailable: true,
        sourceAvailable: true,
        homes: [{ serverId: 'home-a', label: 'Home A' }],
        audiences: [],
        tags: [],
        labels,
        updateFilters: vi.fn(),
        removeAuthoritativelyDeletedSelections: vi.fn(),
        setIncludeInactive: vi.fn(),
        setSource: vi.fn(),
        resetFilters: vi.fn(),
        disableTransitions: true,
        ...overrides,
    };
}

describe('SessionListFilterEditor panel', () => {
    it('keeps the fixed Runs filter summary visible at its default and Reset preserves the Runs destination', async () => {
        let owner: ReturnType<typeof useSessionListViewFilters> | null = null;
        function RunsFilterSummaryHarness() {
            const retained = useSessionListViewFilters({ contextKey: 'runs-summary-panel', fixedShow: 'runs',
                defaults: { homeServerIds: ['home-a'] }, accountScopeResolutions: new Map() });
            owner = retained;
            const summary = readSessionListWorkFilterSummary({ filters: retained.filters,
                defaultFilters: createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] }), fixedShow: 'runs' });
            return <>
                <SessionListSearchChrome searchQuery="" onSearchQueryChange={retained.setSearchQuery}
                    filterSummary={summary ? { label: summary, onReset: retained.resetFilters } : undefined} />
                <Text testID="retained-runs-filter">{JSON.stringify({ show: retained.filters.show, startedBy: retained.filters.startedBy })}</Text>
            </>;
        }
        const screen = await renderScreen(<RunsFilterSummaryHarness />);
        expect(screen.getTextContent()).toContain('Runs · You');
        await act(async () => owner!.updateFilters(filters => ({ ...filters, startedBy: ['you', 'triggers'] })));
        expect(screen.getTextContent()).toContain('Runs · You, Triggers');
        await screen.pressByTestIdAsync('session-list-filter-summary-reset');
        expect(screen.getTextContent()).toContain('"show":"runs","startedBy":["you"]');
        expect(screen.getTextContent()).toContain('Runs · You');
    });
    it('shows a quiet active-filter summary without search and Reset reaches the retained owner', async () => {
        let owner: ReturnType<typeof useSessionListViewFilters> | null = null;
        function FilterSummaryHarness() {
            const retained = useSessionListViewFilters({
                contextKey: 'summary-panel', defaults: { homeServerIds: ['home-a'] },
                accountScopeResolutions: new Map(),
            });
            owner = retained;
            const summary = readSessionListWorkFilterSummary({
                filters: retained.filters,
                defaultFilters: createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] }),
            });
            return <>
                <SessionListSearchChrome
                    searchQuery=""
                    onSearchQueryChange={retained.setSearchQuery}
                    filterSummary={summary ? {
                        label: summary, onReset: retained.resetFilters,
                    } : undefined}
                />
                <Text testID="retained-work-filter">{JSON.stringify({ show: retained.filters.show, startedBy: retained.filters.startedBy })}</Text>
            </>;
        }
        const screen = await renderScreen(<FilterSummaryHarness />);
        expect(screen.findByTestId('session-list-filter-summary')).toBeNull();
        await act(async () => owner!.updateFilters((filters) => ({ ...filters, show: 'runs', startedBy: ['you', 'triggers'] })));
        expect(screen.getTextContent()).toContain('Runs · You, Triggers');
        await screen.pressByTestIdAsync('session-list-filter-summary-reset');
        expect(screen.findByTestId('session-list-filter-summary')).toBeNull();
        expect(screen.getTextContent()).toContain('"show":"both","startedBy":["you"]');
    });

    it('names the space in the Sessions title and marks Runs narrowing in the Runs summary control', async () => {
        const defaults = createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] });
        const controller: SessionListViewFilterController = {
            filters: defaults, displayFilters: defaults, defaultFilters: defaults, contextDefaultFilters: defaults, updateFilters: vi.fn(), setSearchQuery: vi.fn(),
            removeAuthoritativelyDeletedSelections: vi.fn(), resetFilters: vi.fn(), includeInactive: true,
            showCoordinatorsRequest: 0, acknowledgeShowCoordinatorsRequest: vi.fn(),
            corpusStorage: 'active', setIncludeInactive: vi.fn(), setSource: vi.fn(), queryEnabled: true,
            corpusPresentation: 'semantic_query', queryHomes: [], pagingHomes: [], followingAvailable: true,
            sourceAvailable: true, homeOptions: [{ serverId: 'home-a', label: 'Home A' }],
            viewContext: { kind: 'global' }, viewContextKey: 'global', retentionScopeKey: 'home-a',
            spaces: [], selectedSpaceId: 'my-work', selectedSpace: null, spacesReady: false,
            activeSpace: null, spacesEnabled: false,
            spaceSettingsScope: null, includeNeedsYouEverywhere: false, isSpaceModified: false,
        };
        const chrome = createSessionListSpaceChromeFixture();
        const screen = await renderScreen(<SessionListFilterControl spaceChrome={chrome} controller={controller} organizationProjectionsByServerId={{}} />);
        // The Sessions column's title is the space's menu, not a filter trigger (lab `clfilter`).
        expect(screen.findByTestId('session-list-filter-trigger')).toBeNull();
        expect(screen.findByTestId('session-list-space-title')?.props.accessibilityLabel).toContain('My work');
        const runs = { ...controller, fixedShow: 'runs' as const, filters: { ...defaults, show: 'runs' as const } };
        await act(async () => screen.update(<SessionListFilterControl spaceChrome={chrome} controller={runs} organizationProjectionsByServerId={{}} />));
        expect(screen.findByTestId('session-list-filter-trigger')?.props.accessibilityState.selected).toBe(false);
        await act(async () => screen.update(<SessionListFilterControl spaceChrome={chrome} controller={{ ...runs, filters: { ...runs.filters, startedBy: [] } }} organizationProjectionsByServerId={{}} />));
        expect(screen.findByTestId('session-list-filter-trigger')?.props.accessibilityState.selected).toBe(true);
    });

    it('adds Sessions and runs and Started by as conditions over retained state; Clear restores the base', async () => {
        function RetainedFilterEditor() {
            const owner = useSessionListViewFilters({
                contextKey: 'filter-panel',
                defaults: { homeServerIds: ['home-a'] },
                accountScopeResolutions: new Map(),
            });
            return <SessionListFilterEditor {...editorProps({ ...owner })} />;
        }
        const screen = await renderScreen(<RetainedFilterEditor />);
        // At the base only Whose shows; nothing narrows yet.
        expect(screen.findByTestId('collection-filter-condition:scope:is')).not.toBeNull();
        expect(screen.findByTestId('collection-filter-condition:show:is')).toBeNull();

        await addField(screen, 'show');
        await screen.pressByTestIdAsync(sharedValue('show', 'runs'));
        // A one-value field closes its values once chosen and shows as a condition.
        expect(screen.findByTestId('collection-filter-condition:show:is')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Runs');

        await addField(screen, 'startedBy');
        await screen.pressByTestIdAsync(sharedValue('startedBy', 'triggers'));
        await screen.pressByTestIdAsync(sharedValue('startedBy', 'you'));
        await screen.pressByTestIdAsync('collection-filter-back');
        expect(screen.findByTestId('collection-filter-condition:startedBy:is')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Triggers');

        await screen.pressByTestIdAsync('collection-filter-condition:show:is:remove');
        expect(screen.findByTestId('collection-filter-condition:show:is')).toBeNull();
        expect(screen.findByTestId('collection-filter-condition:startedBy:is')).not.toBeNull();

        await screen.pressByTestIdAsync('collection-filter-clear');
        expect(screen.findByTestId('collection-filter-condition:startedBy:is')).toBeNull();
    });

    it('keeps the Runs destination fixed while leaving its Started by field available', async () => {
        const screen = await renderScreen(<SessionListFilterEditor {...editorProps({
            fixedShow: 'runs',
            filters: { ...createSessionListViewFilterDefaults(), show: 'runs' },
        })} />);
        await screen.pressByTestIdAsync('collection-filter-add');
        expect(screen.findByTestId(fieldOption('show'))).toBeNull();
        expect(screen.findByTestId(fieldOption('startedBy'))).not.toBeNull();
    });

    it('offers only the available scopes for Whose and writes the chosen one; Archived opens without writing', async () => {
        const updateFilters = vi.fn();
        const setIncludeInactive = vi.fn();
        const onOpenArchived = vi.fn();
        const screen = await renderScreen(
            <SessionListFilterEditor {...editorProps({ followingAvailable: false, updateFilters, setIncludeInactive, onOpenArchived })} />,
        );
        await screen.pressByTestIdAsync('collection-filter-condition:scope:is:value');
        expect(screen.findByTestId(valueOption('scope:my_work'))).not.toBeNull();
        // Following is not answerable on this Home: choosing it writes nothing.
        const following = screen.findByTestId(valueOption('scope:following'));
        if (following) await screen.pressByTestIdAsync(valueOption('scope:following'));
        expect(updateFilters).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync(valueOption('scope:all_accessible'));
        expect(updateFilters).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'all_accessible' }));

        updateFilters.mockClear();
        await screen.pressByTestIdAsync('collection-filter-condition:scope:is:value');
        await screen.pressByTestIdAsync(valueOption('destination:archived'));
        expect(onOpenArchived).toHaveBeenCalledTimes(1);
        expect(updateFilters).not.toHaveBeenCalled();
        expect(setIncludeInactive).not.toHaveBeenCalled();
    });

    it('writes Needs me, Hide inactive and Source through their existing owners', async () => {
        const updateFilters = vi.fn();
        const setIncludeInactive = vi.fn();
        const setSource = vi.fn();
        const screen = await renderScreen(<SessionListFilterEditor {...editorProps({ updateFilters, setIncludeInactive, setSource })} />);

        await addField(screen, 'attention');
        expect(updateFilters).toHaveBeenLastCalledWith(expect.objectContaining({ attention: 'needs_my_attention' }));
        await addField(screen, 'includeInactive');
        expect(setIncludeInactive).toHaveBeenLastCalledWith(false);
        await addField(screen, 'source');
        await screen.pressByTestIdAsync(sharedValue('source', 'direct'));
        expect(setSource).toHaveBeenLastCalledWith('direct');
        // Source has its own persisted owner; it never also writes the retained view filters.
        expect(updateFilters).toHaveBeenCalledTimes(1);
    });

    it('removing Needs me returns to any attention', async () => {
        const updateFilters = vi.fn();
        const filters: SessionListViewFilters = {
            ...createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] }),
            attention: 'needs_my_attention',
        };
        const screen = await renderScreen(<SessionListFilterEditor {...editorProps({ filters, updateFilters })} />);
        expect(screen.getTextContent()).toContain('Waiting on you');
        await screen.pressByTestIdAsync('collection-filter-condition:attention:is:remove');
        expect(updateFilters).toHaveBeenLastCalledWith(expect.objectContaining({ attention: 'any' }));
    });

    it('selects Homes and Tags by qualified identity through their value lists', async () => {
        const updateFilters = vi.fn();
        const tags = Array.from({ length: 7 }, (_, index) => ({ serverId: 'home-a', tagId: `tag-${index}`, label: `tag ${index}` }));
        const filters = createSessionListViewFilterDefaults({ homeServerIds: ['home-a', 'home-b'] });
        const screen = await renderScreen(<SessionListFilterEditor {...editorProps({
            filters,
            updateFilters,
            homes: [{ serverId: 'home-a', label: 'Home A' }, { serverId: 'home-b', label: 'Home B' }],
            tags,
        })} />);

        await addField(screen, 'homeServerIds');
        await screen.pressByTestIdAsync(sharedValue('homeServerIds', 'home-b'));
        expect(updateFilters).toHaveBeenLastCalledWith(expect.objectContaining({ homeServerIds: ['home-a'] }));
        await screen.pressByTestIdAsync('collection-filter-back');

        await addField(screen, 'tagIds');
        const lastTag = sharedValue('tagIds', JSON.stringify({ serverId: 'home-a', tagId: 'tag-6' }));
        await vi.waitFor(() => expect(screen.findByTestId(lastTag)).not.toBeNull());
        await screen.pressByTestIdAsync(lastTag);
        expect(updateFilters).toHaveBeenLastCalledWith(expect.objectContaining({ tagIds: [{ serverId: 'home-a', tagId: 'tag-6' }] }));
    });

    it('states the result count, clears through the filter owner, and Done only closes', async () => {
        const resetFilters = vi.fn();
        const onDone = vi.fn();
        const screen = await renderScreen(<SessionListFilterEditor {...editorProps({ resetFilters, onDone, resultCount: 14 })} />);
        expect(screen.getTextContent()).toContain('14 sessions');
        screen.pressByTestId('collection-filter-clear');
        expect(resetFilters).toHaveBeenCalledTimes(1);
        screen.pressByTestId('collection-filter-done');
        expect(onDone).toHaveBeenCalledTimes(1);
        expect(resetFilters).toHaveBeenCalledTimes(1);
    });

    it('says a partial result is partial instead of an authoritative count', async () => {
        const screen = await renderScreen(<SessionListFilterEditor {...editorProps({ result: { matchedCount: 5, coverage: 'partial' } })} />);
        expect(screen.findByTestId('collection-filter-count')?.props.children).not.toBe('5 sessions');
        expect(screen.getTextContent()).toContain('5');
    });

    it('reaches the touch target from Clear and Done without enlarging what they draw', async () => {
        vi.stubGlobal('navigator', { maxTouchPoints: 1 });
        const screen = await renderScreen(<SessionListFilterEditor {...editorProps({ onDone: vi.fn() })} />);
        const flatten = (style: unknown): Record<string, unknown> => (
            typeof style === 'function'
                ? flatten(style({ hovered: false, pressed: false, focused: false }))
                : Array.isArray(style)
                ? style.reduce<Record<string, unknown>>((result, value) => ({ ...result, ...flatten(value) }), {})
                : (style as Record<string, unknown> | null) ?? {}
        );
        // A touch target is a hit area, not a drawn size (DESIGN.md): drawn height plus the invisible frame's reach.
        const reach = (testID: string) => {
            const control = screen.findByTestId(testID)!;
            const frame = control.findAll((node) => (node.props as { dataSet?: { happierHitArea?: string } }).dataSet?.happierHitArea === 'true')[0];
            const edges = flatten(frame?.props.style);
            return { drawn: Number(flatten(control.props.style).minHeight ?? 0), reached: Number(flatten(control.props.style).minHeight ?? 0) - Number(edges.top ?? 0) - Number(edges.bottom ?? 0) };
        };
        expect(reach('collection-filter-clear').drawn).toBe(24);
        expect(reach('collection-filter-clear').reached).toBeGreaterThanOrEqual(44);
        expect(reach('collection-filter-done').reached).toBeGreaterThanOrEqual(44);
    });
});

const fieldOption = (fieldId: string) => `collection-filter-field:${fieldId}`;
const sharedValue = (fieldId: string, value: string) => `collection-filter-value:${fieldId}:${value}`;
const valueOption = (optionId: string) => `session-list-filter-editor:session-list-filters:option:${optionId}`;

/** Add filter, then the field: a toggle applies at once, a field with values opens them. */
async function addField(screen: Awaited<ReturnType<typeof renderScreen>>, fieldId: string): Promise<void> {
    await screen.pressByTestIdAsync('collection-filter-add');
    await vi.waitFor(() => expect(screen.findByTestId(fieldOption(fieldId))).not.toBeNull());
    await screen.pressByTestIdAsync(fieldOption(fieldId));
}
