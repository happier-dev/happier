import type { RpcHandlerConfig } from '@/api/rpc/types';
import type { StoredCredentials } from '@/persistence';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { isHostRequesterUnrestrictedOwner, selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { createCurrentMachineExecutionOriginContextResolver, type CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';

/** The Session transport owns its receiver. Incoming actor authority comes only
 * from Home's exact physical receipt, never from the runner's own Account. */
export function createSessionRpcAuthorization(input: Readonly<{
    sessionId: string;
    localMachineId?: string | null;
    serverUrl: string;
    isClosed(): boolean;
    readHomeServerIdentityId(): string | null | undefined;
    readOwnerCredentials(): Promise<StoredCredentials | null>;
}>): NonNullable<RpcHandlerConfig['authorizeRequest']> {
    return async request => {
        const { callerInputAuthorization: authorization, signal } = request;
        const unavailable = { ok: false, error: 'Requester execution protection is unavailable', errorCode: 'agent_isolation_unavailable' } as const;
        const prefix = `${input.sessionId}:`;
        const method = request.method.startsWith(prefix) ? request.method.slice(prefix.length) : request.method;
        let verifiedRawOrigin: CurrentMachineExecutionOriginContext | undefined;
        if (resolveMachineRpcRoutePolicy(method).requesterExecutionIsolationRequired === true) {
            try {
                const home = input.readHomeServerIdentityId() ?? null;
                const receipt = request.machineAdmission;
                const currentBinding = () => !input.isClosed() && !signal?.aborted && !!home
                    && input.readHomeServerIdentityId() === home && !!input.localMachineId
                    && receipt?.machineId === input.localMachineId;
                const verifyCurrent = async () => {
                    if (!currentBinding() || !receipt) return false;
                    const installation = readInstallationIdentityIfExistsSync();
                    if (!installation || installation.installationId !== receipt.installationId) return false;
                    const credentials = await input.readOwnerCredentials();
                    if (!credentials || !currentBinding()) return false;
                    const current = await verifyMachineRpcAdmissionCurrent({ context: receipt,
                        purpose: { kind: 'requester_session_currentness', sessionId: input.sessionId },
                        privateKey: installation.privateKey, daemonToken: credentials.token,
                        serverHttpBaseUrl: input.serverUrl, ...(signal ? { signal } : {}) });
                    return current && currentBinding()
                        && readInstallationIdentityIfExistsSync()?.installationId === installation.installationId;
                };
                const identity = selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: home,
                    actionContext: { authority: request.callerAuthority, machineAdmission: receipt,
                        callerInputAuthorization: authorization, sessionActionOrigin: request.sessionActionOrigin,
                        localActionContext: request.localActionContext, inheritedLocalActionContext: request.inheritedLocalActionContext,
                        requesterSessionBootstrap: request.requesterSessionBootstrap,
                        verifyMachineAdmissionCurrent: verifyCurrent, signal } });
                if (!isHostRequesterUnrestrictedOwner(identity) || !await verifyCurrent()) return unavailable;
                verifiedRawOrigin = { machineId: input.localMachineId!, serverIdentityId: home! };
            } catch { return unavailable; }
        }
        // API roots retain only their verified principal and captured grant,
        // never Account custody. Preserve their existing exact-root check.
        if (!authorization || !('grant' in authorization.binding) || authorization.requesterAccountContext) return { ok: true };
        try {
            const installation = readInstallationIdentityIfExistsSync();
            const origin = verifiedRawOrigin ?? await createCurrentMachineExecutionOriginContextResolver({
                serverUrl: input.serverUrl, resolveCurrentMachineId: () => input.isClosed() ? null : input.localMachineId ?? null,
            })(signal);
            const binding = authorization.binding;
            if (input.isClosed() || signal?.aborted || !installation || !origin
                || installation.installationId !== binding.installationId
                || origin.machineId !== binding.machineId || origin.serverIdentityId !== binding.serverIdentityId
                || !await verifyExternalActionExecutionAuthorizationCurrent({ authorization,
                    effectActionId: binding.actionId, target: binding.target, installationId: installation.installationId,
                    privateKey: installation.privateKey, serverHttpBaseUrl: input.serverUrl,
                    ...(signal ? { signal } : {}) })) return { ok: false, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' };
            return { ok: true };
        } catch { return { ok: false, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' }; }
    };
}
