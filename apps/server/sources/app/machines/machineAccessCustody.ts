import { MachineAccessLossCustodyResponseV1Schema, MachineAccessLossRequesterCensusResponseV1Schema, type MachineAccessLossCustodyRequestV1, type MachineAdmission } from '@happier-dev/protocol/machines/machineAccessV1';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES, type RpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { CLIENT_UPGRADE_REQUIRED_ERROR_CODE } from '@happier-dev/protocol/clientCompatibility/upgradeRequiredV1';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { readMachineAccessKeySessionBindingsInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { inReadSnapshot, inTx, type Tx } from '@/storage/inTx';
import { log } from '@/utils/logging/log';
import { resolveEffectiveMachineRoleInTx, resolveMachineAdmissionInTx } from './machineAccess';
import type { RpcAckResponseEmitter } from '@/app/api/socket/rpc/_types';

type MachineCustody = Readonly<{ machineId: string;
    expectedCustodianAccountId: string; expectedInstallationId: string }>;
type CustodyLoss = MachineCustody & Readonly<{ subjectAccountId: string }>;
type CurrentCustodyAdmission = Extract<MachineAdmission, { kind: 'admitted' }>;

/** Server-private diagnostics; the strict daemon wire response remains unchanged. */
export type MachineAccessLossCustodyIncompleteReason =
    | `admission_refused:${Extract<MachineAdmission, { kind: 'denied' }>['code']}`
    | 'custodian_mismatch' | 'installation_mismatch' | 'target_not_found' | 'forwarder_unavailable'
    | `forward_failed:${RpcErrorCode | typeof MACHINE_RPC_TIMEOUT_ERROR_CODE | typeof CLIENT_UPGRADE_REQUIRED_ERROR_CODE | 'unknown'}`
    | 'response_invalid' | 'cleanup_incomplete' | 'custody_unavailable';
type IncompleteCustody = Readonly<{ kind: 'incomplete'; reason: MachineAccessLossCustodyIncompleteReason }>;
export type MachineAccessLossCustodyOutcome = Readonly<{ kind: 'settled' }> | IncompleteCustody;

async function readCurrentCustodyInTx(tx: Tx, input: MachineCustody): Promise<CurrentCustodyAdmission | IncompleteCustody> {
    const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: input.expectedCustodianAccountId,
        machineId: input.machineId, rpcMethod: RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS, requireOnline: true });
    if (admission.kind === 'denied') return { kind: 'incomplete', reason: `admission_refused:${admission.code}` };
    if (admission.custodianAccountId !== input.expectedCustodianAccountId) return { kind: 'incomplete', reason: 'custodian_mismatch' };
    if (admission.installationId !== input.expectedInstallationId) return { kind: 'incomplete', reason: 'installation_mismatch' };
    return admission;
}

