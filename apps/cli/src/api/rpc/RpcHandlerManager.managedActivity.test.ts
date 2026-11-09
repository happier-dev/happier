import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { RpcHandlerManager } from './RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '../machine/machineRpcAuthorization';
import { registerManagedActivityRpcHandlers } from '../machine/rpcHandlers.managedActivity';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

afterEach(() => vi.restoreAllMocks());

it('admits only content-free managed read/drain from the authenticated Home socket without guest-to-Home admission calls', async () => {
    const keys = tweetnacl.sign.keyPair();
    const context = { actorAccountId: 'company', custodianAccountId: 'member', machineId: 'guest',
        installationId: 'guest-installation', encryptionMode: 'e2ee' as const, role: 'manage' as const };
    const target = { homeId: 'home', managedId: 'managed', expectedRevision: 1,
        controller: { machineId: 'controller', installationId: 'controller-installation' } };
    // HTTP is the external boundary; the real authorizer and verifier remain
    // wired so an accidental second Home admission produces a counted request.
    const current = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected Home admission'));
    const manager = new RpcHandlerManager({ scopePrefix: 'guest', localMachineId: 'guest', encryptionMode: 'e2ee',
        encryptionKey: new Uint8Array(32).fill(5), encryptionVariant: 'dataKey', logger: () => {},
        authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, { machineId: 'guest',
            resolveCustodianAccountId: async () => 'member', resolveInstallationId: () => 'guest-installation',
            verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
                privateKey: keys.secretKey, daemonToken: 'member-token', serverHttpBaseUrl: 'https://home.invalid' }) }, source) });
    // A real empty incumbent owner positively establishes complete coverage.
    const activity = createManagedActivityInventory({ producers: [{
        read: () => ({ items: [], coverage: 'complete' }), subscribe: () => () => {},
    }] });
    const drain = createDaemonAdmissionDrain();
    registerManagedActivityRpcHandlers({ rpcHandlerManager: manager, activity, admissionDrain: drain });
    const call = (request: Parameters<typeof manager.handleRequest>[0]) =>
        manager.handleRequest(request, undefined, 'authenticated_home_socket');
    try {
        const privateHandler = vi.fn();
        manager.registerHandler('private.fixture', privateHandler);
        expect(await call({ method: 'guest:private.fixture', params: {}, machineAdmission: context }))
            .toMatchObject({ errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
        expect(privateHandler).not.toHaveBeenCalled();
        expect(await call({ method: `guest:${MANAGED_ACTIVITY_READ_RPC_METHOD}`,
            params: { ...target, content: 'not-content-free' }, machineAdmission: context }))
            .toMatchObject({ errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
        expect(await call({ method: `guest:${MANAGED_ACTIVITY_READ_RPC_METHOD}`, params: target,
            machineAdmission: context })).toMatchObject({ kind: 'idle' });
        expect(await call({ method: `guest:${MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD}`,
            params: { ...target, action: 'begin' }, machineAdmission: context })).toMatchObject({ kind: 'idle' });
        expect(drain.isQuiescing()).toBe(true);
        expect(await call({ method: `guest:${MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD}`,
            params: { ...target, action: 'resume' }, machineAdmission: context })).toMatchObject({ kind: 'idle' });
        expect(drain.isQuiescing()).toBe(false);
        expect(current).not.toHaveBeenCalled();
    } finally { activity.dispose(); }
});
