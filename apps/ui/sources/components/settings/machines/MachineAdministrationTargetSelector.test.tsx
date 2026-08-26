import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol';

import type {
    ServerScopedMachineGroup,
    ServerScopedMachinePresentation,
} from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { renderScreen } from '@/dev/testkit';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type {
    MachineAdministrationCandidateV1,
    MachineAdministrationTargetStateV1,
} from '@/sync/domains/machines/administration/targetSelection';
import type {
    MachineAdministrationTargetPickerRowV1,
    MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';

import { installNewSessionComponentsCommonModuleMocks } from '../../sessions/new/components/newSessionComponentsTestHelpers';

type PresentedMachine = ServerScopedMachinePresentation & Readonly<{
    target: MachineAdministrationTargetV1;
    candidate: MachineAdministrationCandidateV1;
}>;

type CapturedPickerProps = Readonly<{
    groups: readonly ServerScopedMachineGroup<PresentedMachine>[];
    selectedMachineId: string | null;
    selectedServerId: string | null;
    onSelect: (machine: PresentedMachine) => void;
    resolveMachineAvailability?: (machine: PresentedMachine) => Readonly<{
        detail: string;
        selectable: boolean;
    }>;
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
const runGuardedNavigationMock = vi.hoisted(() => vi.fn());

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
vi.mock('@/utils/navigation/runGuardedNavigation', () => ({
    runGuardedNavigation: runGuardedNavigationMock,
}));

function createSelection(params: Readonly<{
    availability: 'online' | 'offline';
    observation?: 'live' | 'stale';
}>): Readonly<{
    selection: MachineAdministrationTargetSelectionV1;
    selectTarget: ReturnType<typeof vi.fn>;
}> {
    const target: MachineAdministrationTargetV1 = {
        serverIdentityId: 'portable-server-b',
        machineId: 'machine-b',
    };
    const machine: MachineDisplayRenderable = {
        id: target.machineId,
        updatedAt: 100,
        active: params.availability === 'online',
        activeAt: params.availability === 'online' ? 100 : 0,
        revokedAt: null,
        metadataVersion: 1,
        metadata: { displayName: 'Machine B', host: 'host-b', homeDir: '/home/b' },
    };
    const candidate: MachineAdministrationCandidateV1 = {
        target,
        displayName: 'Machine B',
        serverLabel: 'Server B',
        availability: params.availability,
        observation: params.observation ?? 'live',
        observedAt: 100,
    };
    const pickerRows: readonly MachineAdministrationTargetPickerRowV1[] = [{
        candidate,
        serverId: 'local-profile-b',
        serverName: 'Server B',
        machine,
    }];
    const state: MachineAdministrationTargetStateV1 = params.availability === 'online'
        && candidate.observation === 'live'
        ? { kind: 'online', target, machine: candidate }
        : { kind: 'offline', target, snapshot: candidate };
    const selectTarget = vi.fn();

    return {
        selection: {
            candidates: [candidate],
            pickerRows,
            state,
            selectedTarget: target,
            canExecute: params.availability === 'online' && candidate.observation === 'live',
            selectTarget,
            clearTarget: vi.fn(),
            resolveExecutionTarget: () => null,
        },
        selectTarget,
    };
}

describe('MachineAdministrationTargetSelector', () => {
    it('routes administration target changes through the active unsaved-draft guard', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection, selectTarget } = createSelection({ availability: 'online' });
        capturedPickerProps.length = 0;
        capturedItemProps.length = 0;
        runGuardedNavigationMock.mockReset();
        runGuardedNavigationMock.mockImplementation((navigate: () => void) => {
            navigate();
            return true;
        });

        await renderScreen(React.createElement(MachineAdministrationTargetSelector, {
            selection,
            testIDPrefix: 'administration.target',
        }));

        const picker = capturedPickerProps[0]!;
        picker.onSelect(picker.groups[0]!.machines[0]!);

        expect(runGuardedNavigationMock).toHaveBeenCalledTimes(1);
        expect(selectTarget).toHaveBeenCalledWith({
            serverIdentityId: 'portable-server-b',
            machineId: 'machine-b',
        });
    });

    it('keeps the exact selected portable target visible and stale rows unavailable before the clear control', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection } = createSelection({ availability: 'online', observation: 'stale' });
        capturedPickerProps.length = 0;
        capturedItemProps.length = 0;

        await renderScreen(React.createElement(MachineAdministrationTargetSelector, {
            selection,
            testIDPrefix: 'administration.target',
        }));

        const currentIndex = capturedItemProps.findIndex((props) => props.testID === 'administration.target.current');
        const clearIndex = capturedItemProps.findIndex((props) => props.testID === 'administration.target.clear');
        expect(currentIndex).toBeGreaterThanOrEqual(0);
        expect(clearIndex).toBeGreaterThan(currentIndex);
        expect(capturedItemProps[currentIndex]).toEqual(expect.objectContaining({
            testID: 'administration.target.current',
            title: 'Machine B',
            subtitle: 'Server B',
            detail: 'settingsProviders.detail.machineOffline',
            selected: true,
            mode: 'info',
            showChevron: false,
        }));

        expect(capturedPickerProps).toHaveLength(1);
        expect(capturedPickerProps[0]).toEqual(expect.objectContaining({
            selectedMachineId: 'machine-b',
            selectedServerId: 'local-profile-b',
            testIdPrefix: 'administration.target.picker',
        }));
        const staleMachine = capturedPickerProps[0]!.groups[0]!.machines[0]!;
        expect(capturedPickerProps[0]!.resolveMachineAvailability?.(staleMachine)).toEqual({
            detail: 'settingsProviders.detail.machineOffline',
            selectable: false,
        });
    });

    it('converts the incumbent picker result back to its exact portable target', async () => {
        const { MachineAdministrationTargetSelector } = await import('./MachineAdministrationTargetSelector');
        const { selection, selectTarget } = createSelection({ availability: 'online' });
        capturedPickerProps.length = 0;
        capturedItemProps.length = 0;

        await renderScreen(React.createElement(MachineAdministrationTargetSelector, {
            selection,
            testIDPrefix: 'administration.target',
        }));

        const picker = capturedPickerProps[0]!;
        picker.onSelect(picker.groups[0]!.machines[0]!);

        expect(selectTarget).toHaveBeenCalledWith({
            serverIdentityId: 'portable-server-b',
            machineId: 'machine-b',
        });
    });
});
