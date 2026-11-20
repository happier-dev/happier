import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { loadManagedSessionDefaultsContextV1, type ManagedSessionDefaultsContextLoaderV1 } from '@happier-dev/protocol/projects/loadManagedSessionDefaultsContextV1';
import { buildManagedSessionDefaultsContext, resolveManagedSessionDefaults } from '@happier-dev/protocol/teams/managedDefaults';
import { getOrganizationPolicySessionDefaults } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { isManagedPresetAcquireInputV1, type ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedControllerAccessV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { SessionSpawnNewActionInputV2Schema, admitSessionSpawnNewActionInputV2, projectSessionSpawnNewActionInputV2,
    type SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { resolveSessionModelSelectionInputRefV1 } from '@happier-dev/protocol/providers/model-selection';
import { readOrganizationPolicy } from '@/sync/domains/organizationPolicy/organizationPolicy';
import { projectAccountManagedSessionDefaults } from '@/sync/ops/teams/managedSessionDefaults';
import type { Settings } from '@/sync/domains/settings/settings';

type AuthoringInput = ReturnType<typeof SessionSpawnNewActionInputV2Schema.parse>;
type PreparationPorts = Readonly<{
    createLoader(context: ActionExecutorContext): ManagedSessionDefaultsContextLoaderV1;
    readSettings(): Promise<Settings>;
    resolveDefaultAgentTarget?: (executionTarget: SessionSpawnNewInputV2['executionTarget'] | null, context: ActionExecutorContext) => Promise<AgentExecutionTargetV1 | null>;
    bindPreset?: (placement: Extract<NonNullable<SessionSpawnNewInputV2['sessionPlacement']>, { kind: 'preset' }>, context: ActionExecutorContext) => Promise<Readonly<{
        input: ManagedAcquireInputV1; controllerAccess?: ManagedControllerAccessV1;
    }>>;
    resolveConnectedServices?: (intent: NonNullable<AuthoringInput['connectedServicesAuthIntent']>, target: AgentExecutionTargetV1,
        executionTarget: SessionSpawnNewInputV2['executionTarget'], context: ActionExecutorContext) => Promise<SessionSpawnNewInputV2['connectedServices']>;
}>;

function unavailable(reason: string): never {
    throw createActionExecuteFailureError({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
        details: { reason }, effectAttempted: false });
}

/** Settle authoring omissions before the existing native Machine/Agent admission. */
export function createUiPrepareSessionSpawnNewInput(ports: PreparationPorts): NonNullable<ActionExecutorDeps['prepareSessionSpawnNewInput']> {
    return async (rawInput, context) => {
        const input = SessionSpawnNewActionInputV2Schema.parse(rawInput);
        const captured = context.sessionCreationDefaults;
        const retained = input.sourceContext !== undefined || input.configuration?.providerSessionResume !== undefined;
        const settings = captured || retained ? null : await ports.readSettings();
        const loaded = captured ?? (retained ? { context: buildManagedSessionDefaultsContext({}), unavailableDefaults: undefined }
            : await loadManagedSessionDefaultsContextV1({ ...input.projectContext, primaryTeamId: input.primaryTeamId,
                sharedTeamIds: [...new Set(input.initialAccess?.grants.flatMap(({ subject }) =>
                    subject.kind === 'account' ? [] : [subject.teamId]))],
                memberDefaults: settings ? projectAccountManagedSessionDefaults(settings) : undefined,
                policyDefaults: getOrganizationPolicySessionDefaults(readOrganizationPolicy()),
            }, ports.createLoader(context)));
        let defaultsContext = loaded.context;
        // A submitted Agent is the one its model and connected services were chosen for, so every
        // later defaults decision (here and on the receiving Machine) keys by it.
        const authoredChoices = {
            ...(captured?.authoredChoices ?? {
                ...(input.executionTarget ? { executionTarget: input.executionTarget } : {}),
                ...(input.sessionPlacement ? { sessionPlacement: input.sessionPlacement } : {}),
            }),
            ...(input.agentTarget ? { agentTarget: input.agentTarget } : {}),
        };
        const authoredPlacement = authoredChoices.sessionPlacement;
        const acquiredCreation = input.managedCreation !== undefined;
        const acquiredPlacement = acquiredCreation && input.sessionPlacement?.kind === 'managed' ? input.sessionPlacement : null;
        if (acquiredCreation && !input.executionTarget) return unavailable('machine_target_unavailable');
        const selected = resolveManagedSessionDefaults({ ...defaultsContext,
            agentTargetKey: input.agentTarget ? buildBackendTargetKeyV2(input.agentTarget) : '',
            explicitChoices: { ...(authoredChoices.agentTarget ? { defaultAgentTarget: authoredChoices.agentTarget } : {}),
                ...(acquiredCreation && input.executionTarget ? { placement: { kind: 'machine', target: input.executionTarget } }
                    : authoredPlacement && authoredPlacement.kind !== 'managed' ? { placement: authoredPlacement }
                        : authoredChoices.executionTarget ? { placement: { kind: 'machine', target: authoredChoices.executionTarget } } : {}) } });
        let executionTarget = input.executionTarget;
        let managedPresetAcquisition = captured?.managedPresetAcquisition;
        let managedPresetControllerAccess = captured?.managedPresetControllerAccess;
        if (selected.placement.value?.kind === 'machine') executionTarget = selected.placement.value.target;
        else if (selected.placement.value?.kind === 'preset') {
            if (!managedPresetAcquisition) {
                const bound = ports.bindPreset ? await ports.bindPreset(selected.placement.value, context)
                    : unavailable('controller_unavailable');
                managedPresetAcquisition = bound.input;
                managedPresetControllerAccess = bound.controllerAccess;
            }
            if (!isManagedPresetAcquireInputV1(managedPresetAcquisition) || !managedPresetAcquisition.controller) return unavailable('controller_unavailable');
            executionTarget = { serverId: selected.placement.value.homeId, machineId: managedPresetAcquisition.controller.machineId };
        }
        if (!executionTarget) return unavailable('machine_target_unavailable');
        const agentTarget = selected.agentTarget.source === 'none'
            ? await ports.resolveDefaultAgentTarget?.(selected.placement.value?.kind === 'preset' ? null : executionTarget, context)
            : selected.agentTarget.value;
        if (!agentTarget) return unavailable('agent_contribution_unavailable');
        if (settings) defaultsContext = buildManagedSessionDefaultsContext({ context: defaultsContext,
            creationMachineApprovalProfileId: settings.actionsSettingsV1.machineApprovalProfiles?.[executionTarget.machineId] });
        const { modelSelectionInput, connectedServicesAuthIntent, ...authoredInput } = input;
        const modelRef = modelSelectionInput ? resolveSessionModelSelectionInputRefV1({ agentTargetKey: buildBackendTargetKeyV2(agentTarget),
            providerConnectionId: modelSelectionInput.providerConnectionId ?? null, modelId: modelSelectionInput.modelId }) : undefined;
        const connectedServices = connectedServicesAuthIntent
            ? ports.resolveConnectedServices ? await ports.resolveConnectedServices(connectedServicesAuthIntent, agentTarget, executionTarget, context)
                : unavailable('connected_services_unavailable') : undefined;
        const configuration = modelSelectionInput && modelRef === null ? {
            ...input.configuration,
            mode: input.configuration?.mode ?? { value: null, updatedAtMs: modelSelectionInput.updatedAt },
            permissionIntent: input.configuration?.permissionIntent ?? { value: null, updatedAtMs: modelSelectionInput.updatedAt },
            options: input.configuration?.options ?? {},
            model: { value: null, updatedAtMs: modelSelectionInput.updatedAt, selectionSource: 'explicit' as const },
        } : input.configuration;
        const exact = admitSessionSpawnNewActionInputV2({ ...authoredInput, executionTarget, agentTarget,
            ...(acquiredPlacement ? { sessionPlacement: acquiredPlacement }
                : acquiredCreation && selected.placement.source === 'explicit' && selected.placement.value ? { sessionPlacement: selected.placement.value }
                    : selected.placement.source === 'explicit' && authoredPlacement ? { sessionPlacement: authoredPlacement }
                    : selected.placement.value ? { sessionPlacement: selected.placement.value } : {}),
            ...(modelSelectionInput && modelRef ? { modelSelection: { v: 1, ref: modelRef, updatedAt: modelSelectionInput.updatedAt } } : {}),
            ...(configuration ? { configuration } : {}), ...(connectedServices ? { connectedServices } : {}),
        });
        context.onSessionCreationPrepared?.({ agentTarget: exact.agentTarget, executionTarget: exact.executionTarget });
        return { input: projectSessionSpawnNewActionInputV2(exact), defaults: { context: defaultsContext, authoredChoices,
            ...(loaded.unavailableDefaults ? { unavailableDefaults: loaded.unavailableDefaults } : {}),
            ...(managedPresetAcquisition ? { managedPresetAcquisition } : {}),
            ...(managedPresetControllerAccess ? { managedPresetControllerAccess } : {}) } };
    };
}
