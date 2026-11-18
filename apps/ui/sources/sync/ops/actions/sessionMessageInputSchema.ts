import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { readCompleteActionSpecV1 } from '@happier-dev/protocol/actions/actionInputJsonSchemaValidation';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { readHomeAccountDepartures } from '@/sync/runtime/orchestration/homeAccountChange';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { getMachineContributionRegistryProjectionAuthorityRevision } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
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
    session: Pick<Session, 'id' | 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView'>;
    machineId: string;
    context: ActionExecutorContext;
    signal?: AbortSignal;
}>): Promise<object> {
    const { account, session, machineId, context, signal } = params;
    account.assertCurrent();
    const accountKey = serverAccountScopeKeySuffix(account.accountLifetime.scope);
    const departures = readHomeAccountDepartures(account.serverId);
    let held = schemasByAccount.get(accountKey);
    if (!held || held.departures !== departures) {
        held = { departures, sessions: new Map() };
        schemasByAccount.set(accountKey, held);
    }
    const metadata = readSessionOwnerMetadataView(session);
    const occurrence = JSON.stringify([machineId, metadata?.hostPid ?? null,
        metadata?.hostProcessStartTimeMs ?? null, metadata?.hostProcessInstanceFingerprint ?? null,
        getMachineContributionRegistryProjectionAuthorityRevision({ serverId: account.serverId, machineId })]);
    let entry = held.sessions.get(session.id);
    if (!entry || entry.occurrence !== occurrence) {
        entry = { occurrence, pending: createScopedResolutionSingleFlight<object>() };
        held.sessions.set(session.id, entry);
    }
    if (entry.inputSchema) return entry.inputSchema;
    const selected = entry;
    return selected.pending.run('session.message.send', async physicalSignal => {
        const execute = createUiAccountAction({ account });
        const advertised = await readCompleteActionSpecV1({ actionId: 'session.message.send', includeOutputSchema: false, signal: physicalSignal,
            read: input => execute({ actionId: 'action.spec.get', input,
                context: { ...context, signal: physicalSignal }, signal: physicalSignal }) });
        account.assertCurrent();
        selected.inputSchema = advertised.inputSchema;
        return advertised.inputSchema;
    }, { signal });
}
