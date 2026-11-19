import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';
import { compileEntityListFilterV1, type CollectionFilterMapV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import type { EntityFilterRegistryV1 } from '@happier-dev/protocol/collections/filter/fieldRegistryV1';
import { createDefaultCollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { DEFAULT_WORKFLOW_LIST_FILTER_V1, workflowListFilterFieldsV1 } from '@happier-dev/protocol/workflows/listing/workflowListFilterV1';
import { DEFAULT_DISCUSSION_LIST_FILTER_V1, discussionListFilterFieldsV1 } from '@happier-dev/protocol/discussions/listing/discussionListFilterV1';
import { DEFAULT_DEPLOYMENT_ENVIRONMENT_LIST_FILTER_V1, deploymentEnvironmentListFilterFieldsV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentListFilterV1';
import { DEFAULT_REVIEW_LIST_FILTER_V1, reviewListFilterFieldsV1 } from '@happier-dev/protocol/reviews/reviewListFilterV1';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { useCollectionSpaceFilter } from './useCollectionSpaceFilter';
import { useCollectionSpaceHeader } from './useCollectionSpaceHeader';
import { useCollectionSpaceEditing } from './useCollectionSpaceEditing';
import { useNewSessionOrganizationPlacement } from '@/components/sessions/new/organization/useNewSessionOrganizationPlacement';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Deleting a space asks once (P6 §7.1); the person confirms it here.
const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    confirmResult: true, spies: { confirm },
}).module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/components/ui/popover', async original => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(original));
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const originalState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(originalState, true); });

async function mountEntity<K extends 'workflow' | 'discussion' | 'deploymentEnvironment' | 'review', Facts>(input: {
    kind: K; defaultFilter: CollectionFilterMapV1[K]; narrowed: CollectionFilterMapV1[K];
    registry: EntityFilterRegistryV1<CollectionFilterMapV1[K], Facts>; rows: readonly (Facts & { id: string })[];
    mode?: 'plain' | 'e2ee';
    settingsVersion?: number;
}) {
    let offline = false;
    const account = await createSecretSettingsTestHarness({ mode: input.mode, settingsVersion: input.settingsVersion, settings: settingsParse({ actionsSettingsV1: ActionsSettingsV1Schema.parse({
        v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] },
    }) }), handleRequest: async (path, init) => {
        if (offline && path === '/v2/account/settings' && init?.method === 'POST') throw new TypeError('Offline');
        return null;
    } });
    let view!: ReturnType<typeof useCollectionSpaceFilter<K>>;
    let header!: ReturnType<typeof useCollectionSpaceHeader<K, Facts>>;
    let ids: string[] = [];
    function Host() {
        const lifetime = useActiveServerAccountScopeLifetime();
        view = useCollectionSpaceFilter(input.kind, { lifetime, defaultName: 'All', defaultFilter: input.defaultFilter });
        header = useCollectionSpaceHeader({ entityKind: input.kind, testIDPrefix: 'joined', defaultName: 'All',
            view, registry: input.registry, bindings: {},
            defaultIcon: createDefaultCollectionSpaceV1(input.kind).icon });
        const match = compileEntityListFilterV1(input.registry, view.filters);
        ids = input.rows.filter(row => match(row) === 'match').map(row => row.id);
        return <>{header.titleControl}{header.strip}{header.conditionRow}{header.overlays}</>;
    }
    const element = <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}><Host /></HappierUiPlatformProvider>;
    const screen = await renderScreen(element);
    const selectTitleMenuItem = async (testID: string) => {
        const menu = screen.tree.findAllByType(DropdownMenu).find(node => node.props.items.some((item: { testID?: string }) => item.testID === testID));
        expect(menu).toBeDefined();
        const item = menu!.props.items.find((item: { testID?: string }) => item.testID === testID);
        await act(async () => { menu!.props.onSelect(item.id); });
    };
    return { account, screen, element, view: () => view, header: () => header, ids: () => ids,
        edit: () => selectTitleMenuItem('joined-menu-edit'),
        saveAs: () => selectTitleMenuItem('joined-menu-save-as'),
        // An ordinary New Session entry mounted now: the Space it starts in, if any.
        newEntrySpaceId: async () => {
            const entry = await renderHook(() => useNewSessionOrganizationPlacement({
                serverId: null, executionTarget: null, directory: '', startInActiveSpace: true,
            }));
            const spaceId = entry.getCurrent().spaceMembership?.spaceId ?? null;
            await entry.unmount();
            return spaceId;
        },
        setOffline: (next: boolean) => { offline = next; } };
}

