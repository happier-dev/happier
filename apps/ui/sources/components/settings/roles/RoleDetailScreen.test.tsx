import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_ROLES_V1, renderSessionRoleBlockV1 } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Action front door is this surface's boundary: role reads and writes are Actions whose host
 * (policy, Artifact CAS, `rolesV1`) is outside the page. The fake records each call and answers
 * `roles.list` with a catalog; everything below it (the page, its catalog read, the renderer) is real.
 */
const shared = vi.hoisted(() => ({
    calls: [] as Array<{ actionId: string; input: any }>,
    items: [] as unknown[],
    rolesV1: { overrides: {} as Record<string, Record<string, string>> },
    shown: [] as unknown[],
    savedFiles: [] as Array<{ fileName: string; json: string }>,
}));

// The document file boundary (web download / native share sheet) is the platform edge of "Send a copy".
vi.mock('@/sync/domains/workflows/workflowDocumentFile', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/workflows/workflowDocumentFile')>()),
    saveWorkflowDocument: async (file: { fileName: string; json: string }) => { shared.savedFiles.push(file); },
}));

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => async (actionId: string, input: unknown) => {
        shared.calls.push({ actionId, input });
        if (actionId === 'roles.list') return { ok: true, result: { items: shared.items } };
        return { ok: true, result: {} };
    },
}));

// The modal host is the presentation boundary: the test captures what the page asked it to show.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { show: (config) => { shared.shown.push(config); return 'modal-id'; } } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: createUseSettingMock({
                fallback: (key: string) => {
                    if (key === 'profiles') return [];
                    if (key === 'workDepthLimit') return 4;
                    if (key === 'rolesV1') return shared.rolesV1;
                    if (key === 'acpCatalogSettingsV1') return { v: 2, backends: [] };
                    if (key === 'backendEnabledByTargetKey') return {};
                    return undefined;
                },
            }),
        },
    });
});

const orchestrator = { roleId: 'orchestrator', ...BUILT_IN_ROLES_V1.orchestrator };
const ownRole = {
    roleId: 'ui-builder',
    name: 'UI builder',
    instructions: 'Build interfaces and their copy.',
    runsAs: { kind: 'session' },
    workspaceWrites: 'allow',
    secondOpinion: 'off',
    enabled: true,
};

const { RoleDetailScreen } = await import('./RoleDetailScreen');
const { invalidateRoleCatalog } = await import('@/components/roles/catalog/useRoleCatalog');
const { storage } = await import('@/sync/domains/state/storageStore');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
let previousStorageState = storage.getState();
let previousSnapshot = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();

async function renderRole(roleId: string) {
    const screen = await renderScreen(<RoleDetailScreen target={{ kind: 'role', roleId }} />);
    // The catalog read resolves after mount.
    await vi.waitFor(() => expect(screen.findByTestId(`settings.roles.detail.${roleId}`)).toBeTruthy());
    return screen;
}

function writes() {
    return shared.calls.filter((call) => call.actionId !== 'roles.list');
}

