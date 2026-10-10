import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';

import type {
    ServerScopedMachineGroup,
    ServerScopedMachinePresentation,
} from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { renderScreen } from '@/dev/testkit';
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
            selectOrigin,
            clearOrigin,
            resolveExecutionOrigin: () => null,
        },
        selectOrigin,
        clearOrigin,
    };
}

describe('PluginMachineExecutionOriginSelector', () => {
    it('preserves the typed rejection and exact friendly target without selecting a replacement', async () => {
        const machine = candidate({ machineId: 'machine-a', materializationId: 'mat-a', version: '1.0.0' });
        const rejected = { ...machine, validation: { kind: 'rejected' as const, reason: 'disabled' as const } };
        const origin: PluginMachineExecutionOriginV1 = { serverIdentityId: 'srv_one', materializationRef: { machineId: 'machine-a', materializationId: 'mat-a', pluginId: 'acme.plugin' } };
        const fixture = selection({ candidates: [rejected], selectedOrigin: origin, state: { kind: 'unavailable', storedOrigin: origin, candidates: [rejected], reasons: ['disabled'] } });
        const { resolvePluginMachineExecutionOriginPresentation } = await import('./PluginMachineExecutionOriginSelector');
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
                selectionSource: 'soleCandidate',
            },
        });
        const { PluginMachineExecutionOriginSelectorView } = await import('./PluginMachineExecutionOriginSelector');
        capturedPickerProps.length = 0;
        capturedItemProps.length = 0;

        await renderScreen(React.createElement(PluginMachineExecutionOriginSelectorView, {
            selection: fixture.value,
            testIDPrefix: 'plugin.origin',
        }));

        expect(capturedItemProps).toContainEqual(expect.objectContaining({
            testID: 'plugin.origin.current',
            title: 'machine-a',
            subtitle: 'srv_one\ncommon.version 1.0.0',
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
        const { PluginMachineExecutionOriginSelectorView } = await import('./PluginMachineExecutionOriginSelector');
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

    it('keeps a typed selection conflict visible instead of silently dropping it', async () => {
        const machineA = candidate({ machineId: 'machine-a', materializationId: 'mat-a', version: '1.0.0' });
        const fixture = selection({
            candidates: [machineA],
            state: { kind: 'conflict', candidates: [machineA], reasons: ['different_versions'] },
        });
        fixture.selectOrigin.mockResolvedValueOnce({ status: 'conflict', currentSettingsVersion: 9 });
        const { PluginMachineExecutionOriginSelectorView } = await import('./PluginMachineExecutionOriginSelector');
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
        const { PluginMachineExecutionOriginSelectorView } = await import('./PluginMachineExecutionOriginSelector');
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
        const { PluginMachineExecutionOriginSelectorView } = await import('./PluginMachineExecutionOriginSelector');
        capturedPickerProps.length = 0;
        capturedItemProps.length = 0;

        await renderScreen(React.createElement(PluginMachineExecutionOriginSelectorView, {
            selection: fixture.value,
            testIDPrefix: 'plugin.origin',
        }));

        expect(capturedItemProps).toContainEqual(expect.objectContaining({
            testID: 'plugin.origin.current',
            title: 'machine-old',
            subtitle: 'srv_old\nsettingsPlugins.targetSelection.missing',
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
        const { PluginMachineExecutionOriginSelectorView } = await import('./PluginMachineExecutionOriginSelector');
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
        const { PluginMachineExecutionOriginSelectorView } = await import('./PluginMachineExecutionOriginSelector');
        capturedGroupTitleProps.length = 0;

        await renderScreen(React.createElement(PluginMachineExecutionOriginSelectorView, {
            selection: fixture.value,
            testIDPrefix: 'plugin.origin',
        }));

        expect(capturedGroupTitleProps).toContainEqual({ title: 'settingsProviders.detail.targetMachine' });
    });
});
