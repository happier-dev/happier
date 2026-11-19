import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';

import type {
    ServerScopedMachineGroup,
    ServerScopedMachinePresentation,
} from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { renderScreen } from '@/dev/testkit';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type {
    PluginMachineExecutionOriginCandidateV1,
    PluginMachineExecutionOriginStateV1,
} from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import type { PluginMachineExecutionOriginSelectionV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';

import { installNewSessionComponentsCommonModuleMocks } from '../../sessions/new/components/newSessionComponentsTestHelpers';

type PresentedOrigin = ServerScopedMachinePresentation & Readonly<{
    candidate: PluginMachineExecutionOriginCandidateV1;
    origin: PluginMachineExecutionOriginV1;
}>;

type CapturedPickerProps = Readonly<{
    groups: readonly ServerScopedMachineGroup<PresentedOrigin>[];
    selectedMachineId: string | null;
    selectedServerId: string | null;
    onSelect: (machine: PresentedOrigin) => void;
    resolveMachineAvailability?: (machine: PresentedOrigin) => Readonly<{
        detail: string;
        selectable: boolean;
    }>;
    getMachineKey?: (machine: PresentedOrigin) => string;
    isMachineSelected?: (machine: PresentedOrigin) => boolean;
    testIdPrefix?: string;
}>;

type CapturedItemProps = Readonly<{
    testID?: string;
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    detail?: string;
    selected?: boolean;
    mode?: string;
    showChevron?: boolean;
    onPress?: () => void;
    accessibilityLabel?: string;
}>;

const capturedPickerProps: CapturedPickerProps[] = [];
const capturedItemProps: CapturedItemProps[] = [];
const capturedGroupTitleProps: Readonly<{ title?: React.ReactNode }>[] = [];

installNewSessionComponentsCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: CapturedItemProps) => {
        capturedItemProps.push(props);
        return null;
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ title, children }: { title?: React.ReactNode; children?: React.ReactNode }) => {
        capturedGroupTitleProps.push({ title });
        return React.createElement(React.Fragment, null, children);
    },
}));

vi.mock('@/components/sessions/new/components/ServerScopedMachineSelector', () => ({
    ServerScopedMachineSelector: (props: CapturedPickerProps) => {
        capturedPickerProps.push(props);
        return null;
    },
}));

const { PluginMachineExecutionOriginSelectorView, resolvePluginMachineExecutionOriginPresentation }
    = await import('./PluginMachineExecutionOriginSelector');
const { storage } = await import('@/sync/domains/state/storageStore');

it('uses the Machine verdict for an unavailable origin dot, preserving unknown and genuine offline', async () => {
    const storedTarget = { serverIdentityId: 'home', machineId: 'machine' };
    const fixture = selection({ candidates: [], state: { kind: 'unavailable', storedOrigin: null, storedTarget, candidates: [], reasons: ['offline'] } });
    const machine = { target: storedTarget, displayName: 'Studio', serverLabel: 'Home', availability: 'unknown' as const,
        observation: 'stale' as const, observedAt: 1 };
    const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={fixture.value} machineCandidates={[machine]} presentation="chip" />);
    const filter = () => screen.root.findAll(node => node.props.filter?.id === 'plugin-execution')[0]?.props.filter;
    expect(filter()).toBeDefined();
    expect(filter()).not.toHaveProperty('presence');
    await screen.update(<PluginMachineExecutionOriginSelectorView selection={fixture.value} machineCandidates={[{ ...machine, availability: 'offline' }]} presentation="chip" />);
    expect(filter()?.presence).toBe('offline');
    expect(resolvePluginMachineExecutionOriginPresentation(fixture.value, [machine])).not.toHaveProperty('presence');
    expect(resolvePluginMachineExecutionOriginPresentation(fixture.value, [{ ...machine, availability: 'offline' }])).toMatchObject({ presence: 'offline' });
});

