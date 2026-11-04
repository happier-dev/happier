import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { renderSessionRoleBlockV1 } from '@happier-dev/protocol/prompts/roles/renderSessionRoleBlockV1';
import { RoleArtifactV1Schema, type RoleArtifactV1 } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { ROLE_ACTION_IDS_V1 } from '@happier-dev/protocol/prompts/roles/roleActionIdsV1';
import { RoleActionOutputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { RoleOverrideRecordV1Schema } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installDisconnectedServerSocketBoundary, configureConnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const pluginRoleId = 'plugin:example/scout';
const ownRole = RoleArtifactV1Schema.parse({ name: 'UI builder', instructions: 'Build interfaces and their copy.',
    runsAs: { kind: 'session' }, workspaceWrites: 'allow', secondOpinion: 'off', enabled: true });
const pluginProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {},
    installedPackagesById: { example: { id: 'example', displayName: 'Roles plugin', version: '1.0.0', enabled: true,
        source: { kind: 'path', locator: '/plugins/example' }, occurrenceId: 'roles-plugin-occurrence' } },
    familiesById: { roles: { family: 'roles', entriesById: {
        'example/scout': { id: 'example/scout', pluginId: 'example', definition: { id: 'scout', ...ownRole } },
    } } },
});
// Daemon projection is an external Socket RPC response. Catalog selection and plugin admission stay real.
installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    socket.emitWithAck = vi.fn(async (event: string, payload?: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return {};
        if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string'
            && payload.method.endsWith(`:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`)) {
            return { ok: true, result: { protocolVersion: 1, projection: pluginProjection } };
        }
        return { ok: false, error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
    });
});

const { RoleDetailScreen } = await import('./RoleDetailScreen');
const { router } = await import('expo-router');
const { Modal } = await import('@/modal');
const { invalidateRoleCatalog, useRoleCatalog } = await import('@/components/roles/catalog/useRoleCatalog');
const { roleActions } = await import('@/sync/ops/roles/roleActions');
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { clearActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
const execute = createFrontDoorActionExecute();
let home: Awaited<ReturnType<typeof createSecretSettingsTestHarness>>;
let catalog: ReturnType<typeof createPromptLibraryCatalogBoundary>;
let roleId: string;
let initialState = storage.getState();
let disposeExecutor: (() => void) | undefined;

async function createRole(role: RoleArtifactV1 = ownRole): Promise<string> {
    const result = await roleActions.create(role);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error);
    return RoleActionOutputSchemasV1['roles.create'].parse(result.result).roleId;
}
function storedRole(id = roleId): RoleArtifactV1 {
    return RoleArtifactV1Schema.parse(JSON.parse(home.artifacts.readPlainBody(id)!));
}
function overrides() { return RoleOverrideRecordV1Schema.parse(catalog.read('role-overrides').value).overrides; }
async function saveRole(patch: Partial<RoleArtifactV1>, id = roleId) {
    const row = home.artifacts.read(id)!;
    expect(await roleActions.update(id, { ...storedRole(id), ...patch }, {
        headerVersion: row.headerVersion, bodyVersion: row.bodyVersion!,
    })).toMatchObject({ ok: true });
    invalidateRoleCatalog();
}
async function setOverride(override: Parameters<typeof roleActions.setOverride>[0]) {
    expect(await roleActions.setOverride(override)).toMatchObject({ ok: true });
    invalidateRoleCatalog();
}
async function renderRole(id = roleId) {
    const screen = await renderScreen(<RoleDetailScreen target={{ kind: 'role', roleId: id }} />);
    await vi.waitFor(() => expect(screen.findByTestId(`settings.roles.detail.${id}`)).toBeTruthy());
    return screen;
}
type Screen = Awaited<ReturnType<typeof renderScreen>>;
function previewText(screen: Screen): string {
    return screen.findByTestId('settings.roles.detail.preview.block')!
        .findAll(node => typeof node.props?.code === 'string')[0]!.props.code;
}
async function openPreview(screen: Screen) {
    await screen.pressByTestIdAsync('settings.roles.detail.preview');
    await vi.waitFor(() => expect(screen.findByTestId('settings.roles.detail.preview.block')).toBeTruthy());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
}
function toggle(screen: Screen, field: string): ReactTestInstance {
    return screen.findByTestId(`settings.roles.detail.${field}`)!
        .findAll(node => typeof node.props?.onValueChange === 'function')[0]!;
}
function menuActions(screen: Screen): Array<{ id: string; onSelect: () => unknown }> {
    return screen.findAll(node => node.props?.testID === 'settings.roles.detail.menu' && Array.isArray(node.props.actions))[0]?.props.actions ?? [];
}
function shareButton(screen: Screen) {
    return screen.findAll(node => node.props?.testID === 'settings.roles.detail.share' && typeof node.props.onPress === 'function')[0];
}
function shareSheets() {
    return vi.mocked(Modal.show).mock.calls.map(([config]) => config)
        .filter(config => config.chrome?.testID === 'document-share-modal');
}
async function sharedRole(access: 'view' | 'edit' | 'admin') {
    const id = await createRole();
    // An externally committed grant changes who owns this row, as a recipient Home read would report.
    home.artifacts.replaceStoredRow({ ...home.artifacts.read(id)!, ownerAccountId: 'other-account' });
    home.artifacts.seedAccountGrant(id, home.scope.accountId, access);
    invalidateRoleCatalog();
    return id;
}
async function restoreRoleHome(accountId = 'account-a') {
    const rows = createPromptLibraryCatalogBoundary();
    const restored = await createSecretSettingsTestHarness({ accountId,
        settings: settingsParse({ workDepthLimit: 4,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                approvalWaivedSurfaces: Object.fromEntries([...ROLE_ACTION_IDS_V1, 'artifact.export'].map(id => [id, ['ui']])),
            }),
        }),
        handleRequest: async (path, init) => {
            const url = new URL(path, 'https://role-fixture.test');
            if (url.pathname.startsWith('/v1/account/entity-rows/prompt-library')) return rows.handle(url.pathname, init);
            return createPlainMachineReadHttpResponseFixture(url.pathname, init, accountId);
        },
    });
    home = restored;
    catalog = rows;
}

