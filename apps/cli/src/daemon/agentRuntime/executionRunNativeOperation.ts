import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { isHostRequesterUnrestrictedOwner, resolveHostRequesterAgentExecutionIdentity,
    resolveHostRequesterAgentPlacementForHost, type HostAgentIsolationLaunchContext,
    type HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { resolveAgentLaunchNativeEnvironment } from '@/daemon/agentIsolation/agentLaunchRuntime';
import type { AgentLaunchOperationMaterialization } from '@/daemon/agentIsolation/agentLaunchMaterials';

type PreparedNativeOperation = Awaited<ReturnType<ApiMachineClient['prepareNativeOperation']>>;
/** Direct placement retains requester custody without inventing OS material. */
export type ExecutionRunNativeOperation = Readonly<{ signal: AbortSignal }> & (PreparedNativeOperation
    | (Pick<PreparedNativeOperation, 'requesterIdentity' | 'agentIsolation' | 'workingDirectory' | 'dispose'>
        & Readonly<{ memberIdentity?: undefined; materialTarget?: undefined }>));

export type ExecutionRunNativeOperationOwner = {
    prepareNativeOperation(cwd: string, signal: AbortSignal, correlationId: string): Promise<ExecutionRunNativeOperation | undefined>;
    disposeNativeOperation(): Promise<void>;
};

/** The captured Run owns one native operation; its Account attribution remains with the Run. */
export function createExecutionRunNativeOperationOwner(input: Readonly<{
    machine: Pick<ApiMachineClient, 'prepareNativeOperation' | 'readMemberFolderOwner'>;
    agentIsolation: HostAgentIsolationLaunchContext;
    ingress: RpcHandlerContext;
    resolveRequesterIdentity(): Promise<HostRequesterExecutionIdentity>;
}>): ExecutionRunNativeOperationOwner {
    const lifetime = new AbortController();
    let pending: Promise<ExecutionRunNativeOperation | undefined> | undefined;
    return {
        prepareNativeOperation(cwd: string, signal: AbortSignal, correlationId: string) {
            signal.throwIfAborted();
            lifetime.signal.throwIfAborted();
            return pending ??= (async () => {
                const cancelPreparation = () => lifetime.abort(signal.reason);
                signal.addEventListener('abort', cancelPreparation, { once: true });
                try {
                    const requester = await input.resolveRequesterIdentity();
                    let identity = resolveHostRequesterAgentExecutionIdentity(requester);
                    if (identity.kind !== 'isolated') throw new PluginError({ code: 'agent_isolation_unavailable',
                        message: 'Run native execution identity is unavailable' });
                    const placement = resolveHostRequesterAgentPlacementForHost({ identity, snapshot: input.agentIsolation.read() });
                    if (placement === 'daemon') return {
                        requesterIdentity: identity, workingDirectory: cwd, signal: lifetime.signal,
                        agentIsolation: { ...input.agentIsolation, requesterIdentity: identity, resolveRequesterIdentity: undefined },
                        async dispose() {},
                    };
                    if (isHostRequesterUnrestrictedOwner(requester)) {
                        const folderOwner = await input.machine.readMemberFolderOwner(cwd);
                        // The launch carries the requester's own secrets; under another person's
                        // OS account that person could read them. Their folder runs only as them.
                        if (folderOwner && (folderOwner.requester.serverId !== identity.requester.serverId
                            || folderOwner.requester.accountId !== identity.requester.accountId)) {
                            throw new PluginError({ code: 'credential_scope_denied', retryable: false,
                                message: "A Run cannot use your credentials in another person's member folder" });
                        }
                        identity = folderOwner ?? identity;
                    }
                    signal.throwIfAborted();
                    let material: AgentLaunchOperationMaterialization | undefined;
                    const prepared = await input.machine.prepareNativeOperation({ requesterIdentity: identity,
                        ingress: { ...input.ingress, signal: lifetime.signal }, signal: lifetime.signal,
                        allowMemberPreparation: false,
                        readMaterial: native => material ??= ({ materializationKey: correlationId,
                            environment: resolveAgentLaunchNativeEnvironment(native.home), selectedMaterials: [] }),
                    });
                    return { ...prepared, signal: lifetime.signal };
                } finally { signal.removeEventListener('abort', cancelPreparation); }
            })();
        },
        async disposeNativeOperation() {
            lifetime.abort();
            if (!pending) return;
            // A rejected preparation supplied no material to dispose. Its
            // caller still owns the typed refusal and the Start receipt.
            try { await (await pending.catch(() => undefined))?.dispose(); }
            finally { pending = undefined; }
        },
    };
}
