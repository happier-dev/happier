import { HEALTH_CHECK_EVENT_REFS_V1, HealthCheckSourceConfigV1ProtocolSchema, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated, type PluginActionInputById } from '@happier-dev/plugin-sdk/actions';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { HEALTH_REMOVE_ACTION_ID } from './actionIds.js';

const identifier = defineProtocolString({ minLength: 1 });
const inputSchema = defineProtocolObject({ automationId: identifier, triggerId: identifier, checkId: identifier }, { policy: 'closed' });
const resultSchema = defineProtocolUnion([
    defineProtocolObject({ status: defineProtocolLiteral('removed') }, { policy: 'closed' }),
    defineProtocolObject({ status: defineProtocolLiteral('approvalRequested'), artifactId: identifier }, { policy: 'closed' }),
]);

export const savedHealthRemovalActions = {
    [HEALTH_REMOVE_ACTION_ID]: {
        title: 'Remove saved health check', execution: { target: 'daemon' }, scopes: ['global', 'machine'],
        surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'], dangerLevel: 'destructive', approvalScope: 'healthCheck',
        confirmation: { title: 'Remove this health check?', body: 'The selected check will stop running.' },
        inputSchema, resultSchema,
        async run(input: unknown, context: PluginInvocationContext) {
            const { automationId, triggerId, checkId } = inputSchema.parse(input);
            const options = { signal: context.signal };
            const actions = context.services.actions;
            const saved = await actions.execute('workflow.trigger.list', { automationId, triggerId }, options);
            if (isPluginActionApprovalRequestCreated(saved)) return { status: 'approvalRequested', artifactId: saved.artifactId };
            const set = saved.sets.find(item => item.automationId === automationId);
            const trigger = set?.triggers.find(item => item.id === triggerId);
            const definition = saved.triggerDefinition?.definition;
            if (!set?.observationOnly || !definition || trigger?.kind !== 'pluginEvent'
                || !Object.values(HEALTH_CHECK_EVENT_REFS_V1).some(ref => ref.pluginId === trigger.eventRef.pluginId
                    && ref.localId === trigger.eventRef.localId)) throw new PluginError({ code: 'source_unavailable' });

            const source = HealthCheckSourceConfigV1ProtocolSchema.parse(definition.sourceConfig);
            const remaining = source.checks.filter(check => check.checkId !== checkId);
            if (remaining.length === source.checks.length) throw new PluginError({ code: 'source_unavailable' });
            let request: PluginActionInputById['workflow.trigger.update'];
            if (remaining.length === 0) {
                // Retire the whole set when it contains only this source. An exact Save can re-enable it.
                request = { automationId, expectedRevision: set.revision, patch: { enabled: false },
                    ...(set.triggers.length === 1 ? {} : { triggerId }) };
            } else {
                const watcher = trigger.observation.kind === 'checkpointedPull' ? trigger.observation.watcher : null;
                if (!watcher) throw new PluginError({ code: 'source_unavailable' });
                request = { automationId, triggerId, expectedRevision: set.revision, patch: { trigger: {
                    kind: 'pluginEvent', eventRef: trigger.eventRef, sourceContractVersion: trigger.sourceContractVersion,
                    sourceInstanceId: definition.sourceInstanceId, sourceConfig: { ...source, checks: remaining },
                    displayLabel: definition.displayLabel, filter: definition.filter,
                    maximumObservationAgeMs: definition.maximumObservationAgeMs,
                    ...(definition.subject === undefined ? {} : { subject: definition.subject }),
                    observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
                        machineId: watcher.machineId, pluginId: watcher.pluginId, materializationId: watcher.materializationId,
                    } },
                } } };
            }
            const updated = await actions.execute('workflow.trigger.update', request, options);
            return isPluginActionApprovalRequestCreated(updated)
                ? { status: 'approvalRequested', artifactId: updated.artifactId } : { status: 'removed' };
        },
    },
} as const;
