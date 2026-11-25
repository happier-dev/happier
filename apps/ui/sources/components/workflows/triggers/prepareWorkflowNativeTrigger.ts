import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';

import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { configurePluginEventAutomationSetup } from '@/components/automations/editor/pluginEventAutomationSetup';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/executionTarget';
import { PLUGIN_EVENT_AUTOMATION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { callWorkflowAction, type WorkflowActionCallerContext } from '@/sync/domains/workflows/callWorkflowAction';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import type { WorkflowTriggerDraftSeedIntent } from './workflowTriggerStarts';
import { subjectStarterEventSeed } from './subjectTriggerStarters';
import { readWorkflowEventDraftSeed } from '../events/workflowEventFacts';

export async function prepareWorkflowNativeTrigger(
    source: WorkflowTriggerDraftSeedIntent,
    runsOnMachineId: string,
    accountLifetime: ServerAccountScopeLifetime,
    signal: AbortSignal | undefined,
    caller?: WorkflowActionCallerContext,
) {
    const serverId = accountLifetime.scope.serverId;
    const load = (target: Readonly<{ machineId: string; serverId: string | null }>) => loadDaemonMergedProjectionInputs({
        ...target, sections: PLUGIN_EVENT_AUTOMATION_SECTIONS, accountLifetime, signal,
    });
    const machineId = source.nativeEvent?.machineId ?? runsOnMachineId;
    const projection = await load({ machineId, serverId });
    const eligibleEvents = projection?.automationEligibleEvents ?? [];
    if (signal?.aborted || !accountLifetime.isCurrent()) return null;

    const machineSeed = source.nativeEvent && readWorkflowEventDraftSeed(source.nativeEvent, {
        serverId, events: eligibleEvents.map(({ event }) => ({
            eventRef: event.identity, automation: event.automation, payloadSchema: event.payloadSchema,
        })),
    });
    const environment = source.deploymentEvent?.environment;
    const eventSeed = machineSeed?.setupRequired ? machineSeed.eventSeed
        : environment && subjectStarterEventSeed('deploymentFailed', { deploymentEnvironment: environment });
    const subject = machineSeed?.setupRequired ? machineSeed.subject : environment && {
        kind: 'environment' as const, serverId: environment.serverId, environmentId: environment.environmentId,
    };
    if (!eventSeed || !subject) return null;
    const eligible = eligibleEvents.find(({ event }) => event.identity.pluginId === eventSeed.eventRef.pluginId
        && event.identity.localId === eventSeed.eventRef.localId);
    const origin = eligible?.observationBinding?.executionOrigin;
    if (!eligible || !origin || eligible.setupSurface || getPluginMachineExecutionOriginRef(origin).machineId !== machineId) return null;

    const resolveExecutionOrigin = () => {
        const machineTarget = resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: origin.serverIdentityId, machineId },
            { accountScope: accountLifetime.scope });
        return machineTarget === null ? null : { origin, machineTarget };
    };
    let setupFailure: WorkflowActionError | undefined;
    const setup = await configurePluginEventAutomationSetup({
        eligibleEvent: eligible,
        initialSetupSeed: { ...eventSeed, monitoringMachineId: machineId },
        observationTransport: 'checkpointedPull',
        filter: source.deploymentEvent?.filter ?? null,
        maximumObservationAgeMs: null,
        accountLifetime,
        signal,
        resolveExecutionOrigin,
        loadCurrentProjection: load,
        // Only the seeded read-only setup may run through a retained caller.
        // Interactive setup still belongs to the person at its own surface.
        ...(caller === undefined || caller.authority === 'present_user' ? {} : { dispatch: async ({ action, input, resolveContributedAction, signal, isCurrent }) => {
            if (typeof action === 'string' || !isCurrent?.() || signal?.aborted) {
                return { ok: false, code: 'event_retired', reason: 'event_retired' };
            }
            const declaration = resolveContributedAction?.(action);
            if (!declaration || caller.actionCaller?.kind !== 'session' || !caller.executeChildAction) {
                return { ok: false, code: 'workflow_trigger_setup_required', reason: 'workflow_trigger_setup_required' };
            }
            try {
                const result = await callWorkflowAction({
                    actionId: ACTION_INVOKE_ACTION_ID_V1,
                    input: { action, input, ...(caller.defaultSessionMachineId === machineId
                        ? { expectedContributorOccurrenceId: declaration.occurrenceId } : {}) },
                    accountLifetime, signal, parseResult: result => PluginJsonValueV2Schema.parse(result),
                    context: caller,
                });
                return { ok: true, result };
            } catch (error) {
                if (error instanceof WorkflowActionError) setupFailure = error;
                const code = setupFailure?.code ?? 'workflow_trigger_setup_required';
                return { ok: false, code, reason: code };
            }
        } }),
        // The occurrence supplied the whole setup input. The ordinary setup form still validates it.
        present: ({ form }) => {
            void form.submit().then(result => {
                if (result.kind !== 'settled' || !result.outcome.ok) form.cancel();
            }, () => form.cancel());
        },
    });
    if (setup.kind !== 'configured') {
        if (setupFailure) throw setupFailure;
        if ('code' in setup && setup.code && caller !== undefined) throw new WorkflowActionError({ message: setup.code, rawCode: setup.code });
        return null;
    }
    return { trigger: { ...setup.trigger, subject }, payloadSchema: eligible.event.payloadSchema };
}
