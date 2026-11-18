import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { MachineServiceObservationV1 } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
import { arePluginMachineMaterializationRefsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { projectMachineServiceObservation, projectMachineServiceObservationForSource, projectNativeEventObservationAdmissionInput } from '@happier-dev/plugins-machine-services/native-events';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { StoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '../reload/runtimeLease';
import { createAutomationEventAdoptedDefinitionSetHostV1, createAutomationEventStoredDefinitionsHttpTransportV1 } from './automationEventAdoptedDefinitionSetHost';

/** A finite admitted native operation borrows the installed writer and the
 * requester's ordinary E3/E2 owners. It creates no observer or Account registry. */
export async function publishRequesterMachineServiceObservation(input: Readonly<{
    publisherCredentials: Pick<StoredCredentials, 'token'>;
    authorization: ExternalActionExecutionAuthorizationV1;
    observation: MachineServiceObservationV1;
}>): Promise<void> {
    const requester = readRequesterAccountActionContext(input.authorization);
    if (!requester) throw new Error('automation_event_host_evidence_unavailable');
    const observation = projectMachineServiceObservation(input.observation, Date.now());
    if (!observation) return;
    await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, async () => {
        const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
        try {
            const pluginId = observation.eventRef.pluginId;
            const declaration = lease.registry.contributes.events?.find(entry => entry.pluginId === pluginId
                && entry.definition.localId === observation.eventRef.localId);
            const setup = declaration?.definition.kind === 'event'
                ? declaration.definition.automation?.source.setupActionRef : null;
            if (!setup) throw new Error('automation_event_host_evidence_unavailable');
            // Declarative Events have no runtime registration. Their own setup
            // Action is the exact existing activation right; publication never runs it.
            await lease.registry.activateContributionsOnDemand([{ pluginId: setup.pluginId, family: 'actions', localId: setup.localId }]);
            const caller = lease.resolveCurrentPluginMaterializationRef?.(pluginId);
            const occurrenceId = lease.registry.readPluginOccurrenceId(pluginId);
            const sourceCustody = lease.registry.readPluginSourceCustody?.(pluginId);
            if (!caller || !occurrenceId || !sourceCustody) throw new Error('automation_event_host_evidence_unavailable');
            const revalidateMaterialization = async (candidate: typeof caller) => {
                const current = lease.resolveCurrentPluginMaterializationRef?.(pluginId);
                return current !== null && current !== undefined && arePluginMachineMaterializationRefsEqual(current, candidate);
            };
            const revalidateOccurrence = async (candidate: Readonly<{ pluginId: string; occurrenceId: string }>) =>
                lease.registry.isPluginOccurrenceCurrent(candidate.pluginId, candidate.occurrenceId);
            const requesterOperation = { authorizationToken: input.authorization.token,
                requestId: input.authorization.binding.requestId };
            const transport = createAutomationEventStoredDefinitionsHttpTransportV1({
                credentials: input.publisherCredentials, requesterOperation,
                revalidateCaller: async candidate => await revalidateMaterialization(candidate.materialization)
                    && await revalidateOccurrence(candidate),
            });
            const owner = createAutomationEventAdoptedDefinitionSetHostV1({
                credentials: requester.credentials, caller, occurrenceId, sourceCustody,
                transport: { kind: 'checkpointedPull' }, occurrenceSignal: new AbortController().signal,
                isOccurrenceCurrent: () => lease.registry.isPluginOccurrenceCurrent(pluginId, occurrenceId),
                revalidateCallerMaterialization: revalidateMaterialization,
                revalidateCallerOccurrence: revalidateOccurrence, readStoredDefinitions: transport.read,
            });
            const execute = createCliActionDeps({ credentials: requester.credentials, token: requester.credentials.token,
                sessionId: '', serverId: input.authorization.binding.serverIdentityId, serverHttpBaseUrl: requester.serverHttpBaseUrl,
                automationEventPublisher: { credentials: input.publisherCredentials, requesterOperation },
                resolveAuthenticatedAccountId: async () => input.authorization.binding.accountId,
                acquireAutomationEventObservationRegistry: acquireAuthoritativePluginRuntimeRegistryLease,
                revalidatePluginActionCallerMaterialization: revalidateMaterialization,
                revalidatePluginActionCallerOccurrence: revalidateOccurrence,
                resolveAutomationEventAdoptedDefinitionSet: (candidate, candidateOccurrence, transport) =>
                    arePluginMachineMaterializationRefsEqual(candidate, caller) && candidateOccurrence === occurrenceId
                        && transport.kind === 'checkpointedPull' ? owner : null,
            }).automationEventAction;
            if (!execute) throw new Error('automation_event_host_evidence_unavailable');
            const actionCaller = { kind: 'plugin' as const, pluginId, occurrenceId, sourceCustody, materialization: caller };
            // Native completion and configured Event triggers share the owner's
            // normal occurrence admission, as in the installed source adapter.
            const completion = await execute({ actionId: 'automation.event.admit', caller: actionCaller,
                input: { ...projectNativeEventObservationAdmissionInput(observation), definitions: [] } });
            await owner.refresh();
            const projection = owner.readPublicProjection();
            if (projection.kind !== 'available') throw new Error('automation_event_adopted_definitions_unavailable');
            for (const definition of projection.definitions) {
                const selected = projectMachineServiceObservationForSource(input.observation, definition, observation.observationReceivedAt);
                if (!selected) continue;
                const result = await execute({ actionId: 'automation.event.admit', caller: actionCaller,
                    input: { ...projectNativeEventObservationAdmissionInput(selected), definitions: [{ automationId: definition.automationId,
                        triggerId: definition.triggerId, triggerRevision: definition.triggerRevision, sourceSelectorId: definition.sourceSelectorId }] } });
                if ('ok' in result && !result.ok) throw new Error(result.errorCode);
            }
            if ('ok' in completion && !completion.ok) throw new Error(completion.errorCode);
        } finally { await lease.release(); }
    });
}