/** Census and cleanup share the same exact current installation transport custody. */
async function forwardMachineAccessCustody(input: MachineCustody, callParams: MachineAccessLossCustodyRequestV1,
    readCurrent: () => Promise<CurrentCustodyAdmission | IncompleteCustody | null>,
): Promise<IncompleteCustody | Readonly<{ kind: 'forwarded'; result: unknown }> | null> {
    const current = await readCurrent();
    if (!current) return null;
    if (current.kind === 'incomplete') return current;
    const { kind: _kind, ...machineAdmission } = current;
    const sameMachine = (target: RpcAckResponseEmitter) => target.data?.clientType === 'machine-scoped'
        && target.data.userId === input.expectedCustodianAccountId && target.data.machineId === input.machineId;
    const matches = (target: RpcAckResponseEmitter) => sameMachine(target)
        && target.data?.verifiedMachineInstallationId === input.expectedInstallationId;
    let rejection: IncompleteCustody | undefined;
    const response = await eventRouter.forwardServerOwnedRpc({
        targetUserId: input.expectedCustodianAccountId, method: `${input.machineId}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
        callParams, authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN,
        machineAdmission, targetGuard: {
            filterTargets: async targets => {
                const matched = targets.filter(matches);
                rejection = matched.length === 0 && targets.some(sameMachine)
                    ? { kind: 'incomplete', reason: 'installation_mismatch' } : undefined;
                return matched;
            },
            runOperation: async ({ target, readLatestTarget, operation }) => {
                if (!matches(target)) {
                    rejection = { kind: 'incomplete', reason: sameMachine(target) ? 'installation_mismatch' : 'target_not_found' };
                    return { status: 'unavailable' };
                }
                const latest = await readLatestTarget();
                if (!latest || !matches(latest)) {
                    rejection = { kind: 'incomplete', reason: latest && sameMachine(latest) ? 'installation_mismatch' : 'target_not_found' };
                    return { status: 'unavailable' };
                }
                const admission = await readCurrent();
                if (!admission || admission.kind === 'incomplete') {
                    rejection = admission ?? undefined;
                    return { status: 'unavailable' };
                }
                return { status: 'current', value: await operation() };
            },
        },
    });
    if (!response) return { kind: 'incomplete', reason: 'forwarder_unavailable' };
    if (rejection) return rejection;
    // A delivered ACK can itself be a typed daemon refusal. Preserve its closed
    // code just like a transport refusal, without copying either error message.
    const failure = response.ok ? response.result : response;
    const errorCode = failure && typeof failure === 'object' && 'errorCode' in failure ? failure.errorCode : undefined;
    const knownCode = Object.values(RPC_ERROR_CODES).find(code => code === errorCode)
        ?? (errorCode === MACHINE_RPC_TIMEOUT_ERROR_CODE ? MACHINE_RPC_TIMEOUT_ERROR_CODE
            : failure && typeof failure === 'object' && 'error' in failure
                && failure.error === CLIENT_UPGRADE_REQUIRED_ERROR_CODE ? CLIENT_UPGRADE_REQUIRED_ERROR_CODE : undefined);
    if (response.ok && !knownCode) return { kind: 'forwarded', result: response.result };
    if (!response.ok && (errorCode === 'target_unavailable' || errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        || errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND || errorCode === RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE)) {
        return { kind: 'incomplete', reason: 'target_not_found' };
    }
    // Only closed producer-owned codes enter diagnostics; never forward error prose.
    return { kind: 'incomplete', reason: `forward_failed:${knownCode ?? 'unknown'}` };
}

/** Home's existing role snapshot projects full loss or Machine-only Manage withdrawal to cleanup. */
export async function dispatchMachineAccessLossCustody(input: CustodyLoss): Promise<MachineAccessLossCustodyOutcome> {
    let response: Awaited<ReturnType<typeof forwardMachineAccessCustody>>;
    try {
        const current = await inReadSnapshot(async tx => {
            const role = await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: input.subjectAccountId, machineId: input.machineId });
            if (role === 'manage') return null;
            return { custody: await readCurrentCustodyInTx(tx, input), remainingRole: role };
        });
        if (!current) return { kind: 'settled' };
        response = await forwardMachineAccessCustody(input, { v: 1, subjectAccountId: input.subjectAccountId,
            ...(current.remainingRole === 'use' ? { remainingRole: 'use' } : {}),
        }, async () => current.custody);
    } catch {
        response = { kind: 'incomplete', reason: 'custody_unavailable' };
    }
    const result = response?.kind === 'forwarded' ? MachineAccessLossCustodyResponseV1Schema.safeParse(response.result) : null;
    if (result?.success && result.data.kind === 'settled') return { kind: 'settled' };
    const outcome: IncompleteCustody = response?.kind === 'incomplete' ? response
        : { kind: 'incomplete', reason: result?.success ? 'cleanup_incomplete' : 'response_invalid' };
    log({ module: 'machine-access', level: 'warn', machineId: input.machineId,
        subjectAccountId: input.subjectAccountId, reason: outcome.reason }, 'Requester work cleanup remains incomplete');
    return outcome;
}

/** History and live attribution supply subjects; only current access loss authorizes cleanup. */
export async function recoverMachineAccessLossCustody(input: MachineCustody): Promise<void> {
    const admission = await inReadSnapshot(tx => readCurrentCustodyInTx(tx, input));
    if (admission.kind === 'incomplete') return;
    const bindings = await inTx(tx => readMachineAccessKeySessionBindingsInTx(tx, {
        accountId: input.expectedCustodianAccountId, machineId: input.machineId,
    }));
    const subjects = new Set(bindings.map(binding => binding.accountId));
    const response = await forwardMachineAccessCustody(input, { v: 1, kind: 'requesters' }, async () => admission);
    const census = response?.kind === 'forwarded' ? MachineAccessLossRequesterCensusResponseV1Schema.safeParse(response.result) : null;
    if (census?.success) for (const accountId of census.data.accountIds) subjects.add(accountId);
    if (!census?.success || census.data.coverage !== 'complete') {
        log({ module: 'machine-access', level: 'warn', machineId: input.machineId }, 'Reconnect requester work census remains incomplete');
    }
    for (const subjectAccountId of subjects) {
        await dispatchMachineAccessLossCustody({ ...input, subjectAccountId });
    }
}