describe('saved Space deletion through the mounted Action owner', () => {
    it.each(['sessionWork', 'workflow', 'discussion', 'deploymentEnvironment'] as const)('%s consumes the editor confirmation once even with saved Ask', async entityKind => {
        confirm.mockClear();
        const base = createDefaultCollectionSpaceV1(entityKind);
        const saved = { ...base, id: 'release', name: 'Release' };
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            collectionSpacesV1: { v: 1, spaces: [saved] },
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'settings.invoke': { approvalRequiredSurfaces: ['ui'] },
            } }),
        }) });
        let editing!: ReturnType<typeof useCollectionSpaceEditing>;
        const anchorRef = { current: null };
        function Host() {
            editing = useCollectionSpaceEditing({ entityKind, testIDPrefix: 'deletion', scope: account.scope,
                spaces: [saved], selectedSpace: saved, currentFilter: base.filter,
                suggestion: { name: 'Work', icon: base.icon }, summary: [], anchorRef });
            return editing.formOverlay;
        }
        const screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}><Host /></HappierUiPlatformProvider>);
        try {
            await act(() => editing.openEdit());
            await screen.pressByTestIdAsync('deletion-delete');
            await vi.waitFor(() => expect(account.persistedSettings.collectionSpacesV1.spaces).toEqual([]));
            expect(confirm).toHaveBeenCalledTimes(1);
            expect(screen.findByTestId('deletion-form')).toBeNull();
        } finally { standardCleanup(); await account.dispose(); }
    });
});

