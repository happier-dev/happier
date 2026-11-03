import { supportsMachineOperationProtocolCapabilityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { resolveMachineRpcExternalActionEffectV1, resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { SESSION_LIFECYCLE_ACTION_SPECS } from '@happier-dev/protocol/actions/actionSpecs';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionRequiredAuthority } from '@happier-dev/protocol/actions/metadata';
import type { SessionActionRpcOriginV1 } from '@happier-dev/protocol/socketRpc';

/** Existing Home-verified invocation facts; never RPC body identity claims. */
export type MachineOperationRequesterContext = Readonly<{
    callerAuthority: ActionRequiredAuthority;
    sessionActionOrigin?: SessionActionRpcOriginV1;
    executionBinding?: ExternalActionExecutionAuthorizationV1['binding'];
}>;

// Project and Session owners admit these exact typed native payloads. Derive
// primary methods and aliases from their existing contracts, not raw names.
const nativePayloadMethods = new Set<string>([
    ...Object.values(PROJECT_FINITE_ACTION_RPC_METHODS_V1),
    ...SESSION_LIFECYCLE_ACTION_SPECS.flatMap(spec => {
        const bindings = spec.bindings;
        return [bindings && 'rpcMethod' in bindings ? bindings.rpcMethod : undefined,
            ...(bindings && 'rpcMethodAliases' in bindings ? bindings.rpcMethodAliases ?? [] : [])];
    })
        .filter((method): method is string => typeof method === 'string' && method.length > 0),
]);

/** Operation support is independent of grants and reviewed composite-effect custody. */
export function isMachineOperationSupportedForRequester(input: Readonly<{
    actorAccountId: string;
    machine: Readonly<{
        accountId: string;
        operationProtocolCapabilities: unknown;
        operationProtocolCapabilitiesRevision: unknown;
        id?: string;
        installationId?: string | null;
    }>;
    rpcMethod?: string;
    actionId?: string;
}> & Partial<MachineOperationRequesterContext>): boolean {
    // This compatibility capability protects non-owner requester dispatch.
    // Ownership is not person authority: owner automation retains its verified
    // source and the receiving operation's existing approval/custody policy.
    if (input.actorAccountId === input.machine.accountId) {
        const rawSessionDeputy = input.sessionActionOrigin !== undefined && input.rpcMethod !== undefined
            && resolveMachineRpcRoutePolicy(input.rpcMethod).requesterExecutionIsolationRequired === true
            && !nativePayloadMethods.has(input.rpcMethod);
        if (!rawSessionDeputy) return true;
        // Private native children spend the already verified original root.
        // A raw resume-looking method never establishes that proof on its own.
        const nativeChild = input.rpcMethod && input.executionBinding && input.machine.id && input.machine.installationId
            ? resolveMachineRpcExternalActionEffectV1(input.rpcMethod, input.executionBinding,
                { machineId: input.machine.id, installationId: input.machine.installationId }) : null;
        if (nativeChild === 'session.spawn_new' || nativeChild === 'session.agent.transition') return true;
    }
    const protectedOperation = input.actionId === 'session.spawn_new' || input.actionId === 'session.open'
        || input.rpcMethod !== undefined
            && resolveMachineRpcRoutePolicy(input.rpcMethod).requesterExecutionIsolationRequired === true;
    return !protectedOperation || typeof input.machine.operationProtocolCapabilitiesRevision === 'number'
        && Number.isInteger(input.machine.operationProtocolCapabilitiesRevision)
        && input.machine.operationProtocolCapabilitiesRevision > 0
        && supportsMachineOperationProtocolCapabilityV1(input.machine.operationProtocolCapabilities, 'requesterExecutionIsolation');
}