describe('Settings › Roles detail', () => {
    it('updates only the Orchestrator preview when a consumed cross-role fact changes', async () => {
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id="orchestrator" onRender={() => { commits += 1; }}>
            <RoleDetailScreen target={{ kind: 'role', roleId: 'orchestrator' }} />
        </React.Profiler>);
        await vi.waitFor(() => expect(screen.findByTestId('settings.roles.detail.orchestrator')).toBeTruthy());
        const settled = commits;
        const { roleId: _id, ...other } = ownRole;
        shared.items[1] = { roleId: 'ui-builder', role: { ...other, instructions: 'Unconsumed instructions' },
            revision: { headerVersion: 3, bodyVersion: 8 }, shared: false, viewOnly: false, migratedFromV0_2: false };
        await act(async () => { invalidateRoleCatalog(); });
        expect(commits).toBe(settled);
        shared.items[1] = { roleId: 'ui-builder', role: { ...other, name: 'Renamed builder' },
            revision: { headerVersion: 3, bodyVersion: 9 }, shared: false, viewOnly: false, migratedFromV0_2: false };
        await act(async () => { invalidateRoleCatalog(); });
        expect(commits).toBeGreaterThan(settled);
        expect(screen.findByTestId('settings.roles.detail.preview.block')!.props.value).toContain('Renamed builder');
    });

    it('retires the previous Account Role detail when the next Account has no matching Role', async () => {
        const screen = await renderRole('ui-builder');
        shared.items = [];
        await act(async () => { storage.setState({ profileScope: { serverId: 'server-1', accountId: 'account-2' } }); });
        expect(screen.findByTestId('settings.roles.detail.ui-builder')).toBeNull();
        expect(screen.findByTestId('settings.roles.detail.unavailable')).toBeTruthy();
    });
    it('does not recommit role detail for equal refreshes or another role change; preview stays current', async () => {
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id="detail" onRender={() => { commits += 1; }}>
            <RoleDetailScreen target={{ kind: 'role', roleId: 'ui-builder' }} />
        </React.Profiler>);
        await vi.waitFor(() => expect(screen.findByTestId('settings.roles.detail.ui-builder')).toBeTruthy());
        const settled = commits;
        shared.items = structuredClone(shared.items);
        await act(async () => { invalidateRoleCatalog(); });
        expect(commits).toBe(settled);
        const { roleId: _id, ...other } = orchestrator;
        shared.items[0] = { roleId: 'orchestrator', role: { ...other, instructions: 'Updated unrelated instructions' },
            shared: false, viewOnly: false, migratedFromV0_2: false };
        await act(async () => { invalidateRoleCatalog(); });
        expect(commits).toBe(settled);
        const { roleId: _ownId, ...selected } = ownRole;
        shared.items[1] = { roleId: 'ui-builder', role: { ...selected, instructions: 'Updated selected instructions' },
            revision: { headerVersion: 3, bodyVersion: 8 }, shared: false, viewOnly: false, migratedFromV0_2: false };
        await act(async () => { invalidateRoleCatalog(); });
        expect(commits).toBeGreaterThan(settled);
        expect(screen.findByTestId('settings.roles.detail.preview.block')!.props.value).toContain('Updated selected instructions');
    });
    beforeEach(async () => { await act(async () => {
        previousStorageState = storage.getState();
        previousSnapshot = getAppliedActiveServerSnapshot();
        previousAvailable = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot({ serverId: 'server-1', serverUrl: 'https://roles.test', generation: 0 });
        storage.setState({ profileScope: { serverId: 'server-1', accountId: 'account-1' } });
        shared.calls = [];
        shared.shown = [];
        shared.savedFiles = [];
        const { roleId: _orchestratorId, ...orchestratorDocument } = orchestrator;
        const { roleId: _ownId, ...ownDocument } = ownRole;
        shared.items = [
            { roleId: 'orchestrator', role: orchestratorDocument, shared: false, viewOnly: false, migratedFromV0_2: false },
            { roleId: 'ui-builder', role: ownDocument, revision: { headerVersion: 3, bodyVersion: 7 }, shared: false, viewOnly: false, migratedFromV0_2: false },
        ];
        shared.rolesV1 = { overrides: { orchestrator: { roleId: 'orchestrator', secondOpinion: 'encouraged' } } };
        invalidateRoleCatalog();
    }); });

    afterEach(async () => {
        standardCleanup();
        await act(async () => {
        retireActiveServerAccountScopeLifetime();
        storage.setState(previousStorageState);
        publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        });
    });

    it('saves a built-in change as the reader\'s override, keeping the fields already overridden', async () => {
        const screen = await renderRole('orchestrator');
        const handsOff = screen.findByTestId('settings.roles.detail.handsOff')!;
        const toggle = handsOff.findAll((node: any) => typeof node.props?.onValueChange === 'function')[0]!;
        await toggle.props.onValueChange(false);
        await vi.waitFor(() => expect(writes()).toEqual([{
            actionId: 'roles.override.set',
            input: { roleId: 'orchestrator', secondOpinion: 'encouraged', workspaceWrites: 'allow' },
        }]));
    });

    it('saves the reader\'s own role to its Artifact under the revision it was read at', async () => {
        const screen = await renderRole('ui-builder');
        const handsOff = screen.findByTestId('settings.roles.detail.handsOff')!;
        const toggle = handsOff.findAll((node: any) => typeof node.props?.onValueChange === 'function')[0]!;
        await toggle.props.onValueChange(true);
        await vi.waitFor(() => expect(writes()).toEqual([{
            actionId: 'roles.update',
            input: {
                roleId: 'ui-builder',
                role: { name: 'UI builder', instructions: 'Build interfaces and their copy.', runsAs: { kind: 'session' }, workspaceWrites: 'deny', secondOpinion: 'off', enabled: true },
                expectedRevision: { headerVersion: 3, bodyVersion: 7 },
            },
        }]));
    });

    it('previews exactly the block the one role renderer dispatches', async () => {
        const screen = await renderRole('orchestrator');
        const preview = screen.findByTestId('settings.roles.detail.preview.block')!;
        const effectiveOrchestrator = { ...orchestrator, secondOpinion: 'encouraged', changedAt: 'settings' };
        expect(preview.props.value).toBe(renderSessionRoleBlockV1({
            role: effectiveOrchestrator as any,
            source: 'dispatch',
            availableRoles: [effectiveOrchestrator as any, ownRole as any],
        }));
        // The reader's override reaches the prompt: "encouraged" renders its line.
        expect(preview.props.value).toContain('Consider a second opinion');
        expect(preview.props.value).toContain('session.spawn_new');
    });

    function menuActions(screen: Awaited<ReturnType<typeof renderRole>>): Array<{ id: string; onSelect: () => unknown }> {
        const menus = screen.findAll((node: any) => node.props?.testID === 'settings.roles.detail.menu' && Array.isArray(node.props.actions));
        return menus[0]?.props.actions ?? [];
    }

    it('offers Share for role Artifacts while keeping Reset and Delete scoped to their existing permissions', async () => {
        const ids = (screen: Awaited<ReturnType<typeof renderRole>>) => menuActions(screen).map((action) => action.id);
        const { roleId: _ownId, ...ownDocument } = ownRole;
        shared.items.push(
            { roleId: 'shared-editor', role: { ...ownDocument, name: 'Shared editor' }, revision: { headerVersion: 1, bodyVersion: 1 }, shared: true, viewOnly: false, migratedFromV0_2: false },
            { roleId: 'shared-viewer', role: { ...ownDocument, name: 'Shared viewer' }, revision: { headerVersion: 1, bodyVersion: 1 }, shared: true, viewOnly: true, migratedFromV0_2: false },
            { roleId: 'plugin:example/scout', role: { ...ownDocument, name: 'Plugin scout' }, shared: false, viewOnly: false, migratedFromV0_2: false },
        );
        invalidateRoleCatalog();
        expect(ids(await renderRole('orchestrator'))).toEqual(['reset']);
        expect(ids(await renderRole('ui-builder'))).toEqual(['share', 'delete']);
        expect(ids(await renderRole('shared-editor'))).toEqual(['share']);
        expect(ids(await renderRole('shared-viewer'))).toEqual(['share']);
        expect(ids(await renderRole('plugin:example/scout'))).toEqual([]);
    });

    it.each([
        { access: 'Admin', roleId: 'shared-admin', viewOnly: false },
        { access: 'Can edit', roleId: 'shared-editor', viewOnly: false },
        { access: 'Can use', roleId: 'shared-viewer', viewOnly: true },
    ])('opens the canonical role share sheet for a recipient with $access', async ({ roleId, viewOnly }) => {
        const { roleId: _ownId, ...role } = ownRole;
        // roles.list projects Admin and Can edit alike; the sheet reads the grant level itself.
        shared.items.push({ roleId, role, shared: true, viewOnly, migratedFromV0_2: false });
        invalidateRoleCatalog();
        const screen = await renderRole(roleId);
        const share = menuActions(screen).find((action) => action.id === 'share');
        expect(share).toBeDefined();
        await share!.onSelect();
        expect(shared.shown).toEqual([expect.objectContaining({
            chrome: expect.objectContaining({ testID: 'document-share-modal' }),
            props: expect.objectContaining({
                kind: 'role.v1', artifactId: roleId, linkPath: `/settings/roles/${roleId}`,
                onSendCopy: expect.any(Function),
            }),
        })]);
        expect(writes()).toEqual([]);
    });

    it('shares the reader\'s own role through the one document share sheet, as its role Artifact', async () => {
        const screen = await renderRole('ui-builder');
        const share = menuActions(screen).find((action) => action.id === 'share');
        expect(share).toBeDefined();
        await share!.onSelect();
        expect(shared.shown).toHaveLength(1);
        expect(shared.shown[0]).toMatchObject({
            chrome: { testID: 'document-share-modal', subtitle: 'roles.settings.runsAsSession' },
            props: { kind: 'role.v1', artifactId: 'ui-builder', linkPath: '/settings/roles/ui-builder' },
        });
        const sheet = shared.shown[0] as { chrome: { subtitle: string } };
        expect(sheet.chrome.subtitle).not.toContain('null');
        // Opening the sheet writes nothing; grants change only inside the sheet.
        expect(writes()).toEqual([]);
    });

    it('sends a copy of the role as its portable role.v1 document', async () => {
        const screen = await renderRole('ui-builder');
        await menuActions(screen).find((action) => action.id === 'share')!.onSelect();
        const sheet = shared.shown[0] as { props: { onSendCopy?: () => unknown } };
        expect(typeof sheet.props.onSendCopy).toBe('function');
        await sheet.props.onSendCopy!();
        await vi.waitFor(() => expect(shared.savedFiles).toHaveLength(1));
        const { RoleArtifactV1Schema } = await import('@happier-dev/protocol');
        const { roleId: _roleId, ...document } = ownRole;
        expect(RoleArtifactV1Schema.parse(JSON.parse(shared.savedFiles[0]!.json))).toEqual(document);
        expect(shared.savedFiles[0]!.fileName).toBe('UI-builder.role.json');
        expect(writes()).toEqual([]);
    });
});
