import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { createMachineFixture, renderHook } from '@/dev/testkit';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';

import { useNewSessionMachinePathState } from './useNewSessionMachinePathState';
import { createManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MachineFixtureInput = {
    id: string;
    metadata?: Partial<NonNullable<Machine['metadata']>> | null;
    active?: boolean;
    activeAt?: number;
    revokedAt?: number | null;
};

type HookState = ReturnType<typeof useNewSessionMachinePathState>;
type HookParams = Omit<Parameters<typeof useNewSessionMachinePathState>[0], 'serverId'> & { serverId?: string | null };

function makeMachine({ id, metadata, ...overrides }: MachineFixtureInput): Machine {
    const base = createMachineFixture({ id, ...overrides });
    // These tests intentionally model partially hydrated machine metadata.
    const mergedMetadata = metadata === undefined
        ? base.metadata
        : metadata === null
            ? null
            : {
                ...(base.metadata ?? {}),
                ...metadata,
            } as NonNullable<Machine['metadata']>;
    return {
        ...base,
        ...overrides,
        id,
        metadata: mergedMetadata,
    };
}

function toMachines(...machines: MachineFixtureInput[]): HookParams['machines'] {
    return machines.map(makeMachine);
}

function createSession(input: Readonly<{
    id: string;
    machineId: string;
    path: string;
    updatedAt?: number;
}>): Session {
    return {
        id: input.id,
        seq: 1,
        createdAt: 1,
        updatedAt: input.updatedAt ?? 1,
        active: true,
        activeAt: 1,
        metadata: {
            machineId: input.machineId,
            path: input.path,
            homeDir: '/Users/test',
            host: 'host.local',
            flavor: 'claude',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

function getSelection(state: HookState): Readonly<{
    selectedMachineId: string | null;
    selectedPath: string;
}> {
    return {
        selectedMachineId: state.selectedMachineId,
        selectedPath: state.selectedPath,
    };
}

function renderMachinePathState(initialProps: HookParams) {
    return renderHook((props: HookParams) => useNewSessionMachinePathState({ serverId: 'server-a', ...props }), {
        initialProps,
    });
}

describe('useNewSessionMachinePathState', () => {
    it('defaults Bot drafts to the selected machine home while ordinary drafts keep their recent folder', async () => {
        const initial = { machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/home/alice' } },
            { id: 'machine-b', metadata: { homeDir: 'C:\\Users\\bob\\' } }),
            recentMachinePaths: [{ machineId: 'machine-a', path: '/home/alice/repo' },
                { machineId: 'machine-b', path: 'C:\\Users\\bob\\repo' }],
            machineIdParam: 'machine-a', pathParam: null };
        const ordinary = await renderMachinePathState(initial);
        expect(ordinary.getCurrent().selectedPath).toBe('/home/alice/repo');
        await ordinary.unmount();
        const bot = await renderMachinePathState({ ...initial, isBot: true });
        expect(bot.getCurrent().directoryIntent).toEqual({ kind: 'path', path: '/home/alice' });
        await act(async () => bot.getCurrent().setSelectedMachineId('machine-b'));
        expect(bot.getCurrent().selectedPath).toBe('C:\\Users\\bob\\');
        await act(async () => bot.getCurrent().setSelectedPath('C:\\work\\chosen'));
        await bot.rerender({ ...initial, isBot: true });
        expect(bot.getCurrent().getRequestedPath()).toBe('C:\\work\\chosen');
        await bot.unmount();
    });

    it('resolves a Bot default after machine hydration and keeps explicit draft folders', async () => {
        const initial = { machines: toMachines({ id: 'machine-a', metadata: null }),
            recentMachinePaths: [{ machineId: 'machine-a', path: '/home/alice/repo' }],
            machineIdParam: 'machine-a', pathParam: null, isBot: true };
        const bot = await renderMachinePathState(initial);
        expect(bot.getCurrent().selectedPath).toBe('');
        await bot.rerender({ ...initial, machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/home/alice' } }) });
        expect(bot.getCurrent().getRequestedPath()).toBe('/home/alice');
        await bot.unmount();
        const restored = await renderMachinePathState({ ...initial, persistedMachineId: 'machine-a', persistedPath: '/chosen' });
        expect(restored.getCurrent().selectedPath).toBe('/chosen');
        await restored.unmount();
    });

    it('adopts the enrolled dedicated Bot machine home without replacing an explicitly chosen folder', async () => {
        const initial = { machines: toMachines({ id: 'host', metadata: { homeDir: '/home/host' } }),
            recentMachinePaths: [], machineIdParam: null, pathParam: null, isBot: true };
        const bot = await renderMachinePathState(initial);
        // Ordinary auto-persistence echoes the default; it is not a folder choice.
        await bot.rerender({ ...initial, persistedPath: '/home/host' });
        await act(async () => bot.getCurrent().adoptManagedMachineTarget('enrolled'));
        await bot.rerender({ ...initial, machines: toMachines({ id: 'host', metadata: { homeDir: '/home/host' } },
            { id: 'enrolled', metadata: { homeDir: '/home/guest' } }) });
        expect(bot.getCurrent().directoryIntent).toEqual({ kind: 'path', path: '/home/guest' });
        await act(async () => bot.getCurrent().setSelectedPath('/explicit'));
        await act(async () => bot.getCurrent().adoptManagedMachineTarget('second'));
        await bot.rerender({ ...initial, machines: toMachines({ id: 'second', metadata: { homeDir: '/home/second' } }) });
        expect(bot.getCurrent().getRequestedPath()).toBe('/explicit');
        await bot.unmount();
    });

    it('reopens an unallocated dedicated Bot without mistaking its persisted home default for an authored folder', async () => {
        const draft = createManagedMachineSelectionDraft({
            selection: { kind: 'preset', homeId: 'server-a', id: 'guest', revision: 1 },
            receipt: { launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
                controller: { machineId: 'host', installationId: 'installation' }, optionStatus: 'current', prerequisites: [],
                billing: { location: 'local', stoppedBilling: 'not-billed' }, retentionCapabilities: { supportedIntents: ['delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        });
        const initial = { machines: toMachines({ id: 'host', metadata: { homeDir: '/home/host' } },
            { id: 'guest', metadata: { homeDir: '/home/guest' } }), recentMachinePaths: [],
            machineIdParam: null, pathParam: null, isBot: true, persistedExecutionTarget: null,
            persistedManagedMachineSelection: draft, persistedPath: '/home/host' };
        const bot = await renderMachinePathState(initial);
        await act(async () => bot.getCurrent().adoptManagedMachineTarget('guest'));
        expect(bot.getCurrent().getRequestedPath()).toBe('/home/guest');
        await bot.unmount();
        const explicit = await renderMachinePathState({ ...initial, persistedPath: '/chosen' });
        await act(async () => explicit.getCurrent().adoptManagedMachineTarget('guest'));
        expect(explicit.getCurrent().getRequestedPath()).toBe('/chosen');
        await explicit.unmount();
    });

    it('defaults a foreign controller to Keep and exposes the owner-only reason while refusing Stop/Delete selection', async () => {
        const draft = createManagedMachineSelectionDraft({
            selection: { kind: 'preset', homeId: 'srv-home-a', id: 'preset-a', revision: 3 },
            receipt: { launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
                controller: { machineId: 'host', installationId: 'installation' }, optionStatus: 'current', prerequisites: [],
                billing: { location: 'local', stoppedBilling: 'not-billed' }, retentionCapabilities: { supportedIntents: ['stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            archiveEffect: 'stop',
        });
        const shared = createMachineFixture({ id: 'host', isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready',
        } });
        const hook = await renderMachinePathState({ machines: [shared], recentMachinePaths: [], machineIdParam: null,
            pathParam: null, requestedManagedMachineSelection: draft });
        expect(hook.getCurrent().managedMachineSelection?.archiveEffect).toBe('keep');
        expect(hook.getCurrent()).toMatchObject({ managedMachineArchiveChoiceAvailability: {
            supportedEffects: ['keep'], reason: 'shared_unsupported', controllerMachineId: 'host',
            custodian: { accountId: 'alice', displayName: 'Alice' },
        } });
        for (const effect of ['stop', 'delete'] as const) {
            await act(async () => hook.getCurrent().setManagedMachineArchiveEffect(effect));
            expect(hook.getCurrent().managedMachineSelection?.archiveEffect).toBe('keep');
        }
        await hook.unmount();
        const owned = await renderMachinePathState({ machines: [createMachineFixture({ id: 'host', active: false, activeAt: 0 })],
            recentMachinePaths: [], machineIdParam: null, pathParam: null, requestedManagedMachineSelection: draft });
        expect(owned.getCurrent().managedMachineSelection?.archiveEffect).toBe('stop');
        expect(owned.getCurrent()).toMatchObject({ managedMachineArchiveChoiceAvailability: {
            supportedEffects: ['keep', 'stop', 'delete'], nativeUnsupportedEffects: [],
        } });
        expect(owned.getCurrent().managedMachineArchiveChoiceAvailability?.reason).toBeUndefined();
        await owned.unmount();
    });

    it('consumes a fresh reviewed managed picker request once without restoring a previous paid target or replacing the authored path', async () => {
        const draft = createManagedMachineSelectionDraft({
            selection: { kind: 'preset', homeId: 'srv-home-a', id: 'new-recipe', revision: 3 },
            receipt: { launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
                controller: { machineId: 'host', installationId: 'installation' }, optionStatus: 'current', prerequisites: [],
                billing: { location: 'local', stoppedBilling: 'not-billed' }, retentionCapabilities: { supportedIntents: ['delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        });
        const initial = { machines: toMachines({ id: 'host' }, { id: 'previous-paid' }), recentMachinePaths: [], machineIdParam: null, pathParam: null };
        const hook = await renderMachinePathState(initial);
        await act(async () => hook.getCurrent().setSelectedMachineId('previous-paid'));
        await act(async () => hook.getCurrent().setSelectedPath('/authored'));
        expect(hook.getCurrent().selectedPath).toBe('/authored');
        await hook.rerender({ ...initial, requestedManagedMachineSelection: draft, executionTargetRequestKey: 'managed-picker-use', persistedExecutionTarget: null });
        expect(hook.getCurrent()).toMatchObject({ managedMachineSelection: draft, executionTarget: null, selectedMachineId: null, selectedPath: '/authored' });
        await act(async () => hook.getCurrent().cancelManagedMachineTarget());
        await hook.rerender({ ...initial, requestedManagedMachineSelection: draft, executionTargetRequestKey: 'managed-picker-use', persistedExecutionTarget: null });
        expect(hook.getCurrent().managedMachineSelection).toBeNull();
        await hook.unmount();
        const reopened = await renderMachinePathState({ ...initial, requestedManagedMachineSelection: draft,
            executionTargetRequestKey: 'reopened-managed-use', persistedExecutionTarget: null, persistedPath: '/authored' });
        expect(reopened.getCurrent()).toMatchObject({ managedMachineSelection: draft, selectedMachineId: null, selectedPath: '/authored' });
        await reopened.unmount();
    });

    it('keeps a reviewed managed recipe unallocated, preserves authored input on enrollment, and clears it on a replacement target', async () => {
        const draft = createManagedMachineSelectionDraft({
            selection: { kind: 'preset', homeId: 'srv-home-a', id: 'preset-a', revision: 3 },
            receipt: {
                launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1,
                    name: 'Guest', choices: { cores: 2 } },
                controller: { machineId: 'host', installationId: 'installation' }, optionStatus: 'current',
                prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                preset: { id: 'preset-a', revision: 3, name: 'Guest' },
            },
        });
        const hook = await renderMachinePathState({ machines: toMachines({ id: 'host' }),
            recentMachinePaths: [], machineIdParam: null, pathParam: null });
        await act(async () => {
            hook.getCurrent().setSelectedPath('/authored');
            hook.getCurrent().setManagedMachineTarget(draft);
        });
        expect(hook.getCurrent().managedMachineSelection).toEqual(draft);
        expect(hook.getCurrent().executionTarget).toBeNull();
        expect(hook.getCurrent().selectedMachineId).toBeNull();
        expect(hook.getCurrent().agentCatalogMachineId).toBe('host');
        expect(hook.getCurrent().selectedPath).toBe('/authored');
        await act(async () => hook.getCurrent().adoptManagedMachineTarget('enrolled'));
        expect(hook.getCurrent().selectedMachineId).toBe('enrolled');
        expect(hook.getCurrent().managedMachineSelection).toEqual(draft);
        expect(hook.getCurrent().selectedPath).toBe('/authored');
        await act(async () => hook.getCurrent().setManagedMachineArchiveEffect('stop'));
        expect(hook.getCurrent().managedMachineSelection).toEqual({ ...draft, archiveEffect: 'stop' });
        // Archive policy edits keep the admitted target and paid selection identity.
        expect(hook.getCurrent().managedMachineSelection?.selection).toBe(draft.selection);
        expect(hook.getCurrent().selectedMachineId).toBe('enrolled');
        expect(hook.getCurrent().selectedPath).toBe('/authored');
        await act(async () => hook.getCurrent().cancelManagedMachineTarget());
        expect(hook.getCurrent().managedMachineSelection).toBeNull();
        expect(hook.getCurrent().selectedMachineId).toBeNull();
        expect(hook.getCurrent().selectedPath).toBe('/authored');
        await act(async () => hook.getCurrent().setManagedMachineTarget(draft));
        await act(async () => hook.getCurrent().setTemporaryComputerTarget({
            serverId: 'server-a', artifactTarget: 'linux-x64', workspace: { kind: 'choose_on_endpoint' },
        }));
        expect(hook.getCurrent().managedMachineSelection).toBeNull();
        await act(async () => hook.getCurrent().setManagedMachineTarget(draft));
        await hook.rerender({ machines: toMachines({ id: 'host' }), recentMachinePaths: [],
            machineIdParam: null, pathParam: null, serverId: 'server-b' });
        expect(hook.getCurrent().managedMachineSelection).toBeNull();
        // A deliberate cross-Home Use carries the local profile separately from stable Home identity.
        await act(async () => hook.getCurrent().setManagedMachineTarget(draft, 'server-c'));
        await hook.rerender({ machines: toMachines({ id: 'host' }), recentMachinePaths: [],
            machineIdParam: null, pathParam: null, serverId: 'server-c' });
        expect(hook.getCurrent().managedMachineSelection).toEqual(draft);
        await hook.unmount();
    });

    it('commits a Temporary computer target without pairing it with a machine', async () => {
        const hook = await renderHook(() => useNewSessionMachinePathState({
            serverId: 'server-a',
            machines: [makeMachine({ id: 'machine-a' })],
            recentMachinePaths: [],
            machineIdParam: null,
            pathParam: null,
        }));

        await act(async () => {
            hook.getCurrent().setTemporaryComputerTarget({
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                workspace: { kind: 'choose_on_endpoint' },
            });
        });

        expect(hook.getCurrent().executionTarget).toEqual({
            kind: 'temporary_computer',
            serverId: 'server-a',
            artifactTarget: 'linux-x64',
            workspace: { kind: 'choose_on_endpoint' },
        });
        expect(hook.getCurrent().selectedMachineId).toBeNull();
        await hook.unmount();
    });

    it('applies a fresh rich picker target after an earlier explicit Machine selection', async () => {
        const initial = {
            machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/a' } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-a',
            pathParam: '/a/repo',
            executionTargetRequestKey: 'seed-before-picker',
            persistedExecutionTarget: {
                kind: 'machine' as const,
                target: { serverId: 'server-a', machineId: 'machine-a' },
            },
        } satisfies HookParams;
        const hook = await renderMachinePathState(initial);
        await act(async () => hook.getCurrent().setSelectedMachineId('machine-a'));

        const temporaryTarget = {
            kind: 'temporary_computer' as const,
            serverId: 'server-a',
            artifactTarget: 'linux-x64' as const,
            workspace: { kind: 'choose_on_endpoint' as const },
        };
        await hook.rerender({
            ...initial,
            machineIdParam: null,
            pathParam: null,
            executionTargetRequestKey: 'picker-return',
            persistedExecutionTarget: temporaryTarget,
        });

        expect(hook.getCurrent()).toMatchObject({
            executionTarget: temporaryTarget,
            selectedMachineId: null,
            selectedPath: '',
        });
        await hook.unmount();
    });

    it('clears a prior Pool origin when the user explicitly selects the same Machine', async () => {
        const poolId = '3a948f0c-bc30-491c-b764-37f0e6744d1f';
        const initial = {
            machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/a' } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-a',
            pathParam: null,
            routeSelectionOrigin: { kind: 'machine_pool' as const, poolId },
        } satisfies HookParams;
        const hook = await renderMachinePathState(initial);
        expect(hook.getCurrent().executionTarget).toMatchObject({
            kind: 'machine',
            selectionOrigin: { kind: 'machine_pool', poolId },
        });

        await act(async () => hook.getCurrent().setSelectedMachineId('machine-a'));
        await hook.rerender({ ...initial, routeSelectionOrigin: undefined });

        expect(hook.getCurrent().executionTarget).toEqual({
            kind: 'machine',
            target: { serverId: 'server-a', machineId: 'machine-a' },
        });
        await hook.unmount();
    });

    it('applies a newly resolved Pool origin when the exact Machine is unchanged', async () => {
        const poolId = '3a948f0c-bc30-491c-b764-37f0e6744d1f';
        const initial = {
            machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/a' } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-a',
            pathParam: null,
            routeSelectionOrigin: undefined,
        } satisfies HookParams;
        const hook = await renderMachinePathState(initial);
        expect(hook.getCurrent().executionTarget).toEqual({
            kind: 'machine',
            target: { serverId: 'server-a', machineId: 'machine-a' },
        });

        await hook.rerender({
            ...initial,
            routeSelectionOrigin: { kind: 'machine_pool' as const, poolId },
        });

        expect(hook.getCurrent().executionTarget).toMatchObject({
            kind: 'machine',
            target: { serverId: 'server-a', machineId: 'machine-a' },
            selectionOrigin: { kind: 'machine_pool', poolId },
        });
        await hook.unmount();
    });

    it('keeps the authored working directory through a redundant or provenance-only reselection', async () => {
        const poolId = '3a948f0c-bc30-491c-b764-37f0e6744d1f';
        const initial = {
            machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/home/a' } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-a',
            pathParam: null,
            routeSelectionOrigin: undefined,
        } satisfies HookParams;
        const hook = await renderMachinePathState(initial);

        await act(async () => hook.getCurrent().setSelectedPath('/home/a/uncommitted-project'));
        expect(hook.getCurrent().selectedPath).toBe('/home/a/uncommitted-project');

        // Re-selecting the Machine already authored is not a target change.
        await act(async () => hook.getCurrent().setSelectedMachineTarget({
            machineId: 'machine-a',
            selectionOrigin: null,
        }));
        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-a',
            selectedPath: '/home/a/uncommitted-project',
        });

        // Resolving the same Machine through a Pool only adds provenance.
        await act(async () => hook.getCurrent().setSelectedMachineTarget({
            machineId: 'machine-a',
            selectionOrigin: { kind: 'machine_pool', poolId },
        }));
        expect(hook.getCurrent().executionTarget).toMatchObject({
            kind: 'machine',
            selectionOrigin: { kind: 'machine_pool', poolId },
        });
        expect(hook.getCurrent().selectedPath).toBe('/home/a/uncommitted-project');

        // Returning through the route with that Pool origin is the same answer.
        await hook.rerender({
            ...initial,
            routeSelectionOrigin: { kind: 'machine_pool' as const, poolId },
        });
        expect(hook.getCurrent().selectedPath).toBe('/home/a/uncommitted-project');

        // Control: a genuinely different Machine still reconciles the folder.
        await act(async () => hook.getCurrent().setSelectedMachineTarget({
            machineId: 'machine-b',
            selectionOrigin: null,
        }));
        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-b',
            selectedPath: '',
        });
        await hook.unmount();
    });

    it('keeps the authored working directory when a Pool resolves the same Machine before its row hydrates', async () => {
        const poolId = '3a948f0c-bc30-491c-b764-37f0e6744d1f';
        const initial = {
            // The exact target is committed, but its local Machine row is absent/partial.
            machines: toMachines({ id: 'machine-other', metadata: { homeDir: '/home/other' } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-a',
            pathParam: null,
            routeSelectionOrigin: undefined,
        } satisfies HookParams;
        const hook = await renderMachinePathState(initial);
        expect(hook.getCurrent().selectedMachineId).toBe('machine-a');

        await act(async () => hook.getCurrent().setSelectedPath('/work/authored-project'));

        // The route picker resolves a Pool to the same Home+Machine: provenance only.
        await hook.rerender({
            ...initial,
            routeSelectionOrigin: { kind: 'machine_pool' as const, poolId },
        });
        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-a',
            selectedPath: '/work/authored-project',
        });
        expect(hook.getCurrent().executionTarget).toMatchObject({
            kind: 'machine',
            target: { serverId: 'server-a', machineId: 'machine-a' },
            selectionOrigin: { kind: 'machine_pool', poolId },
        });

        // Control: a different unhydrated Machine from the route is a real target change.
        await hook.rerender({
            ...initial,
            machineIdParam: 'machine-b',
            routeSelectionOrigin: { kind: 'machine_pool' as const, poolId },
        });
        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-b',
            selectedPath: '',
        });
        await hook.unmount();
    });

    it('can attach a resolved Pool origin without waiting for route parameter hydration', async () => {
        const poolId = '3a948f0c-bc30-491c-b764-37f0e6744d1f';
        const hook = await renderMachinePathState({
            machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/a' } }),
            recentMachinePaths: [],
            machineIdParam: null,
            pathParam: null,
        });

        await act(async () => hook.getCurrent().setSelectedMachineTarget({
            machineId: 'machine-a',
            selectionOrigin: { kind: 'machine_pool', poolId },
        }));

        expect(hook.getCurrent().executionTarget).toMatchObject({
            kind: 'machine',
            target: { serverId: 'server-a', machineId: 'machine-a' },
            selectionOrigin: { kind: 'machine_pool', poolId },
        });
        await hook.unmount();
    });

    it('commits an explicit Machine and its Machine-scoped path through one target transition', async () => {
        const hook = await renderMachinePathState({
            machines: toMachines(
                { id: 'machine-a', metadata: { homeDir: '/a' } },
                { id: 'machine-b', metadata: { homeDir: '/b' } },
            ),
            recentMachinePaths: [],
            machineIdParam: 'machine-a',
            pathParam: '/a/repo',
        });

        await act(async () => hook.getCurrent().setSelectedMachineTarget({
            machineId: 'machine-b',
            path: '/b/repo',
        }));

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-b',
            selectedPath: '/b/repo',
        });
        await hook.unmount();
    });

    it('retains a Temporary computer target and its independent directory until an explicit Machine replacement', async () => {
        const executionTarget = {
            kind: 'temporary_computer',
            serverId: 'server-a',
            artifactTarget: 'darwin-arm64',
            workspace: { kind: 'choose_on_endpoint' },
        } as const;
        const initial = {
            serverId: 'server-a',
            machines: toMachines({ id: 'available', metadata: { homeDir: '/available' } }),
            recentMachinePaths: [],
            machineIdParam: null,
            pathParam: null,
            persistedExecutionTarget: executionTarget,
            persistedPath: '/retained-machine-directory',
        };
        const hook = await renderMachinePathState(initial);
        expect(hook.getCurrent()).toMatchObject({
            executionTarget,
            selectedMachineId: null,
            selectedPath: '/retained-machine-directory',
        });
        await hook.rerender({ ...initial, machines: [] });
        await hook.rerender(initial);
        expect(hook.getCurrent()).toMatchObject({ executionTarget, selectedMachineId: null });

        await act(async () => hook.getCurrent().setSelectedMachineId('available'));
        await hook.rerender(initial);
        expect(hook.getCurrent()).toMatchObject({
            executionTarget: { kind: 'machine', target: { serverId: 'server-a', machineId: 'available' } },
            selectedMachineId: 'available',
        });
    });

    it('accepts a fresh exact route replacement before its Machine snapshot arrives', async () => {
        const initial = {
            machines: toMachines({ id: 'original', metadata: { homeDir: '/original' } }),
            recentMachinePaths: [],
            machineIdParam: 'original',
            pathParam: '/original/repo',
        } satisfies HookParams;
        const hook = await renderMachinePathState(initial);
        await act(async () => hook.getCurrent().setSelectedMachineId('original'));
        await hook.rerender({ ...initial, machineIdParam: 'replacement', pathParam: '/replacement/repo' });
        expect(getSelection(hook.getCurrent())).toEqual({ selectedMachineId: 'replacement', selectedPath: '/replacement/repo' });
        await hook.unmount();
    });

    it('does not transfer an edited implicit Machine path to an exact picker target that has not hydrated', async () => {
        const initial = {
            machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/a' } }),
            recentMachinePaths: [],
            machineIdParam: null,
            pathParam: null,
        } satisfies HookParams;
        const hook = await renderMachinePathState(initial);
        await act(async () => hook.getCurrent().setSelectedPath('/a/authored-repo'));

        await hook.rerender({ ...initial, machineIdParam: 'machine-b' });
        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-b',
            selectedPath: '',
        });

        await hook.rerender({
            ...initial,
            machines: toMachines(
                { id: 'machine-a', metadata: { homeDir: '/a' } },
                { id: 'machine-b', metadata: { homeDir: '/b' } },
            ),
            machineIdParam: 'machine-b',
        });
        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-b',
            selectedPath: '/b',
        });
        await hook.unmount();
    });

    it('does not restore an absent route target after the user replaces it and it reconnects', async () => {
        const initial = {
            machines: toMachines({ id: 'replacement', metadata: { homeDir: '/replacement' } }),
            recentMachinePaths: [],
            machineIdParam: 'original',
            pathParam: '/original/repo',
        } satisfies HookParams;
        const hook = await renderMachinePathState(initial);
        await act(async () => {
            hook.getCurrent().setSelectedMachineId('replacement');
            hook.getCurrent().setSelectedPath('/replacement/repo');
        });
        await hook.rerender({
            ...initial,
            machines: toMachines(
                { id: 'original', metadata: { homeDir: '/original' } },
                { id: 'replacement', metadata: { homeDir: '/replacement' } },
            ),
        });
        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'replacement',
            selectedPath: '/replacement/repo',
        });
        await hook.unmount();
    });

    it('pins the implicit target once its directory is edited, including uncommitted typing', async () => {
        const initial = {
            machines: toMachines({ id: 'original', metadata: { homeDir: '/original' } }),
            recentMachinePaths: [],
            machineIdParam: null,
            pathParam: null,
        } satisfies HookParams;
        const hook = await renderMachinePathState(initial);
        await act(async () => hook.getCurrent().setDraftSelectedPath('/original/typing'));
        await hook.rerender({
            ...initial,
            machines: toMachines({ id: 'replacement', metadata: { homeDir: '/replacement' } }),
        });
        expect(hook.getCurrent().selectedMachineId).toBe('original');
        expect(hook.getCurrent().getRequestedPath()).toBe('/original/typing');
        await hook.unmount();
    });

    it('applies a deliberate route Home change even when both Homes use the same Machine id', async () => {
        const initial = {
            machines: toMachines({ id: 'shared-id', metadata: { homeDir: '/home-a' } }),
            recentMachinePaths: [],
            machineIdParam: 'shared-id',
            pathParam: null,
            cacheScopeKey: 'home-a',
        } satisfies HookParams;
        const hook = await renderMachinePathState(initial);
        await hook.rerender({
            ...initial,
            machines: toMachines({ id: 'shared-id', metadata: { homeDir: '/home-b' } }),
            cacheScopeKey: 'home-b',
        });
        expect(getSelection(hook.getCurrent())).toEqual({ selectedMachineId: 'shared-id', selectedPath: '/home-b' });
        await hook.unmount();
    });

    it('does not restore the prior Home path from a draft echo after an exact Home change', async () => {
        const initial = {
            machines: toMachines({ id: 'shared-id', metadata: { homeDir: '/home-a' } }),
            recentMachinePaths: [],
            machineIdParam: 'shared-id',
            pathParam: null,
            cacheScopeKey: 'home-a',
        } satisfies HookParams;
        const hook = await renderMachinePathState(initial);
        const changed = {
            ...initial,
            machines: toMachines({ id: 'shared-id', metadata: { homeDir: '/home-b' } }),
            cacheScopeKey: 'home-b',
        };
        await hook.rerender(changed);
        expect(hook.getCurrent().selectedPath).toBe('/home-b');
        await hook.rerender({ ...changed, persistedMachineId: 'shared-id', persistedPath: '/home-a' });
        expect(hook.getCurrent().selectedPath).toBe('/home-b');
        await hook.unmount();
    });

    it('seeds the selected path from previous sessions when no stored recent path exists', async () => {
        const initialProps = {
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/test' } }),
            recentMachinePaths: [],
            machineIdParam: null,
            pathParam: null,
            sessions: [
                createSession({
                    id: 'session-1',
                    machineId: 'machine-1',
                    path: '/Users/test/Development/atlas',
                    updatedAt: 25,
                }),
            ],
        };

        const hook = await renderMachinePathState(initialProps);

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/Users/test/Development/atlas',
        });

        await hook.unmount();
    });

    it('applies the route path param immediately even before the route machine snapshot hydrates', async () => {
        const now = Date.now();

        const initialMachines = toMachines(
            { id: 'machine-other', metadata: { homeDir: '/other' }, activeAt: now - 10_000 },
        );
        const hydratedMachines = toMachines(
            { id: 'machine-other', metadata: { homeDir: '/other' }, activeAt: now - 10_000 },
            { id: 'machine-target', metadata: { homeDir: '/target' }, activeAt: now - 10_000 },
        );

        const hook = await renderMachinePathState({
            machines: initialMachines,
            recentMachinePaths: [],
            machineIdParam: 'machine-target',
            pathParam: '/repo/desired',
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-target',
            selectedPath: '/repo/desired',
        });

        await hook.rerender({
            machines: hydratedMachines,
            recentMachinePaths: [],
            machineIdParam: 'machine-target',
            pathParam: '/repo/desired',
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-target',
            selectedPath: '/repo/desired',
        });

        await hook.unmount();
    });

    it('applies a route machineId once it becomes available after machines hydrate', async () => {
        const now = Date.now();
        const initialMachines = toMachines(
            { id: 'machine-other', metadata: { homeDir: '/other' }, activeAt: now - 10_000 },
        );
        const hydratedMachines = toMachines(
            { id: 'machine-other', metadata: { homeDir: '/other' }, activeAt: now - 10_000 },
            { id: 'machine-target', metadata: { homeDir: '/target' }, activeAt: now - 10_000 },
        );

        const hook = await renderMachinePathState({
            machines: initialMachines,
            recentMachinePaths: [],
            machineIdParam: 'machine-target',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-target',
            selectedPath: '',
        });

        await hook.rerender({
            machines: hydratedMachines,
            recentMachinePaths: [],
            machineIdParam: 'machine-target',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-target',
            selectedPath: '/target',
        });

        await hook.unmount();
    });

    it('never pairs an exact seeded directory with a persisted machine from another target', async () => {
        const hook = await renderMachinePathState({
            machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/a' } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-b',
            pathParam: '/b/repo',
            persistedMachineId: 'machine-a',
            persistedPath: '/a/repo',
        } as HookParams & { persistedMachineId: string; persistedPath: string });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-b',
            selectedPath: '/b/repo',
        });

        await hook.unmount();
    });

    it('keeps a persisted exact machine and its path when another machine is online', async () => {
        const now = Date.now();

        const hook = await renderMachinePathState({
            machines: toMachines(
                { id: 'machine-online', metadata: { homeDir: '/online' }, active: true, activeAt: now - 10_000 },
                { id: 'machine-offline', metadata: { homeDir: '/offline' }, active: false, activeAt: now - 10 * 60_000 },
            ),
            recentMachinePaths: [],
            machineIdParam: null,
            pathParam: null,
            persistedMachineId: 'machine-offline',
            persistedPath: '/repo/stale',
        } as HookParams & {
            persistedMachineId: string;
            persistedPath: string;
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-offline',
            selectedPath: '/repo/stale',
        });

        await hook.unmount();
    });

    it('does not let initial machine preselection race persisted preference during hydration', async () => {
        const initial = {
            machines: [],
            recentMachinePaths: [],
            machineIdParam: null,
            pathParam: null,
            persistedMachineId: 'machine-preferred',
            persistedPath: '/repo/preferred',
        } satisfies HookParams;
        const hook = await renderMachinePathState(initial);

        await hook.rerender({
            ...initial,
            machines: toMachines(
                { id: 'machine-default', metadata: { homeDir: '/default' }, activeAt: Date.now() - 10_000 },
                { id: 'machine-preferred', metadata: { homeDir: '/preferred' }, activeAt: Date.now() - 10_000 },
            ),
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-preferred',
            selectedPath: '/repo/preferred',
        });
        await hook.unmount();
    });

    it('tracks a typed draft path separately from the committed selectedPath until the path is committed', async () => {
        const now = Date.now();

        const hook = await renderMachinePathState({
            machines: toMachines(
                { id: 'machine-online', metadata: { homeDir: '/home/online' }, active: true, activeAt: now - 10_000 },
            ),
            recentMachinePaths: [{ machineId: 'machine-online', path: '/repo/current' }],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-online',
            selectedPath: '/repo/current',
        });
        expect((hook.getCurrent() as HookState & {
            getRequestedPath: () => string;
        }).getRequestedPath()).toBe('/repo/current');

        await act(async () => {
            (hook.getCurrent() as HookState & {
                setDraftSelectedPath: (path: string) => void;
            }).setDraftSelectedPath('/repo/draft');
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-online',
            selectedPath: '/repo/current',
        });
        expect((hook.getCurrent() as HookState & {
            getRequestedPath: () => string;
        }).getRequestedPath()).toBe('/repo/draft');

        await act(async () => {
            hook.getCurrent().setSelectedPath('/repo/committed');
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-online',
            selectedPath: '/repo/committed',
        });
        expect((hook.getCurrent() as HookState & {
            getRequestedPath: () => string;
        }).getRequestedPath()).toBe('/repo/committed');

        await hook.unmount();
    });

    it('treats machines as eligible for initial selection when they are online via activeAt even if active=false', async () => {
        const now = Date.now();

        const hook = await renderMachinePathState({
            machines: toMachines(
                { id: 'machine-stale-active', metadata: { homeDir: '/stale' }, active: true, activeAt: now - 3 * 60_000 },
                // Real server snapshots can report recent activeAt while leaving `active` false.
                { id: 'machine-online', metadata: { homeDir: '/online' }, active: false, activeAt: now - 10_000 },
            ),
            recentMachinePaths: [
                { machineId: 'machine-stale-active', path: '/repo/stale' },
                { machineId: 'machine-online', path: '/repo/online' },
            ],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-online',
            selectedPath: '/repo/online',
        });

        await hook.unmount();
    });

    it('prefers an online machine from recent paths over an offline one', async () => {
        const now = Date.now();

        const hook = await renderMachinePathState({
            machines: toMachines(
                { id: 'machine-offline', metadata: { homeDir: '/offline' }, activeAt: now - 3 * 60_000 },
                { id: 'machine-online', metadata: { homeDir: '/online' }, activeAt: now - 10_000 },
            ),
            recentMachinePaths: [
                { machineId: 'machine-offline', path: '/repo/offline' },
                { machineId: 'machine-online', path: '/repo/online' },
            ],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-online',
            selectedPath: '/repo/online',
        });

        await hook.unmount();
    });

    it('upgrades an implicitly selected offline machine to an online replacement once machines hydrate', async () => {
        const now = Date.now();

        const hook = await renderMachinePathState({
            machines: toMachines(
                { id: 'machine-old', metadata: { homeDir: '/old' }, activeAt: now - 3 * 60_000 },
            ),
            recentMachinePaths: [{ machineId: 'machine-old', path: '/repo/old' }],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-old',
            selectedPath: '/repo/old',
        });

        await hook.rerender({
            machines: toMachines(
                { id: 'machine-old', metadata: { homeDir: '/old' }, activeAt: now - 3 * 60_000 },
                { id: 'machine-new', metadata: { homeDir: '/new' }, activeAt: now - 10_000 },
            ),
            recentMachinePaths: [{ machineId: 'machine-old', path: '/repo/old' }],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-new',
            selectedPath: '/new',
        });

        await hook.unmount();
    });

    it('preserves the requested route machine when it is offline but still available', async () => {
        const now = Date.now();

        const hook = await renderMachinePathState({
            machines: toMachines(
                { id: 'machine-offline', metadata: { homeDir: '/offline' }, activeAt: now - 3 * 60_000 },
                { id: 'machine-online', metadata: { homeDir: '/online' }, activeAt: now - 10_000 },
            ),
            recentMachinePaths: [],
            machineIdParam: 'machine-offline',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-offline',
            selectedPath: '/offline',
        });

        await hook.unmount();
    });

    it('reselects a valid machine when the currently selected machine disappears', async () => {
        const initialMachines: MachineFixtureInput[] = [
            { id: 'machine-old', metadata: { homeDir: '/Users/leeroy' } },
        ];
        const replacementMachines: MachineFixtureInput[] = [
            { id: 'machine-new', metadata: { homeDir: '/Users/leeroy/new-home' } },
        ];

        const hook = await renderMachinePathState({
            machines: toMachines(...initialMachines),
            recentMachinePaths: [{ machineId: 'machine-old', path: '/repo/old' }],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-old',
            selectedPath: '/repo/old',
        });

        await hook.rerender({
            machines: toMachines(...replacementMachines),
            recentMachinePaths: [{ machineId: 'machine-new', path: '/repo/new' }],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-new',
            selectedPath: '/repo/new',
        });

        await hook.unmount();
    });

    it('keeps an explicitly selected exact machine and path when that machine disappears', async () => {
        const hook = await renderMachinePathState({
            machines: toMachines(
                { id: 'machine-a', metadata: { homeDir: '/a' } },
                { id: 'machine-b', metadata: { homeDir: '/b' } },
            ),
            recentMachinePaths: [],
            machineIdParam: null,
            pathParam: null,
        });

        await act(async () => {
            hook.getCurrent().setSelectedMachineId('machine-a');
            hook.getCurrent().setSelectedPath('/a/repo');
        });

        await hook.rerender({
            machines: toMachines({ id: 'machine-b', metadata: { homeDir: '/b' } }),
            recentMachinePaths: [{ machineId: 'machine-b', path: '/b/repo' }],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-a',
            selectedPath: '/a/repo',
        });

        await hook.unmount();
    });

    it('keeps an absent persisted exact machine and path instead of selecting an available machine', async () => {
        const hook = await renderMachinePathState({
            machines: toMachines({ id: 'machine-b', metadata: { homeDir: '/b' } }),
            recentMachinePaths: [{ machineId: 'machine-b', path: '/b/repo' }],
            machineIdParam: null,
            pathParam: null,
            persistedMachineId: 'machine-a',
            persistedPath: '/a/repo',
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-a',
            selectedPath: '/a/repo',
        });

        await hook.unmount();
    });

    it('preserves the current selection when it becomes offline but still exists', async () => {
        const now = Date.now();
        const initialMachines = toMachines(
            { id: 'machine-old', metadata: { homeDir: '/Users/leeroy' }, activeAt: now - 5_000 },
            { id: 'machine-new', metadata: { homeDir: '/Users/leeroy/new-home' }, activeAt: now - 10_000 },
        );
        const updatedMachines = toMachines(
            { id: 'machine-old', metadata: { homeDir: '/Users/leeroy' }, activeAt: now - 5 * 60_000 },
            { id: 'machine-new', metadata: { homeDir: '/Users/leeroy/new-home' }, activeAt: now - 10_000 },
        );

        const hook = await renderMachinePathState({
            machines: initialMachines,
            recentMachinePaths: [{ machineId: 'machine-old', path: '/repo/old' }],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-old',
            selectedPath: '/repo/old',
        });

        await hook.rerender({
            machines: updatedMachines,
            recentMachinePaths: [
                { machineId: 'machine-old', path: '/repo/old' },
                { machineId: 'machine-new', path: '/repo/new' },
            ],
            machineIdParam: null,
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-old',
            selectedPath: '/repo/old',
        });

        await hook.unmount();
    });

    it('does not reapply a stale route path after the user switches to another linked worktree path', async () => {
        const hook = await renderMachinePathState({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }),
            recentMachinePaths: [{ machineId: 'machine-1', path: '/repo/custom' }],
            machineIdParam: 'machine-1',
            pathParam: '/repo/custom',
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/custom',
        });
        expect(typeof hook.getCurrent().setSelectedPath).toBe('function');

        await act(async () => {
            hook.getCurrent().setSelectedPath('/repo/release');
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/release',
        });

        await hook.rerender({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }),
            recentMachinePaths: [{ machineId: 'machine-1', path: '/repo/custom' }],
            machineIdParam: 'machine-1',
            pathParam: '/repo/custom',
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/release',
        });

        await hook.rerender({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }),
            recentMachinePaths: [{ machineId: 'machine-1', path: '/repo/custom' }],
            machineIdParam: 'machine-1',
            pathParam: '/repo/hotfix',
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/hotfix',
        });

        await hook.unmount();
    });

    it('accepts string-array machine and path route params from expo-router search state', async () => {
        const hook = await renderMachinePathState({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }),
            recentMachinePaths: [{ machineId: 'machine-1', path: '/repo/recent' }],
            machineIdParam: ['machine-1'],
            pathParam: ['/repo/custom'],
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/custom',
        });

        await hook.unmount();
    });

    it('does not reapply an unchanged machine param after the user selects another available machine', async () => {
        const now = Date.now();

        const hook = await renderMachinePathState({
            machines: toMachines(
                { id: 'machine-offline', metadata: { homeDir: '/offline' }, activeAt: now - 3 * 60_000 },
                { id: 'machine-online', metadata: { homeDir: '/online' }, activeAt: now - 10_000 },
            ),
            recentMachinePaths: [],
            machineIdParam: 'machine-offline',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-offline',
            selectedPath: '/offline',
        });

        await act(async () => {
            hook.getCurrent().setSelectedMachineId('machine-online');
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-online',
            selectedPath: '/online',
        });

        await hook.rerender({
            machines: toMachines(
                { id: 'machine-offline', metadata: { homeDir: '/offline' }, activeAt: now - 3 * 60_000 },
                { id: 'machine-online', metadata: { homeDir: '/online' }, activeAt: now - 10_000 },
            ),
            recentMachinePaths: [],
            machineIdParam: 'machine-offline',
            pathParam: null,
        });

        // The unchanged route machine is not reapplied, so neither is its folder:
        // pairing the machine the user chose with the other machine's home
        // directory would launch the Agent in a directory of a different Machine.
        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-online',
            selectedPath: '/online',
        });

        await hook.unmount();
    });

    it('backfills an empty seeded path once the selected machine home directory becomes available', async () => {
        const hook = await renderMachinePathState({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: undefined } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-1',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '',
        });

        await hook.rerender({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-1',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/Users/leeroy',
        });

        await hook.unmount();
    });

    it('does not clobber an explicit user-cleared path when machine metadata refreshes', async () => {
        const hook = await renderMachinePathState({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/leeroy' } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-1',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '/Users/leeroy',
        });

        await act(async () => {
            hook.getCurrent().setSelectedPath('');
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '',
        });

        await hook.rerender({
            machines: toMachines({ id: 'machine-1', metadata: { homeDir: '/Users/leeroy/updated' } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-1',
            pathParam: null,
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-1',
            selectedPath: '',
        });

        await hook.unmount();
    });

    it('reapplies the route directory after the requested machine hydrates later', async () => {
        const hook = await renderMachinePathState({
            machines: toMachines(),
            recentMachinePaths: [],
            machineIdParam: 'machine-a',
            pathParam: '/repo',
        });

        await hook.rerender({
            machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/Users/leeroy' } }),
            recentMachinePaths: [],
            machineIdParam: 'machine-a',
            pathParam: '/repo',
        });

        expect(getSelection(hook.getCurrent())).toEqual({
            selectedMachineId: 'machine-a',
            selectedPath: '/repo',
        });

        await hook.unmount();
    });

    describe('directory intent', () => {
        it('applies pushed picker intent changes even when choosing the same remembered folder', async () => {
            const initial = {
                machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/a' } }),
                recentMachinePaths: [], machineIdParam: 'machine-a', pathParam: '/a/repo',
                directoryKindParam: 'path' as const,
            };
            const hook = await renderMachinePathState(initial);
            await hook.rerender({ ...initial, directoryKindParam: 'managed' });
            expect(hook.getCurrent().directoryIntent).toEqual({ kind: 'managed' });
            expect(hook.getCurrent().rememberedPath).toBe('/a/repo');
            await hook.rerender(initial);
            expect(hook.getCurrent().directoryIntent).toEqual({ kind: 'path', path: '/a/repo' });
            await hook.unmount();
        });
        it('removes the folder without forgetting it, and choosing it again restores it', async () => {
            const hook = await renderMachinePathState({
                machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/a' } }),
                recentMachinePaths: [],
                machineIdParam: 'machine-a',
                pathParam: '/a/repo',
            });
            expect(hook.getCurrent().directoryIntent).toEqual({ kind: 'path', path: '/a/repo' });

            await act(async () => hook.getCurrent().setDirectoryIntent({ kind: 'managed' }));
            expect(hook.getCurrent().directoryIntent).toEqual({ kind: 'managed' });
            // Folder-scoped features see no folder; the draft still remembers it.
            expect(hook.getCurrent().selectedPath).toBe('');
            expect(hook.getCurrent().getRequestedPath()).toBe('');
            expect(hook.getCurrent().rememberedPath).toBe('/a/repo');

            // Changing machine keeps the no-folder choice.
            await act(async () => hook.getCurrent().setSelectedMachineTarget({ machineId: 'machine-a', path: '/a/other' }));
            expect(hook.getCurrent().directoryKind).toBe('managed');

            await act(async () => hook.getCurrent().setDirectoryIntent({ kind: 'path', path: '/a/repo' }));
            expect(hook.getCurrent().directoryIntent).toEqual({ kind: 'path', path: '/a/repo' });
            expect(hook.getCurrent().selectedPath).toBe('/a/repo');
            await hook.unmount();
        });

        it('treats choosing a folder in the picker as choosing to have one', async () => {
            const hook = await renderMachinePathState({
                machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/a' } }),
                recentMachinePaths: [],
                machineIdParam: undefined,
                pathParam: undefined,
                persistedMachineId: 'machine-a',
                persistedPath: '/a/repo',
                initialDirectoryKind: 'managed',
            });
            expect(hook.getCurrent().directoryIntent).toEqual({ kind: 'managed' });

            await act(async () => hook.getCurrent().setSelectedPath('/a/notes'));
            expect(hook.getCurrent().directoryIntent).toEqual({ kind: 'path', path: '/a/notes' });
            await hook.unmount();
        });

        it('reopens a no-folder draft without a folder', async () => {
            const hook = await renderMachinePathState({
                machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/a' } }),
                recentMachinePaths: [],
                machineIdParam: undefined,
                pathParam: undefined,
                persistedMachineId: 'machine-a',
                persistedPath: '/a/repo',
                initialDirectoryKind: 'managed',
            });
            expect(hook.getCurrent().directoryIntent).toEqual({ kind: 'managed' });
            expect(hook.getCurrent().rememberedPath).toBe('/a/repo');
            await hook.unmount();
        });

        it('holds a fixed intent: no default folder is resolved and no writer can change it', async () => {
            const hook = await renderMachinePathState({
                machines: toMachines({ id: 'machine-a', metadata: { homeDir: '/a' } }),
                recentMachinePaths: [{ machineId: 'machine-a', path: '/a/recent' }],
                machineIdParam: 'machine-a',
                pathParam: undefined,
                fixedDirectoryIntent: { kind: 'managed' },
            });
            const current = hook.getCurrent();
            expect(current.directoryIntent).toEqual({ kind: 'managed' });
            expect(current.directoryIntentFixed).toBe(true);
            expect(current.selectedPath).toBe('');

            await act(async () => hook.getCurrent().setDirectoryIntent({ kind: 'path', path: '/a/recent' }));
            expect(hook.getCurrent().directoryIntent).toEqual({ kind: 'managed' });
            expect(hook.getCurrent().selectedPath).toBe('');
            await hook.unmount();
        });
    });
});
