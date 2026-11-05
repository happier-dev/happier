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
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTarget } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { computeSessionConfigOptionControls } from '@/sync/domains/sessionControl/configOptionsControl';
import { PROVIDER_REASONING_EFFORT_LEVELS_V1, PROVIDER_REASONING_EFFORT_OPTION_ID } from '@happier-dev/protocol/providers/catalog/reasoningEffort';
import { readSessionProviderBindingMetadataV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { discoverMachineModelsForActions } from '@/sync/ops/modelDiscovery';
import { buildSessionModelDiscoveryContext } from '@/sync/ops/sessionModelDiscovery';
import type { LazyActionAccountContext } from './actionAccountContext';

export function createUiSessionConfigOptionAction(account: LazyActionAccountContext | undefined): NonNullable<ActionExecutorDeps['sessionConfigOptionSet']> {
    return async ({ sessionId, configId, valueId }) => {
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
            const selection = session && target ? getModelOverrideForSpawn(session, buildBackendTargetKeyV2(target))?.modelSelection.ref : null;
            const composerInput = session?.composerOptionsInput === undefined ? metadata : session.composerOptionsInput;
            let modelControls = agentId === null || selection?.providerConnectionId ? null : computeSessionModelConfigOptionControls({
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
            const declaredChoiceIds = selection && !control
                ? readUnpublishedProviderModelChoiceIds(metadata, selection, configId)
                : null;
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

/**
 * The selected Provider model's choices when the Session's own catalog does not hold them. A Provider-bound
 * runner publishes no Session option state: the running Provider model's choices are in its launch
 * binding. A Provider model armed for the next message has no descriptor in Session state,
 * so only the shared Provider effort level is checked:
 * its start admission keeps a retained effort the model declares and omits one it does not
 * (docs/providers.md).
 */
function readUnpublishedProviderModelChoiceIds(
    metadata: Readonly<Record<string, unknown>> | null,
    selection: Readonly<{ providerConnectionId: string | null; modelId: string }>,
    configId: string,
): readonly string[] | null {
    if (selection.providerConnectionId === null) return null;
    const binding = readSessionProviderBindingMetadataV1(metadata);
    if (binding?.model && binding.connectionId === selection.providerConnectionId && binding.model.id === selection.modelId) {
        const option = binding.model.modelOptions?.find(candidate => candidate.id === configId);
        return option?.options?.map(choice => choice.value) ?? [];
    }
    return configId === PROVIDER_REASONING_EFFORT_OPTION_ID ? PROVIDER_REASONING_EFFORT_LEVELS_V1 : null;
}