function candidate(input: Readonly<{
    machineId: string;
    materializationId: string;
    version: string;
    releaseContent?: 'matched' | 'conflict';
}>): PluginMachineExecutionOriginCandidateV1 {
    return {
        materialization: {
            serverIdentityId: 'srv_one',
            machineId: input.machineId,
            materializationId: input.materializationId,
            pluginId: 'acme.plugin',
            version: input.version,
            sourceClass: 'registryPackage',
            portableRelease: true,
            uiArtifacts: [],
            enabled: true,
            trustState: 'trusted',
            observedAt: 100,
        },
        releaseContent: input.releaseContent ?? 'matched',
        validation: { kind: 'admitted' },
    };
}

function selection(input: Readonly<{
    state: PluginMachineExecutionOriginStateV1;
    candidates: readonly PluginMachineExecutionOriginCandidateV1[];
    selectedOrigin?: PluginMachineExecutionOriginV1 | null;
}>): Readonly<{
    value: PluginMachineExecutionOriginSelectionV1;
    selectOrigin: ReturnType<typeof vi.fn>;
    clearOrigin: ReturnType<typeof vi.fn>;
}> {
    const selectOrigin = vi.fn(async () => ({ status: 'applied' as const, settingsVersion: 8, value: undefined }));
    const clearOrigin = vi.fn(async () => ({ status: 'applied' as const, settingsVersion: 8, value: undefined }));
    return {
        value: {
            candidates: input.candidates,
            state: input.state,
            selectedOrigin: input.selectedOrigin ?? null,
            canExecute: false,
            loading: false,
            selectOrigin,
            clearOrigin,
            resolveExecutionOrigin: () => null,
        },
        selectOrigin,
        clearOrigin,
    };
}

