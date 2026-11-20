import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { prepareAccountSettingsForDaemonSpawnIfNeeded } from '@/sync/ops/accountSettingsDaemonSpawnPreparation';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import {
    SessionConnectedServiceAuthSwitchReceiptSchema,
    type SessionConnectedServiceAuthSwitchReceipt,
    type SessionConnectedServiceAuthSwitchRpcParams,
} from '@happier-dev/protocol/connect/sessionConnectedServiceAuthSwitch';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';

export const SESSION_CONNECTED_SERVICE_AUTH_SWITCH_MACHINE_RPC_METHOD =
    RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH;

export type {
    SessionConnectedServiceAuthSwitchErrorCode,
    SessionConnectedServiceAuthSwitchReceipt as SessionConnectedServiceAuthSwitchResult,
    SessionConnectedServiceAuthSwitchServiceReceipt as SessionConnectedServiceAuthSwitchServiceResult,
} from '@happier-dev/protocol/connect/sessionConnectedServiceAuthSwitch';

/** Read the same settled receipt after direct execution or reviewed replay. */
export function readSessionConnectedServiceAuthSwitchActionResult(result: ActionExecuteResult): SessionConnectedServiceAuthSwitchReceipt {
    if (!result.ok) {
        const receipt = SessionConnectedServiceAuthSwitchReceiptSchema.safeParse(result.details);
        if (receipt.success && !receipt.data.ok) return receipt.data;
    }
    requireActionSuccess(result);
    return SessionConnectedServiceAuthSwitchReceiptSchema.parse(result.result);
}

export async function readSessionConnectedServiceAuthOptions(
    params: Readonly<{ sessionId: string; machineId: string; serverId?: string | null }>,
    context: ActionExecutorContext,
): Promise<unknown> {
    return await machineRpcWithServerScope({
        machineId: params.machineId,
        serverId: params.serverId ?? null,
        method: RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_OPTIONS,
        payload: { sessionId: params.sessionId },
        authorization: { kind: 'session.read', sessionId: params.sessionId },
        ...(context.signal ? { signal: context.signal } : {}),
    });
}

export async function setSessionConnectedServiceAuthBinding({ machineId, serverId, ...params }: Readonly<SessionConnectedServiceAuthSwitchRpcParams & {
    machineId: string;
    serverId?: string | null;
}>): Promise<SessionConnectedServiceAuthSwitchReceipt> {
    const accountSettingsPreparation = await prepareAccountSettingsForDaemonSpawnIfNeeded(params.accountSettingsVersionHint);
    const accountSettingsVersionHint = typeof params.accountSettingsVersionHint === 'number'
        ? params.accountSettingsVersionHint
        : accountSettingsPreparation.accountSettingsVersionHint;
    return await machineRpcWithServerScope<SessionConnectedServiceAuthSwitchReceipt, SessionConnectedServiceAuthSwitchRpcParams>({
        machineId,
        serverId: serverId ?? null,
        method: SESSION_CONNECTED_SERVICE_AUTH_SWITCH_MACHINE_RPC_METHOD,
        authorization: { kind: 'session.write', sessionId: params.sessionId },
        // This is a non-idempotent session mutation. Once emitted, the scoped
        // transport must surface uncertainty instead of retrying it on another route.
        onIssued: () => {},
        payload: {
            ...params,
            ...(typeof accountSettingsVersionHint === 'number' ? { accountSettingsVersionHint } : {}),
        },
    });

}
