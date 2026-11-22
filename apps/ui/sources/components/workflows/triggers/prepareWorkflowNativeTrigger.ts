import { getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';

import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { buildPluginEventAutomationTriggerInput } from '@/components/automations/editor/pluginEventAutomationDraft';
import { configurePluginEventAutomationSetup } from '@/components/automations/editor/pluginEventAutomationSetup';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/executionTarget';
import { PLUGIN_EVENT_AUTOMATION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkflowActivityLiveFact } from '@/sync/domains/workflows/workflowActivityTypes';
import { readWorkflowEventDraftSeed } from '../events/workflowEventFacts';

export async function prepareWorkflowNativeTrigger(
    fact: Extract<WorkflowActivityLiveFact, { kind: 'machine' }>,
    accountLifetime: ServerAccountScopeLifetime,
    signal: AbortSignal | undefined,
) {
    const serverId = accountLifetime.scope.serverId;
    const load = (target: Readonly<{ machineId: string; serverId: string | null }>) => loadDaemonMergedProjectionInputs({
        ...target, sections: PLUGIN_EVENT_AUTOMATION_SECTIONS, accountLifetime, signal,
    });
    const machineId = fact.machineId;
    const projection = await load({ machineId, serverId });
    const eligibleEvents = projection?.automationEligibleEvents ?? [];
    const seed = readWorkflowEventDraftSeed(fact, { serverId, events: eligibleEvents.map(({ event }) => ({
        eventRef: event.identity, automation: event.automation, payloadSchema: event.payloadSchema,
    })) });
    if (!seed?.setupRequired || signal?.aborted || !accountLifetime.isCurrent()) return null;

    const eligible = eligibleEvents.find(({ event }) => event.identity.pluginId === seed.eventSeed.eventRef.pluginId
        && event.identity.localId === seed.eventSeed.eventRef.localId);
    const origin = eligible?.observationBinding?.executionOrigin;
    if (!eligible || !origin || eligible.setupSurface || getPluginMachineExecutionOriginRef(origin).machineId !== machineId) return null;

    const resolveExecutionOrigin = () => {
        const machineTarget = resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: origin.serverIdentityId, machineId },
            { accountScope: accountLifetime.scope });
        return machineTarget === null ? null : { origin, machineTarget };
    };
    const setup = await configurePluginEventAutomationSetup({
        eligibleEvent: eligible,
        initialSetupSeed: { ...seed.eventSeed, monitoringMachineId: machineId },
        observationTransport: 'checkpointedPull',
        filter: null,
        maximumObservationAgeMs: null,
        accountLifetime,
        signal,
        resolveExecutionOrigin,
        loadCurrentProjection: load,
        // The occurrence supplied the whole setup input. The ordinary setup form still validates it.
        present: ({ form }) => {
            void form.submit().then(result => {
                if (result.kind !== 'settled' || !result.outcome.ok) form.cancel();
            }, () => form.cancel());
        },
    });
    if (setup.kind !== 'configured') return null;
    const watcher = setup.draft.resolveFreshWatcherOrigin();
    const trigger = watcher ? buildPluginEventAutomationTriggerInput({
        eligibleEvents, draft: setup.draft.draft, watcherOrigin: watcher.origin,
    }) : null;
    return trigger ? { trigger, payloadSchema: seed.payloadSchema } : null;
}
