import * as React from 'react';
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
}>;

const capturedPickerProps: CapturedPickerProps[] = [];
const capturedItemProps: CapturedItemProps[] = [];

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
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
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
    const selectOrigin = vi.fn();
    const clearOrigin = vi.fn();
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
            subtitle: 'srv_one',
            detail: 'common.version 1.0.0',
            selected: true,
        }));
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
            detail: 'common.unavailable',
            selected: false,
        }));
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
        expect(picker.getMachineKey?.(presentedA)).toBe('7:srv_one|9:machine-a|5:mat-a|11:acme.plugin');
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
            detail: 'settingsPlugins.executionOriginReleaseContentConflict',
            selected: false,
        }));
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
            subtitle: 'srv_old',
            detail: 'common.unavailable',
            selected: true,
        }));
        const clear = capturedItemProps.find((item) => item.testID === 'plugin.origin.clear');
        clear?.onPress?.();
        expect(fixture.clearOrigin).toHaveBeenCalledOnce();
        expect(capturedPickerProps).toHaveLength(0);
    });
});
