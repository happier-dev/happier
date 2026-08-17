import {
    DaemonPluginCollectionCandidatePreparationRequestV1Schema,
    DaemonPluginCollectionCandidatePreparationResponseV1Schema,
    type PluginCollectionCandidatePreparationBindingV1,
    type PluginCollectionContractRefV1,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    callGuardedMachineRpcWithPolicy,
} from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import type {
    CandidateCollectionReleaseDaemonExecution,
} from './candidateCollectionReleaseExecution';
import type {
    CandidateCollectionReleaseSelectionPreparation,
    CandidateCollectionReleaseSelectionPreparationInput,
    CandidateCollectionReleaseSelectionPreparationResult,
    CandidateCollectionReleaseSelectionPreparedStage,
} from './candidateCollectionReleaseSelection';

type DaemonCandidateCollectionReleasePreparation = Extract<
    CandidateCollectionReleaseSelectionPreparation,
    Readonly<{ kind: 'daemon' }>
>;

function sameContract(
    left: PluginCollectionContractRefV1,
    right: PluginCollectionContractRefV1,
): boolean {
    return left.pluginId === right.pluginId
        && left.collectionId === right.collectionId
        && left.schemaVersion === right.schemaVersion
        && left.contractDigest === right.contractDigest;
}

function sameContractSet(
    left: readonly PluginCollectionContractRefV1[],
    right: readonly PluginCollectionContractRefV1[],
): boolean {
    return left.length === right.length
        && left.every((contract) => right.some((other) => sameContract(contract, other)))
        && right.every((contract) => left.some((other) => sameContract(contract, other)));
}

function currentAccount(lifetime: ActiveServerAccountScopeLifetime): boolean {
    try {
        return lifetime.isCurrent();
    } catch {
        return false;
    }
}

function currentRequest(input: CandidateCollectionReleaseSelectionPreparationInput): boolean {
    try {
        return input.accountLifetime.isCurrent() && input.isCurrent();
    } catch {
        return false;
    }
}

function daemonTarget(execution: CandidateCollectionReleaseDaemonExecution) {
    return Object.freeze({
        serverIdentityId: execution.origin.serverIdentityId,
        machineId: execution.origin.materializationRef.machineId,
    });
}

function expectedTargetMatchesExecution(input: Readonly<{
    execution: CandidateCollectionReleaseDaemonExecution;
    target: CandidateCollectionReleaseSelectionPreparationInput['target'];
}>): boolean {
    return input.target.release.pluginId === input.execution.release.facts.ref.pluginId
        && input.target.release.version === input.execution.release.facts.ref.version
        && sameContractSet(
            input.target.collectionContracts,
            input.execution.release.facts.collectionContracts,
        );
}

function bindingsMatchPreparedRequest(input: Readonly<{
    execution: CandidateCollectionReleaseDaemonExecution;
    request: CandidateCollectionReleaseSelectionPreparationInput;
    bindings: readonly PluginCollectionCandidatePreparationBindingV1[];
}>): boolean {
    if (input.bindings.length !== input.request.source.collectionContracts.length) return false;
    const sourceRefs = input.request.source.collectionContracts.map((source) => ({
        pluginId: source.pluginId,
        collectionId: source.collectionId,
        schemaVersion: source.schemaVersion,
        contractDigest: source.contractDigest,
    }));
    return sameContractSet(
        input.bindings.map((binding) => binding.source),
        sourceRefs,
    ) && input.bindings.every((binding) => (
        binding.candidate.releaseVersion === input.execution.release.facts.ref.version
        && binding.candidate.artifactDigest === input.execution.artifactGraph.digest
        && input.request.source.collectionContracts.some((source) => (
            source.pluginId === binding.source.pluginId
            && source.collectionId === binding.source.collectionId
            && source.schemaVersion === binding.source.schemaVersion
            && source.contractDigest === binding.source.contractDigest
        ))
        && input.execution.release.facts.collectionContracts.some((target) => (
            sameContract(binding.target, target)
            && binding.source.collectionId === binding.target.collectionId
        ))
    ));
}

async function retireBindings(input: Readonly<{
    execution: CandidateCollectionReleaseDaemonExecution;
    accountLifetime: ActiveServerAccountScopeLifetime;
    bindings: readonly PluginCollectionCandidatePreparationBindingV1[];
}>): Promise<void> {
    if (!currentAccount(input.accountLifetime)) return;
    const abort = new AbortController();
    const retirement = input.accountLifetime.onRetire(() => abort.abort());
    try {
        if (!currentAccount(input.accountLifetime)) return;
        const payload = DaemonPluginCollectionCandidatePreparationRequestV1Schema.parse({
            version: 1,
            daemonTarget: daemonTarget(input.execution),
            operation: 'retire',
            bindings: input.bindings,
        });
        const raw = await callGuardedMachineRpcWithPolicy<unknown, typeof payload>({
            machineId: input.execution.origin.materializationRef.machineId,
            serverId: input.execution.serverId,
            method: RPC_METHODS.DAEMON_PLUGIN_COLLECTION_CANDIDATE_PREPARATION_EXECUTE,
            payload,
            signal: abort.signal,
        });
        if (!currentAccount(input.accountLifetime) || isRpcMethodNotFoundResult(raw)) {
            throw new Error('Daemon candidate-preparation retirement is unavailable');
        }
        const response = DaemonPluginCollectionCandidatePreparationResponseV1Schema.safeParse(raw);
        if (!response.success || response.data.kind !== 'retired') {
            throw new Error('Daemon candidate-preparation retirement was rejected');
        }
    } finally {
        retirement.dispose();
    }
}

