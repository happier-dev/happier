import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { t } from '@/text';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

// Install the transport leaves before evaluating the header's real runtime graph.
const { resolveSessionViewHeaderProps } = await import('./resolveSessionViewHeaderProps');
const { applyPromptLibraryCatalogSnapshot, getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { storage } = await import('@/sync/domains/state/storageStore');
const { useRoleCatalog, invalidateRoleCatalog } = await import('@/components/roles/catalog/useRoleCatalog');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } =
    await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
let previousState = storage.getState();
let previousSnapshot = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();
let homeId: string;
let disposeExecutor: () => void;
let sync: Awaited<ReturnType<typeof loadSyncSingletonForTests>>;

const catalogReads = () => harness.requests.filter(request => request.path.startsWith('/v1/artifacts')).length;

function input(id: string, roleId: string | null = 'orchestrator', name?: string) {
    const session = createSessionFixture({
        id, serverId: homeId,
        metadata: { path: '/repo', host: 'test', work: { sessionRolesV1: {
            ...(roleId ? { roleId } : {}), overrides: {}, notes: '',
            sessionRoles: roleId && name ? { [roleId]: { ...BUILT_IN_ROLES_V1.builder, roleId, name } } : {},
        } } },
    });
    return {
        isDataReady: true, session, sessionId: id,
        sessionInfoHref: `/session/${id}/info`, sessionRunsHref: `/session/${id}/runs`,
        sessionAutomationsHref: `/session/${id}/automations`, paneScopeId: `session:${id}`,
        windowWidth: 1200, sessionAutomationsEnabledCount: 0, sessionExecutionRunsSupported: false,
        showAutomations: false, shouldShowSubagentsButton: false, subagentActiveCount: 0,
        navigateWithBlurOnWeb: (action: () => void) => action(), handleHeaderExtraItemSelect: () => false,
        router: { push: () => {}, navigate: () => {} }, actionIconColor: '#000', headerTintColor: '#000',
        statusErrorColor: '#f00', externalSessionRuntime: null,
    } as const;
}

