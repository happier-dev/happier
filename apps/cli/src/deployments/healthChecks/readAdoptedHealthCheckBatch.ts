import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';
import { HealthCheckSourceConfigV1Schema, type HealthCheckSourceConfigV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { arePluginMachineMaterializationRefsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { ResolveAutomationEventAdoptedDefinitionSetV1 } from '@/plugins/runtime/automations/automationEventActionExecutor';

/** Lends the existing adopted source once to a finite saved-selector batch. */
export function readAdoptedHealthCheckBatch(input: Readonly<{
    resolveAdoptedDefinitionSet: ResolveAutomationEventAdoptedDefinitionSetV1;
    caller: PluginMachineMaterializationRefV1;
    occurrenceId: string;
    sourceInstanceId: string;
    signal: AbortSignal;
}>): Readonly<{ kind: 'available'; revision: string; source: HealthCheckSourceConfigV1 }>
    | Readonly<{ kind: 'unavailable'; reason: 'source_unavailable' | 'source_config_invalid' }> {
    input.signal.throwIfAborted();
    const owner = input.resolveAdoptedDefinitionSet(input.caller, input.occurrenceId, { kind: 'checkpointedPull' });
    const projection = owner?.readPublicProjection();
    if (!projection || projection.kind !== 'available') return { kind: 'unavailable', reason: 'source_unavailable' };
    // The source conflict owner already requires subscribers to share config
    // and one watcher. A subscriber does not create another check source.
    const definition = projection.definitions.find(candidate => candidate.sourceInstanceId === input.sourceInstanceId
        && candidate.eventRef.pluginId === input.caller.pluginId
        && candidate.observationTransport.kind === 'checkpointedPull'
        && arePluginMachineMaterializationRefsEqual(candidate.observationTransport.watcherMaterializationRef, input.caller));
    if (!definition) return { kind: 'unavailable', reason: 'source_unavailable' };
    const source = HealthCheckSourceConfigV1Schema.safeParse(definition.sourceConfig);
    if (!source.success) return { kind: 'unavailable', reason: 'source_config_invalid' };
    return { kind: 'available', revision: projection.revision, source: source.data };
}