function preparedStage(input: Readonly<{
    execution: CandidateCollectionReleaseDaemonExecution;
    accountLifetime: ActiveServerAccountScopeLifetime;
    bindings: readonly PluginCollectionCandidatePreparationBindingV1[];
}>): CandidateCollectionReleaseSelectionPreparedStage {
    return Object.freeze({
        retire: async () => await retireBindings(input),
    });
}

function unavailable(
    code: Extract<
        CandidateCollectionReleaseSelectionPreparationResult,
        Readonly<{ kind: 'unavailable' }>
    >['code'],
): CandidateCollectionReleaseSelectionPreparationResult {
    return Object.freeze({ kind: 'unavailable' as const, code });
}

/**
 * Bridges an already verified daemon candidate into Availability's existing
 * one-shot preparation seam. It selects no release and never fetches or
 * executes Artifact bytes in the UI process.
 */
export function createDaemonCandidateCollectionReleasePreparation(input: Readonly<{
    execution: CandidateCollectionReleaseDaemonExecution;
}>): DaemonCandidateCollectionReleasePreparation {
    return Object.freeze({
        kind: 'daemon' as const,
        prepare: async (request) => {
            if (!currentRequest(request)) return unavailable('source_release_changed');
            if (!expectedTargetMatchesExecution({ execution: input.execution, target: request.target })) {
                return unavailable('target_contract_mismatch');
            }

            const abort = new AbortController();
            const retirement = request.accountLifetime.onRetire(() => abort.abort());
            try {
                if (!currentRequest(request)) return unavailable('source_release_changed');
                const payload = DaemonPluginCollectionCandidatePreparationRequestV1Schema.parse({
                    version: 1,
                    daemonTarget: daemonTarget(input.execution),
                    operation: 'prepare',
                    source: request.source,
                    candidate: {
                        release: input.execution.release.facts.ref,
                        artifactDigest: input.execution.artifactGraph.digest,
                        origin: input.execution.origin,
                        collectionContracts: input.execution.release.facts.collectionContracts,
                    },
                });
                const raw = await callGuardedMachineRpcWithPolicy<unknown, typeof payload>({
                    machineId: input.execution.origin.materializationRef.machineId,
                    serverId: input.execution.serverId,
                    method: RPC_METHODS.DAEMON_PLUGIN_COLLECTION_CANDIDATE_PREPARATION_EXECUTE,
                    payload,
                    signal: abort.signal,
                });
                if (isRpcMethodNotFoundResult(raw)) {
                    return unavailable('candidate_preparation_unavailable');
                }
                const response = DaemonPluginCollectionCandidatePreparationResponseV1Schema.safeParse(raw);
                if (!response.success) return unavailable('candidate_preparation_unavailable');
                if (response.data.kind === 'unavailable') {
                    if (response.data.code === 'candidate_currentness_changed') {
                        return unavailable('source_release_changed');
                    }
                    if (response.data.code === 'candidate_contract_mismatch') {
                        return unavailable('target_contract_mismatch');
                    }
                    return unavailable('candidate_preparation_unavailable');
                }
                if (response.data.kind !== 'prepared') {
                    return unavailable('candidate_preparation_unavailable');
                }
                if (!bindingsMatchPreparedRequest({
                    execution: input.execution,
                    request,
                    bindings: response.data.bindings,
                })) {
                    return unavailable('target_contract_mismatch');
                }
                if (!currentRequest(request)) {
                    await retireBindings({
                        execution: input.execution,
                        accountLifetime: request.accountLifetime,
                        bindings: response.data.bindings,
                    }).catch(() => undefined);
                    return unavailable('source_release_changed');
                }
                return Object.freeze({
                    kind: 'prepared' as const,
                    stage: preparedStage({
                        execution: input.execution,
                        accountLifetime: request.accountLifetime,
                        bindings: response.data.bindings,
                    }),
                });
            } catch {
                return !currentRequest(request) || abort.signal.aborted
                    ? unavailable('source_release_changed')
                    : unavailable('candidate_preparation_unavailable');
            } finally {
                retirement.dispose();
            }
        },
    });
}
