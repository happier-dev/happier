import { SessionAuthoringEngineDetail } from './SessionAuthoringEngineDetail';
import { readTeamCredentialProviderModelSelection, replaceProviderModelCredentialBinding } from '@/sync/domains/teams/teamCredentialProviderModelSelection';
import * as React from 'react';
import { buildBackendTargetKeyV2, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { WorkflowStepExecutionSelection } from '@happier-dev/protocol/workflows/workflowV1';
import type { SessionAgentPickerSelection } from '@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { useAgentUiSettings } from '@/agents/catalog/useAgentUiSettings';
import { t } from '@/text';
import { resolveSessionAgentPickerSelectionFields } from '@/components/sessions/agentPicker/sessionAgentPickerSelectionFields';
import type { SessionAuthoringControlFacts } from './sessionAuthoringFieldControls';
import { buildRolesRailPickerOption, type RolesRailPickerOptionParams } from '@/components/roles/rail/buildRolesRailPickerOption';
import { buildSessionAgentPickerOptions } from '@/components/sessions/agentPicker/buildSessionAgentPickerOptions';

const EMPTY_TARGETS: NonNullable<SessionAuthoringControlFacts['agentTargets']> = [];

/** The Session engine picker, adapted only at its controlled authoring writer. */
export function useSessionAuthoringEnginePicker(params: Readonly<{
    values: WorkflowStepExecutionSelection;
    facts?: SessionAuthoringControlFacts;
    disabled?: boolean;
    onChangeFields?: (fields: Partial<WorkflowStepExecutionSelection>) => void;
    roleSelection?: RolesRailPickerOptionParams;
}>) {
    const latest = React.useRef(params);
    latest.current = params;
    const selectedKey = params.values.agentTarget ? buildBackendTargetKeyV2(params.values.agentTarget) : null;
    const targets = params.facts?.agentTargets ?? EMPTY_TARGETS;
    const settings = useAgentUiSettings({ agentIds: targets.map(target => target.agentId).filter((id): id is string => Boolean(id)),
        machineId: params.facts?.agentPickerContext?.machineId, domain: 'runtime' });
    const selected = targets.find(option => buildBackendTargetKeyV2(option.target) === selectedKey);
    const context = params.facts?.agentPickerContext;
    const options = React.useMemo<readonly AgentInputChipPickerOption[]>(() => buildSessionAgentPickerOptions({
        entries: targets.flatMap(option => option.pickerEntry ? [option.pickerEntry] : []),
        leadingOptions: params.roleSelection ? [buildRolesRailPickerOption(params.roleSelection)] : [],
        identityScope: { machineId: context?.machineId ?? null, serverId: context?.serverId ?? null, current: true },
        resolvePresentation: entry => ({ subtitle: entry.subtitle ?? undefined, disabled: params.disabled === true, muted: false }),
        resolveBehavior: ({ entry }) => {
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
            const apply = (selection: SessionAgentPickerSelection, sourceFields?: Partial<WorkflowStepExecutionSelection>) => {
                if (latest.current.disabled || !latest.current.onChangeFields) return;
                const values = latest.current.values;
                const matches = values.agentTarget !== undefined && values.agentTarget !== null
                    && buildBackendTargetKeyV2(values.agentTarget) === buildBackendTargetKeyV2(option.target);
                // Typed overrides of the same Agent stay authored; changing Agent clears them.
                latest.current.onChangeFields({ agentTarget: option.target, ...resolveSessionAgentPickerSelectionFields({
                    agentTarget: option.target, selection, updatedAt: Date.now(),
                    retainedOverrides: matches ? values.sessionConfigOptionOverrides : null,
                }), ...(matches && sourceFields?.teamCredentialBindings === undefined
                    && readTeamCredentialProviderModelSelection(values) ? { modelSelection: null } : {}),
                ...(!matches && values.teamCredentialBindings?.some(binding => binding.slot.kind === 'provider_model')
                    ? { teamCredentialBindings: replaceProviderModelCredentialBinding(values.teamCredentialBindings,
                        { v: 1, slot: { kind: 'provider_model' }, resourceId: null }) } : {}),
                ...sourceFields });
            };
            const backendTarget: PersistedBackendTargetRefV2 = option.backendTarget ?? option.target;
            return {
                closeOnSelectImmediate: false,
                onSelectImmediate: () => apply(readSelection()),
                renderDetailContent: () => <SessionAuthoringEngineDetail values={latest.current.values}
                    onSelectionChange={apply} detail={{
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
    }), [targets, context, params.disabled, params.roleSelection, settings, params.values.teamCredentialBindings, params.values.modelSelection,
        params.values.acpSessionModeId, params.values.sessionConfigOptionOverrides]);
    const onSelect = React.useCallback((id: string) => {
        options.find(option => option.id === id)?.onSelectImmediate?.();
    }, [options]);
    return {
        options, selectedOptionId: selected?.id ?? null, onSelect,
        agentId: selected?.agentId,
        onAgentClick: React.useCallback(() => {}, []),
        label: selected?.label ?? (params.values.agentTarget ? t('workflows.input.unavailable') : t('common.default')),
    };
}
