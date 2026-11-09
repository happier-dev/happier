import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import type { ActionAccountContext, LazyActionAccountContext } from './actionAccountContext';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { getActionSpec, type PublicActionInputById } from '@happier-dev/protocol/actions/actionSpecs';
import { parseInputTypeOptionsSourceId } from '@happier-dev/protocol/inputs';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { buildQualifiedPluginContributionKey, qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { loadDaemonMergedProjectionCacheEntry, readObservedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    createUiAccountActionTransport,
    type AccountActionTransport,
    type UiAccountActionExecute,
} from './accountActionTransport';

type OptionsRelayRequest = Pick<PublicActionInputById['action.options.resolve'], 'optionsSourceId' | 'actionId' | 'fieldPath'>;
const OPTIONS_RELAY_SECTIONS = ['familiesById.inputTypes', 'actionsById', 'resourcesById'] as const;

function ownMachines(account: Pick<ActionAccountContext, 'serverId' | 'accountId'>) {
    return resolveVisibleMachinesForActiveServerFromState(storage.getState(), account)
        .filter(machine => machine.access?.custodian.accountId === account.accountId);
}

/** Routing consumes compiled declarations; only activation decides actual registration. */
function receiverDeclaresOptions(projection: PluginProjectionV2 | null | undefined, request: OptionsRelayRequest): boolean {
    if (!projection) return false;
    const action = request.actionId && parseQualifiedPluginActionId(request.actionId);
    const field = action ? projection.actionsById[buildQualifiedPluginContributionKey(action)]?.inputHints?.fields
        .find(field => field.path === request.fieldPath) : undefined;
    const type = field?.inputType ?? (request.optionsSourceId ? parseInputTypeOptionsSourceId(request.optionsSourceId) : null);
    if (!type || 'hostType' in type) return false;
    const declaration = projection.familiesById.inputTypes?.entriesById[buildQualifiedPluginContributionKey(type)];
    if (!declaration) return false;
    const resourceRef = declaration.definition.options?.resource;
    if (!resourceRef) return true;
    const resource = projection.resourcesById[buildQualifiedPluginContributionKey(qualifyPluginContributionReferenceV1(resourceRef, type.pluginId))];
    return !!resource && (resource.execution?.target !== 'account' || resource.accountRuntimeDeclared === true);
}

/** Automatic Account execution stays on an own Machine; explicit native targets retain their reviewed path. */
export function resolveUiAccountActionFallbackMachineId(account: Pick<ActionAccountContext, 'serverId' | 'accountId'>,
    options?: Readonly<{
        candidateMachineIds?: readonly string[];
        target?: ActionExecutorContext['externalActionTarget'];
        /** Registry's user-triggered refresh retries its supplier after a failed request. */
        allowUnreachableFallback?: boolean;
        optionsRequest?: OptionsRelayRequest;
        /** Existing receiver projection answers, also used by composed owner tests. */
        receiverProjections?: ReadonlyMap<string, PluginProjectionV2>;
        accountLifetime?: ActiveServerAccountScopeLifetime | null;
    }>): string | null {
    const machines = resolveVisibleMachinesForActiveServerFromState(storage.getState(), account);
    const candidateMachineIds = options?.candidateMachineIds;
    const candidates = candidateMachineIds === undefined ? machines
        : machines.filter(machine => candidateMachineIds.includes(machine.id));
    const target = options?.target;
    if (target) return target.kind === 'machine'
        ? candidates.find(machine => machine.id === target.machineId)?.id ?? null : null;
    const ownCandidates = candidates.filter(machine => machine.access?.custodian.accountId === account.accountId
        && (!options?.optionsRequest || receiverDeclaresOptions(options.receiverProjections?.get(machine.id)
            ?? (() => {
                const cached = readObservedDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId: account.serverId,
                    accountLifetime: options.accountLifetime, sections: OPTIONS_RELAY_SECTIONS });
                return cached?.kind === 'ready' ? cached.inputs.pluginProjectionV2 : null;
            })(), options.optionsRequest)));
    return ownCandidates.find(machine => isMachineReachable(account, machine))?.id
        ?? (options?.allowUnreachableFallback ? ownCandidates[0]?.id ?? null : null);
}

/** Compose the existing machine relay with the invocation's captured Account. */
export function createUiAccountAction(params: Readonly<{
    account: LazyActionAccountContext;
    transport?: AccountActionTransport;
}>): UiAccountActionExecute {
    const execute = createUiAccountActionTransport({
        account: params.account,
        resolveFallbackMachineId: async args => {
            if (args.actionId !== 'action.options.resolve') return resolveUiAccountActionFallbackMachineId(params.account);
            const request = getActionSpec('action.options.resolve').inputSchema.parse(args.input) as PublicActionInputById['action.options.resolve'];
            const type = request.optionsSourceId && parseInputTypeOptionsSourceId(request.optionsSourceId);
            if (!(type && 'pluginId' in type) && !parseQualifiedPluginActionId(request.actionId)) {
                return resolveUiAccountActionFallbackMachineId(params.account);
            }
            // Demand only declarations, sharing the projection owner's held answers and invalidation.
            // No activation, Resource attempt, liveness RPC or retry loop runs during selection.
            const relayOptions = { optionsRequest: request, accountLifetime: params.account.accountLifetime };
            const heldReceiver = resolveUiAccountActionFallbackMachineId(params.account, relayOptions);
            if (heldReceiver) return heldReceiver;
            for (const machine of ownMachines(params.account).filter(machine => isMachineReachable(params.account, machine))) {
                const demand = { machineId: machine.id, serverId: params.account.serverId,
                    accountLifetime: params.account.accountLifetime, sections: OPTIONS_RELAY_SECTIONS, reuseFreshReady: true,
                    signal: args.signal ?? args.context.signal };
                if (readObservedDaemonMergedProjectionCacheEntry(demand)?.kind === 'ready') continue;
                const answer = await loadDaemonMergedProjectionCacheEntry(demand);
                const projection = answer?.kind === 'ready' ? answer.inputs.pluginProjectionV2 : null;
                if (receiverDeclaresOptions(projection, request)) return machine.id;
            }
            return null;
        },
        transport: params.transport ?? (async input => {
            const execution = await executeOriginalAccountMachineAction({ account: params.account, actionId: input.actionId,
                machineId: input.machineId, machineTarget: input.target, requestId: input.requestId, input: input.payload, invocation: input.invocation,
                ...(input.signal ? { signal: input.signal } : {}) });
            return execution.ok ? execution.result : execution;
        }),
    });
    return async (args) => await execute(
        args.context.serverId !== params.account.serverId
            && areServerProfileIdentifiersEquivalent(args.context.serverId, params.account.serverId)
            ? { ...args, context: { ...args.context, serverId: params.account.serverId } }
            : args,
    );
}
