import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD,
    ManagedActivityBridgeResultV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { callSocketRpc, issueSocketRpcCallWithCancellation } from '@happier-dev/sync-client';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createExternalActionMachineRpcExecution } from '@/api/externalActionExecutionAuthorization';
import { withUserScopedRpcSocket } from '@/session/transport/rpc/withUserScopedRpcSocket';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { ManagedMachineControllerError } from './controllerErrors';
import type { ManagedMachineAcquisitionDriverInput, ManagedMachineExecutionOptions } from './acquire';
import type { ManagedGuestActivityTransport } from './managedIntentReconciler';

type ActivityObserver = Readonly<{
    machineId: ManagedMachineFullV1['enrolledMachineId'];
    attached: () => void;
    changed: () => void;
    failed: (error: unknown) => void;
}>;

type ActivityConnection = {
    socket?: Parameters<typeof callSocketRpc>[0]['socket'];
    observers: Set<ActivityObserver>;
    stop: () => Promise<void>;
};

const connectionsByEnvironment = new WeakMap<NodeJS.ProcessEnv, Map<string, ActivityConnection>>();

function subscribeGuestActivityConnection(input: Pick<ManagedMachineAcquisitionDriverInput, 'token' | 'serverUrl'>, observer: ActivityObserver) {
    const environment = sessionProcessEnvironment();
    let connections = connectionsByEnvironment.get(environment);
    if (!connections) {
        connections = new Map();
        connectionsByEnvironment.set(environment, connections);
    }
    const serverUrl = normalizeServerHttpBaseUrl(input.serverUrl);
    const key = `${serverUrl}\n${input.token}`;
    let connection = connections.get(key);
    if (!connection) {
        const owner = connections;
        const lifetime = new AbortController();
        const active: ActivityConnection = { observers: new Set(), stop: async () => {
            if (owner.get(key) === active) owner.delete(key);
            lifetime.abort();
            await pump;
        } };
        owner.set(key, active);
        const pump = withUserScopedRpcSocket({ token: input.token, serverUrl,
            connectTimeoutMs: resolveSessionControlSocketConnectTimeoutMs(), signal: lifetime.signal,
            reattachOnReconnect: true,
        }, async (socket, connect, signal) => {
            await connect();
            signal?.throwIfAborted();
            const onUpdate = (update: unknown) => {
                const parsed = UpdateContainerSchema.safeParse(update);
                if (!parsed.success || parsed.data.body.t !== 'update-machine') return;
                const machineId = parsed.data.body.machineId;
                for (const guest of active.observers) {
                    if (guest.machineId === machineId) guest.changed();
                }
            };
            socket.on('update', onUpdate);
            active.socket = socket;
            try {
                for (const guest of active.observers) guest.attached();
                await new Promise<void>(resolve => {
                    signal?.addEventListener('abort', () => resolve(), { once: true });
                });
            } finally {
                if (active.socket === socket) active.socket = undefined;
                socket.off('update', onUpdate);
            }
        }).catch(error => {
            if (owner.get(key) === active) owner.delete(key);
            for (const guest of active.observers) guest.failed(error);
        });
        connection = active;
    }
    const active = connection;
    active.observers.add(observer);
    if (active.socket) observer.attached();
    return {
        get socket() { return active.socket; },
        async dispose() {
            if (active.observers.delete(observer) && active.observers.size === 0) await active.stop();
        },
    };
}

