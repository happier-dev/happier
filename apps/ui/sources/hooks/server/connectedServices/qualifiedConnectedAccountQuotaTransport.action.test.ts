import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQualifiedQuotaTestHarness, quotaTestRef as ref } from './qualifiedConnectedAccountQuotaTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { refreshQualifiedConnectedAccountQuota } from './qualifiedConnectedAccountQuotaTransport';

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
installDisconnectedServerSocketBoundary();

describe('qualified quota refresh Action authority', () => {
    let boundary: Awaited<ReturnType<typeof createQualifiedQuotaTestHarness>>;

    beforeEach(async () => { boundary = await createQualifiedQuotaTestHarness(); });
    afterEach(async () => { await boundary?.dispose(); vi.restoreAllMocks(); });

    it('refreshes through the persisted second machine rather than inventory order', async () => {
        await expect(refreshQualifiedConnectedAccountQuota(boundary.context())).resolves.toBeUndefined();
        expect(boundary.controls).toEqual([{ machineId: 'machine-selected', command: {
            operation: 'describeService', service: ref.service, requiredOperation: 'quota_refresh',
        } }]);
        expect(boundary.refresh).toHaveBeenCalledWith(ref);
    });

    it.each([null, 'machine-first'])('refuses an explicit nonselected refresh target %s before any effect', async (refreshMachineId) => {
        await expect(refreshQualifiedConnectedAccountQuota({ ...boundary.context(), refreshMachineId })).rejects.toBeDefined();
        expect(boundary.controls).toEqual([]);
        expect(boundary.refresh).not.toHaveBeenCalled();
    });

    it('refuses a persisted foreign Home selection before any effect', async () => {
        storage.getState().applySettings({ ...storage.getState().settings, machineAdministrationTargetsLocalV1: {
            [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: {
                serverIdentityId: 'srv_another_home', machineId: 'machine-selected',
            },
        } }, 2);
        await expect(refreshQualifiedConnectedAccountQuota(boundary.context())).rejects.toBeDefined();
        expect(boundary.controls).toEqual([]);
        expect(boundary.refresh).not.toHaveBeenCalled();
    });

    it('refuses a missing persisted selection even with available machines', async () => {
        storage.getState().applySettings({ ...storage.getState().settings, machineAdministrationTargetsLocalV1: {} }, 2);
        await expect(refreshQualifiedConnectedAccountQuota(boundary.context())).rejects.toBeDefined();
        expect(boundary.controls).toEqual([]);
        expect(boundary.refresh).not.toHaveBeenCalled();
    });

    it('refuses a captured retired generation before any effect', async () => {
        const context = boundary.context();
        await expect(refreshQualifiedConnectedAccountQuota({
            ...context, serverBasis: { ...context.serverBasis, generation: context.serverBasis.generation - 1 },
        })).rejects.toBeDefined();
        expect(boundary.controls).toEqual([]);
        expect(boundary.refresh).not.toHaveBeenCalled();
    });

    it('refuses credentials captured for another Account before any effect', async () => {
        const context = boundary.context();
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'another-account' })).toString('base64url')}.signature`;
        await expect(refreshQualifiedConnectedAccountQuota({ ...context, credentials: { token } })).rejects.toBeDefined();
        expect(boundary.controls).toEqual([]);
        expect(boundary.refresh).not.toHaveBeenCalled();
    });
});
