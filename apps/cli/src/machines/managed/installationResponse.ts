import { callSocketRpc } from '@happier-dev/sync-client';
import { approveManagedMachineEnrollment, respondToManagedInstallation } from '@happier-dev/protocol/machines/managed/installationResponse';
import { ManagedAcceptedV1Schema, ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { readManagedInstallationPromptSnapshot } from '@happier-dev/protocol/machines/managed/installationPrompt';
import { ACTION_OPERATION_GET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/operations/actionIdsV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { RequesterOperationRequestV1 } from '@happier-dev/protocol/actions/operations/requesterReadV1';
import { unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { isPresentUserHostInvocation } from '@happier-dev/protocol/actions/invocationAuthority';
import { ActionOperationGetV1ResponseSchema, ACTION_OPERATION_RPC_METHODS_V2, readActionOperationTerminalResultV1 } from '@happier-dev/protocol/actions/operations/v1';
import { parseCapabilitiesInvokeResponse } from '@happier-dev/protocol/capabilities/invokeResponse';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { hasStoredSessionCredentialProvenance, type StoredCredentials } from '@/persistence';
import { readManagedMachine, readManagedMachineRead, openManagedMachineRead } from '@/machines/managed/readManagedMachine';
import { decodeJwtPayload, readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { withUserScopedRpcSocket } from '@/session/transport/rpc/withUserScopedRpcSocket';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { approveTerminalAuthRequest } from '@/auth/terminalAuthApproval';
import { observeServerProfileHomeConnection } from '@/server/profileObservation';
import { logger } from '@/ui/logger';

/** A command-line invocation is itself an answering client; no App or daemon acquires its credential custody. */
export function createCliManagedInstallationRespond(params: Readonly<{
    credentials: StoredCredentials; serverId: string; serverIdentityId?: string; serverUrl: string;
    /** The acquire this daemon admitted: it may answer that operation's guest sign-in and nothing else. */
    admittedAcquire?: Readonly<{ homeId: string; managedId: string; operationId: string }>;
}>): NonNullable<ActionExecutorDeps['machineManagedInstallationRespond']> {
    return async (input, context) => {
        const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
        const scope = (id: string) => id === params.serverId || id === params.serverIdentityId ? params.serverId : null;
        if (!areServerProfileIdentifiersEquivalent(input.serverId, params.serverId, scope)
            || context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, params.serverId, scope)) return fail('server_target_mismatch');
        const accountId = readAccountIdFromToken(params.credentials.token);
        if (!accountId) return fail('action_account_scope_changed');
        const invoke = async (machineId: string, method: string, request: unknown, signal?: AbortSignal) =>
            callExactMachineRpc({ credentials: params.credentials, serverUrl: params.serverUrl,
                machineId, method, request, timeoutMs: null, ...(signal ? { signal } : {}) });
        const parseResponse = (raw: unknown) => parseCapabilitiesInvokeResponse(raw)
            ?? { ok: false as const, error: { code: 'managed_response_invalid', message: 'Invalid managed installation response' } };
        const provenance = readAuthTokenProvenance(decodeJwtPayload(params.credentials.token), { allowLegacyHome: true })?.provenance;
        const terminalPairingAuthority = provenance?.kind === 'terminal'
            && hasStoredSessionCredentialProvenance(params.credentials) && isPresentUserHostInvocation(context)
            && input.purpose === 'approve' && input.prompt.kind === 'auth.approveRemoteProvisioning';
        return respondToManagedInstallation(input, context, {
            accountId, homeId: params.serverIdentityId,
            accountAuthority: provenance?.kind === 'account' || terminalPairingAuthority,
            ...(params.admittedAcquire ? { admittedAcquire: params.admittedAcquire } : {}),
            assertCurrent: () => context.signal?.throwIfAborted(),
            readMachine: async (request, signal) => {
                const read = await readManagedMachineRead({ credentials: params.credentials, serverHttpBaseUrl: params.serverUrl,
                    homeId: request.homeId, managedId: request.managedId, ...(signal ? { signal } : {}) });
                const machine = await openManagedMachineRead({ credentials: params.credentials, serverHttpBaseUrl: params.serverUrl,
                    read, ...(signal ? { signal } : {}) });
                return { originalMachine: unwrapManagedMachineReadV1(read), machine };
            },
            readOperation: async (machineId, operationId, signal) => ActionOperationGetV1ResponseSchema.parse(
                await invoke(machineId, ACTION_OPERATION_RPC_METHODS_V2.get, { operationId }, signal)),
            invokeTask: async (machineId, response, signal) => parseResponse(await invoke(machineId,
                RPC_METHODS.CAPABILITIES_INVOKE, { id: 'tool.systemTasks', method: 'respond', params: response }, signal)),
            // This is the same finite Home-authorized purpose as the UI. It carries no controller key or Machine grant.
            invokeInstallation: async (response, signal) => withUserScopedRpcSocket({
                token: params.credentials.token, serverUrl: params.serverUrl,
                connectTimeoutMs: resolveSessionControlSocketConnectTimeoutMs(), signal,
            }, async (socket, connect, requestSignal) => {
                await connect();
                return parseResponse(await callSocketRpc({ socket, target: { kind: 'machine', id: response.controller!.machineId },
                    method: RPC_METHODS.CAPABILITIES_INVOKE,
                    params: { id: 'tool.systemTasks', method: 'respond', params: response },
                    content: { mode: 'plain' }, timeoutMs: null, signal: requestSignal }));
            }),
            approvePairing: async (pairing, signal) => {
                // The admitted Action connection can observe a new approval ingress
                // even when the saved descriptor still names a retired one.
                const { profile } = await observeServerProfileHomeConnection({ profileId: params.serverId,
                    serverUrl: params.serverUrl, token: params.credentials.token, signal });
                const descriptor = profile.homeConnectionDescriptor;
                if (descriptor?.homeServerIdentityId !== input.homeId) return 'server_target_mismatch';
                const target = resolveHomeTargetFromDescriptor({ descriptor, authority: 'saved_profile', profile });
                await approveTerminalAuthRequest({ publicKey: pairing.publicKey, pairing: pairing.pairing,
                    supportsTokenOnly: pairing.supportsTokenOnly, target, accountCredentials: params.credentials, signal });
                return undefined;
            },
        });
    };
}

/**
 * The requester's own daemon answers the guest sign-in of an acquire it admitted (owner ruling 2026-11-26).
 * The approval of that acquire, or the person's "allow" setting for it, covers signing the guest into their
 * Account. The answer uses this daemon's own sign-in and data key; the custodian's controller receives only
 * the answer. Every other question stays with the person. A daemon restart ends this follow, and the
 * question then expires visibly with Retry setup as its recovery.
 */
export async function answerAdmittedManagedAcquireSignIn(params: Readonly<{
    credentials: StoredCredentials; serverId: string; serverIdentityId: string; serverUrl: string;
    acquireInput: unknown; acquireResult: unknown; signal: AbortSignal;
    /** The requester-scoped operation read this daemon's executor already uses. */
    readOperation(request: RequesterOperationRequestV1): Promise<ActionExecuteResult | null>;
}>): Promise<void> {
    const input = ManagedAcquireInputV1Schema.safeParse(params.acquireInput);
    const accepted = ManagedAcceptedV1Schema.safeParse(params.acquireResult);
    const accountId = readAccountIdFromToken(params.credentials.token);
    if (!input.success || !accepted.success || !accepted.data.operation || !accountId) return;
    const admitted = { homeId: input.data.selection.homeId, managedId: accepted.data.managedId,
        operationId: accepted.data.operation.operationId };
    const machine = await readManagedMachine({ credentials: params.credentials, serverHttpBaseUrl: params.serverUrl,
        homeId: admitted.homeId, managedId: admitted.managedId, signal: params.signal });
    // Only a guest enrolling this Account under someone else's custody asks this requester.
    if (!machine.controller || machine.enrollmentAccountId !== accountId || machine.custodianAccountId === accountId) return;
    const address = { serverId: params.serverIdentityId, machineId: machine.controller.machineId,
        operationId: admitted.operationId, waitForTerminal: true } as const;
    let sinceRevision: number | undefined;
    for (;;) {
        const found = await params.readOperation({ actionId: ACTION_OPERATION_GET_ACTION_ID_V1,
            input: sinceRevision === undefined ? { ...address, includeManagedPrompt: true } : { ...address, sinceRevision } });
        const response = found?.ok ? ActionOperationGetV1ResponseSchema.safeParse(found.result) : null;
        if (!response?.success || response.data.kind !== 'found') return;
        const snapshot = response.data.operation;
        if (snapshot.operationId !== admitted.operationId || readActionOperationTerminalResultV1(snapshot)
            || sinceRevision !== undefined && snapshot.revision <= sinceRevision) return;
        const question = readManagedInstallationPromptSnapshot(snapshot);
        if (question?.kind === 'auth.approveRemoteProvisioning' && snapshot.domainRef?.kind === 'managedMachine'
            && snapshot.domainRef.id === admitted.managedId) {
            const { taskId, ...prompt } = question;
            const respond = createCliManagedInstallationRespond({ credentials: params.credentials, serverId: params.serverId,
                serverIdentityId: params.serverIdentityId, serverUrl: params.serverUrl, admittedAcquire: admitted });
            const answered = await approveManagedMachineEnrollment({ prompt,
                correlation: { ...admitted, serverId: params.serverId, operationId: admitted.operationId, taskId },
                respond: answer => respond(answer, { surface: 'mcp', authority: 'account_automation', actionCaller: { kind: 'host' },
                    runtimeAccountId: accountId, serverId: params.serverId, serverIdentityId: params.serverIdentityId, signal: params.signal }) });
            if (answered && typeof answered === 'object' && 'ok' in answered && answered.ok === false) {
                logger.warn('[managed] The admitted acquire could not sign its guest in', {
                    managedId: admitted.managedId, operationId: admitted.operationId, errorCode: (answered as { errorCode?: unknown }).errorCode });
            }
            return;
        }
        // An earlier setup question belongs to the person; follow the next revision for the sign-in.
        sinceRevision = snapshot.revision;
    }
}
