import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { applyManagedMachineEnrollmentIsolation } from '@happier-dev/cli-common/machines/managed';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { publishMachineMetadataOnce, readOpenedMachineMetadataSnapshot } from '@/api/machine/machineMetadataPublication';
import type { Machine } from '@/api/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations';
import { readAgentIsolationSnapshot } from './agentIsolationPolicy';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';

it('retains the guest metadata conflict through bootstrap admission and terminal operation settlement', async () => {
    const machine: Machine = { id: 'guest', encryptionMode: 'plain', metadataVersion: 4, daemonStateVersion: 1,
        metadata: { host: 'guest', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier' },
        daemonState: { status: 'running', runtimeId: 'daemon', agentIsolation: { kind: 'unavailable', code: 'provisioning_unavailable' } } };
    const port = {
        read: async () => readOpenedMachineMetadataSnapshot(machine, true),
        compareAndSwap: (input: Parameters<typeof publishMachineMetadataOnce>[1]) => publishMachineMetadataOnce({
            getMachine: () => machine, codec: createMachineContentCodec({ encryptionMode: 'plain' }), expectedDataEncryptionKey: null,
            isContentCurrent: () => true, retireAndRefreshContent: async () => {}, notifyMetadataChanged: () => {},
            // Socket persistence is the boundary; the metadata publisher and CAS stay real.
            socket: { connected: true, emitWithAck: async (_event, payload) => ({ result: 'success' as const,
                version: payload.expectedVersion + 1, metadata: payload.metadata }) },
        }, input),
    };
    const native = createAgentIsolationEffectsBoundary({ installationId: 'guest-installation',
        installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
        publishStatus: async status => { machine.daemonState = { ...machine.daemonState!, agentIsolation: status }; } });
    const rpc = new RpcHandlerManager({ scopePrefix: machine.id, localMachineId: machine.id, encryptionMode: 'plain',
        logger: () => {}, authorizeRequest: async () => ({ ok: true }) });
    registerDaemonMachineAgentIsolationRpcHandlers(rpc, {
        target: () => ({ serverId: 'home', machineId: machine.id, installationId: 'guest-installation', custodianAccountId: 'owner' }),
        read: () => readAgentIsolationSnapshot({ metadata: readOpenedMachineMetadataSnapshot(machine, true),
            daemonState: machine.daemonState, runtimeId: 'daemon', platform: 'linux' }),
        captureMetadataPort: () => port, effects: native.effects,
    });
    const executor = createActionExecutor({ machineAgentIsolationAction: async ({ actionId, input }) => rpc.invokeLocal(actionId, input, {
        rpcContext: { signal: new AbortController().signal, callerAuthority: 'present_user',
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: machine.id,
                installationId: 'guest-installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true },
    }) });
    const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
        generateOperationId: () => 'bootstrap-conflict' });
    const details = { kind: 'managedAgentIsolation', phase: 'machines.agentIsolation.set', code: 'conflict',
        expectedMetadataVersion: 4, metadataVersion: 5, expectedPolicy: { enabled: false }, policy: { enabled: false } };
    await expect(operations.observeExecution({ actionId: 'machines.managed.bootstrap.retry',
        input: { homeId: 'home', managedId: 'managed' }, actionRequestId: 'retry', execute: async () => {
            await applyManagedMachineEnrollmentIsolation({ target: { serverId: 'home', machineId: machine.id }, policy: { enabled: true },
                dispatch: async request => {
                    const result = await executor.execute(request.actionId, request.input, { surface: 'ui', authority: 'present_user',
                        serverId: 'home', runtimeAccountId: 'owner', actionCaller: { kind: 'host' }, actionRequestId: 'isolation' });
                    if (!result.ok) throw new Error(result.errorCode);
                    if (request.actionId === 'machines.agentIsolation.preview') {
                        // A real unrelated startup publication lands between review and Set admission.
                        await port.compareAndSwap({ expectedMetadataVersion: machine.metadataVersion,
                            metadata: { ...machine.metadata!, happyCliVersion: 'refreshed' } });
                    }
                    return result.result;
                } });
            return { ok: true, result: {} };
        } })).rejects.toMatchObject({ code: 'conflict', details });
    expect(await operations.handlers.getV2({ operationId: 'bootstrap-conflict', waitForTerminal: true }))
        .toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'conflict', details } } });
    expect(machine.metadata?.agentIsolation).toBeUndefined();
    expect(native.mutations).toEqual([]);
    expect(native.launches).toEqual([]);
});
