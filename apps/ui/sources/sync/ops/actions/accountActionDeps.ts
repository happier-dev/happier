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
import { buildQualifiedPluginContributionKey, qualifyPluginContributionReferenceV1, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { loadDaemonMergedProjectionCacheEntry, readObservedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    createUiAccountActionTransport,
    type AccountActionTransport,
    type UiAccountActionExecute,
} from './accountActionTransport';

type OptionsRelayRequest = Pick<PublicActionInputById['action.options.resolve'], 'optionsSourceId' | 'actionId' | 'fieldPath'>;
const ACTION_RELAY_SECTIONS = ['actionsById'] as const;
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

function receiverDeclaresAction(projection: PluginProjectionV2 | null | undefined, identity: PluginContributionIdentityV1): boolean {
    const action = projection?.actionsById[buildQualifiedPluginContributionKey(identity)];
    return action?.execution.target === 'account' && action.available === true;
}

/** Automatic Account execution stays on an own Machine; explicit native targets retain their reviewed path. */
export function resolveUiAccountActionFallbackMachineId(account: Pick<ActionAccountContext, 'serverId' | 'accountId'>,
    options?: Readonly<{
        candidateMachineIds?: readonly string[];
        target?: ActionExecutorContext['externalActionTarget'];
        /** Registry's user-triggered refresh retries its supplier after a failed request. */
        allowUnreachableFallback?: boolean;
        optionsRequest?: OptionsRelayRequest;
        action?: PluginContributionIdentityV1;
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
    const ownCandidates = candidates.filter(machine => {
        if (machine.access?.custodian.accountId !== account.accountId) return false;
        if (!options?.optionsRequest && !options?.action) return true;
        const cached = options.receiverProjections?.get(machine.id) ?? (() => {
            const entry = readObservedDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId: account.serverId,
                accountLifetime: options.accountLifetime, sections: options.optionsRequest ? OPTIONS_RELAY_SECTIONS : ACTION_RELAY_SECTIONS });
            return entry?.kind === 'ready' ? entry.inputs.pluginProjectionV2 : null;
        })();
        return options.optionsRequest ? receiverDeclaresOptions(cached, options.optionsRequest)
            : receiverDeclaresAction(cached, options.action!);
    });
    return ownCandidates.find(machine => isMachineReachable(account, machine))?.id
        ?? (options?.allowUnreachableFallback ? ownCandidates[0]?.id ?? null : null);
}

/** Shared placement for whole Account Actions and declaration-backed options. */
export async function resolveUiAccountActionReceiverMachineId(account: LazyActionAccountContext,
    args: Parameters<UiAccountActionExecute>[0]): Promise<string | null> {
    const action = args.actionId === 'action.invoke'
        ? (getActionSpec('action.invoke').inputSchema.parse(args.input) as PublicActionInputById['action.invoke']).action : undefined;
    const request = args.actionId === 'action.options.resolve'
        ? getActionSpec('action.options.resolve').inputSchema.parse(args.input) as PublicActionInputById['action.options.resolve'] : undefined;
    const type = request?.optionsSourceId && parseInputTypeOptionsSourceId(request.optionsSourceId);
    const optionsRequest = request && ((type && 'pluginId' in type) || parseQualifiedPluginActionId(request.actionId)) ? request : undefined;
    if (!action && !optionsRequest) return resolveUiAccountActionFallbackMachineId(account);
    const relayOptions = { action, optionsRequest, accountLifetime: account.accountLifetime };
    const heldReceiver = resolveUiAccountActionFallbackMachineId(account, relayOptions);
    if (heldReceiver) return heldReceiver;
    // Reuse the registry owner's current answers and demand path. No liveness probe,
    // activation, operation attempt, polling or fallback execution is added.
    const sections = optionsRequest ? OPTIONS_RELAY_SECTIONS : ACTION_RELAY_SECTIONS;
    for (const machine of ownMachines(account).filter(machine => isMachineReachable(account, machine))) {
        const demand = { machineId: machine.id, serverId: account.serverId, accountLifetime: account.accountLifetime,
            sections, reuseFreshReady: true, signal: args.signal ?? args.context.signal };
        if (readObservedDaemonMergedProjectionCacheEntry(demand)?.kind === 'ready') continue;
        const answer = await loadDaemonMergedProjectionCacheEntry(demand);
        const projection = answer?.kind === 'ready' ? answer.inputs.pluginProjectionV2 : null;
        if (optionsRequest ? receiverDeclaresOptions(projection, optionsRequest) : receiverDeclaresAction(projection, action!)) return machine.id;
    }
    return null;
}

/** Compose the existing machine relay with the invocation's captured Account. */
export function createUiAccountAction(params: Readonly<{
    account: LazyActionAccountContext;
    transport?: AccountActionTransport;
}>): UiAccountActionExecute {
    const execute = createUiAccountActionTransport({
        account: params.account,
        resolveFallbackMachineId: args => resolveUiAccountActionReceiverMachineId(params.account, args),
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
