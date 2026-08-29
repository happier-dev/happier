import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const fixture = vi.hoisted(() => ({
    materializationAdmission: null as unknown,
    snapshots: [] as readonly unknown[],
}));
const capturedItemProps = vi.hoisted(() => [] as Readonly<Record<string, unknown>>[]);

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Readonly<Record<string, unknown>>) => {
        capturedItemProps.push(props);
        return React.createElement('Item');
    },
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/domains/plugins/availability/projection', () => ({
    useActivePluginAccountAvailabilityReader: () => ({
        readMaterializations: () => fixture.materializationAdmission,
    }),
    useActivePluginAccountAvailabilityReleaseClassifier: () => () => ({
        releaseContent: 'matched',
        validation: { kind: 'admitted' },
    }),
}));
vi.mock('@/sync/domains/machines/useMachineInventorySnapshots', () => ({
    useAllProfileMachineInventorySnapshots: () => fixture.snapshots,
}));

function machine(id: string, online: boolean) {
    const now = Date.now();
    return {
        id,
        updatedAt: now,
        active: true,
        activeAt: online ? now : now - 86_400_000,
        revokedAt: null,
        metadataVersion: 1,
        metadata: { displayName: id },
    };
}

function materialization(machineId: string, overrides: Readonly<Record<string, unknown>> = {}) {
    return {
        serverIdentityId: 'srv_one',
        machineId,
        materializationId: `mat-${machineId}`,
        pluginId: 'acme.plugin',
        version: '1.0.0',
        sourceClass: 'versionedArchive',
        portableRelease: true,
        uiArtifacts: [],
        enabled: true,
        trustState: 'trusted',
        observedAt: Date.now() - 1_000,
        ...overrides,
    };
}

describe('PluginMachineMatrixSection', () => {
    beforeEach(() => {
        capturedItemProps.length = 0;
        fixture.snapshots = [{
            kind: 'resolved',
            profileId: 'profile-one',
            serverIdentityId: 'srv_one',
            serverName: 'Server One',
            observation: 'live',
            machines: [machine('machine-a', true), machine('machine-b', false)],
        }];
        fixture.materializationAdmission = {
            kind: 'available',
            availabilityCursor: 7,
            materializations: [materialization('machine-a'), materialization('machine-b')],
            // Reporting identity: both machines are included in this snapshot,
            // so neither is silently unknown to the matrix.
            snapshots: [
                { serverIdentityId: 'srv_one', machineId: 'machine-a', revision: 1, materializations: [] },
                { serverIdentityId: 'srv_one', machineId: 'machine-b', revision: 1, materializations: [] },
            ],
        };
    });

    afterEach(() => {
        standardCleanup();
    });

    it('states each machine\'s distinct truth for one plugin', async () => {
        const { PluginMachineMatrixSection } = await import('./PluginMachineMatrixSection');
        await renderScreen(<PluginMachineMatrixSection pluginId="acme.plugin" />);

        const cells = capturedItemProps.filter((props) => (
            String(props.testID ?? '').endsWith('.cell')
        ));
        expect(cells.map((props) => [props.title, props.detail])).toEqual([
            ['machine-a', 'settingsPlugins.machineMatrix.state.installedCurrent'],
            ['machine-b', 'settingsPlugins.machineMatrix.state.staleOffline'],
        ]);
    });

    it('renders no interactive affordance, so a matrix cell can never retarget administration', async () => {
        const { PluginMachineMatrixSection } = await import('./PluginMachineMatrixSection');
        await renderScreen(<PluginMachineMatrixSection pluginId="acme.plugin" />);

        expect(capturedItemProps.length).toBeGreaterThan(0);
        const interactive = capturedItemProps.filter((props) => (
            props.mode !== 'info'
            || Object.entries(props).some(([, value]) => typeof value === 'function')
        ));
        expect(interactive).toEqual([]);
    });

    it('says the machine states are unknown rather than drawing an empty grid while Availability is unloaded', async () => {
        fixture.materializationAdmission = {
            kind: 'unavailable',
            code: 'account_availability_not_loaded',
        };
        const { PluginMachineMatrixSection } = await import('./PluginMachineMatrixSection');
        await renderScreen(<PluginMachineMatrixSection pluginId="acme.plugin" />);

        expect(capturedItemProps.map((props) => props.title)).toEqual([
            'settingsPlugins.machineMatrix.unavailable',
        ]);
    });
});
