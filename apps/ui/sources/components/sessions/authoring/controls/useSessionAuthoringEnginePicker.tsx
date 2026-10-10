import * as React from 'react';
import { buildAcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import { buildBackendTargetKeyV2, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';
import { buildSessionAgentPickerDetailContent, type SessionAgentPickerSelection } from '@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { useSettings } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { buildSessionModelSelectionForAgentTarget } from '../sessionModelSelectionValue';
import type { SessionAuthoringControlFacts } from './sessionAuthoringFieldControls';
import { buildRolesRailPickerOption, type RolesRailPickerOptionParams } from '@/components/roles/rail/buildRolesRailPickerOption';
import { buildSessionAgentPickerOptions } from '@/components/sessions/agentPicker/buildSessionAgentPickerOptions';

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
                return {
                    modelId: matches ? values.modelSelection?.ref.modelId ?? 'default' : 'default',
                    modelSelection: matches ? values.modelSelection : null,
                    sessionModeId: matches ? values.acpSessionModeId ?? null : null,
                    configOverrides: matches ? Object.fromEntries(Object.entries(values.sessionConfigOptionOverrides?.overrides ?? {})
                        .flatMap(([id, override]) => typeof override.value === 'string' ? [[id, override.value] as const] : [])) : {},
                };
            };
            const apply = (selection: SessionAgentPickerSelection) => {
                if (latest.current.disabled || !latest.current.onChangeFields) return;
                const updatedAt = Date.now();
                const values = latest.current.values;
                const matches = values.agentTarget !== undefined && values.agentTarget !== null
                    && buildBackendTargetKeyV2(values.agentTarget) === buildBackendTargetKeyV2(option.target);
                // The native detail edits string choices. Other valid typed overrides
                // remain authored; changing Agent or resetting the engine clears them.
                const overrides = {
                    ...Object.fromEntries(Object.entries(matches ? values.sessionConfigOptionOverrides?.overrides ?? {} : {})
                        .filter(([, override]) => typeof override.value !== 'string')),
                    ...Object.fromEntries(Object.entries(selection.configOverrides).map(([id, value]) => [id, { value, updatedAt }])),
                };
                latest.current.onChangeFields({
                    agentTarget: option.target,
                    modelSelection: selection.modelSelection ?? buildSessionModelSelectionForAgentTarget({
                        agentTarget: option.target, modelId: selection.modelId, updatedAt,
                    }),
                    acpSessionModeId: selection.sessionModeId,
                    sessionConfigOptionOverrides: Object.keys(overrides).length === 0 ? null : buildAcpConfigOptionOverridesV1({ updatedAt, overrides }),
                });
            };
            const backendTarget: PersistedBackendTargetRefV2 = option.backendTarget ?? option.target;
            return {
                closeOnSelectImmediate: false,
                onSelectImmediate: () => apply(readSelection()),
                renderDetailContent: () => buildSessionAgentPickerDetailContent({
                    agentCatalogEntry: entry.agentCatalogEntry,
                    backendTarget, runtimeCarrierAgentId: option.agentId,
                    selectedMachineId: context?.machineId ?? null,
                    capabilityServerId: context?.serverId ?? '', cwd: context?.directory ?? null,
                    settings, selection: readSelection(), onSelectionChange: apply,
                }),
            };
        },
    }), [targets, context, params.disabled, params.roleSelection, settings]);
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
