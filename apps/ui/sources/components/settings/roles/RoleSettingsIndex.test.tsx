import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol';

import { createDeferred, renderInCollectionLayout, standardCleanup } from '@/dev/testkit';

const boundary = vi.hoisted(() => ({
    list: vi.fn<() => Promise<{ ok: true; result: { items: unknown[] } }>>(),
    push: vi.fn(),
}));

// Reuse RoleDetailScreen's Action front door: catalog reads and projection stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => async (actionId: string) => {
        if (actionId === 'roles.list') return boundary.list();
        throw new Error(`Unexpected Action: ${actionId}`);
    },
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/settings/roles', router: { push: boundary.push } }).module;
});

const { RoleSettingsIndex } = await import('./RoleSettingsIndex');
const { t } = await import('@/text');
const { RoleCollectionRail } = await import('./RoleCollectionRail');
const { RolesRailDetail } = await import('@/components/roles/rail/RolesRailDetail');
const { CollectionList } = await import('@/components/ui/lists/collection/CollectionList');
const { OptionPickerOverlay } = await import('@/components/sessions/pickers/OptionPickerOverlay');
const { Item } = await import('@/components/ui/lists/Item');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { storage } = await import('@/sync/domains/state/storageStore');
const { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
let previousStorageState = storage.getState();
let previousSnapshot = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();

async function renderLanding() {
    return renderInCollectionLayout(<RoleSettingsIndex />, 'split');
}

describe('Settings › Roles collection landing', () => {
    beforeEach(async () => {
        boundary.list.mockReset().mockResolvedValue({ ok: true, result: { items: [] } });
        boundary.push.mockReset();
        await act(async () => {
            previousStorageState = storage.getState();
            previousSnapshot = getAppliedActiveServerSnapshot();
            previousAvailable = isAppliedActiveServerRuntimeAvailable();
            publishAppliedActiveServerSnapshot({ serverId: 'server-1', serverUrl: 'https://roles.test', generation: 0 });
            storage.setState({ profileScope: { serverId: 'server-1', accountId: 'account-1' } });
            applyPromptLibraryCatalogSnapshot({ serverId: 'server-1', accountId: 'account-1' }, {
                catalog: { status: 'ready', rows: [{ record: { key: 'role-overrides', value: { v: 1, overrides: {} } }, revision: 1 }],
                    tombstones: [], diagnostics: [] },
                rawSettings: {}, sourceSettingsVersion: 0,
            }, true);
        });
    });

    afterEach(async () => {
        standardCleanup();
        await act(async () => {
            retireActiveServerAccountScopeLifetime();
            resetPromptLibraryCatalogEngineForTests();
            resetPromptLibraryCatalogSnapshotsForTests();
            storage.setState(previousStorageState);
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        });
    });

    it('finishes an empty catalog read and offers creation instead of continued loading', async () => {
        const screen = await renderLanding();
        expect(screen.findByType(SurfaceStateCard).props.kind).toBe('empty');
        expect(Boolean(screen.findHostByTestId('settings.roles.landing-loading-spinner'))).toBe(false);
        await screen.pressByTestIdAsync('settings.roles.landing-action');
        expect(boundary.push).toHaveBeenCalledWith('/settings/roles/new');
    });

    it('keeps a pending catalog read loading until its empty result arrives', async () => {
        const pending = createDeferred<{ ok: true; result: { items: unknown[] } }>();
        boundary.list.mockReturnValue(pending.promise);
        const screen = await renderLanding();
        expect(screen.findByType(SurfaceStateCard).props.kind).toBe('loading');
        expect(screen.findHostByTestId('settings.roles.landing-loading-spinner')).toBeTruthy();
        expect(Boolean(screen.findHostByTestId('settings.roles.landing-action'))).toBe(false);
        await act(async () => { pending.resolve({ ok: true, result: { items: [] } }); });
        expect(Boolean(screen.findHostByTestId('settings.roles.landing-loading-spinner'))).toBe(false);
        expect(screen.findHostByTestId('settings.roles.landing-action')).toBeTruthy();
    });

    it('shows the first catalog read on the phone list before revealing its roles', async () => {
        const pending = createDeferred<{ ok: true; result: { items: unknown[] } }>();
        boundary.list.mockReturnValue(pending.promise);
        const screen = await renderInCollectionLayout(<RoleSettingsIndex />, 'stacked');
        expect(screen.findHostByTestId('settings.roles.page.loading-loading-spinner')).toBeTruthy();
        expect(screen.findHostByTestId('settings.roles.page.row.orchestrator')).toBeNull();
        await act(async () => { pending.resolve({ ok: true, result: { items: [{
            roleId: 'orchestrator', role: BUILT_IN_ROLES_V1.orchestrator,
            shared: false, viewOnly: false, migratedFromV0_2: false,
        }] } }); });
        expect(screen.findHostByTestId('settings.roles.page.loading-loading-spinner')).toBeNull();
        await screen.pressByTestIdAsync('settings.roles.page.row.orchestrator');
        expect(boundary.push).toHaveBeenCalledWith('/settings/roles/orchestrator');
    });

    it.each(['split', 'stacked'] as const)('offers Retry after a failed read and recovers to creation (%s)', async (mode) => {
        boundary.list.mockRejectedValueOnce(new Error('Roles transport unavailable'));
        const screen = await renderInCollectionLayout(<RoleSettingsIndex />, mode);
        const retryId = mode === 'split' ? 'settings.roles.landing-action' : 'settings.roles.page.failed-action';
        const createId = mode === 'split' ? 'settings.roles.landing-action' : 'settings.roles.page.add';
        expect(screen.findByType(SurfaceStateCard).props.kind).toBe('error');
        expect(Boolean(screen.findHostByTestId('settings.roles.landing-loading-spinner'))).toBe(false);
        expect(screen.findByTestId(retryId)!.props.accessibilityLabel).toBe(t('common.retry'));
        await screen.pressByTestIdAsync(retryId);
        if (mode === 'split') expect(screen.findByTestId(createId)!.props.accessibilityLabel).toBe(t('roles.settings.newRole'));
        else expect(screen.findHostByTestId('settings.roles.page.failed')).toBeNull();
        await screen.pressByTestIdAsync(createId);
        expect(boundary.push).toHaveBeenCalledWith('/settings/roles/new');
    });

    it('never labels the collection or open role picker empty before the first shared catalog answer', async () => {
        const pending = createDeferred<{ ok: true; result: { items: unknown[] } }>();
        boundary.list.mockReturnValue(pending.promise);
        const commits = vi.fn();
        const screen = await renderInCollectionLayout(<React.Profiler id="roles" onRender={commits}><RoleCollectionRail /><RolesRailDetail value={null} onChange={() => {}} /></React.Profiler>, 'split');
        expect(screen.findByType(CollectionList).props.count).toBeUndefined();
        expect(screen.findAllByType(Item).some(row => row.props.title === t('roles.rail.empty'))).toBe(false);
        expect(screen.findByType(OptionPickerOverlay).props.emptyText).toBe(t('common.loading'));
        expect(boundary.list).toHaveBeenCalledTimes(1);
        expect(commits).toHaveBeenCalledTimes(1);
        await act(async () => { pending.resolve({ ok: true, result: { items: [] } }); });
        expect(screen.findByType(CollectionList).props.count).toBe(0);
        expect(screen.findByType(OptionPickerOverlay).props.emptyText).toBe(t('roles.rail.empty'));
        expect(commits).toHaveBeenCalledTimes(2);
    });

    it('lands on an available role instead of showing an empty invitation', async () => {
        boundary.list.mockResolvedValue({ ok: true, result: { items: [{
            roleId: 'orchestrator', role: BUILT_IN_ROLES_V1.orchestrator,
            shared: false, viewOnly: false, migratedFromV0_2: false,
        }] } });
        const screen = await renderLanding();
        expect(screen.findByType('Redirect').props.href).toBe('/settings/roles/orchestrator');
        expect(Boolean(screen.findHostByTestId('settings.roles.landing'))).toBe(false);
    });
    it.each(['split', 'stacked'] as const)('marks an edited role and explains a migrated one by name on the role list (%s)', async (mode) => {
        const { orchestrator, scout } = BUILT_IN_ROLES_V1;
        boundary.list.mockResolvedValue({ ok: true, result: { items: [
            { roleId: 'orchestrator', role: orchestrator, shared: false, viewOnly: false, migratedFromV0_2: false },
            { roleId: 'research', role: { ...scout, name: 'Research' }, revision: { headerVersion: 1, bodyVersion: 1 },
                shared: false, viewOnly: false, migratedFromV0_2: true },
        ] } });
        await act(async () => {
            applyPromptLibraryCatalogSnapshot({ serverId: 'server-1', accountId: 'account-1' }, {
                catalog: { status: 'ready', rows: [{ record: { key: 'role-overrides', value: { v: 1, overrides: {
                    orchestrator: { roleId: 'orchestrator', instructionsOverride: 'Lead, and run e2e before a pull request.' },
                } } }, revision: 2 }], tombstones: [], diagnostics: [] },
                rawSettings: {}, sourceSettingsVersion: 0,
            }, true);
        });
        const screen = await renderInCollectionLayout(mode === 'split' ? <RoleCollectionRail /> : <RoleSettingsIndex />, mode);
        const rowPrefix = mode === 'split' ? 'settings.roles.row' : 'settings.roles.page.row';
        await vi.waitFor(() => expect(screen.findHostByTestId(`${rowPrefix}.orchestrator`)).toBeTruthy());

        expect(screen.findHostByTestId(`${rowPrefix}.orchestrator.edited`)).toBeTruthy();
        expect(screen.findHostByTestId(`${rowPrefix}.research.edited`)).toBeNull();
        const note = screen.findAll(node => node.props?.testID === `${mode === 'split' ? 'settings.roles.rail' : 'settings.roles.page'}.migratedNote`
            && typeof node.props?.title === 'string')[0];
        expect(note?.props.title).toBe(t('roles.settings.migratedNote', { names: ['Research'] }));
    });
});
