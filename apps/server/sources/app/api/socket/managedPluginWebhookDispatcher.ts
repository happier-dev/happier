import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/rpc';
import {
    MANAGED_PLUGIN_WEBHOOK_DAEMON_RPC_METHOD_V1,
    ManagedPluginWebhookResultV1Schema,
    type ManagedPluginWebhookOriginV1,
    type ManagedPluginWebhookRequestV1,
    type ManagedPluginWebhookResultV1,
} from '@happier-dev/protocol/plugins/webhooks/managedRepositoryWebhookRpcV1';
import type { Server } from 'socket.io';

import { readVerifiedMachineSocketInstallationIdFromSocketData } from './machineSocketInstallationProof';
import type { RpcAckResponseEmitter } from './rpc/_types';
import { forwardRpcCall } from './rpc/forwardRpcCall';

export type ForwardManagedPluginWebhookOperation = (params: Readonly<{
    target: Readonly<{ accountId: string; machineId: string; installationId: string }>;
    operation: ManagedPluginWebhookRequestV1;
}>) => Promise<ManagedPluginWebhookResultV1>;

const unavailable = { kind: 'unavailable', code: 'target_unavailable' } as const;

/** The endpoint owner supplies the admitted target. The socket layer enforces its exact installation. */
export function createManagedPluginWebhookDispatcher(input: Readonly<{ io: Server }>): ForwardManagedPluginWebhookOperation {
    return async ({ target, operation }) => {
        const authorization: ManagedPluginWebhookOriginV1 = {
            kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.MANAGED_PLUGIN_WEBHOOK_SERVER_ORIGIN,
            accountId: target.accountId,
            machineId: target.machineId,
        };
        const isTarget = ({ data }: Pick<RpcAckResponseEmitter, 'data'>) => data?.clientType === 'machine-scoped'
            && data.machineId === target.machineId
            && readVerifiedMachineSocketInstallationIdFromSocketData(data) === target.installationId;
        try {
            const result = await forwardRpcCall({
                io: input.io,
                targetUserId: target.accountId,
                method: `${target.machineId}:${MANAGED_PLUGIN_WEBHOOK_DAEMON_RPC_METHOD_V1}`,
                authorization,
                callParams: operation,
                targetGuard: {
                    async filterTargets(targets) { return targets.filter(isTarget); },
                    async runOperation({ readLatestTarget, operation: send }) {
                        const current = await readLatestTarget();
                        if (!current || !isTarget(current)) return { status: 'unavailable' };
                        return { status: 'current', value: await send() };
                    },
                },
            });
            if (!result.ok) return unavailable;
            const parsed = ManagedPluginWebhookResultV1Schema.safeParse(result.result);
            return parsed.success ? parsed.data : unavailable;
        } catch {
            // No exception from a transport carrying the verifier secret can leave this operation.
            return unavailable;
        }
    };
}
