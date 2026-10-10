import type * as React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerScopedMachine, ServerScopedMachineGroup } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';

import { installNewSessionComponentsCommonModuleMocks } from '../newSessionComponentsTestHelpers';
import type {
    BuildMachineSelectionListModelParams,
    useMachineSelectionListModel as UseMachineSelectionListModel,
} from './useMachineSelectionListModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The modal host is the one genuine boundary the custom-expiry flow crosses; the
// real `showTemporaryComputerExpiryModal`, the real editor contract and the real
// commit path all run beneath it.
const modalHost = vi.hoisted(() => ({
    show: vi.fn((_config: unknown) => 'modal-id'),
}));

installNewSessionComponentsCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key, params) => key === 'machines.destinations.shared'
            ? `${key}:${String(params?.team)}` : key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { show: modalHost.show as never } }).module;
    },
});

// Cuts the row-accessory's sync/ops import graph out of this pure-model suite;
// the accessory is only ever created as an element here, never rendered.
vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: () => null,
}));

let useMachineSelectionListModel: typeof UseMachineSelectionListModel;

beforeAll(async () => {
    ({ useMachineSelectionListModel } = await import('./useMachineSelectionListModel'));
}, 240_000);

function createMachine(id: string): Machine {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: Date.now(),
        metadata: {
            host: `${id}.local`,
            platform: 'darwin',
            happyCliVersion: '1.0.0',
            happyHomeDir: '/Users/tester/.happy',
            displayName: id,
            homeDir: '/Users/tester',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

function createScopedMachine(machine: Machine): ServerScopedMachine {
    return {
        ...machine,
        serverId: 'server-a',
        serverName: 'Server A',
    };
}

type Fixture = Readonly<{
    machines: ReadonlyArray<Machine>;
    groups: ReadonlyArray<ServerScopedMachineGroup>;
    recent: ReadonlyArray<Machine>;
    favorites: ReadonlyArray<Machine>;
}>;

/**
 * Built per test, never at module scope: `isMachineOnline` compares `activeAt`
 * against a 60s grace window, and this suite's module evaluation can precede
 * the first test by longer than that — a module-scope fixture would silently
 * decay to "offline" and make every row non-selectable.
 */
function createFixture(): Fixture {
    const machines = ['m-1', 'm-2', 'm-3'].map(createMachine);
    return {
        machines,
        groups: [{
            serverId: 'server-a',
            serverName: 'Server A',
            loading: false,
            signedOut: false,
            machines: machines.map(createScopedMachine),
        }],
        recent: [machines[0]!],
        favorites: [machines[1]!],
    };
}

type Handlers = Readonly<{
    selectSpy: ReturnType<typeof vi.fn>;
    toggleSpy: ReturnType<typeof vi.fn>;
    onSelectMachine: (machine: Machine) => void;
    onSelectScopedMachine: (machine: ServerScopedMachine) => void;
    onToggleFavorite: (machine: Machine) => void;
}>;

/**
 * Every field except the handlers is referentially stable across renders — the
 * new-session screen model stabilizes groups / recent / favorites by signature
 * (`useStableValueBySignature`). Only the handlers are recreated, exactly like
 * the machine popover's `renderContent({ requestClose, maxHeight })` does on
 * every measured-placement pass while the popover is open.
 */
function buildParams(fixture: Fixture, handlers: Handlers): BuildMachineSelectionListModelParams {
    return {
        groups: fixture.groups,
        selectedMachine: fixture.machines[0]!,
        selectedServerId: 'server-a',
        recentMachines: fixture.recent,
        favoriteMachines: fixture.favorites,
        onSelectMachine: handlers.onSelectMachine,
        onSelectScopedMachine: handlers.onSelectScopedMachine,
        serverId: 'server-a',
        onToggleFavorite: handlers.onToggleFavorite,
        showFavorites: true,
        showRecent: true,
        showSearch: true,
        showCliGlyphs: true,
        autoDetectCliGlyphs: true,
        favoriteGroupPlacement: 'afterRecent',
        testIdPrefix: 'new-session-machine',
    };
}

function makeHandlers(): Handlers {
    const selectSpy = vi.fn();
    const toggleSpy = vi.fn();
    return {
        selectSpy,
        toggleSpy,
        onSelectMachine: (machine) => selectSpy(machine.id),
        onSelectScopedMachine: (machine) => selectSpy(machine.id),
        onToggleFavorite: (machine) => toggleSpy(machine.id),
    };
}

async function renderModel(fixture: Fixture, initialProps: Handlers) {
    return renderHook<ReturnType<typeof UseMachineSelectionListModel>, Handlers>(
        (handlers) => useMachineSelectionListModel(buildParams(fixture, handlers)),
        { initialProps },
    );
}

function firstStaticOption(model: ReturnType<typeof UseMachineSelectionListModel>) {
    const section = model.rootStep.sections[0];
    if (section?.kind !== 'static') throw new Error('expected a leading static section');
    const option = section.options[0];
    if (!option) throw new Error('expected at least one option');
    return option;
}

describe('useMachineSelectionListModel', () => {
    it.each(['session', 'finite'] as const)('keeps %s managed recipe selection separate from published artifacts and exact machines', async purpose => {
        const fixture = createFixture();
        const handlers = makeHandlers();
        const selection = { kind: 'preset', homeId: 'server-a', id: 'recipe', revision: 3 } as const;
        const receipt = {
            launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1,
                name: 'Guest', choices: { cores: 2 } },
            controller: { machineId: 'host', installationId: 'installation' }, optionStatus: 'current' as const,
            prerequisites: [], billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const },
            retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] as ('start' | 'stop' | 'delete')[] },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
            price: { amount: '1.25', currency: 'USD', unit: 'hour', source: 'provider', observedAt: 1 },
            preset: { id: 'recipe', revision: 3, name: 'Guest' },
        };
        const draft = { selection, receipt, archiveEffect: 'keep' as const };
        const onSelectManagedMachine = vi.fn();
        const onConfigure = vi.fn();
        const artifactSelect = vi.fn();
        const onOpenManagedPresets = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, handlers),
            purpose,
            temporaryComputers: [{ serverId: 'server-a', artifactTarget: 'darwin-arm64', selected: false,
                workspace: null, packageExpiresAt: 12345, onSelect: artifactSelect }],
            managedMachines: [{ id: 'managed-machine:server-a:preset:recipe:3', homeId: 'server-a', kind: 'preset',
                title: 'Guest', subtitle: 'host · Keep', draft }, { id: 'managed-machine:server-a:one-off', homeId: 'server-a',
                kind: 'one-off', title: 'One-off', onSelect: onConfigure }],
            selectedManagedMachine: draft,
            onSelectManagedMachine,
            onOpenManagedPresets,
        }));
        const model = rendered.getCurrent();
        const managed = model.rootStep.sections.find((section) => section.id === 'managed-machines');
        const published = model.rootStep.sections.find((section) => section.id === 'temporary-computer');
        expect(managed?.kind).toBe('static');
        expect(published?.title).toBe(purpose === 'session' ? 'newSession.temporaryComputer.publishedTitle' : undefined);
        if (managed?.kind !== 'static') throw new Error('expected a managed recipe section');
        expect(managed.options.map((row) => row.id)).toEqual([
            'managed-machine:server-a:preset:recipe:3', 'managed-machine:server-a:one-off',
        ]);
        // "New machine" with a quiet trailing "Presets" destination; a preset reads as a preset, one-off as an add.
        expect(managed.title).toBe('newSession.managedMachine.title');
        expect(managed.action?.label).toBe('machinePresets.short');
        managed.action?.onPress();
        expect(onOpenManagedPresets).toHaveBeenCalledOnce();
        expect((managed.options[0]?.icon as React.ReactElement<{ name: string }>).props.name).toBe('stack');
        expect((managed.options[1]?.icon as React.ReactElement<{ name: string }>).props.name).toBe('plus');
        expect(model.selectedOptionId).toBe('managed-machine:server-a:preset:recipe:3');
        expect(managed.options[0]?.rightAccessory).toBeUndefined();
        expect(managed.options[0]?.subtitle).not.toContain('1.25');
        managed.options[0]?.onSelect?.();
        expect(onSelectManagedMachine).toHaveBeenCalledWith(draft);
        managed.options[1]?.onSelect?.();
        expect(onConfigure).toHaveBeenCalledOnce();
        expect(artifactSelect).not.toHaveBeenCalled();
        expect(handlers.selectSpy).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('does not expose managed recipes for purposes that require an existing destination', async () => {
        const fixture = createFixture();
        const handlers = makeHandlers();
        const onSelect = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, handlers), purpose: 'trigger',
            managedMachines: [{ id: 'managed-machine:server-a:one-off', homeId: 'server-a', title: 'One-off', onSelect }],
        }));
        expect(rendered.getCurrent().rootStep.sections.some((section) => section.id === 'managed-machines')).toBe(false);
        expect(onSelect).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('retires an old managed row activation when its purpose or Home offer is replaced or unavailable', async () => {
        const fixture = createFixture();
        const handlers = makeHandlers();
        const onSelect = vi.fn();
        const offer = { id: 'managed-machine:server-a:one-off', homeId: 'server-a', title: 'One-off', onSelect };
        const base = buildParams(fixture, handlers);
        const rendered = await renderHook(
            (props: BuildMachineSelectionListModelParams) => useMachineSelectionListModel(props),
            { initialProps: { ...base, managedMachines: [offer] } },
        );
        const section = rendered.getCurrent().rootStep.sections.find((candidate) => candidate.id === 'managed-machines');
        if (section?.kind !== 'static') throw new Error('expected a managed recipe section');
        const oldOption = section.options[0]!;
        await rendered.rerender({ ...base, purpose: 'trigger', managedMachines: [offer] });
        oldOption.onSelect?.();
        expect(onSelect).not.toHaveBeenCalled();
        await rendered.rerender({ ...base, managedMachines: [{ ...offer, disabled: true, unavailableText: 'offline' }] });
        oldOption.onSelect?.();
        expect(onSelect).not.toHaveBeenCalled();
        await rendered.rerender({ ...base, managedMachines: [{ ...offer, id: 'managed-machine:server-b:one-off', homeId: 'server-b' }] });
        oldOption.onSelect?.();
        expect(onSelect).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('keeps exact shared Home targets grouped and prevents a presentation override widening readiness or purpose', async () => {
        const ready: Machine = { ...createMachine('shared'), isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready',
        } };
        const pending: Machine = { ...ready, id: 'pending', metadata: null,
            access: { ...ready.access!, accessState: 'key_pending' },
            availability: { kind: 'locked', reason: 'recipient_key_pending' } };
        const own = createMachine('own');
        const group = { serverId: 'server-a', serverName: 'Server A', loading: false, signedOut: false,
            machines: [own, ready, pending].map(createScopedMachine) };
        const scopedSelect = vi.fn();
        const params = (purpose: 'session' | 'trigger'): BuildMachineSelectionListModelParams => ({
            groups: [group, { ...group, serverId: 'server-b', serverName: 'Server B', machines: [] }],
            selectedMachine: pending, selectedServerId: 'server-a', recentMachines: [], favoriteMachines: [],
            showFavorites: false, showRecent: false, showSearch: false, showCliGlyphs: false, autoDetectCliGlyphs: false,
            onSelectMachine: vi.fn(), onSelectScopedMachine: scopedSelect, purpose,
            resolveMachineAvailability: () => ({ selectable: true }),
        });
        const model = await renderHook(() => useMachineSelectionListModel(params('session')));
        const shared = model.getCurrent().rootStep.sections.find((section) => section.id === 'server:server-a:shared:alice');
        if (shared?.kind !== 'static') throw new Error('expected a scoped shared ownership section');
        expect(shared.title).toBe('Server A · machines.destinations.shared:Alice');
        expect(shared.options.map((option) => option.id)).toEqual(['server-a::shared', 'server-a::pending']);
        expect(shared.options[0]?.subtitle).toContain('machines.destinations.owner');
        expect(model.getCurrent().selectedOptionId).toBe('server-a::pending');
        expect(shared.options[1]?.disabled).toBe(true);
        shared.options[1]?.onSelect?.();
        expect(scopedSelect).not.toHaveBeenCalled();
        shared.options[0]?.onSelect?.();
        expect(scopedSelect).toHaveBeenCalledWith(group.machines[1]);
        await model.unmount();
        scopedSelect.mockClear();
        const trigger = await renderHook(() => useMachineSelectionListModel(params('trigger')));
        const triggerShared = trigger.getCurrent().rootStep.sections.find((section) => section.id === 'server:server-a:shared:alice');
        if (triggerShared?.kind !== 'static') throw new Error('expected retained shared section');
        expect(triggerShared.options.every((option) => option.disabled)).toBe(true);
        triggerShared.options[0]?.onSelect?.();
        expect(scopedSelect).not.toHaveBeenCalled();
        await trigger.unmount();
    });

    it.each([true, false])('keeps a shared bucket distinct when its custodian name is unavailable (single Home: %s)', async singleHome => {
        const shared = { ...createMachine('shared-without-owner'), isShared: true };
        const group = { serverId: 'server-a', serverName: 'Server A', loading: false, signedOut: false, machines: [createScopedMachine(shared)] };
        const model = await renderHook(() => useMachineSelectionListModel({ groups: singleHome ? [group] : [group, { ...group, serverId: 'server-b', machines: [] }],
            selectedMachine: null, recentMachines: [], favoriteMachines: [], showFavorites: false, showRecent: false,
            showSearch: false, showCliGlyphs: false, autoDetectCliGlyphs: false, onSelectMachine: vi.fn() }));
        const section = model.getCurrent().rootStep.sections.find(section => section.id === (singleHome ? 'shared:' : 'server:server-a:shared:'));
        expect(section?.title).toBe(`${singleHome ? '' : 'Server A · '}machines.destinations.sharedWithoutOwner`);
        await model.unmount();
    });
    it('keeps the selected unavailable machine visible without allowing activation', async () => {
        const machine = { ...createMachine('retired'), revokedAt: Date.now() };
        const onSelectMachine = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [{ serverId: 'server-a', serverName: 'Server A', loading: false, signedOut: false, machines: [createScopedMachine(machine)] }],
            selectedMachine: machine, selectedServerId: 'server-a', recentMachines: [], favoriteMachines: [],
            onSelectMachine, onSelectScopedMachine: vi.fn(), includeSelectedUnavailableMachineId: machine.id,
            showFavorites: true, showRecent: true, showSearch: true, showCliGlyphs: false, autoDetectCliGlyphs: false,
        }));
        const section = rendered.getCurrent().rootStep.sections[0];
        expect(section?.kind).toBe('static');
        if (section?.kind !== 'static') throw new Error('expected unavailable machine section');
        expect(section.options[0]?.disabled).toBe(true);
        section.options[0]?.onSelect?.();
        expect(onSelectMachine).not.toHaveBeenCalled();
    });

    it('shows the resolved Temporary computer target even when no machine is available', async () => {
        const onSelectTemporaryComputer = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [],
            selectedMachine: null,
            selectedServerId: 'server-a',
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            temporaryComputers: [{
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                selected: true,
                workspace: { kind: 'endpoint_home' },
                onSelect: onSelectTemporaryComputer,
            }],
            showFavorites: true,
            showRecent: true,
            showSearch: true,
            showCliGlyphs: true,
            autoDetectCliGlyphs: true,
            testIdPrefix: 'new-session-machine',
        }));

        const section = rendered.getCurrent().rootStep.sections[0];
        expect(section?.kind).toBe('static');
        if (section?.kind !== 'static') throw new Error('expected the Temporary computer section');
        expect(section.options).toHaveLength(1);
        expect(section.options[0]).toMatchObject({
            id: 'temporary-computer:server-a:linux-x64',
            testID: 'new-session-machine-temporary-computer:server-a:linux-x64',
            label: 'newSession.temporaryComputer.title',
        });
        expect(rendered.getCurrent().selectedOptionId).toBe('temporary-computer-workspace:server-a:linux-x64:endpoint_home');

        const workspaceStep = section.options[0]!.openStep;
        expect(workspaceStep).toMatchObject({
            id: 'temporary-computer-workspace:server-a:linux-x64',
            title: 'newSession.temporaryComputer.workspace.title',
        });
        // Expiry is offered beside the folder, defaulting to Never, and the
        // folder choice is what commits the target.
        const expirySection = workspaceStep?.sections[0];
        if (expirySection?.kind !== 'static') throw new Error('expected the expiry section');
        expect(expirySection.options.map((option) => option.id)).toEqual([
            'temporary-computer-expiry:server-a:linux-x64:never',
            'temporary-computer-expiry:server-a:linux-x64:inOneDay',
            'temporary-computer-expiry:server-a:linux-x64:inOneWeek',
            'temporary-computer-expiry:server-a:linux-x64:custom',
        ]);
        // Never is the default, and the section says so in the one place the
        // list actually renders a current answer.
        expect(expirySection.resultHint).toBe('newSession.temporaryComputer.expiry.never');

        const workspaceSection = workspaceStep?.sections[1];
        if (workspaceSection?.kind !== 'static') throw new Error('expected the workspace section');
        // The step names the endpoint's folder from the endpoint's point of
        // view — the creator is not choosing their own working directory — and
        // marks the recommended default the same way the expiry section marks
        // its own.
        expect(workspaceSection.title).toBe('newSession.temporaryComputer.workspace.title');
        expect(workspaceSection.options.map((option) => [option.id, option.label, option.subtitle])).toEqual([
            [
                'temporary-computer-workspace:server-a:linux-x64:choose_on_endpoint',
                'newSession.temporaryComputer.target.workspaceChoose',
                'newSession.temporaryComputer.workspace.chooseRecommended',
            ],
            [
                'temporary-computer-workspace:server-a:linux-x64:endpoint_home',
                'newSession.temporaryComputer.target.workspaceHome',
                'newSession.temporaryComputer.workspace.homeDetail',
            ],
        ]);
        // The committed folder is echoed in the one place the list renders a
        // current answer, exactly like the expiry beside it.
        expect(workspaceSection.resultHint).toBe('newSession.temporaryComputer.target.workspaceHome');
        workspaceSection.options[0]!.onSelect?.();
        workspaceSection.options[1]!.onSelect?.();
        expect(onSelectTemporaryComputer).toHaveBeenNthCalledWith(1, { kind: 'choose_on_endpoint' }, undefined);
        expect(onSelectTemporaryComputer).toHaveBeenNthCalledWith(2, { kind: 'endpoint_home' }, undefined);
        await rendered.unmount();
    });

    it('commits an explicitly chosen package expiry as an absolute instant with the folder', async () => {
        const onSelectTemporaryComputer = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [],
            selectedMachine: null,
            selectedServerId: 'server-a',
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            temporaryComputers: [{
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                selected: false,
                workspace: null,
                onSelect: onSelectTemporaryComputer,
            }],
            showFavorites: true,
            showRecent: true,
            showSearch: true,
            showCliGlyphs: true,
            autoDetectCliGlyphs: true,
        }));

        const readWorkspaceStep = () => {
            const section = rendered.getCurrent().rootStep.sections[0];
            if (section?.kind !== 'static') throw new Error('expected the Temporary computer section');
            return section.options[0]?.openStep;
        };
        const readExpirySection = () => {
            const expiry = readWorkspaceStep()?.sections[0];
            if (expiry?.kind !== 'static') throw new Error('expected the expiry section');
            return expiry;
        };
        const expiryOptions = () => readExpirySection().options;

        const before = Date.now();
        await act(async () => { expiryOptions()[1]!.onSelect?.(); });
        const after = Date.now();
        // This suite's `t` returns keys, so the exact instant is proven by the
        // commit below; here the section must stop reporting Never.
        expect(readExpirySection().resultHint).toBe('newSession.temporaryComputer.expiry.expiresAt');

        const workspace = readWorkspaceStep()?.sections[1];
        if (workspace?.kind !== 'static') throw new Error('expected the workspace section');
        await act(async () => { workspace.options[1]!.onSelect?.(); });

        expect(onSelectTemporaryComputer).toHaveBeenCalledTimes(1);
        const [committedWorkspace, committedExpiry] = onSelectTemporaryComputer.mock.calls[0]!;
        expect(committedWorkspace).toEqual({ kind: 'endpoint_home' });
        // Absolute, resolved once at selection time — not a duration anything
        // downstream has to count down.
        expect(committedExpiry).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
        expect(committedExpiry).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000);
        await rendered.unmount();
    });

    it('commits an arbitrary future instant chosen through the shared date and time editor', async () => {
        const onSelectTemporaryComputer = vi.fn();
        // A moment no offered shortcut can produce: the contract is an optional
        // absolute expiry the author states exactly, not a menu of durations.
        const chosen = new Date(2031, 4, 17, 6, 42).getTime();
        modalHost.show.mockClear();
        modalHost.show.mockImplementation((config: unknown) => {
            const resolve = (config as { props: { onResolve: (value: number | null) => void } }).props.onResolve;
            queueMicrotask(() => resolve(chosen));
            return 'modal-id';
        });
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [],
            selectedMachine: null,
            selectedServerId: 'server-a',
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            temporaryComputers: [{
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                selected: false,
                workspace: null,
                onSelect: onSelectTemporaryComputer,
            }],
            showFavorites: true,
            showRecent: true,
            showSearch: true,
            showCliGlyphs: true,
            autoDetectCliGlyphs: true,
        }));

        const readWorkspaceStep = () => {
            const section = rendered.getCurrent().rootStep.sections[0];
            if (section?.kind !== 'static') throw new Error('expected the Temporary computer section');
            return section.options[0]?.openStep;
        };
        const readExpirySection = () => {
            const expiry = readWorkspaceStep()?.sections[0];
            if (expiry?.kind !== 'static') throw new Error('expected the expiry section');
            return expiry;
        };

        await act(async () => { readExpirySection().options[3]!.onSelect?.(); });
        await act(async () => { await Promise.resolve(); });

        expect(modalHost.show).toHaveBeenCalledOnce();
        expect(readExpirySection().resultHint).toBe('newSession.temporaryComputer.expiry.expiresAt');

        const workspace = readWorkspaceStep()?.sections[1];
        if (workspace?.kind !== 'static') throw new Error('expected the workspace section');
        await act(async () => { workspace.options[0]!.onSelect?.(); });

        expect(onSelectTemporaryComputer).toHaveBeenCalledWith({ kind: 'choose_on_endpoint' }, chosen);
        modalHost.show.mockReset();
        modalHost.show.mockImplementation(() => 'modal-id');
        await rendered.unmount();
    });

    it('keeps the committed expiry when the author backs out of the date and time editor', async () => {
        const onSelectTemporaryComputer = vi.fn();
        const committed = new Date(2030, 0, 2, 3, 4).getTime();
        modalHost.show.mockClear();
        modalHost.show.mockImplementation((config: unknown) => {
            const resolve = (config as { props: { onResolve: (value: number | null) => void } }).props.onResolve;
            queueMicrotask(() => resolve(null));
            return 'modal-id';
        });
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [],
            selectedMachine: null,
            selectedServerId: 'server-a',
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            temporaryComputers: [{
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                selected: true,
                workspace: { kind: 'endpoint_home' },
                packageExpiresAt: committed,
                onSelect: onSelectTemporaryComputer,
            }],
            showFavorites: true,
            showRecent: true,
            showSearch: true,
            showCliGlyphs: true,
            autoDetectCliGlyphs: true,
        }));

        const readWorkspaceStep = () => {
            const section = rendered.getCurrent().rootStep.sections[0];
            if (section?.kind !== 'static') throw new Error('expected the Temporary computer section');
            return section.options[0]?.openStep;
        };
        const expiry = readWorkspaceStep()?.sections[0];
        if (expiry?.kind !== 'static') throw new Error('expected the expiry section');
        await act(async () => { expiry.options[3]!.onSelect?.(); });
        await act(async () => { await Promise.resolve(); });

        const workspace = readWorkspaceStep()?.sections[1];
        if (workspace?.kind !== 'static') throw new Error('expected the workspace section');
        await act(async () => { workspace.options[1]!.onSelect?.(); });

        expect(onSelectTemporaryComputer).toHaveBeenCalledWith({ kind: 'endpoint_home' }, committed);
        modalHost.show.mockReset();
        modalHost.show.mockImplementation(() => 'modal-id');
        await rendered.unmount();
    });

    it('names each published platform row for a person rather than by artifact id', async () => {
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [],
            selectedMachine: null,
            selectedServerId: 'server-a',
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            temporaryComputers: [{
                serverId: 'server-a',
                artifactTarget: 'darwin-arm64',
                selected: false,
                workspace: null,
                onSelect: vi.fn(),
            }, {
                serverId: 'server-a',
                artifactTarget: 'windows-x64',
                selected: false,
                workspace: null,
                onSelect: vi.fn(),
            }],
            showFavorites: true,
            showRecent: true,
            showSearch: true,
            showCliGlyphs: true,
            autoDetectCliGlyphs: true,
        }));

        const section = rendered.getCurrent().rootStep.sections[0];
        if (section?.kind !== 'static') throw new Error('expected the Temporary computer section');
        const platformSection = section.options[0]?.openStep?.sections[0];
        if (platformSection?.kind !== 'static') throw new Error('expected the platform section');
        for (const option of platformSection.options) {
            expect(option.label).not.toMatch(/^(darwin|windows|linux)-/);
            // The accessible name says the same thing the row shows, so a screen
            // reader never hears an identifier the screen does not display.
            expect(option.accessibilityLabel).toContain(option.label as string);
        }
        expect(platformSection.options[0]?.label).toBe('newSession.temporaryComputer.platform.darwin-arm64');
        expect(platformSection.options[1]?.label).toBe('newSession.temporaryComputer.platform.windows-x64');
        await rendered.unmount();
    });

    it('keeps platform and workspace as nested picker steps when several artifacts are available', async () => {
        const selectLinux = vi.fn();
        const selectWindows = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [],
            selectedMachine: null,
            selectedServerId: 'server-a',
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            temporaryComputers: [{
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                selected: false,
                workspace: null,
                onSelect: selectLinux,
            }, {
                serverId: 'server-a',
                artifactTarget: 'windows-x64',
                selected: false,
                workspace: null,
                onSelect: selectWindows,
            }],
            showFavorites: true,
            showRecent: true,
            showSearch: true,
            showCliGlyphs: true,
            autoDetectCliGlyphs: true,
        }));

        const section = rendered.getCurrent().rootStep.sections[0];
        if (section?.kind !== 'static') throw new Error('expected the Temporary computer section');
        const platformStep = section.options[0]?.openStep;
        const platformSection = platformStep?.sections[0];
        if (platformSection?.kind !== 'static') throw new Error('expected the platform section');
        expect(platformSection.options).toHaveLength(2);
        expect(platformSection.options[0]?.openStep?.id).toBe('temporary-computer-workspace:server-a:linux-x64');
        expect(platformSection.options[1]?.openStep?.id).toBe('temporary-computer-workspace:server-a:windows-x64');
        expect(selectLinux).not.toHaveBeenCalled();
        expect(selectWindows).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('keeps an unavailable restored Temporary computer visible and routes retry to its projection owner', async () => {
        const retry = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [],
            selectedMachine: null,
            selectedServerId: 'server-a',
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            temporaryComputers: [{
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                selected: true,
                workspace: { kind: 'choose_on_endpoint' },
                disabled: true,
                unavailableText: 'newSession.temporaryComputer.status.failed',
                onRetry: retry,
                onSelect: vi.fn(),
            }],
            showFavorites: true,
            showRecent: true,
            showSearch: true,
            showCliGlyphs: true,
            autoDetectCliGlyphs: true,
            testIdPrefix: 'new-session-machine',
        }));

        const section = rendered.getCurrent().rootStep.sections[0];
        if (section?.kind !== 'static') throw new Error('expected the Temporary computer section');
        expect(section.options[0]).toMatchObject({
            id: 'temporary-computer:server-a:linux-x64',
            disabled: true,
            subtitle: 'newSession.temporaryComputer.status.failed',
        });
        expect(section.options[0]?.openStep).toBeUndefined();
        expect(section.options[1]).toMatchObject({
            id: 'temporary-computer-retry:server-a',
            label: 'common.retry',
        });
        section.options[1]?.onSelect?.();
        expect(retry).toHaveBeenCalledOnce();
        expect(rendered.getCurrent().selectedOptionId).toBe('temporary-computer:server-a:linux-x64');
        await rendered.unmount();
    });

    it('shows pending and retryable unavailable feedback on the selected Pool row', async () => {
        const fixture = createFixture();
        const poolId = '3a948f0c-bc30-491c-b764-37f0e6744d1f';
        const base = {
            ...buildParams(fixture, makeHandlers()),
            poolGroups: [{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                pools: [{
                    pool: {
                        id: poolId,
                        name: 'Development',
                        description: null,
                        revision: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        members: [],
                    },
                    availability: { state: 'known' as const, connectedCount: 1, enabledCount: 1 },
                }],
            }],
            onSelectPool: vi.fn(),
        };
        const rendered = await renderHook(
            (props: BuildMachineSelectionListModelParams) => useMachineSelectionListModel(props),
            {
                initialProps: {
                    ...base,
                    poolSelectionStatus: { kind: 'resolving', serverId: 'server-a', accountId: 'account-a', poolId },
                },
            },
        );

        let poolOption = firstStaticOption(rendered.getCurrent());
        expect(poolOption.subtitle).toBe('machinePools.resolvingTarget');
        expect(poolOption.disabled).toBe(true);

        await rendered.rerender({
            ...base,
            poolSelectionStatus: {
                kind: 'unavailable',
                serverId: 'server-a',
                accountId: 'account-a',
                poolId,
                reason: 'no_available_machine',
            },
        });
        poolOption = firstStaticOption(rendered.getCurrent());
        expect(poolOption.subtitle).toBe('machinePools.resolveNoAvailable');
        expect(poolOption.disabled).toBe(false);
        await rendered.unmount();
    });

    it('keeps a retained Pool row readable without advertising its cached connection count as current', async () => {
        const fixture = createFixture();
        const poolId = '3a948f0c-bc30-491c-b764-37f0e6744d1f';
        const onSelectPool = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, makeHandlers()),
            poolGroups: [{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                status: 'error',
                projectionReady: true,
                pools: [{
                    pool: {
                        id: poolId, name: 'Development', description: null,
                        revision: 1, createdAt: 1, updatedAt: 1, members: [],
                    },
                    availability: { state: 'known' as const, connectedCount: 2, enabledCount: 2 },
                }],
            }],
            onSelectPool,
            onRefreshPools: vi.fn(),
        }));

        const poolOption = firstStaticOption(rendered.getCurrent());
        expect(poolOption.disabled).toBe(true);
        expect(poolOption.subtitle).toContain('machinePools.refreshFailed');
        expect(poolOption.subtitle).not.toContain('machinePools.availabilityKnown');
        poolOption.onSelect?.();
        expect(onSelectPool).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('does not resolve a retained Pool row while its Home Machine list is failed', async () => {
        const fixture = createFixture();
        const onSelectPool = vi.fn();
        const failedGroups = fixture.groups.map((group) => ({ ...group, error: true }));
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams({ ...fixture, groups: failedGroups }, makeHandlers()),
            poolGroups: [{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                status: 'idle',
                projectionReady: true,
                pools: [{
                    pool: {
                        id: 'pool-a', name: 'Development', description: null,
                        revision: 1, createdAt: 1, updatedAt: 1, members: [],
                    },
                    availability: { state: 'known' as const, connectedCount: 1, enabledCount: 1 },
                }],
            }],
            onSelectPool,
        }));

        const poolOption = firstStaticOption(rendered.getCurrent());
        expect(poolOption.disabled).toBe(true);
        expect(poolOption.subtitle).toContain('common.error');
        expect(poolOption.subtitle).not.toContain('machinePools.availabilityKnown');
        poolOption.onSelect?.();
        expect(onSelectPool).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('names a Pool member whose decrypted Machine metadata is unavailable as a locked machine', async () => {
        const fixture = createFixture();
        const machineId = 'machine-without-readable-metadata';
        const unidentifiedMachine = createMachine(machineId);
        // Sync explicitly marks an unreadable Machine locked; null metadata alone can still be hydrating.
        unidentifiedMachine.metadata = null;
        unidentifiedMachine.availability = { kind: 'locked', reason: 'decryption_failed' };
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams({
                ...fixture,
                groups: [{
                    ...fixture.groups[0]!,
                    machines: [createScopedMachine(unidentifiedMachine)],
                }],
            }, makeHandlers()),
            poolGroups: [{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                status: 'idle',
                projectionReady: true,
                pools: [{
                    pool: {
                        id: 'pool-a',
                        name: 'Development',
                        description: null,
                        revision: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        members: [{
                            machineId,
                            enabled: true,
                            priorityTier: 0,
                            state: 'connected',
                        }],
                    },
                    availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
                }],
            }],
            onSelectPool: vi.fn(),
        }));

        const poolOption = firstStaticOption(rendered.getCurrent());
        // A member whose details cannot be read is a locked machine, never a raw or short id.
        expect(poolOption.subtitle).toContain('machine.lockedMachine');
        expect(poolOption.accessibilityLabel).toContain('machine.lockedMachine');
        expect(poolOption.subtitle).not.toContain(machineId.slice(0, 8));
        await rendered.unmount();
    });

    it('uses only enabled members in the visible and accessible Pool preview', async () => {
        const fixture = createFixture();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, makeHandlers()),
            poolGroups: [{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                status: 'idle',
                projectionReady: true,
                pools: [{
                    pool: {
                        id: 'pool-a', name: 'Development', description: null,
                        revision: 1, createdAt: 1, updatedAt: 1,
                        members: [
                            { machineId: 'm-1', enabled: false, priorityTier: 0, state: 'connected' },
                            { machineId: 'm-2', enabled: true, priorityTier: 1, state: 'connected' },
                            { machineId: 'm-3', enabled: true, priorityTier: 1, state: 'connected' },
                        ],
                    },
                    availability: { state: 'known', connectedCount: 2, enabledCount: 2 },
                }],
            }],
            onSelectPool: vi.fn(),
        }));

        const poolOption = firstStaticOption(rendered.getCurrent());
        expect(poolOption.subtitle).toContain('m-2, m-3');
        expect(poolOption.subtitle).not.toContain('m-1');
        expect(poolOption.accessibilityLabel).toContain('m-2, m-3');
        expect(poolOption.accessibilityLabel).not.toContain('m-1');
        await rendered.unmount();
    });

    it('includes the exact Home in accessible Pool labels when several Homes are shown', async () => {
        const machineA = createScopedMachine(createMachine('machine-a'));
        const machineB = {
            ...createScopedMachine(createMachine('machine-a')),
            serverId: 'server-b',
            serverName: 'Server B',
        };
        const pool = (id: string) => ({
            pool: {
                id,
                name: 'Development',
                description: null,
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
                members: [{ machineId: 'machine-a', priorityTier: 0, enabled: true, state: 'connected' as const }],
            },
            availability: { state: 'known' as const, connectedCount: 1, enabledCount: 1 },
        });
        const groups = [
            { serverId: 'server-a', serverName: 'Server A', loading: false, signedOut: false, machines: [machineA] },
            { serverId: 'server-b', serverName: 'Server B', loading: false, signedOut: false, machines: [machineB] },
        ];
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups,
            poolGroups: [
                { serverId: 'server-a', accountId: 'account-a', serverName: 'Server A', status: 'idle', projectionReady: true, pools: [pool('pool-a')] },
                { serverId: 'server-b', accountId: 'account-b', serverName: 'Server B', status: 'idle', projectionReady: true, pools: [pool('pool-b')] },
            ],
            selectedMachine: null,
            selectedServerId: null,
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            onSelectPool: vi.fn(),
            showFavorites: false,
            showRecent: false,
            showSearch: true,
            showCliGlyphs: false,
            autoDetectCliGlyphs: false,
        }));

        const poolSections = rendered.getCurrent().rootStep.sections.filter((section) => (
            section.kind === 'static' && section.id.endsWith(':machine-pools')
        ));
        expect(poolSections).toHaveLength(2);
        expect(poolSections[0]?.kind === 'static' ? poolSections[0].options[0]?.accessibilityLabel : '').toContain('Server A');
        expect(poolSections[1]?.kind === 'static' ? poolSections[1].options[0]?.accessibilityLabel : '').toContain('Server B');
        await rendered.unmount();
    });

    it('offers a failed Home an explicit retry into the canonical Machine refresh owner', async () => {
        const fixture = createFixture();
        const failedGroups = fixture.groups.map((group) => ({ ...group, error: true }));
        const onRefreshMachines = vi.fn();
        const onRefreshPools = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams({ ...fixture, groups: failedGroups }, makeHandlers()),
            poolGroups: [{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                status: 'idle',
                projectionReady: true,
                pools: [{
                    pool: {
                        id: 'pool-a', name: 'Development', description: null,
                        revision: 1, createdAt: 1, updatedAt: 1, members: [],
                    },
                    availability: { state: 'unknown' as const },
                }],
            }],
            onSelectPool: vi.fn(),
            onRefreshMachines,
            onRefreshPools,
        }));

        const section = rendered.getCurrent().rootStep.sections[0];
        if (section?.kind !== 'static') throw new Error('expected the Pool section');
        const retry = section.options.find((option) => option.id === 'pool-refresh:server-a');
        expect(retry?.label).toBe('common.retry');
        retry?.onSelect?.();
        expect(onRefreshMachines).toHaveBeenCalledOnce();
        expect(onRefreshPools).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('routes each unavailable resolve outcome to its own existing recovery owner', async () => {
        const fixture = createFixture();
        const poolId = '3a948f0c-bc30-491c-b764-37f0e6744d1f';
        const onOpenPoolSettings = vi.fn();
        const onRefreshPools = vi.fn();
        const onDismissPoolSelection = vi.fn();
        const base = {
            ...buildParams(fixture, makeHandlers()),
            poolGroups: [{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                status: 'idle' as const,
                projectionReady: true,
                pools: [{
                    pool: {
                        id: poolId, name: 'Development', description: null,
                        revision: 1, createdAt: 1, updatedAt: 1, members: [],
                    },
                    availability: { state: 'known' as const, connectedCount: 0, enabledCount: 0 },
                }],
            }],
            onSelectPool: vi.fn(),
            onOpenPoolSettings,
            onRefreshPools,
            onDismissPoolSelection,
        };
        const rendered = await renderHook(
            (props: BuildMachineSelectionListModelParams) => useMachineSelectionListModel(props),
            {
                initialProps: {
                    ...base,
                    poolSelectionStatus: { kind: 'unavailable', serverId: 'server-a', accountId: 'account-a', poolId, reason: 'empty' },
                },
            },
        );

        const optionIdsOf = () => {
            const section = rendered.getCurrent().rootStep.sections[0];
            if (section?.kind !== 'static') throw new Error('expected the Pool section');
            return section.options;
        };
        const settings = optionIdsOf().find((option) => option.id === 'pool-settings:server-a');
        expect(settings?.label).toBe('machinePools.openSettings');
        settings?.onSelect?.();
        expect(onOpenPoolSettings).toHaveBeenCalledWith({ serverId: 'server-a', poolId });
        expect(optionIdsOf().some((option) => option.id === 'pool-pick-machine:server-a')).toBe(false);

        await rendered.rerender({
            ...base,
            poolSelectionStatus: {
                kind: 'unavailable', serverId: 'server-a', accountId: 'account-a', poolId, reason: 'no_available_machine',
            },
        });
        expect(optionIdsOf().some((option) => option.id === 'pool-settings:server-a')).toBe(false);
        optionIdsOf().find((option) => option.id === 'pool-refresh:server-a')?.onSelect?.();
        expect(onRefreshPools).toHaveBeenCalledWith('server-a');
        const pickSpecific = optionIdsOf().find((option) => option.id === 'pool-pick-machine:server-a');
        expect(pickSpecific?.label).toBe('machinePools.pickSpecificMachine');
        pickSpecific?.onSelect?.();
        expect(onDismissPoolSelection).toHaveBeenCalledOnce();

        // A current Home with a cached zero-connected summary still reaches the authoritative
        // resolve; only the Home's own currentness may deny activation.
        expect(optionIdsOf().find((option) => option.id === `pool:server-a:${poolId}`)?.disabled).toBe(false);
        await rendered.unmount();
    });

    it('lets a consuming domain decide which rows are selectable and shows its reason', async () => {
        const fixture = createFixture();
        const handlers = makeHandlers();
        const offline: Machine = { ...fixture.machines[1]!, active: false, activeAt: 0 };
        const machines = [fixture.machines[0]!, offline].map(createScopedMachine);
        const params = (withDomainDecision: boolean): BuildMachineSelectionListModelParams => ({
            ...buildParams(fixture, handlers),
            groups: [{ ...fixture.groups[0]!, machines }],
            recentMachines: [],
            favoriteMachines: [],
            showFavorites: false,
            showRecent: false,
            ...(withDomainDecision ? {
                resolveMachineAvailability: (machine: Machine) => machine.id === offline.id
                    ? { selectable: true, detail: 'offline but eligible' }
                    : { selectable: false, detail: 'update required' },
            } : {}),
        });
        const rowsOf = (model: ReturnType<typeof UseMachineSelectionListModel>) => {
            const section = model.rootStep.sections.find((candidate) => candidate.id === 'all');
            if (section?.kind !== 'static') throw new Error('expected the all-machines section');
            return new Map(section.options.map((option) => [option.id, option]));
        };

        const canonical = await renderHook(() => useMachineSelectionListModel(params(false)));
        const canonicalRows = rowsOf(canonical.getCurrent());
        expect(canonicalRows.get('m-1')?.disabled).toBe(false);
        expect(canonicalRows.get('m-2')?.disabled).toBe(true);
        // K1 anatomy: the second line is the machine's status line, presence first, with the
        // presence dot leading it (online / offline) instead of a trailing "● Online" label.
        expect(canonicalRows.get('m-1')?.subtitle).toBe('settingsOverview.machineOnline');
        expect(canonicalRows.get('m-2')?.subtitle).toBe('settingsOverview.machineOffline');
        expect(canonicalRows.get('m-1')?.subtitleLeading).toBeTruthy();
        expect(canonicalRows.get('m-2')?.subtitleLeading).toBeTruthy();
        await canonical.unmount();

        const decided = await renderHook(() => useMachineSelectionListModel(params(true)));
        const rows = rowsOf(decided.getCurrent());
        expect(rows.get('m-2')?.disabled).toBe(false);
        expect(rows.get('m-2')?.subtitle).toBe('settingsOverview.machineOffline · offline but eligible');
        expect(rows.get('m-1')?.disabled).toBe(true);
        expect(rows.get('m-1')?.subtitle).toBe('settingsOverview.machineOnline · update required');

        rows.get('m-1')?.onSelect?.();
        expect(handlers.selectSpy).not.toHaveBeenCalled();
        rows.get('m-2')?.onSelect?.();
        expect(handlers.selectSpy).toHaveBeenCalledWith('m-2');
        await decided.unmount();
    });

    it('reuses the derived model when only the caller handler identities change', async () => {
        const rendered = await renderModel(createFixture(), makeHandlers());
        const first = rendered.getCurrent();

        await rendered.rerender(makeHandlers());
        const second = rendered.getCurrent();

        // Handlers are behaviour, not data: recreating them must not rebuild the
        // step tree, because every row's `icon` / `rightAccessory` element loses
        // referential identity when it does, and React can then no longer skip
        // the row subtrees while the popover re-renders.
        expect(second.rootStep).toBe(first.rootStep);
        expect(second.rootStep.sections).toBe(first.rootStep.sections);
        expect(firstStaticOption(second)).toBe(firstStaticOption(first));
        expect(firstStaticOption(second).rightAccessory).toBe(firstStaticOption(first).rightAccessory);

        await rendered.unmount();
    });

    it('rebuilds the model when the machine data actually changes', async () => {
        // Same handler identities, different data: the model MUST be rebuilt,
        // otherwise the ref indirection would freeze the list against real
        // machine/recent/favorite updates.
        const fixture = createFixture();
        const handlers = makeHandlers();
        const rendered = await renderHook<ReturnType<typeof UseMachineSelectionListModel>, ReadonlyArray<Machine>>(
            (recent) => useMachineSelectionListModel({ ...buildParams(fixture, handlers), recentMachines: recent }),
            { initialProps: fixture.recent },
        );
        const before = rendered.getCurrent().rootStep;
        expect(before.sections.map((section) => section.id)).toEqual(['recent', 'favorites', 'all']);

        await rendered.rerender([fixture.machines[2]!]);
        const after = rendered.getCurrent().rootStep;
        expect(after).not.toBe(before);
        const recentSection = after.sections[0];
        if (recentSection?.kind !== 'static') throw new Error('expected the recent section');
        expect(recentSection.options.map((option) => option.id)).toEqual(['m-3']);

        await rendered.unmount();
    });

    it('activates the LATEST handler after the caller replaced it', async () => {
        const initialHandlers = makeHandlers();
        const rendered = await renderModel(createFixture(), initialHandlers);

        const nextHandlers = makeHandlers();
        await rendered.rerender(nextHandlers);

        firstStaticOption(rendered.getCurrent()).onSelect?.();

        expect(nextHandlers.selectSpy).toHaveBeenCalledTimes(1);
        expect(initialHandlers.selectSpy).not.toHaveBeenCalled();

        await rendered.unmount();
    });
});