beforeEach(async () => {
    initialState = storage.getState();
    clearActiveUnsavedChangesGuard();
    await act(async () => {
        await restoreRoleHome();
        const bridge = await loadVitestModuleForNodeRequire(new URL('../../../sync/ops/actions/defaultActionExecutor.ts', import.meta.url),
            () => import('@/sync/ops/actions/defaultActionExecutor'));
        disposeExecutor = bridge.dispose;
        roleId = await createRole();
        await setOverride({ roleId: 'orchestrator', secondOpinion: 'encouraged' });
    });
});
afterEach(async () => {
    await standardCleanup();
    clearActiveUnsavedChangesGuard();
    await home?.dispose();
    disposeExecutor?.();
    disposeExecutor = undefined;
    storage.setState(initialState, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Settings › Roles detail', () => {
    it('persists delegation in the role Artifact or the reader override', async () => {
        const own = await renderRole();
        expect(toggle(own, 'canDelegateToOtherRoles').props.value).toBe(false);
        await act(async () => { await toggle(own, 'canDelegateToOtherRoles').props.onValueChange(true); });
        await vi.waitFor(() => expect(storedRole().canDelegateToOtherRoles).toBe(true));
        const builtIn = await renderRole('orchestrator');
        expect(toggle(builtIn, 'canDelegateToOtherRoles').props.value).toBe(true);
        await act(async () => { await toggle(builtIn, 'canDelegateToOtherRoles').props.onValueChange(false); });
        await vi.waitFor(() => expect(overrides().orchestrator).toMatchObject({ secondOpinion: 'encouraged', canDelegateToOtherRoles: false }));
    });
    it('keeps a custom role preview mounted as delegation changes', async () => {
        const screen = await renderRole();
        expect(screen.findAll(node => node.props?.testIDPrefix === 'settings.roles.detail.runsAs').length).toBeGreaterThan(0);
        await openPreview(screen);
        const block = screen.findByTestId('settings.roles.detail.preview.block');
        expect(previewText(screen)).not.toContain('"roleId":"orchestrator"');
        for (const canDelegateToOtherRoles of [true, false]) {
            await act(async () => { await saveRole({ canDelegateToOtherRoles }); });
            await vi.waitFor(() => expect(previewText(screen).includes('"roleId":"orchestrator"')).toBe(canDelegateToOtherRoles));
            expect(screen.findByTestId('settings.roles.detail.preview.block')).toBe(block);
        }
    });
    it('omits cross-role preview after an explicit Orchestrator delegation override', async () => {
        await act(async () => { await setOverride({ roleId: 'orchestrator', canDelegateToOtherRoles: false }); });
        const screen = await renderRole('orchestrator');
        expect(screen.findHostByTestId('settings.roles.detail.runsAs.thisSession')).toBeTruthy();
        await openPreview(screen);
        expect(previewText(screen)).not.toContain(`"roleId":"${roleId}"`);
    });
    it('recommits Orchestrator preview only for a consumed cross-role change', async () => {
        const observer = await renderHook(() => useRoleCatalog());
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id="orchestrator" onRender={() => { commits += 1; }}>
            <RoleDetailScreen target={{ kind: 'role', roleId: 'orchestrator' }} />
        </React.Profiler>);
        await vi.waitFor(() => expect(screen.findByTestId('settings.roles.detail.orchestrator')).toBeTruthy());
        await openPreview(screen);
        const settled = commits;
        await act(async () => { await saveRole({ instructions: 'Unconsumed instructions' }); });
        // A peer catalog observer proves that the real refresh has published before counting.
        await vi.waitFor(() => expect(observer.getCurrent().entries.find(entry => entry.roleId === roleId)?.role.instructions)
            .toBe('Unconsumed instructions'));
        expect(commits).toBe(settled);
        await act(async () => { await saveRole({ name: 'Renamed builder' }); });
        await vi.waitFor(() => expect(previewText(screen)).toContain('Renamed builder'));
        expect(commits).toBeGreaterThan(settled);
    });
    it('retires the previous Account Role detail when another Account is restored', async () => {
        const screen = await renderRole();
        await act(async () => { await home.dispose(); await restoreRoleHome('account-b'); });
        await vi.waitFor(() => expect(screen.findByTestId(`settings.roles.detail.${roleId}`)).toBeNull());
        await vi.waitFor(() => expect(screen.findByTestId('settings.roles.detail.unavailable')).toBeTruthy());
    });
    it('retains detail for equal refreshes and unrelated role edits, then shows a selected edit', async () => {
        const another = await createRole({ ...ownRole, name: 'Another role' });
        const observer = await renderHook(() => useRoleCatalog());
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id="detail" onRender={() => { commits += 1; }}>
            <RoleDetailScreen target={{ kind: 'role', roleId }} />
        </React.Profiler>);
        await vi.waitFor(() => expect(screen.findByTestId(`settings.roles.detail.${roleId}`)).toBeTruthy());
        await openPreview(screen);
        const settled = commits;
        await act(async () => { invalidateRoleCatalog(); });
        expect(commits).toBe(settled);
        await act(async () => { await saveRole({ instructions: 'Unrelated edit' }, another); });
        await vi.waitFor(() => expect(observer.getCurrent().entries.find(entry => entry.roleId === another)?.role.instructions).toBe('Unrelated edit'));
        expect(commits).toBe(settled);
        await act(async () => { await saveRole({ instructions: 'Updated selected instructions' }); });
        await vi.waitFor(() => expect(previewText(screen)).toContain('Updated selected instructions'));
        expect(commits).toBeGreaterThan(settled);
    });
    it('keeps an existing override when saving another built-in field', async () => {
        const screen = await renderRole('orchestrator');
        await act(async () => { await toggle(screen, 'handsOff').props.onValueChange(false); });
        await vi.waitFor(() => expect(overrides().orchestrator).toMatchObject({ secondOpinion: 'encouraged', workspaceWrites: 'allow' }));
    });
    it('renames the reader role through its title, while built-ins retain their platform name', async () => {
        const screen = await renderRole();
        expect(screen.findByTestId('settings.roles.detail.name')).toBeNull();
        await act(async () => { screen.findByTestId('settings.roles.detail.title')!.props.onChangeText('Interface builder'); });
        await act(async () => { screen.findByTestId('settings.roles.detail.title')!.props.onBlur(); });
        await vi.waitFor(() => expect(storedRole().name).toBe('Interface builder'));
        expect((await renderRole('orchestrator')).findByTestId('settings.roles.detail.title')).toBeNull();
    });
    it('writes the own role against its read revision and preserves other fields', async () => {
        const screen = await renderRole();
        const before = home.artifacts.read(roleId)!;
        await act(async () => { await toggle(screen, 'handsOff').props.onValueChange(true); });
        await vi.waitFor(() => expect(storedRole()).toEqual({ ...ownRole, workspaceWrites: 'deny' }));
        expect(home.artifacts.read(roleId)?.bodyVersion).toBe(before.bodyVersion! + 1);
    });
    it.each(['view', 'edit'] as const)('edits shared %s instructions through the permitted writer and resets overrides', async access => {
        const id = await sharedRole(access);
        await act(async () => { await setOverride({ roleId: id, secondOpinion: 'encouraged' }); });
        const screen = await renderRole(id);
        expect(screen.findByTestId('settings.roles.detail.instructions')).toBeFalsy();
        await screen.pressByTestIdAsync('settings.roles.detail.instructions.read');
        await act(async () => { screen.findByTestId('settings.roles.detail.instructions')!.props.onChangeText('Reader instructions'); });
        await act(async () => { screen.findByTestId('settings.roles.detail.instructions')!.props.onBlur(); });
        await vi.waitFor(() => expect(access === 'view' ? overrides()[id]?.instructionsOverride : storedRole(id).instructions).toBe('Reader instructions'));
        if (access === 'view') expect(storedRole(id).instructions).toBe(ownRole.instructions);
        else expect(storedRole(id).secondOpinion).toBe('encouraged');
        await screen.pressByTestIdAsync('settings.roles.detail.instructions.reset');
        await vi.waitFor(() => expect(overrides()[id]).toBeUndefined());
    });
    it('edits a daemon-contributed plugin role only through the reader override', async () => {
        const machine = createMachineFixture({ activeAt: Date.now(), access: createPlainMachineRowFixture({
            id: 'machine-1', accountId: home.scope.accountId,
        }).access });
        await publishMachineInventoryForTest(home.scope, [machine]);
        await act(async () => { await setOverride({ roleId: pluginRoleId, secondOpinion: 'encouraged' }); });
        const screen = await renderRole(pluginRoleId);
        await screen.pressByTestIdAsync('settings.roles.detail.instructions.read');
        await act(async () => { screen.findByTestId('settings.roles.detail.instructions')!.props.onChangeText('Reader instructions'); });
        await act(async () => { screen.findByTestId('settings.roles.detail.instructions')!.props.onBlur(); });
        await vi.waitFor(() => expect(overrides()[pluginRoleId]).toMatchObject({ instructionsOverride: 'Reader instructions', secondOpinion: 'encouraged' }));
        expect(menuActions(screen).map(action => action.id)).toEqual(['duplicate']);
        expect(shareButton(screen)).toBeUndefined();
        await screen.pressByTestIdAsync('settings.roles.detail.instructions.reset');
        await vi.waitFor(() => expect(overrides()[pluginRoleId]).toBeUndefined());
    });
    it('previews the canonical dispatch renderer output for the full saved catalog', async () => {
        const screen = await renderRole('orchestrator');
        expect(screen.findByTestId('settings.roles.detail.preview.block')).toBeNull();
        await openPreview(screen);
        const result = await execute('roles.list', {}, { surface: 'ui' });
        if (!result.ok) throw new Error(result.error);
        const items = RoleActionOutputSchemasV1['roles.list'].parse(result.result).items;
        const orchestrator = { roleId: 'orchestrator', ...BUILT_IN_ROLES_V1.orchestrator, secondOpinion: 'encouraged' as const, changedAt: 'settings' as const };
        expect(previewText(screen)).toBe(renderSessionRoleBlockV1({ role: orchestrator, source: 'dispatch',
            availableRoles: items.map(item => item.roleId === 'orchestrator' ? orchestrator : { roleId: item.roleId, ...item.role }) }));
        expect(previewText(screen)).toContain('Consider a second opinion');
        expect(previewText(screen)).toContain('session.spawn_new');
    });
    it('scopes Share, Duplicate, Reset and Delete to the actual Artifact access', async () => {
        const ids = (screen: Screen) => [...(shareButton(screen) ? ['share'] : []),
            ...(screen.findHostByTestId('settings.roles.detail.instructions.reset') ? ['reset'] : []), ...menuActions(screen).map(action => action.id)];
        expect(ids(await renderRole('orchestrator'))).toEqual(['reset', 'duplicate']);
        expect(ids(await renderRole())).toEqual(['share', 'duplicate', 'delete']);
        for (const access of ['edit', 'view'] as const) expect(ids(await renderRole(await sharedRole(access)))).toEqual(['share', 'duplicate']);
    });
    it.each(['admin', 'edit', 'view'] as const)('opens the document share sheet for a shared %s role without writing', async access => {
        const id = await sharedRole(access);
        const screen = await renderRole(id);
        const before = home.artifacts.list();
        await act(async () => { await shareButton(screen)!.props.onPress(); });
        expect(shareSheets()).toEqual([expect.objectContaining({ chrome: expect.objectContaining({ testID: 'document-share-modal' }),
            props: expect.objectContaining({ kind: 'role.v1', artifactId: id, linkPath: `/settings/roles/${id}`, onSendCopy: expect.any(Function) }) })]);
        expect(home.artifacts.list()).toEqual(before);
    });
    it('shares the own role with a resolved placement subtitle and no writes', async () => {
        const screen = await renderRole();
        const before = home.artifacts.list();
        await act(async () => { await shareButton(screen)!.props.onPress(); });
        expect(shareSheets()[0]).toMatchObject({ chrome: { testID: 'document-share-modal' },
            props: { kind: 'role.v1', artifactId: roleId, linkPath: `/settings/roles/${roleId}` } });
        const sheet = shareSheets()[0] as { chrome: { subtitle: string } };
        expect(sheet.chrome.subtitle).not.toContain('null');
        expect(sheet.chrome.subtitle).not.toContain('roles.rail.defaultEngine');
        expect(sheet.chrome.subtitle).toContain('roles.settings.runsAsSession');
        expect(home.artifacts.list()).toEqual(before);
    });
    it('exports a copy as the portable role document through the browser download boundary', async () => {
        const screen = await renderRole();
        await act(async () => { await shareButton(screen)!.props.onPress(); });
        const blobs: Blob[] = [];
        const downloaded: string[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:role-copy'; });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.stubGlobal('document', { body: { appendChild() {} }, createElement: () => {
            const anchor = { download: '', style: {}, remove() {}, click() { downloaded.push(anchor.download); } };
            return anchor;
        } });
        const onSendCopy = shareSheets()[0]?.props?.onSendCopy;
        if (typeof onSendCopy !== 'function') throw new Error('Share sheet must expose Send a copy');
        await act(async () => { await onSendCopy(); });
        expect(downloaded).toEqual(['UI-builder.role.json']);
        expect(JSON.parse(await blobs[0]!.text())).toEqual(ownRole);
    });
    it('opens the newly created role rather than the previously visited role', async () => {
        const screen = await renderScreen(<RoleDetailScreen target={{ kind: 'draft' }} />);
        await act(async () => { screen.findByTestId('settings.roles.draft.name')!.props.onChangeText('Payments reviewer'); });
        await screen.pressByTestIdAsync('settings.roles.draft.create');
        await vi.waitFor(() => expect(home.artifacts.list()).toHaveLength(2));
        const created = home.artifacts.list().find(row => row.id !== roleId)!;
        await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/settings/roles/${created.id}`));
        expect(storedRole(created.id).name).toBe('Payments reviewer');
    });
    it('duplicates the effective role without editing its original source', async () => {
        const screen = await renderRole('orchestrator');
        await act(async () => { await menuActions(screen).find(action => action.id === 'duplicate')!.onSelect(); });
        await vi.waitFor(() => expect(home.artifacts.list()).toHaveLength(2));
        const duplicate = home.artifacts.list().find(row => row.id !== roleId)!;
        expect(storedRole(duplicate.id)).toEqual({ ...BUILT_IN_ROLES_V1.orchestrator, secondOpinion: 'encouraged', name: 'roles.settings.duplicateName' });
        expect(overrides().orchestrator).toEqual({ roleId: 'orchestrator', secondOpinion: 'encouraged' });
    });
    it('keeps Orchestrator in the current session and offers placement choices for a custom role', async () => {
        const builtIn = await renderRole('orchestrator');
        expect(builtIn.findHostByTestId('settings.roles.detail.runsAs.thisSession')).toBeTruthy();
        expect(builtIn.findAll(node => node.props?.testIDPrefix === 'settings.roles.detail.runsAs')).toEqual([]);
        const own = await renderRole();
        expect(own.findHostByTestId('settings.roles.detail.runsAs.thisSession')).toBeNull();
        expect(own.findAll(node => node.props?.testIDPrefix === 'settings.roles.detail.runsAs').length).toBeGreaterThan(0);
    });
    it('shows the platform default after resetting a built-in override', async () => {
        const edited = await renderRole('orchestrator');
        expect(edited.findHostByTestId('settings.roles.detail.instructions.reset')).toBeTruthy();
        await edited.pressByTestIdAsync('settings.roles.detail.instructions.reset');
        await vi.waitFor(() => expect(edited.findHostByTestId('settings.roles.detail.instructions.platformDefault')).toBeTruthy());
        expect(edited.findHostByTestId('settings.roles.detail.instructions.reset')).toBeNull();
        const own = await renderRole();
        expect(own.findHostByTestId('settings.roles.detail.instructions.platformDefault')).toBeNull();
        expect(own.findHostByTestId('settings.roles.detail.instructions.reset')).toBeNull();
    });
});
