import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, renderScreen, standardCleanup } from '@/dev/testkit';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol';

const directoryBinding = vi.hoisted(() => ({
    version: 0,
    listeners: new Set<() => void>(),
    state: { kind: 'loading' } as Record<string, unknown>,
    publish() {
        this.version += 1;
        for (const listener of this.listeners) listener();
    },
}));
const directoryGroupsBinding = vi.hoisted(() => ({
    rows: [] as Array<Record<string, unknown>>,
    status: 'ready' as 'ready' | 'loading',
    enabled: null as boolean | null,
    accountChange: null as Readonly<{ serverId: string; entityId: string }> | null,
}));
const nativeGroupsBinding = vi.hoisted(() => ({
    rows: [] as Array<Readonly<{ id: string; name: string; memberCount: number }>>,
    error: null as { kind: 'unreachable'; retryable: boolean; code: null } | null,
    reload: vi.fn(),
}));
const useTeamGroupMock = vi.hoisted(() => vi.fn());
const canMutateMock = vi.hoisted(() => ({ current: true }));
const runActionMock = vi.hoisted(() => vi.fn());
const removeSourceMock = vi.hoisted(() => vi.fn());
const readRemovalImpactMock = vi.hoisted(() => vi.fn());
const routerBackMock = vi.hoisted(() => vi.fn());
const executeExternalGroupBindingMock = vi.hoisted(() => vi.fn());
const executeIdentityActionMock = vi.hoisted(() => vi.fn());
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));
const directoryGroupsReloadMock = vi.hoisted(() => vi.fn());
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));
const capabilitiesMock = vi.hoisted(() => ({
    current: { manageAuthentication: true, manageGroups: true },
}));
const announceMock = vi.hoisted(() => vi.fn());
const refreshSourceMock = vi.hoisted(() => vi.fn());
const appStateListeners = vi.hoisted(() => new Set<(state: string) => void>());
const scrollToIndexMock = vi.hoisted(() => vi.fn());
const focusedItems = vi.hoisted(() => [] as string[]);
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const virtualWindow = vi.hoisted(() => ({ enabled: false }));