describe('PluginMachineExecutionOriginSelector', () => {
    it('shows a quiet loading state, not "no machine", while availability is still being read', () => {
        const fixture = selection({ candidates: [], state: { kind: 'unavailable', storedOrigin: null,
            candidates: [], reasons: ['no_materialization'] } });
        const loading = resolvePluginMachineExecutionOriginPresentation({ ...fixture.value, loading: true });
        const loaded = resolvePluginMachineExecutionOriginPresentation(fixture.value);
        expect(loading).toMatchObject({ title: 'common.loading', detail: '', selected: false, unavailable: false });
        expect(loaded.title).not.toBe(loading.title);
    });
    it('names and clears the explicit Machine when no current source remains', async () => {
        const storedTarget = { serverIdentityId: 'srv_one', machineId: 'studio-machine' };
        const fixture = selection({ candidates: [], state: { kind: 'unavailable', storedOrigin: null,
            storedTarget, candidates: [], reasons: ['offline'] } });
        const machineCandidates = [{ target: storedTarget, displayName: 'Studio', serverLabel: 'Home',
            availability: 'offline' as const, observation: 'stale' as const, observedAt: 1 }];
        const value = { ...fixture.value, storedTarget, machineCandidates };
        expect(resolvePluginMachineExecutionOriginPresentation(value)).toMatchObject({
            title: 'Studio', subtitle: 'Home', selected: true,
        });
        expect(resolvePluginMachineExecutionOriginPresentation(fixture.value).subtitle).not.toContain(storedTarget.machineId);
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={value} testIDPrefix="offline-origin" />);
        await screen.pressByTestIdAsync('offline-origin.clear');
        expect(fixture.clearOrigin).toHaveBeenCalledOnce();
        await screen.unmount();
    });
    it.each(['home_unreachable', 'release_unavailable', 'non_portable', 'source_not_ready', 'daemon_unsupported',
        'daemon_invalid_response', 'daemon_unavailable', 'activation_refused'] as const)('keeps the saved origin and explains %s', (reason) => {
        const machine = candidate({ machineId: 'machine-a', materializationId: 'mat-a', version: '0.0.0' });
        const origin: PluginMachineExecutionOriginV1 = { serverIdentityId: 'srv_one', materializationRef: {
            machineId: 'machine-a', materializationId: 'mat-a', pluginId: 'acme.plugin' } };
        const rejected = { ...machine, validation: { kind: 'rejected' as const, reason } };
        const fixture = selection({ candidates: [rejected], selectedOrigin: origin,
            state: { kind: 'unavailable', storedOrigin: origin, candidates: [rejected], reasons: [reason] } });
        expect(resolvePluginMachineExecutionOriginPresentation(fixture.value)).toMatchObject({
            selected: true, detail: `pluginSurfaces.originReason.${reason}`,
        });
        expect(fixture.selectOrigin).not.toHaveBeenCalled();
    });
    it('does not report an unsettled preference save as failed and clears feedback when it applies', async () => {
        const machine = candidate({ machineId: 'machine-a', materializationId: 'mat-a', version: '1.0.0' });
        const origin: PluginMachineExecutionOriginV1 = { serverIdentityId: 'srv_one', materializationRef: {
            machineId: 'machine-a', materializationId: 'mat-a', pluginId: 'acme.plugin' } };
        const fixture = selection({ candidates: [machine], selectedOrigin: origin,
            state: { kind: 'selected', candidate: machine, origin, selectionSource: 'pinned' } });
        const pending = createDeferred<Awaited<ReturnType<PluginMachineExecutionOriginSelectionV1['clearOrigin']>>>();
        fixture.clearOrigin.mockReturnValueOnce(pending.promise);
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={fixture.value} testIDPrefix="origin" />);
        await screen.pressByTestIdAsync('origin.clear');
        expect(screen.findAllByTestId('origin.settlementError')).toHaveLength(0);
        await act(async () => { pending.resolve({ status: 'applied', settingsVersion: 8, value: undefined }); });
        expect(screen.findAllByTestId('origin.settlementError')).toHaveLength(0);
        await screen.unmount();
    });
    it('keeps a configured pending review distinct from a failed preference save', async () => {
        const machine = candidate({ machineId: 'machine-a', materializationId: 'mat-a', version: '1.0.0' });
        const origin: PluginMachineExecutionOriginV1 = { serverIdentityId: 'srv_one', materializationRef: {
            machineId: 'machine-a', materializationId: 'mat-a', pluginId: 'acme.plugin' } };
        const fixture = selection({ candidates: [machine], selectedOrigin: origin,
            state: { kind: 'selected', candidate: machine, origin, selectionSource: 'pinned' } });
        fixture.clearOrigin.mockResolvedValueOnce({ status: 'approvalPending', scope: { serverId: 'home', accountId: 'account' },
            approval: { kind: 'approval_request_created', artifactId: 'pending-origin', actionId: 'plugins.execution_origin.clear' },
            input: { pluginId: 'acme.plugin', expectedSettingsVersion: 7 } });
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={fixture.value} testIDPrefix="origin" />);
        await screen.pressByTestIdAsync('origin.clear');
        expect(screen.findAllByTestId('origin.settlementError')).toHaveLength(0);
        expect(screen.findAllByTestId('origin.approvalPending').length).toBeGreaterThan(0);
        await screen.unmount();
    });
    it('preserves the typed rejection and exact friendly target without selecting a replacement', async () => {
        const machine = candidate({ machineId: 'machine-a', materializationId: 'mat-a', version: '1.0.0' });
        const rejected = { ...machine, validation: { kind: 'rejected' as const, reason: 'disabled' as const } };
        const origin: PluginMachineExecutionOriginV1 = { serverIdentityId: 'srv_one', materializationRef: { machineId: 'machine-a', materializationId: 'mat-a', pluginId: 'acme.plugin' } };
        const fixture = selection({ candidates: [rejected], selectedOrigin: origin, state: { kind: 'unavailable', storedOrigin: origin, candidates: [rejected], reasons: ['disabled'] } });
        const presentation = resolvePluginMachineExecutionOriginPresentation(fixture.value, [{ target: { serverIdentityId: 'srv_one', machineId: 'machine-a' }, displayName: 'Studio', serverLabel: 'Work', availability: 'online', observation: 'live', observedAt: 100 }]);
        expect(presentation.title).toBe('Studio');
        expect(presentation.subtitle).toContain('Work');
        expect(presentation.detail).toContain('settingsPlugins.machineMatrix.state.disabled');
        expect(presentation.selected).toBe(true);
        expect(fixture.selectOrigin).not.toHaveBeenCalled();
    });
    it('shows the sole structurally selected origin while its Account preference is being initialized', async () => {
        const machineA = candidate({ machineId: 'machine-a', materializationId: 'mat-a', version: '1.0.0' });
        const origin: PluginMachineExecutionOriginV1 = {
            serverIdentityId: 'srv_one',
            materializationRef: {
                machineId: 'machine-a',
                materializationId: 'mat-a',
                pluginId: 'acme.plugin',
            },
        };
        const fixture = selection({
            candidates: [machineA],
            state: {
                kind: 'selected',
                origin,
                candidate: machineA,
                selectionSource: 'auto',
            },
        });
        capturedPickerProps.length = 0;
        capturedItemProps.length = 0;

        await renderScreen(React.createElement(PluginMachineExecutionOriginSelectorView, {
            selection: fixture.value,
            testIDPrefix: 'plugin.origin',
        }));

        expect(capturedItemProps).toContainEqual(expect.objectContaining({
            testID: 'plugin.origin.current',
            title: 'machine.unlistedMachine',
            subtitle: expect.stringContaining('common.version 1.0.0'),
            detail: 'common.change',
            selected: true,
        }));
        expect(capturedPickerProps).toHaveLength(0);
        await act(async () => { capturedItemProps.find((item) => item.testID === 'plugin.origin.current')?.onPress?.(); });
        expect(capturedPickerProps[0]?.isMachineSelected?.(capturedPickerProps[0]!.groups[0]!.machines[0]!)).toBe(true);
    });

    it('presents divergent sources without electing one and submits the exact chosen materialization origin', async () => {
        const machineA = candidate({ machineId: 'machine-a', materializationId: 'mat-a', version: '1.0.0' });
        const machineB = candidate({ machineId: 'machine-a', materializationId: 'mat-b', version: '2.0.0' });
        const fixture = selection({
            candidates: [machineA, machineB],
            state: { kind: 'conflict', candidates: [machineA, machineB], reasons: ['different_versions'] },
        });
        capturedPickerProps.length = 0;
        capturedItemProps.length = 0;

        await renderScreen(React.createElement(PluginMachineExecutionOriginSelectorView, {
            selection: fixture.value,
            testIDPrefix: 'plugin.origin',
        }));

        expect(capturedItemProps).toContainEqual(expect.objectContaining({
            testID: 'plugin.origin.current',
            title: 'common.warning',
            subtitle: 'settingsPlugins.targetSelection.differentVersions',
            detail: 'common.change',
            selected: false,
        }));
        await act(async () => { capturedItemProps.find((item) => item.testID === 'plugin.origin.current')?.onPress?.(); });
        const picker = capturedPickerProps[0]!;
        expect(picker.groups.flatMap((group) => group.machines)).toHaveLength(2);
        expect(picker.selectedMachineId).toBeNull();
        const presentedA = picker.groups[0]!.machines[0]!;
        expect(picker.resolveMachineAvailability?.(presentedA)).toEqual({
            detail: 'common.version 1.0.0',
            selectable: true,
        });

        picker.onSelect(presentedA);
        expect(fixture.selectOrigin).toHaveBeenCalledWith({
            serverIdentityId: 'srv_one',
            materializationRef: {
                machineId: 'machine-a',
                materializationId: 'mat-a',
                pluginId: 'acme.plugin',
            },
        });
        const presentedB = picker.groups[0]!.machines[1]!;
        expect(picker.getMachineKey?.(presentedA)).not.toBe(picker.getMachineKey?.(presentedB));
    });

    it('lets the picker row state an offline machine once, with its version only', async () => {
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-b', active: false, activeAt: 100 })], true,
            { sourceServerId: 'srv_one' });
        const online = candidate({ machineId: 'machine-a', materializationId: 'mat-a', version: '1.0.0' });
        const offline = { ...candidate({ machineId: 'machine-b', materializationId: 'mat-b', version: '0.9.0' }),
            validation: { kind: 'rejected' as const, reason: 'offline' as const } };
        const fixture = selection({
            candidates: [online, offline],
            state: { kind: 'conflict', candidates: [online, offline], reasons: ['different_versions'] },
        });
        capturedPickerProps.length = 0;
        capturedItemProps.length = 0;
        await renderScreen(React.createElement(PluginMachineExecutionOriginSelectorView, {
            selection: fixture.value,
            testIDPrefix: 'plugin.origin',
        }));
        await act(async () => { capturedItemProps.find((item) => item.testID === 'plugin.origin.current')?.onPress?.(); });
        const picker = capturedPickerProps[0]!;
        const presentedOffline = picker.groups.flatMap((group) => group.machines).find((machine) => machine.id === 'machine-b')
            ?? picker.groups.flatMap((group) => group.machines)[1]!;
        // The shared row already says "Offline · last seen …"; the plugin adds only what differs.
        expect(picker.resolveMachineAvailability?.(presentedOffline)).toEqual({
            detail: 'common.version 0.9.0',
            selectable: false,
        });
    });

    it('keeps a typed selection conflict visible instead of silently dropping it', async () => {
        const machineA = candidate({ machineId: 'machine-a', materializationId: 'mat-a', version: '1.0.0' });
        const fixture = selection({
            candidates: [machineA],
            state: { kind: 'conflict', candidates: [machineA], reasons: ['different_versions'] },
        });
        fixture.selectOrigin.mockResolvedValueOnce({ status: 'conflict', currentSettingsVersion: 9 });
        capturedPickerProps.length = 0;
        capturedItemProps.length = 0;

        await renderScreen(React.createElement(PluginMachineExecutionOriginSelectorView, {
            selection: fixture.value,
            testIDPrefix: 'plugin.origin',
        }));
        await act(async () => { capturedItemProps.find((item) => item.testID === 'plugin.origin.current')?.onPress?.(); });
        const presented = capturedPickerProps[0]!.groups[0]!.machines[0]!;
        await act(async () => {
            capturedPickerProps[0]!.onSelect(presented);
            await Promise.resolve();
        });

        expect(capturedItemProps).toContainEqual(expect.objectContaining({
            testID: 'plugin.origin.settlementError',
            title: 'settingsPlugins.genericSettingsSaveError',
        }));
    });

    it('keeps an Artifact release-content conflict visible with its version instead of reducing it to unavailable', async () => {
        const conflictingMachine = candidate({
            machineId: 'machine-a',
            materializationId: 'mat-a',
            version: '2.0.0',
            releaseContent: 'conflict',
        });
        const fixture = selection({
            candidates: [conflictingMachine],
            state: {
                kind: 'conflict',
                candidates: [conflictingMachine],
                reasons: ['content_conflict'],
            },
        });
        capturedPickerProps.length = 0;
        capturedItemProps.length = 0;

        await renderScreen(React.createElement(PluginMachineExecutionOriginSelectorView, {
            selection: fixture.value,
            testIDPrefix: 'plugin.origin',
        }));

        expect(capturedItemProps).toContainEqual(expect.objectContaining({
            testID: 'plugin.origin.current',
            title: 'common.warning',
            subtitle: 'settingsPlugins.executionOriginReleaseContentConflict',
            detail: 'common.change',
            selected: false,
        }));
        await act(async () => { capturedItemProps.find((item) => item.testID === 'plugin.origin.current')?.onPress?.(); });
        const picker = capturedPickerProps[0]!;
        const presented = picker.groups[0]!.machines[0]!;
        expect(picker.resolveMachineAvailability?.(presented)).toEqual({
            detail: 'settingsPlugins.executionOriginReleaseContentConflict · common.version 2.0.0',
            selectable: false,
        });
    });

    it('keeps an unavailable stored materialization visible as an inert tombstone until explicit removal', async () => {
        const storedOrigin: PluginMachineExecutionOriginV1 = {
            serverIdentityId: 'srv_old',
            materializationRef: {
                machineId: 'machine-old',
                materializationId: 'mat-old',
                pluginId: 'acme.plugin',
            },
        };
        const fixture = selection({
            candidates: [],
            selectedOrigin: storedOrigin,
            state: {
                kind: 'unavailable',
                storedOrigin,
                candidates: [],
                reasons: ['missing'],
            },
        });
        capturedPickerProps.length = 0;
        capturedItemProps.length = 0;

        await renderScreen(React.createElement(PluginMachineExecutionOriginSelectorView, {
            selection: fixture.value,
            testIDPrefix: 'plugin.origin',
        }));

        expect(capturedItemProps).toContainEqual(expect.objectContaining({
            testID: 'plugin.origin.current',
            title: 'machine.unlistedMachine',
            subtitle: expect.stringContaining('settingsPlugins.targetSelection.missing'),
            selected: true,
        }));
        const clear = capturedItemProps.find((item) => item.testID === 'plugin.origin.clear');
        expect(clear?.accessibilityLabel).toBe('settingsPlugins.targetSelection.clear: settingsPlugins.executionOriginTitle');
        await act(async () => { clear?.onPress?.(); });
        expect(fixture.clearOrigin).toHaveBeenCalledOnce();
        expect(capturedPickerProps).toHaveLength(0);
    });

    it('labels its group with the caller-provided presentation title instead of the shared default', async () => {
        const machineA = candidate({ machineId: 'machine-a', materializationId: 'mat-a', version: '1.0.0' });
        const fixture = selection({
            candidates: [machineA],
            state: { kind: 'conflict', candidates: [machineA], reasons: ['different_versions'] },
        });
        capturedGroupTitleProps.length = 0;

        await renderScreen(React.createElement(PluginMachineExecutionOriginSelectorView, {
            selection: fixture.value,
            testIDPrefix: 'plugin.origin',
            groupTitle: 'settingsPlugins.executionOriginTitle',
        }));

        expect(capturedGroupTitleProps).toContainEqual({ title: 'settingsPlugins.executionOriginTitle' });
    });

    it('keeps the incumbent shared machine heading as the default group title for callers that name nothing', async () => {
        const machineA = candidate({ machineId: 'machine-a', materializationId: 'mat-a', version: '1.0.0' });
        const fixture = selection({
            candidates: [machineA],
            state: { kind: 'conflict', candidates: [machineA], reasons: ['different_versions'] },
        });
        capturedGroupTitleProps.length = 0;

        await renderScreen(React.createElement(PluginMachineExecutionOriginSelectorView, {
            selection: fixture.value,
            testIDPrefix: 'plugin.origin',
        }));

        expect(capturedGroupTitleProps).toContainEqual({ title: 'settingsProviders.detail.targetMachine' });
    });
});


it('keeps an unavailable chip as the Run-on control while the body owns the failure sentence', async () => {
    const machine = candidate({ machineId: 'machine-a', materializationId: 'mat-a', version: '1.0.0' });
    const fixture = selection({ candidates: [machine], state: { kind: 'unavailable', storedOrigin: null, candidates: [machine], reasons: ['offline'] } });
    const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={fixture.value} presentation="chip" testIDPrefix="run-on" />);
    const filter = screen.root.findAll(node => node.props.filter?.id === 'plugin-execution')[0]?.props.filter;
    expect(filter).toBeDefined();
    expect(filter?.valueLabel ?? null).toBeNull();
    expect(filter?.label).toBeTruthy();
    await screen.unmount();
});

it('draws no Run-on chip while there is no Machine to name or choose', async () => {
    const fixture = selection({ candidates: [], state: { kind: 'unavailable', storedOrigin: null, candidates: [], reasons: ['offline'] } });
    const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView selection={fixture.value} presentation="chip" testIDPrefix="run-on" />);
    expect(screen.root.findAll(node => node.props.filter?.id === 'plugin-execution')).toHaveLength(0);
    await screen.unmount();
});
