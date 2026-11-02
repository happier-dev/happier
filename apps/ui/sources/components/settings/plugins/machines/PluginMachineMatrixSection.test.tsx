import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { Item } from '@/components/ui/lists/Item';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());

const fixture = vi.hoisted(() => ({
    materializationAdmission: null as unknown,
    snapshots: [] as readonly unknown[],
}));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
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
        active: online,
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
        fixture.snapshots = [{
            kind: 'resolved',
            profileId: 'profile-one',
            serverIdentityId: 'srv_one',
            accountId: 'account-a',
            serverName: 'Server One',
            observation: 'live',
            machines: [machine('machine-a', true), machine('machine-b', false)],
        }];
        fixture.materializationAdmission = {
            kind: 'available',
            availabilityCursor: 7,
            intentReads: [],
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

    it('summarizes where the plugin is current and lists only the machines that need a look', async () => {
        const { PluginMachineMatrixSection } = await import('./PluginMachineMatrixSection');
        const screen = await renderScreen(<PluginMachineMatrixSection pluginId="acme.plugin" />);
        const capturedItemProps = screen.findAllByType(Item).map((node) => node.props);

        expect(capturedItemProps.find((props) => props.testID === 'settings.plugins.machineMatrix.summary'))
            .toMatchObject({
                title: 'settingsPlugins.surfaces.machinesCurrent(current=1,total=2)',
                subtitle: 'machine-a',
            });
        const exceptions = capturedItemProps.filter((props) => props.testID === 'settings.plugins.machineMatrix.exception');
        expect(exceptions.map((props) => [props.title, props.detail])).toEqual([
            ['machine-b', 'settingsPlugins.machineMatrix.state.staleOffline'],
        ]);
        expect(exceptions[0]?.accessibilityLabel).toEqual(expect.stringContaining(
            'machine-b: settingsPlugins.machineMatrix.state.staleOffline. Server One · common.version 1.0.0 · settingsPlugins.machineMatrix.lastObserved',
        ));
    });

    it('does not claim "current on 0 of N" for a plugin that only lives on its own machine', async () => {
        // A development or machine-bound source is never Account-current by construction;
        // "0 of 2" would read as a failure across the Account. The row naming its machine says it.
        fixture.materializationAdmission = {
            ...(fixture.materializationAdmission as object),
            materializations: [materialization('machine-a', { portableRelease: false })],
        };
        const { PluginMachineMatrixSection } = await import('./PluginMachineMatrixSection');
        const screen = await renderScreen(<PluginMachineMatrixSection pluginId="acme.plugin" />);
        const capturedItemProps = screen.findAllByType(Item).map((node) => node.props);
        expect(capturedItemProps.find((props) => props.testID === 'settings.plugins.machineMatrix.summary')).toBeUndefined();
        expect(capturedItemProps.filter((props) => props.testID === 'settings.plugins.machineMatrix.exception')
            .map((props) => [props.title, props.detail])).toEqual([
            ['machine-a', 'settingsPlugins.machineMatrix.state.localOnly'],
        ]);
    });

    it('does not repeat the Account release, which its own section owns', async () => {
        const { PluginMachineMatrixSection } = await import('./PluginMachineMatrixSection');
        const screen = await renderScreen(<PluginMachineMatrixSection pluginId="acme.plugin" />);
        const capturedItemProps = screen.findAllByType(Item).map((node) => node.props);
        expect(capturedItemProps.some((props) => String(props.testID).endsWith('.account'))).toBe(false);
    });

    it('names a machine that left the Account generically, never by its raw id', async () => {
        fixture.materializationAdmission = {
            ...(fixture.materializationAdmission as object),
            materializations: [materialization('machine-a'), materialization('machine-gone', { version: '0.9.0' })],
        };
        const { PluginMachineMatrixSection } = await import('./PluginMachineMatrixSection');
        const screen = await renderScreen(<PluginMachineMatrixSection pluginId="acme.plugin" />);
        const capturedItemProps = screen.findAllByType(Item).map((node) => node.props);
        const titles = capturedItemProps
            .filter((props) => props.testID === 'settings.plugins.machineMatrix.exception')
            .map((props) => props.title);
        expect(titles).toContain('settingsPlugins.surfaces.machinesRetained');
        expect(JSON.stringify(capturedItemProps.map((props) => [props.title, props.subtitle]))).not.toContain('machine-gone');
    });

    it('renders no interactive row, so a machine can never retarget administration', async () => {
        const { PluginMachineMatrixSection } = await import('./PluginMachineMatrixSection');
        const screen = await renderScreen(<PluginMachineMatrixSection pluginId="acme.plugin" />);
        const capturedItemProps = screen.findAllByType(Item).map((node) => node.props);

        expect(capturedItemProps.length).toBeGreaterThan(0);
        const interactive = capturedItemProps.filter((props) => (
            props.mode !== 'info' || Object.entries(props).some(([, value]) => typeof value === 'function')
        ));
        expect(interactive).toEqual([]);
    });

    it('says the machine states are unknown rather than drawing an empty summary while Availability is unloaded', async () => {
        fixture.materializationAdmission = {
            kind: 'unavailable',
            code: 'account_availability_not_loaded',
        };
        const { PluginMachineMatrixSection } = await import('./PluginMachineMatrixSection');
        const screen = await renderScreen(<PluginMachineMatrixSection pluginId="acme.plugin" />);
        const capturedItemProps = screen.findAllByType(Item).map((node) => node.props);

        expect(capturedItemProps.map((props) => props.title)).toEqual([
            'settingsPlugins.machineMatrix.unavailable',
        ]);
    });
});
