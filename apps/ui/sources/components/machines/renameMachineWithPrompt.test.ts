import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture } from '@/dev/testkit';

const machineUpdateMetadataMock = vi.hoisted(() => vi.fn());
const refreshMachinesMock = vi.hoisted(() => vi.fn());
const promptMock = vi.hoisted(() => vi.fn());
const alertMock = vi.hoisted(() => vi.fn());

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { prompt: promptMock, alert: alertMock } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/sync/ops', () => ({
    machineUpdateMetadata: machineUpdateMetadataMock,
}));

vi.mock('@/sync/sync', () => ({
    sync: { refreshMachines: refreshMachinesMock },
}));

const { renameMachineWithPrompt } = await import('./renameMachineWithPrompt');

function machineFixture(input: Readonly<{ displayName?: string; version?: number }> = {}) {
    return createMachineFixture({
        id: 'machine-a',
        metadataVersion: input.version ?? 4,
        metadata: {
            host: 'mac-studio.local',
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/tester/.happy-dev',
            homeDir: '/Users/tester',
            ...(input.displayName ? { displayName: input.displayName } : {}),
        },
    });
}

describe('renameMachineWithPrompt', () => {
    beforeEach(() => {
        promptMock.mockReset();
        alertMock.mockReset();
        machineUpdateMetadataMock.mockReset();
        refreshMachinesMock.mockReset();
        promptMock.mockResolvedValue(null);
        machineUpdateMetadataMock.mockResolvedValue({ version: 5, metadata: '{}' });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('prompts with the existing alias and persists the confirmed name at the current version', async () => {
        promptMock.mockResolvedValue('Studio');

        const outcome = await renameMachineWithPrompt(machineFixture({ displayName: 'Old name' }));

        expect(outcome).toBe('renamed');
        expect(promptMock).toHaveBeenCalledTimes(1);
        expect(machineUpdateMetadataMock).toHaveBeenCalledTimes(1);
        expect(machineUpdateMetadataMock).toHaveBeenCalledWith(
            'machine-a',
            expect.objectContaining({ host: 'mac-studio.local', displayName: 'Studio' }),
            4,
        );
        expect(refreshMachinesMock).not.toHaveBeenCalled();
    });

    it('does not persist anything when the prompt is cancelled', async () => {
        promptMock.mockResolvedValue(null);

        const outcome = await renameMachineWithPrompt(machineFixture({ displayName: 'Old name' }));

        expect(outcome).toBe('cancelled');
        expect(machineUpdateMetadataMock).not.toHaveBeenCalled();
        expect(alertMock).not.toHaveBeenCalled();
    });

    it('clears the alias when the confirmed name is blank', async () => {
        promptMock.mockResolvedValue('   ');

        const outcome = await renameMachineWithPrompt(machineFixture({ displayName: 'Old name' }));

        expect(outcome).toBe('renamed');
        expect(machineUpdateMetadataMock).toHaveBeenCalledTimes(1);
        const writtenMetadata = machineUpdateMetadataMock.mock.calls[0][1];
        expect(writtenMetadata.displayName).toBeUndefined();
        expect(writtenMetadata.host).toBe('mac-studio.local');
    });

    it('alerts and refreshes machines when the metadata write fails', async () => {
        promptMock.mockResolvedValue('Studio');
        machineUpdateMetadataMock.mockRejectedValue(new Error('version conflict'));

        const outcome = await renameMachineWithPrompt(machineFixture({ displayName: 'Old name' }));

        expect(outcome).toBe('failed');
        expect(alertMock).toHaveBeenCalledWith('common.error', 'version conflict');
        expect(refreshMachinesMock).toHaveBeenCalledTimes(1);
    });
});
