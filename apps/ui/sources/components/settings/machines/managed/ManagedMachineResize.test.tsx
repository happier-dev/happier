import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

installSettingsViewCommonModuleMocks({ storage: 'real', text: async () => vi.importActual<typeof import('@/text')>('@/text') });
const [{ ManagedMachineResize }, { t }] = await Promise.all([import('./ManagedMachineResize'), import('@/text')]);
afterEach(() => standardCleanup());

const GIB = 1024 ** 3;
const machine = () => ManagedMachineV1Schema.parse({ id: 'build-guest', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Build guest', choices: {} },
    allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 3,
    resource: { contributionRef: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'same-native' } },
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    observation: { availability: 'present', observedAt: 1, power: 'running', size: { cpuCores: 2, memoryBytes: 2 * GIB, diskBytes: 20 * GIB } } });
const descriptor = { resize: {
    cpuCores: { kind: 'supported', requiresRestart: false, changes: 'any' },
    memoryBytes: { kind: 'supported', requiresRestart: true, changes: 'any' },
    diskBytes: { kind: 'unsupported', code: 'disk_resize_unsupported' },
} } satisfies Pick<MachineProvisionerContributionV1, 'resize'>;

describe('managed machine resize review', () => {
    it('keeps the creation size out of desired sizes and grow-only validation when current size is unknown', async () => {
        const confirm = vi.fn();
        const original = machine();
        const retained = ManagedMachineV1Schema.parse({ ...original, observation: undefined, reviewedFacts: {
            launch: original.launch, optionStatus: 'current', billing: { location: 'local', stoppedBilling: 'not-billed' },
            prerequisites: [], retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
            retention: original.retention, wakeOnAcceptedMessage: false,
            nativeFacts: { size: { id: 'initial', title: 'Initial size', diskBytes: 20 * GIB } },
        } });
        const screen = await renderScreen(<ManagedMachineResize machine={retained} descriptor={{ resize: { ...descriptor.resize,
            diskBytes: { kind: 'supported', requiresRestart: true, changes: 'grow-only' } } }}
            disabled={false} pending={false} onConfirm={confirm} onCancel={() => undefined} />);
        expect(screen.getTextContent()).toContain(t('managedMachines.resize.reviewed'));
        expect(screen.findByTestId('managed-machine.resize-field:diskBytes')?.props.value).toBe('');
        await act(async () => screen.changeTextByTestId('managed-machine.resize-field:diskBytes', '19'));
        await screen.pressByTestIdAsync('managed-machine.resize-confirm');
        expect(confirm).toHaveBeenCalledWith({ diskBytes: 19 * GIB });
    });
    it('shows the observed size, keeps unsupported disk read-only, and submits only the reviewed changed size', async () => {
        const confirm = vi.fn();
        const screen = await renderScreen(<ManagedMachineResize machine={machine()} descriptor={descriptor}
            disabled={false} pending={false} onConfirm={confirm} onCancel={() => undefined} />);
        expect(screen.findByTestId('managed-machine.resize-current')).not.toBeNull();
        expect(screen.getTextContent()).toContain('2 cores');
        expect(screen.findByTestId('managed-machine.resize-unsupported:diskBytes')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('managedMachines.resize.unsupported'));
        await act(async () => screen.changeTextByTestId('managed-machine.resize-field:memoryBytes', '4'));
        expect(screen.getTextContent()).toContain(t('managedMachines.resize.restart'));
        expect(confirm).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('managed-machine.resize-confirm');
        expect(confirm).toHaveBeenCalledWith({ memoryBytes: 4 * GIB });
    });
    it('keeps a grow-only disk from shrinking and accepts growth near the current size', async () => {
        const confirm = vi.fn();
        const screen = await renderScreen(<ManagedMachineResize machine={machine()} descriptor={{ resize: { ...descriptor.resize,
            diskBytes: { kind: 'supported', requiresRestart: true, changes: 'grow-only' } } }}
            disabled={false} pending={false} onConfirm={confirm} onCancel={() => undefined} />);
        await act(async () => screen.changeTextByTestId('managed-machine.resize-field:diskBytes', '19'));
        expect(screen.findByTestId('managed-machine.resize-confirm')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('managed-machine.resize-confirm');
        expect(confirm).not.toHaveBeenCalled();
        await act(async () => screen.changeTextByTestId('managed-machine.resize-field:diskBytes', '21'));
        await screen.pressByTestIdAsync('managed-machine.resize-confirm');
        expect(confirm).toHaveBeenCalledWith({ diskBytes: 21 * GIB });
    });
});
