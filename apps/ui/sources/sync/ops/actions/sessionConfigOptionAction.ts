import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildLiveSessionAuthoringContext } from '@/components/sessions/authoring/context/buildLiveSessionAuthoringContext';
import { resolveSessionComposerStateFromAuthoringContext } from '@/components/sessions/authoring/context/resolveSessionComposerStateFromAuthoringContext';
import { normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { computeSessionModelConfigOptionControls, getModelOptionsForSession } from '@/sync/domains/models/modelOptions';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { readDynamicModelProbeCache } from '@/sync/domains/models/dynamicModelProbeCache';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { projectSessionModelRefToExecutionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTarget } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { computeSessionConfigOptionControls } from '@/sync/domains/sessionControl/configOptionsControl';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { readSessionProviderBindingMetadataV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { discoverMachineModelsForActions } from '@/sync/ops/modelDiscovery';
import { buildSessionModelDiscoveryContext } from '@/sync/ops/sessionModelDiscovery';
import type { LazyActionAccountContext } from './actionAccountContext';

export function createUiSessionConfigOptionAction(
    account: LazyActionAccountContext | undefined,
    providerAction: ActionExecutorDeps['providerActionExecute'],
): NonNullable<ActionExecutorDeps['sessionConfigOptionSet']> {
    return async ({ sessionId, configId, valueId }, context) => {
        // Withdrawal records existing null intent; it does not select a currently offered value.
        if (valueId !== null) {
            const state = storage.getState();
            const session = state.sessions[sessionId] ?? null;
            const metadata = session ? readSessionOwnerMetadataView(session) : null;
            const authoring = session ? buildLiveSessionAuthoringContext({ session }) : null;
            const sessionAgentId = session ? readSessionPresentationAgentId(session) : null;
            const composer = authoring ? resolveSessionComposerStateFromAuthoringContext(authoring, { fallbackAgentId: sessionAgentId }) : null;
            const agentId = composer?.agentId ?? sessionAgentId;
            const target = session ? resolveSessionActionDefaultTarget(resolveSessionActionDefaultBackend({ session })) : null;
            const sourceSelection = session && target ? getModelOverrideForSpawn(session, buildBackendTargetKeyV2(target))?.modelSelection.ref : null;
            const selection = sourceSelection ? projectSessionModelRefToExecutionModelSelection(sourceSelection).modelSelection : null;
            const composerInput = session?.composerOptionsInput === undefined ? metadata : session.composerOptionsInput;
            let modelControls = agentId === null || sourceSelection && !selection || selection?.providerConnectionId ? null : computeSessionModelConfigOptionControls({
                agentId,
                metadata: composerInput,
                modelId: selection?.modelId ?? 'default',
            });
            if (authoring && composer && target && selection && selection.providerConnectionId === null && agentId
                && !modelControls?.some(candidate => candidate.option.id === configId)) {
                // The picker may hold the native descriptor while a Provider runner reports only
                // its own model. Read that same runtime catalog; direct Actions discover it on demand.
                const serverId = account?.serverId ?? getActiveServerSnapshot().serverId;
                const machineId = resolveMachineControlTargetForSessionFromState(state, { serverId, sessionId })?.machineId
                    ?? metadata?.machineId ?? null;
                const discovery = buildSessionModelDiscoveryContext({
                    target, agentId, machineId, serverId, metadata,
                    directory: authoring.snapshot.directory, profileId: composer.profileId,
                    settings: account ? account.readLiveSettings() ?? await account.readSettings() : state.settings,
                    accountScope: account?.accountLifetime.scope,
                });
                const targetKey = discovery.backendTarget ? resolveBackendTargetKeyV2(discovery.backendTarget) : null;
                const cacheKey = targetKey ? buildDynamicModelProbeCacheKey({
                    machineId, targetKey, serverId, providerConnectionId: null, cwd: discovery.cwd,
                    extraKeySuffixParts: normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(discovery.probeContext),
                }) : null;
                if (cacheKey && machineId) {
                    const successMaxAgeMs = discovery.probeContext?.modelSuccessCacheMaxAgeMs ?? undefined;
                    const held = readDynamicModelProbeCache(cacheKey, successMaxAgeMs);
                    const entry = held?.kind === 'success' ? held : await discoverMachineModelsForActions({
                        cacheKey, agentType: agentId, machineId, serverId, backendTarget: discovery.backendTarget,
                        capabilityParams: discovery.probeContext?.capabilityParams ?? {}, successMaxAgeMs,
                        signal: account?.invocationSignal,
                    });
                    if (entry?.kind === 'success') {
                        modelControls = computeSessionModelConfigOptionControls({
                            agentId, metadata: composerInput, modelId: selection.modelId,
                            modelOptions: getModelOptionsForSession(agentId, composerInput, {
                                preflight: entry.value, preflightUpdatedAt: entry.staticFallback ? null : entry.updatedAt,
                                preflightTargetKey: targetKey, currentTargetKey: targetKey, selectedModelId: selection.modelId,
                            }),
                        });
                    }
                }
            }
            const sessionControl = agentId === null ? undefined : computeSessionConfigOptionControls({ agentId, metadata })
                ?.find(candidate => candidate.option.id === configId);
            const control = modelControls?.find(candidate => candidate.option.id === configId) ?? sessionControl;
            const choiceIds = control?.option.options?.map(choice => choice.value)
                ?? control?.option.groups?.flatMap(group => group.options.map(choice => choice.value))
                ?? [];
            let declaredChoiceIds: readonly string[] | null = null;
            if (selection?.providerConnectionId && !control) {
                const binding = readSessionProviderBindingMetadataV1(metadata);
                let model = binding?.model && binding.connectionId === selection.providerConnectionId && binding.model.id === selection.modelId
                    ? binding.model : null;
                if (!model && providerAction) {
                    const serverId = account?.serverId ?? getActiveServerSnapshot().serverId;
                    const machineId = resolveMachineControlTargetForSessionFromState(state, { serverId, sessionId })?.machineId
                        ?? metadata?.machineId ?? null;
                    if (machineId) {
                        const result = await providerAction({ actionId: 'providers.models.projection', input: {
                            machineId, agentTargetKey: selection.agentTargetKey, currentSelection: selection,
                            sourceConnectionId: selection.providerConnectionId, refreshPolicy: 'current_only',
                        } }, context);
                        if (!result.ok) return result;
                        const projection = DaemonProviderModelProjectionResponseV1Schema.parse(result.result);
                        if (projection.status === 'error') {
                            return { ok: false, errorCode: projection.error.code, error: projection.error.code, details: projection.error };
                        }
                        model = projection.groups.find(group => group.connectionId === selection.providerConnectionId)
                            ?.rows.find(row => row.ref.modelId === selection.modelId)?.descriptor ?? null;
                    }
                }
                const option = model?.modelOptions?.find(candidate => candidate.id === configId);
                declaredChoiceIds = option?.options?.map(choice => choice.value) ?? [];
            }
            if (declaredChoiceIds) {
                if (!declaredChoiceIds.includes(valueId)) {
                    return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
                }
            } else if (!control || control.disabled || sessionControl?.disabled || !choiceIds.includes(valueId)) {
                return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            }
        }
        await sync.publishSessionAcpConfigOptionOverrideToMetadata({
            sessionId, configId, value: valueId, updatedAt: Date.now(),
            ...(account ? { serverId: account.serverId, accountLifetime: account.accountLifetime } : {}),
        });
        return { ok: true, sessionId, configId, valueId };
    };
}