vi.mock('expo-router', () => ({ useRouter: () => ({ back: routerBackMock }), useLocalSearchParams: () => routeParams.current }));
vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        AppState: {
            ...actual.AppState,
            addEventListener: (_type: string, listener: (state: string) => void) => {
                appStateListeners.add(listener);
                return { remove: () => appStateListeners.delete(listener) };
            },
        },
    };
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: modalConfirmMock } }).module;
});
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: 'ActivitySpinner' }));
vi.mock('@/components/ui/forms/CompactSearchField', () => ({ CompactSearchField: 'CompactSearchField' }));
vi.mock('@/components/ui/lists/Item', async () => {
    const React = await import('react');
    return { Item: (props: { testID?: string; rightElement?: unknown; pressableRef?: React.Ref<{ focus: () => void }> }) => {
        React.useLayoutEffect(() => {
            const target = { focus: () => { if (props.testID) focusedItems.push(props.testID); } };
            if (typeof props.pressableRef === 'function') props.pressableRef(target);
            else if (props.pressableRef) props.pressableRef.current = target;
            return () => {
                if (typeof props.pressableRef === 'function') props.pressableRef(null);
                else if (props.pressableRef) props.pressableRef.current = null;
            };
        }, [props.pressableRef, props.testID]);
        return React.createElement('Item', props, props.rightElement as never);
    } };
});
vi.mock('@/components/ui/forms/FieldTextInput', () => ({ FieldTextInput: 'TextInput' }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: announceMock,
}));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: React.forwardRef((props: Readonly<{
        data: readonly { key: string; element: React.ReactElement }[];
        renderItem: (info: { item: { key: string; element: React.ReactElement }; index: number }) => React.ReactNode;
        ListHeaderComponent: React.ReactNode;
    }>, ref) => {
        const [visibleIndex, setVisibleIndex] = React.useState(0);
        React.useImperativeHandle(ref, () => ({ scrollToIndex: (params: { index: number }) => {
            scrollToIndexMock(params);
            if (virtualWindow.enabled) setVisibleIndex(params.index);
        } }), []);
        return React.createElement('VirtualizedList', props, props.ListHeaderComponent,
            ...props.data.flatMap((item, index) => virtualWindow.enabled && index !== visibleIndex
                ? []
                : [React.createElement(React.Fragment, { key: item.key }, props.renderItem({ item, index }))]));
    }),
}));
// The generated bundled-plugin inventory is an unrelated build boundary and
// is intentionally absent from synchronized source-only test targets.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [],
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [],
}));
vi.mock('@/hooks/teams/useTeamGroups', () => ({
    useTeamGroups: () => ({ ...nativeGroupsBinding, isCurrent: !nativeGroupsBinding.error, hasMore: false, status: nativeGroupsBinding.error ? 'error' : 'ready', loadMore: vi.fn() }),
    useTeamGroup: useTeamGroupMock,
}));
vi.mock('@/hooks/teams/useTeamPagedList', () => ({
    useTeamPagedList: (params: Readonly<{
        enabled: boolean;
        accountChange?: Readonly<{ serverId: string; entityId: string }>;
    }>) => {
        directoryGroupsBinding.enabled = params.enabled;
        directoryGroupsBinding.accountChange = params.accountChange ?? null;
        return { rows: directoryGroupsBinding.rows, hasMore: false, status: directoryGroupsBinding.status, error: null, reload: directoryGroupsReloadMock, loadMore: vi.fn() };
    },
}));
vi.mock('./DirectoryPeopleList', async (importOriginal) => ({
    ...await importOriginal<typeof import('./DirectoryPeopleList')>(),
    useDirectoryPeopleList: () => ({ rows: [], hasMore: false, status: 'ready', error: null, reload: vi.fn(), loadMore: vi.fn() }),
}));
vi.mock('./identityAdministrationClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('./identityAdministrationClient')>(),
    createIdentityAdministrationClient: () => ({
        execute: executeIdentityActionMock,
        executeDirectory: vi.fn(),
        executeExternalGroupBinding: executeExternalGroupBindingMock,
    }),
}));
vi.mock('./useDirectoryAdministration', async () => {
    const ReactModule = await import('react');
    return {
        useDirectorySourceAdministration: () => {
            ReactModule.useSyncExternalStore(
                (listener) => {
                    directoryBinding.listeners.add(listener);
                    return () => directoryBinding.listeners.delete(listener);
                },
                () => directoryBinding.version,
            );
            return {
                state: directoryBinding.state,
                refresh: refreshSourceMock,
                pendingAction: null,
                runAction: runActionMock,
                readRemovalImpact: readRemovalImpactMock,
                removeSource: removeSourceMock,
            };
        },
    };
});
vi.mock('../TeamSection', () => ({
    TeamSection: (props: Readonly<{
        children: (context: unknown, header?: React.ReactNode) => React.ReactNode;
    }>) => props.children(
        {
            team: {
                id: 'team-1',
                capabilities: {
                    manageAuthentication: capabilitiesMock.current.manageAuthentication,
                    manageGroups: capabilitiesMock.current.manageGroups,
                },
            },
            scope: { serverId: 'home-1', accountId: 'account-1' },
            address: { serverId: 'home-1', teamId: 'team-1' },
            canMutate: canMutateMock.current,
            requestApproval: vi.fn(),
        },
        // The real shell hands its approval/stale/archived notices to a
        // virtualized child. Reproducing that here is what lets these tests see
        // whether a non-ready branch silently drops them.
        React.createElement('TeamShellHeader', { testID: 'team-shell-header' }),
    ),
}));
vi.mock('@/text', async () => {
    // The canonical text mock so a parameterized string is observable as
    // `key(param=value)`: a count this screen shows must be assertable.
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { DirectorySourceDetailScreen } from './DirectorySourceDetailScreen';
import { DIRECTORY_SOURCE_SETTINGS } from './directorySettings';

beforeEach(() => {
    standardCleanup();
    modalConfirmMock.mockReset();
    modalConfirmMock.mockResolvedValue(true);
    directoryBinding.state = { kind: 'loading' };
    directoryGroupsBinding.rows = [];
    directoryGroupsBinding.status = 'ready';
    directoryGroupsBinding.enabled = null;
    directoryGroupsBinding.accountChange = null;
    nativeGroupsBinding.rows = [];
    nativeGroupsBinding.error = null;
    nativeGroupsBinding.reload.mockReset();
    useTeamGroupMock.mockReset();
    canMutateMock.current = true;
    runActionMock.mockReset();
    runActionMock.mockResolvedValue({ ok: true, value: {} });
    removeSourceMock.mockReset();
    removeSourceMock.mockResolvedValue({ ok: true, value: { v: 1, sourceId: 'source-1' } });
    readRemovalImpactMock.mockReset();
    readRemovalImpactMock.mockResolvedValue({
        ok: true,
        value: {
            v: 1,
            status: 'allowed',
            sourceId: 'source-1',
            sourceLabel: 'Example directory',
            impact: {
                teamMembershipsRemoved: 0,
                groupMembershipsRemoved: 0,
                groupContributionsRemoved: 0,
                directoryCreatedGroupsRetained: 0,
                nativeMembershipsPreserved: 0,
                nativeGroupContributionsPreserved: 0,
            },
        },
    });
    routerBackMock.mockReset();
    executeExternalGroupBindingMock.mockReset();
    executeIdentityActionMock.mockReset();
    executeIdentityActionMock.mockResolvedValue({ ok: true, value: { url: 'https://setup.example.test/dsync' } });
    openExternalUrlMock.mockClear();
    directoryGroupsReloadMock.mockReset();
    announceMock.mockReset();
    refreshSourceMock.mockReset();
    appStateListeners.clear();
    scrollToIndexMock.mockClear();
    focusedItems.length = 0;
    routeParams.current = {};
    virtualWindow.enabled = false;
    capabilitiesMock.current = { manageAuthentication: true, manageGroups: true };
});

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
});