/** Only this retained row and the exact guest can invalidate its activity observation. */
export function createManagedGuestActivityTransport(input: Pick<ManagedMachineAcquisitionDriverInput, 'token' | 'serverUrl' | 'credentials' | 'externalActionMachineRequestPrivateKey' | 'subscribeManagedMachineChanges'>, options: ManagedMachineExecutionOptions, machine: ManagedMachineFullV1): ManagedGuestActivityTransport {
    // Home derives the guest scope from the current admitted retained row;
    // the admitted Machine signs that exact destination with the original root.
    const authorization = options.context?.externalActionExecutionAuthorization;
    const target = options.context?.externalActionTarget;
    if (options.context?.externalActionCredential && !authorization || authorization && (
        !input.externalActionMachineRequestPrivateKey || !target || target.kind !== 'machine'
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
    let changed: false | 'activity' = false;
    let failure: unknown;
    let wake: (() => void) | undefined;
    const activityChanged = () => { changed = 'activity'; wake?.(); };
    const unsubscribeManagedChanges = input.subscribeManagedMachineChanges?.(change => {
        if (change?.kind !== 'managed' || !change.managedIds.includes(machine.id)) return;
        activityChanged();
    });
    let ready!: () => void;
    let rejectReady!: (error: unknown) => void;
    const connected = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
    // Readiness starts eagerly, but a refused preparation may dispose without
    // a reader. Observe that rejection while preserving it for awaited reads.
    void connected.catch(() => {});
    // This bridge retains its connection subscription through exact drain cleanup.
    const fail = (error: unknown) => { failure = error; rejectReady(error); wake?.(); };
    const connection = subscribeGuestActivityConnection(input, { machineId,
        attached: () => { activityChanged(); ready(); }, changed: activityChanged, failed: fail,
    });
    const waitUntilConnected = (signal?: AbortSignal) => issueSocketRpcCallWithCancellation({ signal, issue: () => connected });
    const request = (current: ManagedMachineFullV1) => ({ homeId: current.homeId, managedId: current.id,
        expectedRevision: current.intentRevision, ...(current.controller ? { controller: current.controller } : {}) });
    const call = async (method: string, params: unknown, signal?: AbortSignal, signed = true) => {
        await waitUntilConnected(signal);
        if (failure) throw failure;
        const rpcSocket = connection.socket;
        if (!machineId || !rpcSocket) throw new ManagedMachineControllerError('admission_unavailable');
        const result = await callSocketRpc({ socket: rpcSocket,
            target: { kind: 'machine', id: machineId }, method, params, content: { mode: 'plain' },
            timeoutMs: null, ...(signal ? { signal } : {}),
            ...(signed && externalAction ? { createExternalActionExecution: (request) => {
                const execution = createExternalActionMachineRpcExecution({ ...externalAction, ...request });
                if (!execution) throw new ManagedMachineControllerError('admission_unavailable');
                return execution;
            } } : {}),
        });
        return ManagedActivityBridgeResultV1Schema.parse(readMachineActionRpcResult(result));
    };
    const read = async (current: ManagedMachineFullV1, signal = options.signal) => {
        if (!machineId) throw new ManagedMachineControllerError('admission_unavailable');
        await waitUntilConnected(signal);
        if (failure) throw failure;
        // Subscription precedes this read. An edge during the RPC remains
        // latched, preventing a lost busy→idle notification before the wait.
        changed = false;
        return call(MANAGED_ACTIVITY_READ_RPC_METHOD, request(current), signal);
    };
    const drain = async (current: ManagedMachineFullV1, action: 'begin' | 'resume', signal = options.signal) => {
        if (!machineId) throw new ManagedMachineControllerError('admission_unavailable');
        // Release retains only this exact drain after its original Action retires.
        return call(MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, { ...request(current), action },
            action === 'begin' ? signal : undefined, action === 'begin');
    };
    return {
        read, confirmIdle: (current, signal) => drain(current, 'begin', signal),
        reopen: current => drain(current, 'resume'),
        waitForChange: async (signal = options.signal) => {
            await waitUntilConnected(signal);
            signal?.throwIfAborted();
            if (failure) throw failure;
            if (changed) { const result = changed; changed = false; return result; }
            return await new Promise<'activity'>((resolve, reject) => {
                const onAbort = () => { cleanup(); reject(signal?.reason); };
                const cleanup = () => { wake = undefined; signal?.removeEventListener('abort', onAbort); };
                wake = () => {
                    cleanup();
                    if (failure) reject(failure);
                    else {
                        const result = changed || 'activity';
                        changed = false;
                        resolve(result);
                    }
                };
                signal?.addEventListener('abort', onAbort, { once: true });
                if (signal?.aborted) onAbort();
                else if (changed || failure) wake();
            });
        },
        dispose: async () => {
            unsubscribeManagedChanges?.();
            fail(new DOMException('RPC observation cancelled', 'AbortError'));
            await connection.dispose();
        },
    };
}
