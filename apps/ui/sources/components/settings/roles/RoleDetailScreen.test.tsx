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
const { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
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
        storage.getState().applySettingsLocal({ workDepthLimit: 4 });
        applyPromptLibraryCatalogSnapshot({ serverId: 'server-1', accountId: 'account-1' }, {
            catalog: { status: 'ready', rows: [{ record: { key: 'role-overrides', value: { v: 1, ...shared.rolesV1 } }, revision: 1 }],
                tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 0,
        }, true);
        invalidateRoleCatalog();
    }); });

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

    it.each([
        { roleId: 'plugin:example/scout', sharedRole: false, viewOnly: true },
        { roleId: 'shared-viewer', sharedRole: true, viewOnly: true },
        { roleId: 'shared-editor', sharedRole: true, viewOnly: false },
    ])('edits instructions for $roleId through its permitted writer and preserves Reset', async ({ roleId, sharedRole, viewOnly }) => {
        const { roleId: _id, ...role } = ownRole;
        const revision = { headerVersion: 2, bodyVersion: 5 };
        shared.items.push({ roleId, role, revision, shared: sharedRole, viewOnly, migratedFromV0_2: false });
        shared.rolesV1.overrides[roleId] = { roleId, secondOpinion: 'encouraged' };
        await act(async () => { invalidateRoleCatalog(); });
        const screen = await renderRole(roleId);
        const input = () => screen.findByTestId('settings.roles.detail.instructions')!;
        expect(input().props.editable).not.toBe(false);
        await act(async () => { input().props.onChangeText('Reader instructions'); });
        await act(async () => { input().props.onBlur(); });
        await vi.waitFor(() => expect(writes()).toEqual([viewOnly ? {
            actionId: 'roles.override.set',
            input: { roleId, secondOpinion: 'encouraged', instructionsOverride: 'Reader instructions' },
        } : {
            actionId: 'roles.update',
            input: { roleId, role: { ...role, secondOpinion: 'encouraged', instructions: 'Reader instructions' }, expectedRevision: revision },
        }]));
        // Reset sits with the instructions it restores ("Edited · Reset to default"), not in the ⋯ menu.
        await screen.pressByTestIdAsync('settings.roles.detail.instructions.reset');
        await vi.waitFor(() => expect(writes().at(-1)).toEqual({ actionId: 'roles.override.reset', input: { roleId } }));
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

    /** The visible Share action beside the ⋯ menu (lab `settings-R`). */
    function shareButton(screen: Awaited<ReturnType<typeof renderRole>>): { props: { onPress: () => unknown } } | undefined {
        return screen.findAll((node: any) => node.props?.testID === 'settings.roles.detail.share' && typeof node.props.onPress === 'function')[0];
    }

    it('offers Share for role Artifacts, Duplicate for every role, and keeps Reset and Delete scoped to their permissions', async () => {
        const ids = (screen: Awaited<ReturnType<typeof renderRole>>) => [
            ...(shareButton(screen) ? ['share'] : []),
            ...(screen.findHostByTestId('settings.roles.detail.instructions.reset') ? ['reset'] : []),
            ...menuActions(screen).map((action) => action.id),
        ];
        const { roleId: _ownId, ...ownDocument } = ownRole;
        shared.items.push(
            { roleId: 'shared-editor', role: { ...ownDocument, name: 'Shared editor' }, revision: { headerVersion: 1, bodyVersion: 1 }, shared: true, viewOnly: false, migratedFromV0_2: false },
            { roleId: 'shared-viewer', role: { ...ownDocument, name: 'Shared viewer' }, revision: { headerVersion: 1, bodyVersion: 1 }, shared: true, viewOnly: true, migratedFromV0_2: false },
            { roleId: 'plugin:example/scout', role: { ...ownDocument, name: 'Plugin scout' }, shared: false, viewOnly: false, migratedFromV0_2: false },
        );
        invalidateRoleCatalog();
        expect(ids(await renderRole('orchestrator'))).toEqual(['reset', 'duplicate']);
        expect(ids(await renderRole('ui-builder'))).toEqual(['share', 'duplicate', 'delete']);
        expect(ids(await renderRole('shared-editor'))).toEqual(['share', 'duplicate']);
        expect(ids(await renderRole('shared-viewer'))).toEqual(['share', 'duplicate']);
        expect(ids(await renderRole('plugin:example/scout'))).toEqual(['duplicate']);
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
        const share = shareButton(screen);
        expect(share).toBeDefined();
        await share!.props.onPress();
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
        const share = shareButton(screen);
        expect(share).toBeDefined();
        await share!.props.onPress();
        expect(shared.shown).toHaveLength(1);
        expect(shared.shown[0]).toMatchObject({
            chrome: { testID: 'document-share-modal', subtitle: expect.stringContaining('roles.rail.defaultEngine') },
            props: { kind: 'role.v1', artifactId: 'ui-builder', linkPath: '/settings/roles/ui-builder' },
        });
        const sheet = shared.shown[0] as { chrome: { subtitle: string } };
        expect(sheet.chrome.subtitle).not.toContain('null');
        expect(sheet.chrome.subtitle).toContain('roles.settings.runsAsSession');
        // Opening the sheet writes nothing; grants change only inside the sheet.
        expect(writes()).toEqual([]);
    });

    it('sends a copy of the role as its portable role.v1 document', async () => {
        const screen = await renderRole('ui-builder');
        await shareButton(screen)!.props.onPress();
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
    it('duplicates a role as one of the reader\'s own, leaving the original untouched', async () => {
        const screen = await renderRole('orchestrator');
        await act(async () => { await menuActions(screen).find((action) => action.id === 'duplicate')!.onSelect(); });
        const { roleId: _id, ...document } = orchestrator;
        expect(writes()).toEqual([{ actionId: 'roles.create', input: { role: {
            ...document, secondOpinion: 'encouraged', name: 'roles.settings.duplicateName',
        } } }]);
    });

    it('states that the Orchestrator runs as the session it is turned on in instead of offering a choice', async () => {
        const orchestratorScreen = await renderRole('orchestrator');
        expect(orchestratorScreen.findHostByTestId('settings.roles.detail.runsAs.thisSession')).toBeTruthy();
        expect(orchestratorScreen.findAll((node: any) => node.props?.testIDPrefix === 'settings.roles.detail.runsAs')).toEqual([]);

        const ownScreen = await renderRole('ui-builder');
        expect(ownScreen.findHostByTestId('settings.roles.detail.runsAs.thisSession')).toBeNull();
        expect(ownScreen.findAll((node: any) => node.props?.testIDPrefix === 'settings.roles.detail.runsAs')).toHaveLength(1);
    });

    it('says whether a built-in still follows the platform default or was edited', async () => {
        const edited = await renderRole('orchestrator');
        expect(edited.findHostByTestId('settings.roles.detail.instructions.reset')).toBeTruthy();
        expect(edited.findHostByTestId('settings.roles.detail.instructions.platformDefault')).toBeNull();

        shared.rolesV1 = { overrides: {} };
        await act(async () => {
            applyPromptLibraryCatalogSnapshot({ serverId: 'server-1', accountId: 'account-1' }, {
                catalog: { status: 'ready', rows: [{ record: { key: 'role-overrides', value: { v: 1, overrides: {} } }, revision: 2 }],
                    tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 0,
            }, true);
        });
        const untouched = await renderRole('orchestrator');
        expect(untouched.findHostByTestId('settings.roles.detail.instructions.platformDefault')).toBeTruthy();
        expect(untouched.findHostByTestId('settings.roles.detail.instructions.reset')).toBeNull();
        // The reader's own role is neither: it has no default to follow or return to.
        const own = await renderRole('ui-builder');
        expect(own.findHostByTestId('settings.roles.detail.instructions.platformDefault')).toBeNull();
        expect(own.findHostByTestId('settings.roles.detail.instructions.reset')).toBeNull();
    });
});
