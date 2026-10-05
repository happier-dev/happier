import * as React from 'react';
import { buildAcpConfigOptionOverridesV1, buildBackendTargetKeyV2, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol';
import type { WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';
import { buildSessionAgentPickerDetailContent, type SessionAgentPickerSelection } from '@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { useSettings } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { buildSessionModelSelectionForAgentTarget } from '../sessionModelSelectionValue';
import type { SessionAuthoringControlFacts } from './sessionAuthoringFieldControls';
import { buildRolesRailPickerOption, type RolesRailPickerOptionParams } from '@/components/roles/rail/buildRolesRailPickerOption';

const EMPTY_TARGETS: NonNullable<SessionAuthoringControlFacts['agentTargets']> = [];

/** The Session engine picker, adapted only at its controlled authoring writer. */
export function useSessionAuthoringEnginePicker(params: Readonly<{
    values: WorkflowSessionAuthoringSelection;
    facts?: SessionAuthoringControlFacts;
    disabled?: boolean;
    onChangeFields?: (fields: Partial<WorkflowSessionAuthoringSelection>) => void;
    roleSelection?: RolesRailPickerOptionParams;
}>) {
    const settings = useSettings();
    const latest = React.useRef(params);
    latest.current = params;
    const selectedKey = params.values.agentTarget ? buildBackendTargetKeyV2(params.values.agentTarget) : null;
    const targets = params.facts?.agentTargets ?? EMPTY_TARGETS;
    const selected = targets.find(option => buildBackendTargetKeyV2(option.target) === selectedKey);
    const context = params.facts?.agentPickerContext;
    const options = React.useMemo<readonly AgentInputChipPickerOption[]>(() => [
        ...(params.roleSelection ? [buildRolesRailPickerOption(params.roleSelection)] : []),
        ...targets.map(option => {
        const readSelection = (): SessionAgentPickerSelection => {
            const values = latest.current.values;
            const matches = values.agentTarget !== undefined && values.agentTarget !== null
                && buildBackendTargetKeyV2(values.agentTarget) === buildBackendTargetKeyV2(option.target);
            return {
                modelId: matches ? values.modelSelection?.ref.modelId ?? 'default' : 'default',
                modelSelection: matches ? values.modelSelection : null,
                sessionModeId: matches ? values.acpSessionModeId ?? null : null,
                configOverrides: matches ? Object.fromEntries(Object.entries(values.sessionConfigOptionOverrides?.overrides ?? {})
                    .map(([id, override]) => [id, override.value])) : {},
            };
        };
        const apply = (selection: SessionAgentPickerSelection) => {
            if (latest.current.disabled || !latest.current.onChangeFields) return;
            latest.current.onChangeFields({
                agentTarget: option.target,
                modelSelection: selection.modelSelection ?? buildSessionModelSelectionForAgentTarget({
                    agentTarget: option.target, modelId: selection.modelId, updatedAt: Date.now(),
                }),
                acpSessionModeId: selection.sessionModeId,
                sessionConfigOptionOverrides: buildAcpConfigOptionOverridesV1(selection.configOverrides),
            });
        };
        const backendTarget: PersistedBackendTargetRefV2 = option.backendTarget ?? option.target;
        return {
            id: option.id, label: option.label, subtitle: option.subtitle,
            disabled: params.disabled,
            closeOnSelectImmediate: false,
            onSelectImmediate: () => apply(readSelection()),
            renderDetailContent: () => buildSessionAgentPickerDetailContent({
                backendTarget, runtimeCarrierAgentId: option.agentId,
                selectedMachineId: context?.machineId ?? null,
                capabilityServerId: context?.serverId ?? '', cwd: context?.directory ?? null,
                settings, selection: readSelection(), onSelectionChange: apply,
            }),
        };
    })], [targets, context, params.disabled, params.roleSelection, settings]);
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