/** Every string rendered beneath a node, in order. */
function renderedText(node: import('react-test-renderer').ReactTestInstance | string): string {
    return typeof node === 'string' ? node : node.children.map(renderedText).join('');
}

/** What the recomposed control or notice actually says on screen (its rendered text). */
function textOfTestId(screen: Readonly<{ findHostByTestId(testID: string): import('react-test-renderer').ReactTestInstance | null }>, testID: string): string | undefined {
    const node = screen.findHostByTestId(testID);
    return node ? renderedText(node) || undefined : undefined;
}

describe('DirectorySourceDetailScreen', () => {
    it.each([
        ['remove', 'source-remove', 'team-directory-source-remove'],
        ['searchGroups', 'groups-search', 'directory-groups-search'],
    ] as const)('reveals the virtual %s search anchor after its source loads', async (setting, rowKey, controlId) => {
        const anchor = DIRECTORY_SOURCE_SETTINGS.settings[setting].anchor;
        routeParams.current = { setting: anchor };
        virtualWindow.enabled = true;
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);
        expect(screen.findByTestId(controlId)).toBeNull();
        expect(scrollToIndexMock).not.toHaveBeenCalled();

        await act(async () => {
            directoryBinding.state = {
                kind: 'ready', refreshing: false, stale: false, failure: null,
                item: {
                    v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                    state: 'active', allowedActions: ['teams.directory.sources.remove'], error: null,
                    sync: { mode: 'events_and_full', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
                },
            };
            directoryGroupsBinding.rows = Array.from({ length: 30 }, (_, index) => ({
                id: `external-group-${index}`, displayName: `External Group ${index}`,
                memberCount: 0, boundAccountCount: 0, unboundPeopleCount: 0, mapping: { state: 'unbound' },
            }));
            directoryBinding.publish();
        });

        const list = screen.findByTestId('directory-source-detail-virtualized-list');
        const index = list?.props.data.findIndex((row: { key: string }) => row.key === rowKey);
        expect(index).toBeGreaterThan(0);
        expect(scrollToIndexMock).toHaveBeenCalledWith(expect.objectContaining({ index }));
        expect(screen.findByTestId(controlId)).not.toBeNull();
        expect(screen.findByTestId(`setting-reveal.${anchor}`)).not.toBeNull();

        scrollToIndexMock.mockClear();
        await act(async () => {
            directoryGroupsBinding.rows = [...directoryGroupsBinding.rows, { id: 'new-group', displayName: 'New Group', memberCount: 0, boundAccountCount: 0, unboundPeopleCount: 0, mapping: { state: 'unbound' } }];
            directoryBinding.publish();
        });
        expect(scrollToIndexMock).not.toHaveBeenCalled();
    });

    it('explains a denied Group search target without loading or exposing Group data', async () => {
        vi.useFakeTimers();
        routeParams.current = { setting: DIRECTORY_SOURCE_SETTINGS.settings.searchGroups.anchor };
        capabilitiesMock.current = { manageAuthentication: true, manageGroups: false };
        directoryBinding.state = {
            kind: 'ready', refreshing: false, stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                state: 'active', allowedActions: [], error: null,
                sync: { mode: 'events_and_full', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        };
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(screen.findByTestId('directory-groups-forbidden')).not.toBeNull();
        expect(screen.findByTestId(`setting-reveal.${DIRECTORY_SOURCE_SETTINGS.sectionRefs.groups.id}`)).not.toBeNull();
        expect(screen.findByTestId('directory-groups-search')).toBeNull();
        expect(directoryGroupsBinding.enabled).toBe(false);
    });

    it('renders a bound directory Group with the canonical Team Group display name', async () => {
        directoryBinding.state = {
            kind: 'ready', refreshing: false, stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                state: 'active', allowedActions: [], error: null,
                sync: { mode: 'events_and_full', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        };
        directoryGroupsBinding.rows = [{
            id: 'external-group-1', sourceId: 'source-1', externalGroupId: 'external-1', displayName: 'External engineering',
            memberCount: 4, boundAccountCount: 4, unboundPeopleCount: 0, mapping: { state: 'bound', bindingId: 'binding-1', teamGroupId: 'team-group-opaque-id', teamGroupName: 'Platform Engineering' },
        }];
        nativeGroupsBinding.rows = [];

        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        expect(screen.findByTestId('directory-group:external-group-1')?.props.subtitle)
            .toBe('identityAdministration.mappedTo: Platform Engineering');
        directoryGroupsBinding.rows = [{ ...directoryGroupsBinding.rows[0], mapping: {
            state: 'bound', bindingId: 'binding-1', teamGroupId: 'team-group-opaque-id', teamGroupName: null,
        } }];
        nativeGroupsBinding.rows = [{ id: 'team-group-opaque-id', name: 'A retained name the reader withheld', memberCount: 4 }];
        // This fixture hook has no subscription: mount the withheld projection rather than
        // pretending an equal-props update can wake the memoized real screen.
        const withheldScreen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);
        expect(withheldScreen.findByTestId('directory-group:external-group-1')?.props.subtitle)
            .toBe('identityAdministration.mappedTo: identityAdministration.mappedGroupNotVisible');
    });

    it('projects a full directory page of mapping labels from the directory reader', async () => {
        directoryBinding.state = {
            kind: 'ready', refreshing: false, stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                state: 'active', allowedActions: [], error: null,
                sync: { mode: 'events_and_full', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        };
        directoryGroupsBinding.rows = Array.from({ length: 50 }, (_, index) => ({
            id: `external-group-${index}`,
            displayName: `External Group ${index}`,
            memberCount: index,
            boundAccountCount: index,
            unboundPeopleCount: 0,
            mapping: { state: 'bound', teamGroupId: `team-group-${index}`, teamGroupName: `Team Group ${index}` },
        }));
        nativeGroupsBinding.rows = Array.from({ length: 50 }, (_, index) => ({
            id: `team-group-${index}`,
            name: `Team Group ${index}`,
            memberCount: index,
        }));

        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        expect(screen.findByTestId('directory-group:external-group-49')?.props.subtitle)
            .toBe('identityAdministration.mappedTo: Team Group 49');
        expect(useTeamGroupMock).not.toHaveBeenCalled();
    });

    it('disables source and mapping mutations for a read-only Team', async () => {
        canMutateMock.current = false;
        directoryBinding.state = {
            kind: 'ready', refreshing: false, stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                state: 'active', allowedActions: ['teams.directory.sources.sync', 'teams.directory.sources.remove'], error: null,
                sync: { mode: 'events_and_full', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        };
        directoryGroupsBinding.rows = [{
            id: 'external-group-1', displayName: 'Engineering', memberCount: 4, boundAccountCount: 4, unboundPeopleCount: 0, mapping: { state: 'unbound' },
        }];
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        expect(screen.findByTestId('team-directory-source-sync')?.props.disabled).toBe(true);
        expect(screen.findByTestId('team-directory-source-remove')?.props.disabled).toBe(true);
        expect(screen.findByTestId('directory-group:external-group-1')?.props.disabled).toBe(true);
    });

    it.each(['source', 'groups'])('blocks mapping mutations while its authoritative %s projection refreshes', async (reader) => {
        directoryGroupsBinding.status = reader === 'groups' ? 'loading' : 'ready';
        directoryBinding.state = {
            kind: 'ready', refreshing: reader === 'source', stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                state: 'active', allowedActions: ['teams.directory.sources.sync', 'teams.directory.sources.remove'], error: null,
                sync: { mode: 'events_and_full', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        };
        directoryGroupsBinding.rows = [{
            id: 'external-group-1', displayName: 'Engineering', memberCount: 4, boundAccountCount: 4, unboundPeopleCount: 0, mapping: { state: 'unbound' },
        }];
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        expect(screen.findByTestId('team-directory-source-sync')?.props.disabled).toBe(reader === 'source');
        expect(screen.findByTestId('team-directory-source-remove')?.props.disabled).toBe(reader === 'source');
        expect(screen.findByTestId('directory-group:external-group-1')?.props.disabled).toBe(true);
    });

    it('keeps its hook order stable when the source finishes loading', async () => {
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);
        await expect(act(async () => {
            directoryBinding.state = {
                kind: 'ready',
                refreshing: false,
                stale: false,
                failure: null,
                item: {
                    v: 1,
                    id: 'source-1',
                    teamId: 'team-1',
                    kind: 'workos_directory',
                    displayName: 'Example directory',
                    state: 'paused',
                    allowedActions: ['teams.directory.sources.resume'],
                    sync: {
                        mode: 'events_and_full',
                        attempt: 'paused',
                        freshness: 'stale',
                        lastAttemptAt: null,
                        lastSuccessAt: null,
                        lastFullReconcileAt: null,
                        nextScheduledAt: null,
                    },
                    error: null,
                },
            };
            directoryBinding.publish();
        })).resolves.toBeUndefined();
        // The state is the header's first fact.
        expect(screen.findByTestId('team-directory-source-status')).not.toBeNull();
        expect(renderedText(screen.tree.root)).toContain('teams.authentication.directory.state.paused');
        expect(screen.tree.root.findAllByType('VirtualizedList' as never)).toHaveLength(1);
    });

    it('keeps the Team shell notices and one list root while the source is still loading', async () => {
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        expect(screen.findByTestId('team-shell-header')).not.toBeNull();
        expect(screen.tree.root.findAllByType('VirtualizedList' as never)).toHaveLength(1);
    });

    it('keeps the Team shell notices and one list root when the source is unavailable', async () => {
        directoryBinding.state = {
            kind: 'unavailable',
            failure: { code: 'home_unreachable', retryable: true },
        };
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        expect(screen.findByTestId('team-shell-header')).not.toBeNull();
        expect(screen.findByTestId('team-directory-source-unavailable')).not.toBeNull();
        expect(screen.tree.root.findAllByType('VirtualizedList' as never)).toHaveLength(1);
    });

    it('keeps the Team shell notices when the viewer may not manage this directory', async () => {
        vi.useFakeTimers();
        routeParams.current = { setting: DIRECTORY_SOURCE_SETTINGS.settings.searchGroups.anchor };
        capabilitiesMock.current = { manageAuthentication: false, manageGroups: false };
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

        expect(screen.findByTestId('team-shell-header')).not.toBeNull();
        expect(screen.findByTestId('team-directory-source-forbidden')).not.toBeNull();
        expect(screen.findByTestId(`setting-reveal.${DIRECTORY_SOURCE_SETTINGS.sectionRefs.actions.id}`)).not.toBeNull();
    });

    it('keeps source administration available without exposing Group mappings to an authentication-only manager', async () => {
        capabilitiesMock.current = { manageAuthentication: true, manageGroups: false };
        directoryBinding.state = {
            kind: 'ready', refreshing: false, stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                state: 'active', allowedActions: ['teams.directory.sources.sync', 'teams.directory.sources.pause', 'teams.directory.sources.remove'], error: null,
                sync: { mode: 'events_and_full', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        };
        directoryGroupsBinding.rows = [{
            id: 'external-group-1', displayName: 'Engineering', memberCount: 4, mapping: { state: 'unbound' },
        }];

        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        expect(screen.findByTestId('team-directory-source-status')).not.toBeNull();
        expect(screen.findByTestId('team-directory-source-sync')?.props.disabled).toBe(false);
        expect(screen.findByTestId('team-directory-source-pause')?.props.disabled).toBe(false);
        expect(screen.findByTestId('team-directory-source-remove')?.props.disabled).toBe(false);
        expect(screen.findByTestId('directory-groups-search')).toBeNull();
        expect(screen.findByTestId('directory-group:external-group-1')).toBeNull();
        expect(directoryGroupsBinding.enabled).toBe(false);

        await screen.pressByTestIdAsync('team-directory-source-sync');
        expect(runActionMock).toHaveBeenCalledWith('teams.directory.sources.sync', {
            onApprovalFailed: expect.any(Function),
        });
    });

    it('does not let Group authority substitute for authentication administration authority', async () => {
        capabilitiesMock.current = { manageAuthentication: false, manageGroups: true };

        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        expect(screen.findByTestId('team-directory-source-forbidden')).not.toBeNull();
        expect(screen.findByTestId('directory-groups-search')).toBeNull();
    });

    it('presents the canonical typed message for source and action failures', async () => {
        directoryBinding.state = {
            kind: 'ready', refreshing: false, stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                state: 'needs_attention', allowedActions: ['teams.directory.sources.sync'],
                error: { code: 'directory_source_permission_lost', retryable: false },
                sync: { mode: 'events_and_full', attempt: 'failed', freshness: 'stale', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        };
        runActionMock.mockResolvedValueOnce({
            ok: false,
            failure: { code: 'directory_sync_rate_limited', retryable: true },
        });

        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        // A lost directory permission is an administrator's job, not a provider
        // outage: the one failure owner answers `needs_attention` so no Retry
        // is offered for something a retry cannot clear.
        expect(textOfTestId(screen, 'team-directory-source-error'))
            .toContain('identityAdministration.errorNeedsAttention');
        await screen.pressByTestIdAsync('team-directory-source-sync');
        const visibleMessage = textOfTestId(screen, 'team-directory-source-action-error');
        expect(visibleMessage).toBe('identityAdministration.errorRateLimited');
        expect(announceMock).toHaveBeenCalledWith(visibleMessage);

        // The Home refuses Sync with needs-attention only for a paused source
        // (child 05 :498), whose recovery is Resume.
        runActionMock.mockResolvedValueOnce({
            ok: false,
            failure: { code: 'directory_sync_needs_attention', retryable: false },
        });
        await screen.pressByTestIdAsync('team-directory-source-sync');
        expect(textOfTestId(screen, 'team-directory-source-action-error'))
            .toBe('identityAdministration.errorSyncPaused');
    });

    it('offers the existing Sync control as Retry while the source reports a failure', async () => {
        const sourceWith = (error: Record<string, unknown> | null) => ({
            kind: 'ready', refreshing: false, stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                state: error ? 'needs_attention' : 'active',
                allowedActions: ['teams.directory.sources.sync', 'teams.directory.sources.pause'],
                error,
                sync: { mode: 'events_and_full', attempt: error ? 'failed' : 'succeeded', freshness: 'fresh', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        });
        directoryBinding.state = sourceWith({ code: 'directory_source_permission_lost', retryable: false });

        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        // child 05 §14.1: a failed source offers Retry, and pressing it runs
        // the one Sync Action (a complete scan), not a Pause → Resume detour.
        expect(textOfTestId(screen, 'team-directory-source-sync')).toBe('common.retry');
        await screen.pressByTestIdAsync('team-directory-source-sync');
        expect(runActionMock).toHaveBeenCalledWith('teams.directory.sources.sync', expect.anything());

        await act(async () => {
            directoryBinding.state = sourceWith(null);
            directoryBinding.publish();
        });
        expect(textOfTestId(screen, 'team-directory-source-sync'))
            .toBe('teams.authentication.directory.actions.sync');
    });

    it('binds the mounted directory Group list to its exact Home Team wake', async () => {
        directoryBinding.state = {
            kind: 'ready', refreshing: false, stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                state: 'active', allowedActions: [], error: null,
                sync: { mode: 'events_and_full', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        };

        await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        // A projection change is published as the Team AccountChange; without
        // this subscription a mounted Group list kept its old rows until remount.
        expect(directoryGroupsBinding.accountChange)
            .toEqual({ serverId: 'home-1', entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 });
    });

    it('opens exact source-bound WorkOS recovery for immediate and approved results', async () => {
        directoryBinding.state = {
            kind: 'ready', refreshing: false, stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                workosAdminPortalConnectionId: 'connection-1',
                state: 'needs_attention', allowedActions: ['teams.directory.sources.sync'], error: null,
                sync: { mode: 'events_and_full', attempt: 'failed', freshness: 'stale', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        };
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        await screen.pressByTestIdAsync('team-directory-source-open-workos');
        expect(executeIdentityActionMock).toHaveBeenCalledWith(
            'teams.identity.workos.adminPortalLink.create',
            {
                v: 1,
                teamId: 'team-1',
                connectionId: 'connection-1',
                directorySourceId: 'source-1',
                intent: 'dsync',
            },
            expect.objectContaining({
                onApprovalSucceeded: expect.any(Function),
                onApprovalFailed: expect.any(Function),
            }),
        );
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://setup.example.test/dsync');
        await act(async () => {
            for (const listener of appStateListeners) listener('active');
        });
        expect(refreshSourceMock).toHaveBeenCalledOnce();

        let continueApproved: ((value: Readonly<{ url: string }>) => Promise<void>) | undefined;
        executeIdentityActionMock.mockImplementationOnce(async (
            _actionId: string,
            _input: unknown,
            options: Readonly<{ onApprovalSucceeded: typeof continueApproved }>,
        ) => {
            continueApproved = options.onApprovalSucceeded;
            return { ok: false, approvalPending: true, artifactId: 'approval-portal', failure: { code: 'approval_pending', retryable: false } };
        });
        await screen.pressByTestIdAsync('team-directory-source-open-workos');
        expect(continueApproved).toBeTypeOf('function');
        await act(async () => {
            await continueApproved?.({ url: 'https://setup.example.test/approved' });
        });
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://setup.example.test/approved');
    });

    it('navigates back exactly once when approved source removal executes', async () => {
        directoryBinding.state = {
            kind: 'ready', refreshing: false, stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                state: 'active', allowedActions: ['teams.directory.sources.remove'], error: null,
                sync: { mode: 'events_and_full', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        };
        let finishRemoval: ((value: Readonly<{ sourceId: string }>) => void | Promise<void>) | undefined;
        removeSourceMock.mockImplementationOnce(async (
            options?: Readonly<{ onApprovalSucceeded?: typeof finishRemoval }>,
        ) => {
            finishRemoval = options?.onApprovalSucceeded;
            return {
                ok: false,
                approvalPending: true,
                artifactId: 'approval-source-remove',
                failure: { code: 'approval_pending', retryable: false },
            };
        });
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        await screen.pressByTestIdAsync('team-directory-source-remove');
        expect(removeSourceMock).toHaveBeenCalledWith(expect.objectContaining({
            onApprovalSucceeded: expect.any(Function),
            onApprovalFailed: expect.any(Function),
        }));
        expect(finishRemoval).toBeTypeOf('function');
        expect(routerBackMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('team-directory-source-action-error')).toBeNull();

        await act(async () => {
            await finishRemoval?.({ sourceId: 'source-1' });
        });
        expect(routerBackMock).toHaveBeenCalledOnce();
    });

    it('reloads a mapping after approval and exposes terminal failure for retry', async () => {
        directoryBinding.state = {
            kind: 'ready', refreshing: false, stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                state: 'active', allowedActions: [], error: null,
                sync: { mode: 'events_and_full', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        };
        directoryGroupsBinding.rows = [{
            id: 'external-group-1', sourceId: 'source-1', externalGroupId: 'external-1', displayName: 'Engineering',
            memberCount: 4, boundAccountCount: 4, unboundPeopleCount: 0, mapping: { state: 'unbound' },
        }];
        let finishMapping: (() => void | Promise<void>) | undefined;
        let failMapping: ((code: string) => void) | undefined;
        executeExternalGroupBindingMock.mockImplementationOnce(async (
            _actionId: string,
            _input: unknown,
            options?: Readonly<{
                onApprovalSucceeded?: typeof finishMapping;
                onApprovalFailed?: typeof failMapping;
            }>,
        ) => {
            finishMapping = options?.onApprovalSucceeded;
            failMapping = options?.onApprovalFailed;
            return {
                ok: false,
                approvalPending: true,
                artifactId: 'approval-group-map',
                failure: { code: 'approval_pending', retryable: false },
            };
        });
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        await screen.pressByTestIdAsync('directory-group:external-group-1');
        await screen.pressByTestIdAsync('directory-group-map-create');
        expect(executeExternalGroupBindingMock).toHaveBeenCalledWith(
            'teams.externalGroupBindings.set',
            expect.any(Object),
            expect.objectContaining({
                onApprovalSucceeded: expect.any(Function),
                onApprovalFailed: expect.any(Function),
            }),
        );
        expect(finishMapping).toBeTypeOf('function');
        expect(failMapping).toBeTypeOf('function');
        expect(directoryGroupsReloadMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('directory-group-mapping-failure')).toBeNull();

        await act(async () => {
            await finishMapping?.();
        });
        expect(directoryGroupsReloadMock).toHaveBeenCalledOnce();
        expect(screen.findByTestId('directory-group-map-create')).toBeNull();

        await act(async () => {
            failMapping?.('approval_rejected');
        });
        expect(screen.findByTestId('directory-group-mapping-failure')).not.toBeNull();
        expect(screen.findByTestId('directory-group:external-group-1')?.props.disabled).toBe(false);
    });


    it('opens the mapping chooser beside the pressed group instead of after the whole list', async () => {
        directoryBinding.state = {
            kind: 'ready', refreshing: false, stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                state: 'active', allowedActions: [], error: null,
                sync: { mode: 'events_and_full', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        };
        directoryGroupsBinding.rows = Array.from({ length: 30 }, (_, index) => ({
            id: `external-group-${index}`,
            displayName: `External Group ${index}`,
            memberCount: index,
            boundAccountCount: index,
            unboundPeopleCount: 0,
            mapping: { state: 'unbound' },
        }));
        nativeGroupsBinding.rows = [{ id: 'team-group-1', name: 'Platform Engineering', memberCount: 4 }];
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        await screen.pressByTestIdAsync('directory-group:external-group-0');

        const order = collectRenderedTestIds(screen.tree.toJSON());
        expect(order.indexOf('directory-group:external-group-0'))
            .toBeLessThan(order.indexOf('directory-group-map-create'));
        expect(order.indexOf('directory-group-map-create'))
            .toBeLessThan(order.indexOf('directory-group:external-group-1'));
        expect(screen.findByTestId('directory-group:external-group-0')?.props.accessibilityExpanded).toBe(true);
        expect(focusedItems).toContain('directory-group-map-create');
        expect(scrollToIndexMock).toHaveBeenCalledWith(expect.objectContaining({ index: expect.any(Number), animated: false }));
        await act(async () => { screen.findByTestId('directory-group-map-create')?.props.onKeyDown({ key: 'Escape' }); });
        expect(screen.findByTestId('directory-group-map-create')).toBeNull();
        expect(focusedItems.at(-1)).toBe('directory-group:external-group-0');
    });

    it('shows existing Groups directly without an inert map-existing action', async () => {
        directoryBinding.state = {
            kind: 'ready', refreshing: false, stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                state: 'active', allowedActions: [], error: null,
                sync: { mode: 'events_and_full', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        };
        directoryGroupsBinding.rows = [{
            id: 'external-group-1', displayName: 'Engineering', memberCount: 4, boundAccountCount: 4, unboundPeopleCount: 0, mapping: { state: 'unbound' },
        }];
        nativeGroupsBinding.rows = [{ id: 'team-group-1', name: 'Platform Engineering', memberCount: 4 }];
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);

        await screen.pressByTestIdAsync('directory-group:external-group-1');
        expect(screen.findByTestId('directory-group-map-existing')).toBeNull();
        expect(screen.findByTestId('directory-group-native-target:team-group-1')).not.toBeNull();

        await screen.pressByTestIdAsync('directory-group-chooser-cancel');
        expect(screen.findByTestId('directory-group-chooser-cancel')).toBeNull();
    });

    it('shows a failed Team Group chooser read and retries the native Group reader', async () => {
        directoryBinding.state = {
            kind: 'ready', refreshing: false, stale: false, failure: null,
            item: {
                v: 1, id: 'source-1', teamId: 'team-1', kind: 'workos_directory', displayName: 'Example directory',
                state: 'active', allowedActions: [], error: null,
                sync: { mode: 'events_and_full', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
            },
        };
        directoryGroupsBinding.rows = [{ id: 'external-group-1', displayName: 'Engineering', memberCount: 0, boundAccountCount: 0, unboundPeopleCount: 0, mapping: { state: 'unbound' } }];
        nativeGroupsBinding.error = { kind: 'unreachable', retryable: true, code: null };
        nativeGroupsBinding.rows = [{ id: 'retained-group', name: 'Retained Group', memberCount: 4 }];
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId="home-1" teamId="team-1" sourceId="source-1" />);
        await screen.pressByTestIdAsync('directory-group:external-group-1');
        expect(screen.findByTestId('directory-native-groups-error')).not.toBeNull();
        expect(screen.findByTestId('directory-native-groups-empty')).toBeNull();
        expect(screen.findByTestId('directory-group-native-target:retained-group')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('directory-native-groups-retry');
        expect(nativeGroupsBinding.reload).toHaveBeenCalledOnce();
    });
});
