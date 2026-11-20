import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { createActionExecuteFailureError, isActionExecuteFailure, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readCompleteActionSpecV1 } from '@happier-dev/protocol/actions/actionInputJsonSchemaValidation';
import { log } from '@/log';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { readHomeAccountDepartures } from '@/sync/runtime/orchestration/homeAccountChange';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { getMachineContributionRegistryProjectionAuthorityRevision } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import type { LazyActionAccountContext } from './actionAccountContext';
import { createUiAccountAction } from './accountActionDeps';

type OccurrenceSchema = {
    occurrence: string;
    inputSchema?: object;
    pending: ReturnType<typeof createScopedResolutionSingleFlight<object>>;
};
const schemasByAccount = new Map<string, { departures: number; sessions: Map<string, OccurrenceSchema> }>();

/** Native host schemas belong to the selected Session occurrence, not to an individual send. */
export async function readSessionMessageInputSchema(params: Readonly<{
    account: LazyActionAccountContext;
    sessionId: string;
    hostOccurrence: readonly [number | null, number | null, string | null];
    machineId: string;
    context: ActionExecutorContext;
    signal?: AbortSignal;
}>): Promise<object> {
    const { account, sessionId, hostOccurrence, machineId, context, signal } = params;
    account.assertCurrent();
    const accountKey = serverAccountScopeKeySuffix(account.accountLifetime.scope);
    const departures = readHomeAccountDepartures(account.serverId);
    let held = schemasByAccount.get(accountKey);
    if (!held || held.departures !== departures) {
        held = { departures, sessions: new Map() };
        schemasByAccount.set(accountKey, held);
    }
    const occurrence = JSON.stringify([machineId, ...hostOccurrence,
        getMachineContributionRegistryProjectionAuthorityRevision({ serverId: account.serverId, machineId })]);
    let entry = held.sessions.get(sessionId);
    if (!entry || entry.occurrence !== occurrence) {
        entry = { occurrence, pending: createScopedResolutionSingleFlight<object>() };
        held.sessions.set(sessionId, entry);
    }
    if (entry.inputSchema) return entry.inputSchema;
    const selected = entry;
    return selected.pending.run('session.message.send', async physicalSignal => {
        const execute = createUiAccountAction({ account });
        const advertised = await readCompleteActionSpecV1({ actionId: 'session.message.send', includeOutputSchema: false, signal: physicalSignal,
            read: async input => {
                const result = await execute({ actionId: 'action.spec.get', input,
                    context: { ...context, signal: physicalSignal }, signal: physicalSignal });
                if (isActionExecuteFailure(result)) throw createActionExecuteFailureError(result);
                return result;
            } }).catch(error => {
            if (!physicalSignal.aborted) {
                log.log(`[session-input-schema] ${JSON.stringify(projectActionFailureCauseV1(error, 'session.message.input_schema'))}`);
            }
            throw error;
        });
        account.assertCurrent();
        selected.inputSchema = advertised.inputSchema;
        return advertised.inputSchema;
    }, { signal });
}
