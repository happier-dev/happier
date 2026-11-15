import type { RpcHandlerConfig } from '@/api/rpc/types';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { isHostRequesterUnrestrictedOwner, selectHostRequesterExecutionIdentity, type HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { createCurrentMachineExecutionOriginContextResolver, type CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { projectActionFailureCauseV1, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SessionAttachmentRequester } from '@/rpc/handlers/fileSystem/sessionAttachmentIntake';
import { SessionTransferRpcMethodV1Schema } from '@happier-dev/protocol/socketRpc';

type SessionRpcAuthorizationRefusal = 'closed' | 'aborted' | 'installation_missing' | 'origin_unavailable'
    | 'installation_mismatch' | 'machine_mismatch' | 'home_mismatch' | 'currentness_rejected';
type SessionRpcExecutionUnavailableReason = SessionRpcAuthorizationRefusal
    | Extract<HostRequesterExecutionIdentity, { kind: 'unknown' }>['reason']
    | 'unrestricted_owner_required' | 'home_unavailable' | 'home_changed' | 'machine_missing'
    | 'requester_execution_unavailable';

function forbidden(reason: SessionRpcAuthorizationRefusal) {
    const failureCause: ActionFailureCauseV1 = { phase: `session.rpc.authorization.${reason}`,
        errorClass: 'Error', errorCode: 'RPC_FORBIDDEN', httpStatus: null };
    return { ok: false, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN', failureCause } as const;
}

function executionUnavailable(reason: SessionRpcExecutionUnavailableReason, failureCause?: ActionFailureCauseV1) {
    return { ok: false, error: 'Requester execution protection is unavailable', errorCode: 'agent_isolation_unavailable',
        effectAttempted: false, failureCause: failureCause ?? { phase: `session.rpc.authorization.${reason}`,
            errorClass: 'Error', errorCode: null, httpStatus: null } satisfies ActionFailureCauseV1 } as const;
}

/** The Session transport owns its receiver. Incoming actor authority comes only
 * from Home's exact physical receipt, never from the runner's own Account. Home
 * mints that receipt per relayed RPC immediately after its own Machine admission
 * (`protectedRawSessionTargetGuard`), and it reaches this receiver only over the
 * authenticated Home socket or the daemon's peer-admitted local channel, so the
 * receiver checks the receipt against its own binding and never re-proves it. */
export function createSessionRpcAuthorization(input: Readonly<{
    sessionId: string;
    localMachineId?: string | null;
    serverUrl: string;
    isClosed(): boolean;
    readHomeServerIdentityId(): string | null | undefined;
    /** Native attachment custody survives release of the launching runtime. */
    readSessionAttachmentRequester?(method: string): SessionAttachmentRequester | null | undefined;
}>): NonNullable<RpcHandlerConfig['authorizeRequest']> {
    return async (request, source) => {
        const { callerInputAuthorization: authorization, signal } = request;
        const prefix = `${input.sessionId}:`;
        const method = request.method.startsWith(prefix) ? request.method.slice(prefix.length) : request.method;
        let verifiedRawOrigin: CurrentMachineExecutionOriginContext | undefined;
        if (resolveMachineRpcRoutePolicy(method).requesterExecutionIsolationRequired === true) {
            try {
                const home = input.readHomeServerIdentityId() ?? null;
                const receipt = request.machineAdmission;
                let currentnessRefusal: SessionRpcExecutionUnavailableReason = 'currentness_rejected';
                const refuseCurrent = (reason: SessionRpcExecutionUnavailableReason) => {
                    currentnessRefusal = reason;
                    return false;
                };
                const currentBinding = () => {
                    if (input.isClosed()) return refuseCurrent('closed');
                    if (signal?.aborted) return refuseCurrent('aborted');
                    if (!home) return refuseCurrent('home_unavailable');
                    if (input.readHomeServerIdentityId() !== home) return refuseCurrent('home_changed');
                    if (!input.localMachineId) return refuseCurrent('machine_missing');
                    if (receipt?.machineId !== input.localMachineId) return refuseCurrent('machine_mismatch');
                    return true;
                };
                const verifyCurrent = async () => {
                    if (!currentBinding() || !receipt) return false;
                    const installation = readInstallationIdentityIfExistsSync();
                    if (!installation) return refuseCurrent('installation_missing');
                    if (installation.installationId !== receipt.installationId) return refuseCurrent('installation_mismatch');
                    return true;
                };
                const attachmentRequester = source === 'authenticated_home_socket' && request.method.startsWith(prefix)
                    && SessionTransferRpcMethodV1Schema.safeParse(method).success
                    ? input.readSessionAttachmentRequester?.(method) : undefined;
                // Explicitly withheld native custody cannot fall back to raw
                // owner authority to begin a new upload after runtime release.
                if (attachmentRequester === null) return executionUnavailable('unrestricted_owner_required');
                if (attachmentRequester) {
                    if (!currentBinding()) return executionUnavailable(currentnessRefusal);
                    const installation = readInstallationIdentityIfExistsSync();
                    if (!installation) return executionUnavailable('installation_missing');
                    const requester = attachmentRequester.identity.requester;
                    if (attachmentRequester.sessionId !== input.sessionId
                        || attachmentRequester.homeServerIdentityId !== home
                        || requester.accountId !== receipt?.actorAccountId
                        || requester.machineId !== input.localMachineId
                        || requester.installationId !== installation.installationId
                        || installation.installationId !== receipt?.installationId) {
                        return executionUnavailable('session_requester_unavailable');
                    }
                    // Home authorized this exact Session phase. The native attachment
                    // owner retains its workspace and handles; do not re-admit per chunk.
                } else {
                    const identity = selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: home,
                        actionContext: { authority: request.callerAuthority, machineAdmission: receipt,
                            callerInputAuthorization: authorization, sessionActionOrigin: request.sessionActionOrigin,
                            localActionContext: request.localActionContext, inheritedLocalActionContext: request.inheritedLocalActionContext,
                            requesterSessionBootstrap: request.requesterSessionBootstrap,
                            verifyMachineAdmissionCurrent: verifyCurrent, signal } });
                    if (!isHostRequesterUnrestrictedOwner(identity)) return executionUnavailable(identity.kind === 'unknown'
                        ? identity.reason : 'unrestricted_owner_required');
                    if (!await verifyCurrent()) return executionUnavailable(currentnessRefusal);
                }
                verifiedRawOrigin = { machineId: input.localMachineId!, serverIdentityId: home! };
            } catch (error) {
                return executionUnavailable('requester_execution_unavailable',
                    projectActionFailureCauseV1(error, 'session.rpc.authorization.requester_execution_unavailable'));
            }
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
            if (input.isClosed()) return forbidden('closed');
            if (signal?.aborted) return forbidden('aborted');
            if (!installation) return forbidden('installation_missing');
            if (!origin) return forbidden('origin_unavailable');
            if (installation.installationId !== binding.installationId) return forbidden('installation_mismatch');
            if (origin.machineId !== binding.machineId) return forbidden('machine_mismatch');
            if (origin.serverIdentityId !== binding.serverIdentityId) return forbidden('home_mismatch');
            if (!await verifyExternalActionExecutionAuthorizationCurrent({ authorization,
                    effectActionId: binding.actionId, target: binding.target, installationId: installation.installationId,
                    privateKey: installation.privateKey, serverHttpBaseUrl: input.serverUrl,
                    ...(signal ? { signal } : {}) })) return forbidden('currentness_rejected');
            return { ok: true };
        } catch (error) {
            if (signal?.aborted) return forbidden('aborted');
            return { ok: false, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN',
                failureCause: projectActionFailureCauseV1(error, 'session.rpc.authorization.unavailable') };
        }
    };
}
