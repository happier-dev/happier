import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD,
    ManagedActivityBridgeResultV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { withUserScopedRpcSocket } from '@/session/transport/rpc/withUserScopedRpcSocket';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { ManagedMachineControllerError, type ManagedMachineAcquisitionDriverInput, type ManagedMachineExecutionOptions } from './acquire';
import type { ManagedGuestActivityTransport } from './managedIntentReconciler';

/** The Account socket invalidates observations; only the exact guest RPC decides activity. */
export function createManagedGuestActivityTransport(input: Pick<ManagedMachineAcquisitionDriverInput, 'token' | 'serverUrl' | 'credentials' | 'externalActionMachineRequestPrivateKey'>, options: ManagedMachineExecutionOptions, machine: ManagedMachineV1): ManagedGuestActivityTransport {
    // Home derives the guest scope from the current admitted retained row;
    // the controller signs that exact destination with the original root.
    const authorization = options.context?.externalActionExecutionAuthorization;
    const target = options.context?.externalActionTarget;
    if (options.context?.externalActionCredential && !authorization || authorization && (
        !input.externalActionMachineRequestPrivateKey || !target || target.kind !== 'machine'
        || target.machineId !== machine.controller.machineId
        || authorization.binding.target.kind !== 'machine' || authorization.binding.target.machineId !== target.machineId
        || authorization.binding.serverIdentityId !== machine.homeId
        || authorization.binding.custodianAccountId !== machine.custodianAccountId
        || authorization.binding.machineId !== machine.controller.machineId
        || authorization.binding.installationId !== machine.controller.installationId
        || authorization.binding.requestId !== options.requestId
        || machine.desiredWhen !== 'after-idle'
        || !(authorization.binding.actionId === 'machines.managed.power.set' && machine.desired === 'stop'
            || authorization.binding.actionId === 'machines.managed.delete' && machine.desired === 'delete')
    )) {
        throw new ManagedMachineControllerError('admission_unavailable');
    }
    const externalAction = authorization && input.externalActionMachineRequestPrivateKey ? {
        // Activity is content-free. Requester Account custody must not be
        // projected or sealed to the guest just to observe its activity.
        context: { ...options.context, externalActionExecutionAuthorization: {
            v: authorization.v, token: authorization.token, binding: authorization.binding,
        } },
        effectActionId: authorization.binding.actionId,
        installationId: authorization.binding.installationId,
        privateKey: input.externalActionMachineRequestPrivateKey,
    } : undefined;
    const machineId = machine.enrolledMachineId;
    let changed = false;
    let failure: unknown;
    let wake: (() => void) | undefined;
    let ready!: () => void;
    let rejectReady!: (error: unknown) => void;
    const connected = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
    let close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    const lifetime = new AbortController();
    const onAbort = () => lifetime.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const pump = withUserScopedRpcSocket({ token: input.token, serverUrl: input.serverUrl,
        connectTimeoutMs: resolveSessionControlSocketConnectTimeoutMs(), signal: lifetime.signal,
        reattachOnReconnect: true, disconnectMessage: 'Managed activity observation disconnected',
    }, async (socket, connect, attemptSignal) => {
        const onUpdate = (update: unknown) => {
            const parsed = UpdateContainerSchema.safeParse(update);
            // Managed mutations already publish the Account catch-up cursor;
            // it contains no entity payload. Re-read currentness on that edge.
            if (parsed.success && (parsed.data.body.t === 'account-change'
                || (parsed.data.body.t === 'update-machine' && parsed.data.body.machineId === machineId))) {
                changed = true;
                wake?.();
            }
        };
        socket.on('update', onUpdate);
        let onDisconnect = () => {};
        const disconnected = new Promise<never>((_resolve, reject) => {
            onDisconnect = () => reject(attemptSignal?.reason);
            attemptSignal?.addEventListener('abort', onDisconnect, { once: true });
        });
        try {
            await connect();
            // Reconnect is also an invalidation, not a stale cached decision.
            changed = true;
            wake?.();
            ready();
            await Promise.race([closed, disconnected]);
        } finally {
            socket.off('update', onUpdate);
            attemptSignal?.removeEventListener('abort', onDisconnect);
        }
    }).catch(error => { failure = error; rejectReady(error); wake?.(); });
    const request = (current: ManagedMachineV1) => ({ homeId: current.homeId, managedId: current.id,
        expectedRevision: current.intentRevision, controller: current.controller });
    const read = async (current: ManagedMachineV1, signal?: AbortSignal) => {
        if (!machineId) throw new ManagedMachineControllerError('admission_unavailable');
        await connected;
        if (failure) throw failure;
        // Subscription precedes this read. An edge during the RPC remains
        // latched, preventing a lost busy→idle notification before the wait.
        changed = false;
        return ManagedActivityBridgeResultV1Schema.parse(await callExactMachineRpc({ credentials: input.credentials,
            serverUrl: input.serverUrl, machineId, method: MANAGED_ACTIVITY_READ_RPC_METHOD,
            request: request(current), requireCurrentMachine: true, timeoutMs: null, reattachOnReconnect: true, signal,
            ...(externalAction ? { externalAction } : {}),
        }));
    };
    const drain = async (current: ManagedMachineV1, action: 'begin' | 'resume', signal?: AbortSignal) => {
        if (!machineId) throw new ManagedMachineControllerError('admission_unavailable');
        return ManagedActivityBridgeResultV1Schema.parse(await callExactMachineRpc({ credentials: input.credentials,
            serverUrl: input.serverUrl, machineId, method: MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD,
            request: { ...request(current), action }, requireCurrentMachine: true,
            // Cleanup may outlive cancellation/credential retirement. The
            // guest's incumbent drain owner releases only this exact target;
            // read and begin never borrow this ordinary custodian admission.
            ...(action === 'begin' ? { timeoutMs: null, signal, ...(externalAction ? { externalAction } : {}) } : {}),
        }));
    };
    return {
        read, confirmIdle: (current, signal) => drain(current, 'begin', signal),
        reopen: current => drain(current, 'resume'),
        waitForChange: async signal => {
            await connected;
            signal?.throwIfAborted();
            if (failure) throw failure;
            if (changed) { changed = false; return; }
            await new Promise<void>((resolve, reject) => {
                const onAbort = () => { cleanup(); reject(signal?.reason); };
                const cleanup = () => { wake = undefined; signal?.removeEventListener('abort', onAbort); };
                wake = () => { cleanup(); failure ? reject(failure) : resolve(); };
                signal?.addEventListener('abort', onAbort, { once: true });
                if (signal?.aborted) onAbort();
                else if (changed || failure) wake();
            });
        },
        dispose: async () => {
            close(); lifetime.abort();
            options.signal?.removeEventListener('abort', onAbort);
            await pump;
        },
    };
}
