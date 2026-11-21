import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useNewSessionProjectFilesPlacement } from './useNewSessionProjectFilesPlacement';
import { ManagedCreationSelectionV1Schema } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

describe('Project files authoring in the current placement', () => {
    it('keeps a hydrated guest checkout only while its Machine and folder are selected', async () => {
        const workspace = { v: 2 as const, kind: 'managed' as const, serverId: 'home', workspaceId: 'guest-ref',
            managedId: 'guest', rootPath: '/repo', controller: { machineId: 'controller', installationId: 'install' } };
        const hydratedPlacement = { kind: 'in_place' as const, workspace };
        let selectedPath = '/repo';
        let machineId = 'controller';
        const hook = await renderHook(() => useNewSessionProjectFilesPlacement({
            draftKey: 'project', selectedPath,
            executionTarget: { kind: 'machine', target: { serverId: 'home', machineId } },
            managedMachineSelection: null, hydratedPlacement,
        }));
        expect(hook.getCurrent().sessionPlacement).toEqual(hydratedPlacement);
        expect(hook.getCurrent().projectFilesOutcome).toEqual({ origin: 'default', placementKind: 'in_place' });
        selectedPath = '/other';
        await hook.rerender();
        expect(hook.getCurrent().sessionPlacement).toBeUndefined();
        selectedPath = '/repo';
        machineId = 'other';
        await hook.rerender();
        expect(hook.getCurrent().sessionPlacement).toBeUndefined();
        await hook.unmount();
    });

    it('keeps the chosen method and its Included policy when restoring a draft', async () => {
        const policy = { v: 1 as const, selection: 'all_files' as const,
            extraIgnorePatterns: ['private/**'], extraIncludePatterns: ['build/result.txt'] };
        const contentPolicy = { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) };
        const projectFilesSource = { target: { serverId: 'home', machineId: 'source' }, directory: '/source' };
        const hook = await renderHook(() => useNewSessionProjectFilesPlacement({ draftKey: 'draft', executionTarget: null,
            managedMachineSelection: { selection: ManagedCreationSelectionV1Schema.parse({ kind: 'preset', homeId: 'home', id: 'preset', revision: 1 }) },
            hydratedPlacement: { kind: 'preset', homeId: 'home', presetId: 'preset', projectFilesSource,
                projectFiles: { kind: 'sync', mode: 'keep_both_in_sync', contentPolicy } } }));
        expect(hook.getCurrent().sessionPlacement).toMatchObject({ projectFilesSource,
            projectFiles: { kind: 'sync', mode: 'keep_both_in_sync', contentPolicy } });
        await act(async () => hook.getCurrent().onProjectFilesChange({ kind: 'copy_once', contentPolicy }));
        expect(hook.getCurrent().sessionPlacement).toMatchObject({ projectFiles: { kind: 'copy_once', contentPolicy } });
        await act(async () => hook.getCurrent().onProjectFilesChange({ kind: 'sync', mode: 'keep_synced', contentPolicy }));
        expect(hook.getCurrent().sessionPlacement).toMatchObject({ projectFiles: { kind: 'sync', mode: 'keep_synced', contentPolicy } });
        const gitAccount = { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: 'work' };
        await act(async () => hook.getCurrent().onProjectFilesChange({ kind: 'git_clone', branch: 'feature/work', gitAccount,
            source: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'owner/project' }, protocol: 'https' } }));
        expect(hook.getCurrent().sessionPlacement).toMatchObject({ projectFiles: { gitAccount } });
        await act(async () => hook.getCurrent().onProjectFilesChange(undefined));
        expect(hook.getCurrent().projectFilesOutcome).toMatchObject({ origin: 'default', source: projectFilesSource });
        await hook.unmount();
    });
    it.each([
        { selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 }, expected: { kind: 'preset', homeId: 'home', presetId: 'preset' } },
        { selection: { kind: 'one-off', homeId: 'home', launch: {
            provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {},
        }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }, expected: { kind: 'managed' } },
    ])('keeps default-copy source through $selection.kind creation without a second target', async ({ selection, expected }) => {
        const projectFilesSource = { target: { serverId: 'source-home', machineId: 'source-machine' }, directory: '/source/with-edits' };
        const hook = await renderHook(() => useNewSessionProjectFilesPlacement({ draftKey: 'draft', executionTarget: null,
            managedMachineSelection: { selection: ManagedCreationSelectionV1Schema.parse(selection) }, projectFilesSource }));
        expect(hook.getCurrent().projectFilesOverride).toBeUndefined();
        expect(hook.getCurrent().sessionPlacement).toEqual({ ...expected, projectFilesSource });
        expect(hook.getCurrent().projectFilesOutcome).toEqual({ origin: 'default', placementKind: expected.kind,
            source: projectFilesSource });
        await act(async () => hook.getCurrent().onProjectFilesChange({ kind: 'sync', mode: 'keep_both_in_sync' }));
        expect(hook.getCurrent().sessionPlacement).toEqual({ ...expected, projectFilesSource,
            projectFiles: { kind: 'sync', mode: 'keep_both_in_sync' } });
        expect(hook.getCurrent().projectFilesOutcome).toEqual({ origin: 'override', placementKind: expected.kind,
            source: projectFilesSource, choice: { kind: 'sync', mode: 'keep_both_in_sync' } });
        await hook.unmount();
    });
    it('clears the restored Machine project source when the draft removes its folder', async () => {
        const target = { serverId: 'home', machineId: 'host' };
        const originalSource = { target, directory: '/original' };
        const hydratedPlacement = { kind: 'machine' as const, target, projectFilesSource: originalSource };
        let projectFilesSource: typeof originalSource | undefined = originalSource;
        const hook = await renderHook(() => useNewSessionProjectFilesPlacement({
            draftKey: 'draft', executionTarget: { kind: 'machine', target },
            managedMachineSelection: null, hydratedPlacement, projectFilesSource,
        }));
        expect(hook.getCurrent().sessionPlacement).toEqual(hydratedPlacement);

        projectFilesSource = undefined;
        await hook.rerender();
        expect(hook.getCurrent().sessionPlacement).toEqual({ kind: 'machine', target });
        expect(hook.getCurrent().projectFilesOutcome).toEqual({ origin: 'default', placementKind: 'machine' });

        projectFilesSource = { target, directory: '/replacement' };
        await hook.rerender();
        expect(hook.getCurrent().sessionPlacement).toEqual({ ...hydratedPlacement, projectFilesSource });
        await hook.unmount();
    });

    it('retains a matching reopened choice, supports restoring the default, and leaves another Machine independent', async () => {
        let machineId = 'host';
        const hydratedPlacement = { kind: 'machine' as const, target: { serverId: 'home', machineId: 'host' },
            projectFiles: { kind: 'sync' as const, mode: 'keep_synced' as const } };
        const hook = await renderHook(() => useNewSessionProjectFilesPlacement({ draftKey: 'draft',
            executionTarget: { kind: 'machine', target: { serverId: 'home', machineId } },
            managedMachineSelection: null, hydratedPlacement }));
        expect(hook.getCurrent().sessionPlacement).toEqual(hydratedPlacement);
        await act(async () => hook.getCurrent().onProjectFilesChange({ kind: 'copy_once' }));
        expect(hook.getCurrent().sessionPlacement).toMatchObject({ projectFiles: { kind: 'copy_once' } });
        machineId = 'other-host';
        await hook.rerender();
        expect(hook.getCurrent().sessionPlacement).toBeUndefined();
        expect(hook.getCurrent().projectFilesOverride).toBeUndefined();
        machineId = 'host';
        await hook.rerender();
        await act(async () => hook.getCurrent().onProjectFilesChange(undefined));
        expect(hook.getCurrent().sessionPlacement).toEqual({ kind: 'machine', target: hydratedPlacement.target });
        await hook.unmount();
    });
});
