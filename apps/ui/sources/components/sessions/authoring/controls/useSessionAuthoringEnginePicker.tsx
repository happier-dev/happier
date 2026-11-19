import { SessionAuthoringEngineDetail } from './SessionAuthoringEngineDetail';
import { readTeamCredentialProviderModelSelection, replaceProviderModelCredentialBinding } from '@/sync/domains/teams/teamCredentialProviderModelSelection';
import * as React from 'react';
import { buildBackendTargetKeyV2, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { WorkflowStepExecutionSelection } from '@happier-dev/protocol/workflows/workflowV1';
import { isMachineAgentExecutionStateBlockingV1, resolveMachineAgentExecutionStateV1, type MachineAgentExecutionStateV1 } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { projectMachineAgentForAuthoredSelection } from '@/agents/machineAgents/machineAgentModel';
import type { SessionAgentPickerSelection } from '@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { useAgentUiSettings } from '@/agents/catalog/useAgentUiSettings';
import { t } from '@/text';
import { resolveSessionAgentPickerSelectionFields } from '@/components/sessions/agentPicker/sessionAgentPickerSelectionFields';
import type { SessionAuthoringControlFacts, SessionAuthoringFieldOption } from './sessionAuthoringFieldControls';
import { buildRolesRailPickerOption, type RolesRailPickerOptionParams } from '@/components/roles/rail/buildRolesRailPickerOption';
import { buildSessionAgentPickerOptions } from '@/components/sessions/agentPicker/buildSessionAgentPickerOptions';

const EMPTY_TARGETS: NonNullable<SessionAuthoringControlFacts['agentTargets']> = [];

function readSessionAuthoringReadinessLabel(readiness: MachineAgentExecutionStateV1): string {
    return readiness === 'needsSignIn' ? t('machineAgents.needsSignIn')
        : readiness === 'notInstalled' ? t('machineAgents.notInstalled') : t('machineAgents.unsupported');
}

/** The Session engine picker, adapted only at its controlled authoring writer. */
export function useSessionAuthoringEnginePicker(params: Readonly<{
    values: WorkflowStepExecutionSelection;
    facts?: SessionAuthoringControlFacts;
    /** The allowed engines for staging changes to existing Sessions. */
    engineOptions?: readonly SessionAuthoringFieldOption[];
    disabled?: boolean;
    onChangeFields?: (fields: Partial<WorkflowStepExecutionSelection>) => void;
    roleSelection?: RolesRailPickerOptionParams;
    /**
     * The host writes to several Sessions that run different models (bulk Compose): until an Agent is staged, no
     * model reads as chosen and the running line names the mix. A staged Agent shows its own choice as usual.
     */
    mixedSelection?: Readonly<{ label: string; applyTiming?: string }>;
}>) {
    const latest = React.useRef(params);
    latest.current = params;
    const selectedKey = params.values.agentTarget ? buildBackendTargetKeyV2(params.values.agentTarget) : null;
    const catalogTargets = params.facts?.agentTargets ?? EMPTY_TARGETS;
    const engineOptions = React.useMemo(() => params.engineOptions
        && new Map(params.engineOptions.map(option => [option.id, option])), [params.engineOptions]);
    const targets = React.useMemo(() => engineOptions
        ? catalogTargets.filter(option => engineOptions.has(option.id)) : catalogTargets, [catalogTargets, engineOptions]);
    const settings = useAgentUiSettings({ agentIds: targets.map(target => target.agentId).filter((id): id is string => Boolean(id)),
        machineId: params.facts?.agentPickerContext?.machineId, domain: 'runtime' });
    const selected = targets.find(option => buildBackendTargetKeyV2(option.target) === selectedKey);
    const context = params.facts?.agentPickerContext;
    const options = React.useMemo<readonly AgentInputChipPickerOption[]>(() => buildSessionAgentPickerOptions({
        entries: targets.flatMap(option => option.pickerEntry ? [option.pickerEntry] : []),
        leadingOptions: params.roleSelection ? [buildRolesRailPickerOption(params.roleSelection)] : [],
        identityScope: { machineId: context?.machineId ?? null, serverId: context?.serverId ?? null, current: true },
        resolvePresentation: entry => {
            const option = engineOptions?.get(entry.backendTargetKey);
            if (option?.disabled) return { subtitle: option.subtitle, disabled: true, muted: false };
            return { subtitle: entry.subtitle ?? undefined, disabled: params.disabled === true, muted: false };
        },
        resolveBehavior: ({ entry }) => {
            const fieldOption = engineOptions?.get(entry.backendTargetKey);
            if (fieldOption?.disabled) return {};
            const option = targets.find(target => target.id === entry.backendTargetKey)!;
            const readSelection = (): SessionAgentPickerSelection => {
                const values = latest.current.values;
                const matches = values.agentTarget !== undefined && values.agentTarget !== null
                    && buildBackendTargetKeyV2(values.agentTarget) === buildBackendTargetKeyV2(option.target);
                const teamModel = matches ? readTeamCredentialProviderModelSelection(values) : null;
                return {
                    modelId: matches ? teamModel?.modelId ?? values.modelSelection?.ref.modelId ?? 'default' : 'default',
                    modelSelection: matches ? values.modelSelection : null,
                    sessionModeId: matches ? values.acpSessionModeId ?? null : null,
                    configOverrides: matches ? Object.fromEntries(Object.entries(values.sessionConfigOptionOverrides?.overrides ?? {})
                        .flatMap(([id, override]) => typeof override.value === 'string' ? [[id, override.value] as const] : [])) : {},
                };
            };
            const apply = (selection: SessionAgentPickerSelection | undefined, sourceFields?: Partial<WorkflowStepExecutionSelection>) => {
                if (latest.current.disabled || !latest.current.onChangeFields) return;
                const values = latest.current.values;
                const matches = values.agentTarget !== undefined && values.agentTarget !== null
                    && buildBackendTargetKeyV2(values.agentTarget) === buildBackendTargetKeyV2(option.target);
                // Typed overrides of the same Agent stay authored; changing Agent clears them.
                const fields = selection && resolveSessionAgentPickerSelectionFields({
                    agentTarget: option.target, selection, updatedAt: Date.now(),
                    retainedOverrides: matches ? values.sessionConfigOptionOverrides : null,
                });
                // An empty detail snapshot represents absent settings in an existing-Session change set.
                const authoredFields = fieldOption ? {
                    modelSelection: fields?.modelSelection,
                    acpSessionModeId: fields?.acpSessionModeId ?? undefined,
                    sessionConfigOptionOverrides: fields?.sessionConfigOptionOverrides ?? undefined,
                } : fields;
                latest.current.onChangeFields({
                    agentTarget: option.target,
                    ...authoredFields,
                    ...(matches && sourceFields?.teamCredentialBindings === undefined
                        && readTeamCredentialProviderModelSelection(values) ? { modelSelection: null } : {}),
                    ...(!matches && values.teamCredentialBindings?.some(binding => binding.slot.kind === 'provider_model')
                        ? { teamCredentialBindings: replaceProviderModelCredentialBinding(values.teamCredentialBindings,
                            { v: 1, slot: { kind: 'provider_model' }, resourceId: null }) } : {}),
                    ...sourceFields,
                });
            };
            const backendTarget: PersistedBackendTargetRefV2 = option.backendTarget ?? option.target;
            return {
                closeOnSelectImmediate: false,
                onSelectImmediate: () => {
                    if (!fieldOption) return apply(readSelection());
                    const target = latest.current.values.agentTarget;
                    if (target && buildBackendTargetKeyV2(target) === option.id) return;
                    apply(undefined);
                },
                renderDetailContent: () => <SessionAuthoringEngineDetail values={latest.current.values}
                    onSelectionChange={apply} detail={{
                    ...(latest.current.mixedSelection && !latest.current.values.agentTarget
                        ? { mixedSelection: latest.current.mixedSelection } : {}),
                    agentCatalogEntry: entry.agentCatalogEntry,
                    backendTarget, runtimeCarrierAgentId: option.agentId,
                    selectedMachineId: context?.machineId ?? null,
                    capabilityServerId: context?.serverId ?? '', cwd: context?.directory ?? null,
                    ...('connectedServices' in latest.current.values ? { connectedServices: latest.current.values.connectedServices } : {}),
                    selectedProfileId: latest.current.values.profileId,
                    runtimeDescriptorV1: latest.current.values.runtimeDescriptorV1,
                    settings, selection: readSelection(),
                }} />,
            };
        },
    }), [targets, engineOptions, context, params.disabled, params.roleSelection, settings, params.values.teamCredentialBindings, params.values.modelSelection,
        params.values.acpSessionModeId, params.values.sessionConfigOptionOverrides]);
    const onSelect = React.useCallback((id: string) => {
        options.find(option => option.id === id)?.onSelectImmediate?.();
    }, [options]);
    const selectedAgent = projectMachineAgentForAuthoredSelection(selected?.machineAgent, params.values);
    const selectedReadiness = selectedAgent
        ? resolveMachineAgentExecutionStateV1({ inventoryState: selectedAgent.state })
        : selected?.readiness;
    const selectedBlocked = selectedReadiness !== undefined && isMachineAgentExecutionStateBlockingV1(selectedReadiness);
    return {
        options, selectedOptionId: selected?.id ?? null, onSelect,
        agentId: selected?.agentId,
        onAgentClick: React.useCallback(() => {}, []),
        label: selected ? (selectedBlocked ? `${selected.label} · ${readSessionAuthoringReadinessLabel(selectedReadiness)}` : selected.label)
            : (params.values.agentTarget ? t('workflows.input.unavailable') : t('common.default')),
    };
}