describe('shared entity Space presentation through real settings Actions and HTTP persistence', () => {
    it('persists a filtered Review space across remount and updates its membership mode', async () => {
        const mounted = await mountEntity({ kind: 'review', defaultFilter: DEFAULT_REVIEW_LIST_FILTER_V1,
            narrowed: { state: 'failed' }, registry: reviewListFilterFieldsV1,
            mode: 'e2ee', settingsVersion: 0,
            rows: [{ id: 'failed', state: 'failed' as const }, { id: 'completed', state: 'completed' as const }] });
        const { account, screen } = mounted;
        const savedReviewSpace = () => account.persistedSettings.collectionSpacesV1.spaces.find(space => space.entityKind === 'review');
        try {
            // QA Q09: Save as space after filtering to a failed Review on a fresh Account.
            await act(async () => { mounted.view().update({ filters: { state: 'failed' } }); });
            expect(mounted.ids()).toEqual(['failed']);
            await mounted.saveAs();
            await act(async () => screen.changeTextByTestId('joined-name', 'Release'));
            await screen.pressByTestIdAsync('joined-submit');
            await vi.waitFor(() => expect(savedReviewSpace()).toMatchObject({ name: 'Release',
                filter: { state: 'failed' }, membership: { mode: 'filter_or_manual' } }));
            expect(screen.findByTestId('joined-form')).toBeNull();
            await vi.waitFor(() => expect(mounted.view().selectedSpaceId).toBe(savedReviewSpace()?.id));
            await screen.update(<></>);
            await screen.update(mounted.element);
            expect(mounted.view().selectedSpaceId).toBe(savedReviewSpace()?.id);
            expect(mounted.view().filters).toEqual({ state: 'failed' });
            expect(mounted.ids()).toEqual(['failed']);
            await mounted.edit();
            await screen.pressByTestIdAsync('joined-membership:manual_only');
            await screen.pressByTestIdAsync('joined-submit');
            await vi.waitFor(() => expect(savedReviewSpace()?.membership).toEqual({ mode: 'manual_only' }));
        } finally { standardCleanup(); await account.dispose(); }
    });

    const cases = [
        { kind: 'workflow' as const, defaultFilter: DEFAULT_WORKFLOW_LIST_FILTER_V1, narrowed: { view: 'triggered' as const },
            registry: workflowListFilterFieldsV1, rows: [{ id: 'scheduled', triggered: true }, { id: 'ordinary', triggered: false }] },
        { kind: 'discussion' as const, defaultFilter: DEFAULT_DISCUSSION_LIST_FILTER_V1, narrowed: { ...DEFAULT_DISCUSSION_LIST_FILTER_V1, unreadOnly: true },
            registry: discussionListFilterFieldsV1, rows: [{ id: 'unread', state: 'active' as const, unread: true }, { id: 'read', state: 'active' as const, unread: false }] },
        // Services (owner D5): a saved view of what needs the person.
        { kind: 'deploymentEnvironment' as const, defaultFilter: DEFAULT_DEPLOYMENT_ENVIRONMENT_LIST_FILTER_V1,
            narrowed: { states: { include: ['needsYou' as const], exclude: [] } }, registry: deploymentEnvironmentListFilterFieldsV1,
            rows: [{ id: 'failing', projectSourceId: 'shop', state: 'needsYou' as const, machineId: 'machine-a' },
                { id: 'live', projectSourceId: 'shop', state: 'deployed' as const, machineId: 'machine-a' }] },
    ] as const;
    for (const input of cases) {
        it(`${input.kind}: creates, edits, reorders, reopens and deletes with the user policy Allowed against populated facts`, async () => {
            // Each discriminated case keeps its own real registry/facts; their common owner is generic.
            const mounted = input.kind === 'workflow' ? await mountEntity(input)
                : input.kind === 'discussion' ? await mountEntity(input) : await mountEntity(input);
            const { account, screen } = mounted;
            try {
                expect(mounted.ids()).toHaveLength(2);
                await act(async () => { mounted.view().update({ filters: input.narrowed }); });
                expect(mounted.ids()).toEqual([input.rows[0]!.id]);
                await mounted.saveAs();
                await act(async () => screen.changeTextByTestId('joined-name', 'My selection'));
                await screen.pressByTestIdAsync('joined-submit');
                await vi.waitFor(() => expect(account.persistedSettings.collectionSpacesV1.spaces).toHaveLength(1));
                const saved = account.persistedSettings.collectionSpacesV1.spaces[0]!;
                await vi.waitFor(() => expect(mounted.view().selectedSpaceId).toBe(saved.id));
                expect(saved.filter).toEqual(input.narrowed);
                await mounted.edit();
                await act(async () => screen.changeTextByTestId('joined-name', 'Renamed selection'));
                await screen.pressByTestIdAsync('joined-submit');
                await vi.waitFor(() => expect(account.persistedSettings.collectionSpacesV1.spaces[0]?.name).toBe('Renamed selection'));
                await act(async () => { expect(await mounted.header().reorder(saved.id, mounted.view().spaces[0]!.id)).toBe(true); });
                expect(mounted.view().spaces[0]?.id).toBe(saved.id);
                expect(mounted.view().selectedSpaceId).toBe(saved.id);
                await screen.update(<></>);
                await screen.update(mounted.element);
                expect(mounted.view().selectedSpaceId).toBe(saved.id);
                expect(mounted.ids()).toEqual([input.rows[0]!.id]);
                await mounted.edit();
                expect(screen.findByTestId('joined-name')?.props.value).toBe('Renamed selection');
                await screen.pressByTestIdAsync('joined-delete');
                await vi.waitFor(() => expect(account.persistedSettings.collectionSpacesV1.spaces.filter(space => space.id === saved.id)).toEqual([]));
                await vi.waitFor(() => expect(mounted.ids()).toHaveLength(2));
            } finally { standardCleanup(); await account.dispose(); }
        });
    }

    // SERVICES-ACCEPT-1116 F1: a Services condition is removed by dropping its key, so the header's whole next filter
    // must replace the draft rather than merge over it.
    const tokenField = { workflow: 'view', discussion: 'unreadOnly', deploymentEnvironment: 'states' } as const;
    for (const input of cases) {
        it(`${input.kind}: removing a condition's token through the header shows every row again`, async () => {
            const mounted = input.kind === 'workflow' ? await mountEntity(input)
                : input.kind === 'discussion' ? await mountEntity(input) : await mountEntity(input);
            const { account, screen } = mounted;
            try {
                await act(async () => { mounted.view().update({ filters: input.narrowed }); });
                expect(mounted.ids()).toEqual([input.rows[0]!.id]);
                await screen.pressByTestIdAsync(`joined-filter-token:${tokenField[input.kind]}`);
                expect(mounted.ids()).toHaveLength(2);
                expect(mounted.view().filters).toEqual(input.defaultFilter);
                expect(screen.findByTestId(`joined-filter-token:${tokenField[input.kind]}`)).toBeNull();
            } finally { standardCleanup(); await account.dispose(); }
        });
    }

    it('retains a failed save draft and local selection until HTTP recovery accepts the definition', async () => {
        const mounted = await mountEntity(cases[0]!);
        const { account, screen } = mounted;
        try {
            await act(async () => { mounted.view().update({ filters: { view: 'triggered' } }); });
            const selectedBefore = mounted.view().selectedSpaceId;
            await mounted.saveAs();
            await act(async () => screen.changeTextByTestId('joined-name', 'Keep this draft'));
            mounted.setOffline(true);
            await screen.pressByTestIdAsync('joined-submit');
            await vi.waitFor(() => expect(screen.findByTestId('joined-submit')?.props.disabled).toBe(false));
            expect(screen.findByTestId('joined-name')?.props.value).toBe('Keep this draft');
            expect(account.persistedSettings.collectionSpacesV1.spaces).toEqual([]);
            expect(mounted.view().selectedSpaceId).toBe(selectedBefore);
            expect(mounted.ids()).toEqual(['scheduled']);
            mounted.setOffline(false);
            await screen.pressByTestIdAsync('joined-submit');
            await vi.waitFor(() => expect(account.persistedSettings.collectionSpacesV1.spaces[0]?.name).toBe('Keep this draft'));
            await vi.waitFor(() => expect(mounted.view().selectedSpaceId).toBe(account.persistedSettings.collectionSpacesV1.spaces[0]?.id));
            expect(screen.findByTestId('joined-form')).toBeNull();
            expect(mounted.ids()).toEqual(['scheduled']);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('receives peer definitions and order without moving this device selection, and suppresses New capture while the Account is off', async () => {
        const mounted = await mountEntity(cases[0]!);
        const { account, screen } = mounted;
        try {
            await act(async () => { mounted.view().update({ filters: { view: 'triggered' } }); });
            await mounted.saveAs();
            await act(async () => screen.changeTextByTestId('joined-name', 'Local choice'));
            await screen.pressByTestIdAsync('joined-submit');
            await vi.waitFor(() => expect(account.persistedSettings.collectionSpacesV1.spaces).toHaveLength(1));
            const local = account.persistedSettings.collectionSpacesV1.spaces[0]!;
            await vi.waitFor(() => expect(mounted.view().selectedSpaceId).toBe(local.id));
            const peer = { ...createDefaultCollectionSpaceV1('workflow'), id: 'peer-choice', name: 'Peer choice' };
            await act(async () => account.replaceSettings(settingsParse({ ...account.persistedSettings,
                collectionSpacesV1: { v: 1, spaces: [peer, createDefaultCollectionSpaceV1('workflow'), local] },
            })));
            expect(mounted.view().spaces.map(space => space.id)).toEqual(['peer-choice', 'all-workflows', local.id]);
            expect(mounted.view().selectedSpaceId).toBe(local.id);
            expect(mounted.ids()).toEqual(['scheduled']);
            expect(await mounted.newEntrySpaceId()).not.toBeNull();
            await act(async () => account.replaceSettings(settingsParse({ ...account.persistedSettings, collectionSpacesEnabled: false })));
            expect(mounted.view().activeSpace).toBeNull();
            expect(mounted.view().selectedSpaceId).toBe(local.id);
            expect(mounted.ids()).toEqual(['scheduled', 'ordinary']);
            expect(await mounted.newEntrySpaceId()).toBeNull();
            await act(async () => account.replaceSettings(settingsParse({ ...account.persistedSettings, collectionSpacesEnabled: true })));
            expect(mounted.view().selectedSpaceId).toBe(local.id);
            expect(mounted.ids()).toEqual(['scheduled']);
            expect(await mounted.newEntrySpaceId()).not.toBeNull();
        } finally { standardCleanup(); await account.dispose(); }
    });
});
