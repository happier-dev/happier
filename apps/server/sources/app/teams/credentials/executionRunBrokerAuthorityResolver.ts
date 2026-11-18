import { DaemonExecutionRunBrokerAuthorityResponseV1Schema } from '@happier-dev/protocol/daemon/executionRuns';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { Fastify } from '@/app/api/types';
import type { ProviderBrokerAdmissionFailureCodeV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { TeamCredentialExecutionRunCurrentnessResolver } from './providerBrokerAdmission';
import { db } from '@/storage/db';

type Failure = Readonly<{ ok: false; reasonCode: ProviderBrokerAdmissionFailureCodeV1; failureCause?: ActionFailureCauseV1 }>;

export function createExecutionRunBrokerCurrentnessResolver(input: Readonly<{
    app: Pick<Fastify, 'forwardRpcForUser'>;
    resolveServerIdentityId: () => Promise<string>;
    createNonce: () => string;
}>): TeamCredentialExecutionRunCurrentnessResolver {
    return async request => {
        const requestNonce = input.createNonce();
        const serverIdentityId = await input.resolveServerIdentityId();
        // The worker's custodian owns its RPC registration. The requesting
        // Account remains the consumer principal, including on a shared worker.
        const worker = await db.machine.findUnique({
            where: { id: request.workerMachineId }, select: { accountId: true },
        });
        if (!worker) return failure('execution_run_authority_unavailable');
        const rpc = await input.app.forwardRpcForUser({
            userId: worker.accountId,
            method: `${request.workerMachineId}:${RPC_METHODS.DAEMON_EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE}`,
            params: {
                v: 1,
                requestNonce,
                serverIdentityId,
                requestingAccountId: request.requestingAccountId,
                workerMachineId: request.workerMachineId,
                executionRunId: request.executionRunId,
                ...(request.expectedIntent !== undefined ? { expectedIntent: request.expectedIntent } : {}),
                expectedOccurrenceId: request.expectedOccurrenceId,
                ...(request.expectedDirectMaterialUse
                    ? { expectedDirectMaterialUse: request.expectedDirectMaterialUse }
                    : {}),
            },
        });
        if (!rpc.ok) return failure('execution_run_authority_unavailable');
        const parsed = DaemonExecutionRunBrokerAuthorityResponseV1Schema.safeParse(rpc.result);
        if (!parsed.success) return failure('execution_run_authority_unavailable', 'invalid_response');
        if (parsed.data.requestNonce !== requestNonce) return failure('operation_not_current');
        if (parsed.data.status === 'not_current') {
            const { reason } = parsed.data;
            if (reason === 'not_found') return failure('execution_run_not_found');
            if (reason === 'terminal') return failure('execution_run_terminal');
            return failure(reason === 'runtime_unavailable' ? 'execution_run_authority_unavailable' : 'operation_not_current', reason);
        }
        if (parsed.data.serverIdentityId !== serverIdentityId
            || parsed.data.requestingAccountId !== request.requestingAccountId
            || parsed.data.workerMachineId !== request.workerMachineId
            || parsed.data.executionRunId !== request.executionRunId
            || (request.expectedIntent !== undefined && parsed.data.intent !== request.expectedIntent)
            || (request.expectedOccurrenceId !== null && parsed.data.occurrenceId !== request.expectedOccurrenceId)) {
            return failure('operation_not_current');
        }
        return {
            ok: true,
            parentSessionId: parsed.data.parentSessionId,
            occurrenceId: parsed.data.occurrenceId,
            intent: parsed.data.intent,
            runtimeState: parsed.data.runtimeState,
            activeTurnId: parsed.data.activeTurnId ?? null,
            // The Run owner's own accepted selection (null: it inherits its
            // parent Session's), for broker admission to authorize against.
            teamCredentialProviderModel: parsed.data.teamCredentialProviderModel,
        };
    };
}

function failure(reasonCode: ProviderBrokerAdmissionFailureCodeV1, predicate?: string): Failure {
    return { ok: false, reasonCode, ...(predicate === undefined ? {} : {
        failureCause: { phase: `provider_broker.execution_run.${predicate}`, errorClass: 'Error', errorCode: reasonCode, httpStatus: null },
    }) };
}