describe('session header role chip', () => {
    beforeEach(async () => {
        sync = await loadSyncSingletonForTests();
        disposeExecutor = await installRealActionExecutorModuleLoader();
        await harness.reset();
        homeId = await harness.addHome({ name: 'Roles', serverUrl: 'https://roles.test', accountId: 'role-chip-account', currentAccount: true });
        harness.answer(homeId, '/v1/account/encryption/currentness', {
            body: createPlainAccountEncryptionCurrentnessFixture({ version: 0, settingsVersion: 0, updatedAt: 0 }),
        });
        await act(async () => {
            previousState = storage.getState();
            previousSnapshot = getAppliedActiveServerSnapshot();
            previousAvailable = isAppliedActiveServerRuntimeAvailable();
            publishAppliedActiveServerSnapshot({ serverId: homeId, serverUrl: 'https://roles.test', generation: 0 });
            storage.setState({ profileScope: { serverId: homeId, accountId: 'role-chip-account' } });
            applyPromptLibraryCatalogSnapshot({ serverId: homeId, accountId: 'role-chip-account' }, {
                catalog: { status: 'ready', rows: [{ record: { key: 'role-overrides', value: { v: 1, overrides: {} } }, revision: 1 }],
                    tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 0,
            }, true);
        });
    });
    afterEach(async () => {
        await standardCleanup();
        await act(async () => {
            retireActiveServerAccountScopeLifetime();
            storage.setState(previousState);
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        });
        disposeExecutor();
        sync.dispose();
    });

    it('names the current role without loading the catalog and opens the existing rail with Hands-off on press', async () => {
        const current = input('role-chip-open');
        storage.setState({ sessions: { [current.session.id]: current.session } });
        const props = resolveSessionViewHeaderProps(current);
        expect(props.titleAccessory).toBeDefined();
        const screen = await renderScreen(<>{props.titleAccessory}</>);
        expect(screen.getTextContent()).toContain('Orchestrator');
        expect(catalogReads()).toBe(0);
        expect(screen.findByTestId('session-role-popover')).toBeNull();
        await screen.pressByTestIdAsync('session-header-role-chip');
        expect(screen.findByTestId('roles-rail-detail')).not.toBeNull();
        expect(screen.findByTestId('session-role.handsOff')).not.toBeNull();
        await waitForHomeGovernance(() => expect(catalogReads()).toBeGreaterThan(0));
    });

    it.each([0, 1])('uses the owner-view session snapshot at metadata layout %s, with no catalog read', async (layout) => {
        const initial = input(`role-chip-snapshot-${layout}`, 'plugin:acme/ui', 'Interface builder');
        const current = layout === 0 ? initial : { ...initial, session: {
            ...initial.session, metadataLayoutVersion: 1, ownerMetadataView: initial.session.metadata,
            metadata: { path: '/repo', host: 'test' },
        } };
        storage.setState({ sessions: { [current.session.id]: current.session } });
        const props = resolveSessionViewHeaderProps(current);
        expect(props.titleAccessory).toBeDefined();
        const screen = await renderScreen(<>{props.titleAccessory}</>);
        expect(screen.getTextContent()).toContain('Interface builder');
        expect(catalogReads()).toBe(0);
    });

    it('names an Account role created through the real Action and updates its runs-as from the cached catalog', async () => {
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: homeId };
        const execute = createDefaultActionExecutor().execute;
        const role = { ...BUILT_IN_ROLES_V1.builder, name: 'Interface builder' };
        expect(await execute('roles.create', { roleId: 'my-role', role }, context)).toMatchObject({ ok: true });
        expect(await execute('roles.list', {}, context)).toMatchObject({ ok: true, result: { items: expect.arrayContaining([
            expect.objectContaining({ roleId: 'my-role', role: expect.objectContaining({ name: 'Interface builder' }) }),
        ]) } });
        expect(getPromptLibraryCatalogValue({ serverId: homeId, accountId: 'role-chip-account' }, 'role-overrides').status).toBe('ready');
        const catalog = await renderHook(() => useRoleCatalog(homeId));
        await waitForHomeGovernance(() => expect(catalog.getCurrent().entries.some(entry => entry.roleId === 'my-role')).toBe(true));
        await catalog.unmount();
        const before = catalogReads();
        const current = input('role-chip-account-role', 'my-role');
        storage.setState({ sessions: { [current.session.id]: current.session } });
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id="role-chip" onRender={() => { commits += 1; }}>
            {resolveSessionViewHeaderProps(current).titleAccessory}
        </React.Profiler>);
        expect(screen.getTextContent()).toContain('Interface builder');
        expect(screen.getTextContent()).not.toContain('my-role');
        expect(catalogReads()).toBe(before);
        const updated = { ...role, name: 'Interface scout', runsAs: { kind: 'background_run' as const, intent: 'task' as const } };
        expect(await execute('roles.update', { roleId: 'my-role', role: updated, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context)).toMatchObject({ ok: true });
        await act(async () => { invalidateRoleCatalog(); });
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Interface scout'));
        const { HappierRoleMark } = await import('@happier-dev/plugin-ui/presentation');
        expect(screen.tree.root.findByType(HappierRoleMark).props.runsAs).toBe('background_run');
        const selectedRoleCommits = commits;
        expect(await execute('roles.create', { roleId: 'another-role', role }, context)).toMatchObject({ ok: true });
        const refreshed = await renderHook(() => useRoleCatalog(homeId));
        await waitForHomeGovernance(() => expect(refreshed.getCurrent().entries.some(entry => entry.roleId === 'another-role')).toBe(true));
        expect(commits).toBe(selectedRoleCommits);
        await refreshed.unmount();
    });

    it('shows unavailable instead of a raw role id when the selected role cannot be resolved', async () => {
        const current = input('role-chip-unavailable', 'missing-role');
        storage.setState({ sessions: { [current.session.id]: current.session } });
        const screen = await renderScreen(<>{resolveSessionViewHeaderProps(current).titleAccessory}</>);
        expect(screen.getTextContent()).toContain(t('roles.session.refusal.roleUnavailableTitle'));
        expect(screen.getTextContent()).not.toContain('missing-role');
        expect(catalogReads()).toBe(0);
    });

    it('keeps the role on a phone and omits it without a role or on a blocked surface', () => {
        expect(resolveSessionViewHeaderProps(input('role-chip-none', null)).titleAccessory).toBeUndefined();
        const current = input('role-chip-phone');
        expect(resolveSessionViewHeaderProps({ ...current, windowWidth: 390 }).titleAccessory).toBeDefined();
        expect(resolveSessionViewHeaderProps({ ...current, blockedSurface: 'content_blocked' }).titleAccessory).toBeUndefined();
        expect(resolveSessionViewHeaderProps({ ...current, blockedSurface: 'access_denied' }).titleAccessory).toBeUndefined();
    });

    it('keeps the mounted selected-role leaf current across snapshot edits without loading the catalog', async () => {
        const current = input('role-chip-stable', 'session:ui', 'Interface builder');
        storage.setState({ sessions: { [current.session.id]: current.session } });
        const first = resolveSessionViewHeaderProps(current);
        const screen = await renderScreen(<>{first.titleAccessory}</>);
        const sessionRoles = readSessionRolesV1(current.session.metadata);
        const unchanged = resolveSessionViewHeaderProps({ ...current, session: { ...current.session, metadata: {
            ...current.session.metadata!, work: { sessionRolesV1: {
                ...sessionRoles, notes: 'Unrelated orchestration notes',
            } },
        } } });
        expect(unchanged.titleAccessory).toEqual(first.titleAccessory);
        const renameInput = input('role-chip-stable', 'session:ui', 'Design reviewer');
        await act(async () => { storage.setState({ sessions: { [current.session.id]: renameInput.session } }); });
        const renamed = resolveSessionViewHeaderProps(renameInput);
        expect(renamed.titleAccessory).toEqual(first.titleAccessory);
        expect(screen.getTextContent()).toContain('Design reviewer');
        expect(resolveSessionViewHeaderProps(input('role-chip-stable', 'reviewer')).titleAccessory).not.toEqual(renamed.titleAccessory);
        expect(catalogReads()).toBe(0);
    });
});
