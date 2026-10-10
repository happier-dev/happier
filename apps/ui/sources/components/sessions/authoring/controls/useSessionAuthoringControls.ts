import * as React from 'react';

import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import type { ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import {
    DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS,
    resolveChipOptionInteraction,
    shouldRenderChipForOptions,
    type ChipOptionInteraction,
} from '@/components/sessions/agentInput/chipOptionInteraction';
import {
    resolveSessionModeChipPresentation,
    type SessionModeChipPresentation,
} from '@/components/sessions/agentInput/controls/resolveSessionModeChipPresentation';
import {
    reportedModelSummary,
    resolveReportedModelStatus,
    type ReportedModelStatus,
} from '@/components/sessions/modelPicker/reportedModelPresentation';
import { describeEffectiveModelMode } from '@/sync/domains/models/describeEffectiveModelMode';
import { buildExtendedContextModelControl } from '@/sync/domains/models/extendedContextModelControl';
import {
    findModelOptionForEffectiveModelId,
    getModelOptionsForSession,
    supportsFreeformModelSelectionForSession,
    type ModelOption,
} from '@/sync/domains/models/modelOptions';
import { describeEffectivePermissionMode } from '@/sync/domains/permissions/describeEffectivePermissionMode';
import {
    getPermissionModeBadgeLabelForAgentType,
    getPermissionModeLabelForAgentType,
    getPermissionModeOptionsForSession,
    restrictPermissionModeOptions,
} from '@/sync/domains/permissions/permissionModeOptions';
import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import {
    computeAcpConfigOptionControls,
    computeAcpConfigOptionControlsFromOverride,
    resolveSessionConfigOptionOverridesFromMetadata,
    type AcpConfigOptionControl,
    type SessionConfigOptionInput,
} from '@/sync/domains/sessionControl/configOptionsControl';
import { computeSessionModePickerControl, getSessionModePickerOptions, resolveRequestedSessionModeIdForMetadata } from '@/sync/domains/sessionControl/sessionModeControl';
import { useSetting } from '@/sync/domains/state/storage';
import type { Metadata } from '@happier-dev/session-core/state';
import { t } from '@/text';

/**
 * The one owner of effective Session-authoring policy.
 *
 * Model options, the effective permission and model descriptions, the ACP
 * session-mode composition and the configuration-option controls are the same
 * facts whether the values are being authored in the live composer or in a
 * workflow step. They were previously computed inline inside `AgentInput`, so a
 * second authoring surface could only have re-derived them — a split brain over
 * "what is actually selected". Both callers now read them here.
 *
 * This hook resolves facts only. Applying a selection stays with the caller that
 * owns the value, so nothing here can navigate, persist a remembered selection,
 * or write a preference merely because a value changed.
 */

type SessionModeOptionOverride = Readonly<{ id: string; name: string; description?: string }>;

export type SessionAuthoringSessionModeChipControl = Readonly<{
    options: ReadonlyArray<SessionModeOptionOverride>;
    selectedId: string | null;
    label: string;
    isPending: boolean;
}>;

export type SessionAuthoringAppliedModelPresentation = Readonly<{
    optionValue: string;
    status: ReportedModelStatus;
    summary: string;
}>;

export type SessionAuthoringControlsInput = Readonly<{
    /** The Agent identity whose static policy answers these questions. */
    agentId: string;
    /** Present when Session safety intent is previewed for an armed continuation. */
    permissionTargetAgentId?: string | null;
    metadata?: Metadata | null;
    composerOptionsInput?: ComposerOptionsInputV1 | null;
    sessionId?: string;
    sessionActive?: boolean;
    permissionMode?: PermissionMode | null;
    /** An embed's allowed modes (`grant.permissionModes`); the options narrow to them. `null` = all. */
    allowedPermissionModes?: readonly PermissionMode[] | null;
    modelMode?: ModelMode | null;
    modelOptionsOverride?: readonly ModelOption[] | null;
    /** Capability facts, not handlers: the caller keeps its own mutation owner. */
    canChangeModel: boolean;
    canChangeSessionMode: boolean;
    canChangeConfigOption: boolean;
    acpSessionModeOptionsOverride?: ReadonlyArray<SessionModeOptionOverride> | null;
    acpSessionModeSelectedIdOverride?: string | null;
    acpConfigOptionsOverride?: ReadonlyArray<SessionConfigOptionInput> | null;
    acpConfigOptionOverridesOverride?: AcpConfigOptionOverridesV1 | null;
}>;

export type SessionAuthoringControls = Readonly<{
    modelOptions: readonly ModelOption[];
    permissionModeOptions: ReturnType<typeof getPermissionModeOptionsForSession>;
    permissionModeOrder: readonly PermissionMode[];
    effectivePermissionPolicy: ReturnType<typeof describeEffectivePermissionMode>;
    effectivePermissionLabel: string;
    permissionChipLabel: string;
    effectiveModelPolicy: ReturnType<typeof describeEffectiveModelMode>;
    selectedModelLabel: string;
    appliedModelPresentation: SessionAuthoringAppliedModelPresentation | null;
    modelApplyTiming: string;
    modelNotes: readonly string[];
    canEnterCustomModel: boolean;
    shouldShowModelOptionDescriptions: boolean;
    selectedModelForControls: ModelOption | null;
    selectedModelOptionControls: readonly AcpConfigOptionControl[] | null;
    acpConfigOptionControls: readonly AcpConfigOptionControl[] | null;
    sessionModeChipControl: SessionAuthoringSessionModeChipControl | null;
    sessionModePickerOptions: ReadonlyArray<AgentInputChipPickerOption>;
    shouldRenderSessionModeChip: boolean;
    sessionModeChipPresentation: SessionModeChipPresentation | null;
    sessionModeChipInteraction: ChipOptionInteraction<string> | null;
}>;

export function useSessionAuthoringControls(
    input: SessionAuthoringControlsInput,
): SessionAuthoringControls {
    const {
        agentId,
        canChangeConfigOption,
        canChangeModel,
        canChangeSessionMode,
    } = input;
    const metadata = input.metadata ?? null;
    const permissionAgentId = input.permissionTargetAgentId ?? agentId;
    const permissionMetadata = input.permissionTargetAgentId ? null : metadata;
    const composerOptionsInput = input.composerOptionsInput === undefined ? metadata : input.composerOptionsInput;
    const modelOptionsOverride = input.modelOptionsOverride ?? null;
    const acpConfigOptionsOverride = input.acpConfigOptionsOverride ?? null;
    const acpConfigOptionOverridesOverride = input.acpConfigOptionOverridesOverride ?? null;

    const sessionPermissionModeApplyTiming = useSetting('sessionPermissionModeApplyTiming');

    const modelOptions = React.useMemo(() => modelOptionsOverride
        ?? getModelOptionsForSession(agentId, composerOptionsInput, { selectedModelId: input.modelMode }),
    [agentId, composerOptionsInput, modelOptionsOverride, input.modelMode]);

    const allowedPermissionModes = input.allowedPermissionModes ?? null;
    const permissionModeOptions = React.useMemo(() => {
        return restrictPermissionModeOptions(getPermissionModeOptionsForSession(permissionAgentId, permissionMetadata), allowedPermissionModes);
    }, [permissionAgentId, allowedPermissionModes, permissionMetadata]);

    const permissionModeOrder = React.useMemo(() => {
        return permissionModeOptions.map((option) => option.value);
    }, [permissionModeOptions]);

    const effectivePermissionPolicy = React.useMemo(() => {
        return describeEffectivePermissionMode({
            agentType: permissionAgentId,
            selectedMode: input.permissionMode ?? 'default',
            metadata: permissionMetadata,
            applyTiming: sessionPermissionModeApplyTiming ?? 'immediate',
        });
    }, [permissionAgentId, input.permissionMode, permissionMetadata, sessionPermissionModeApplyTiming]);

    const effectivePermissionLabel = React.useMemo(() => {
        return effectivePermissionPolicy.nativeModeLabel ?? getPermissionModeLabelForAgentType(permissionAgentId, effectivePermissionPolicy.effectiveMode);
    }, [permissionAgentId, effectivePermissionPolicy.effectiveMode, effectivePermissionPolicy.nativeModeLabel]);

    const permissionChipLabel = React.useMemo(() => {
        return getPermissionModeBadgeLabelForAgentType(permissionAgentId, effectivePermissionPolicy.effectiveMode);
    }, [permissionAgentId, effectivePermissionPolicy.effectiveMode]);

    const effectiveModelPolicy = React.useMemo(() => {
        return describeEffectiveModelMode({
            agentType: agentId,
            selectedModelId: input.modelMode ?? 'default',
            metadata,
            composerOptionsInput,
        });
    }, [agentId, input.modelMode, metadata, composerOptionsInput]);

    const selectedModelLabel = React.useMemo(() => {
        const found = findModelOptionForEffectiveModelId(modelOptions, effectiveModelPolicy.selectedModelId);
        if (found) return found.label;
        return effectiveModelPolicy.selectedModelId === 'default'
            ? t('agentInput.model.useCliSettings')
            : effectiveModelPolicy.selectedModelId;
    }, [effectiveModelPolicy.selectedModelId, modelOptions]);

    const appliedModelPresentation = React.useMemo<SessionAuthoringAppliedModelPresentation | null>(() => {
        const appliedModelId = effectiveModelPolicy.appliedModelId;
        if (!appliedModelId) return null;
        const found = findModelOptionForEffectiveModelId(modelOptions, appliedModelId);
        const label = found?.label ?? appliedModelId;
        const status: ReportedModelStatus = resolveReportedModelStatus(input.sessionActive);
        return {
            optionValue: found?.value ?? appliedModelId,
            status,
            summary: reportedModelSummary(status, label),
        };
    }, [effectiveModelPolicy.appliedModelId, input.sessionActive, modelOptions]);

    // One line under the section label: what is running, and when a change to it
    // takes effect. Anything a provider adds beyond that stays a note, so the
    // ordinary case is a label, a line and the models — never a paragraph.
    const modelApplyTiming = React.useMemo(() => (
        effectiveModelPolicy.applyScope === 'spawn_only'
            ? t('agentInput.model.applyTimingNewSession')
            : t('agentInput.model.applyTimingNextMessage')
    ), [effectiveModelPolicy.applyScope]);

    const modelNotes = React.useMemo(() => {
        if (input.sessionActive === false) {
            return [t('agentInput.model.selectedForResume')];
        }
        return effectiveModelPolicy.notes;
    }, [effectiveModelPolicy.notes, input.sessionActive]);

    const canEnterCustomModel = React.useMemo(() => {
        return supportsFreeformModelSelectionForSession(agentId, composerOptionsInput);
    }, [agentId, composerOptionsInput]);

    const shouldShowModelOptionDescriptions = React.useMemo(() => {
        return modelOptions.some((option) => {
            if (option.value === 'default') return false;
            return typeof option.description === 'string' && option.description.trim().length > 0;
        });
    }, [modelOptions]);

    const preflightAcpSessionModeOptions = React.useMemo(() => {
        const raw = input.acpSessionModeOptionsOverride;
        if (!Array.isArray(raw) || raw.length === 0) return null;
        const cleaned = raw
            .filter((mode) => mode && typeof mode.id === 'string' && typeof mode.name === 'string')
            .map((mode) => ({
                id: String(mode.id),
                name: String(mode.name),
                ...(typeof mode.description === 'string' ? { description: mode.description } : {}),
            }))
            .filter((mode) => mode.id.trim().length > 0 && mode.name.trim().length > 0);
        return cleaned.length > 0 ? cleaned : null;
    }, [input.acpSessionModeOptionsOverride]);

    const sessionModePickerControl = React.useMemo(() => {
        if (!canChangeSessionMode) return null;
        // When preflight options are provided (e.g. New Session), prefer the override surface so
        // selections can be reflected immediately without relying on session metadata updates.
        if (preflightAcpSessionModeOptions) return null;
        return computeSessionModePickerControl({ agentId, metadata });
    }, [agentId, canChangeSessionMode, metadata, preflightAcpSessionModeOptions]);

    const preflightAcpSessionModeEffective = React.useMemo(() => {
        const selected = typeof input.acpSessionModeSelectedIdOverride === 'string'
            ? input.acpSessionModeSelectedIdOverride.trim()
            : '';
        const pickerOptions = preflightAcpSessionModeOptions
            ? getSessionModePickerOptions(preflightAcpSessionModeOptions, agentId)
            : [];
        const effectiveId = selected || (pickerOptions.some((option) => option.id === '') ? '' : 'default');
        const option = pickerOptions.find((candidate) => candidate.id === effectiveId) ?? null;
        return {
            id: effectiveId,
            name: option?.name ?? (effectiveId === 'default' ? t('common.default') : effectiveId),
        };
    }, [agentId, input.acpSessionModeSelectedIdOverride, preflightAcpSessionModeOptions]);

    const sessionModeChipControl = React.useMemo<SessionAuthoringSessionModeChipControl | null>(() => {
        if (!canChangeSessionMode) return null;
        if (sessionModePickerControl) {
            const clearOption = sessionModePickerControl.isExplicitOverride ? undefined
                : getSessionModePickerOptions(sessionModePickerControl.options, agentId).find((option) =>
                    resolveRequestedSessionModeIdForMetadata(sessionModePickerControl, option.id) === '');
            return {
                options: sessionModePickerControl.options,
                selectedId: (
                    clearOption?.id
                    ?? sessionModePickerControl.requestedModeId
                    ?? sessionModePickerControl.effectiveModeId
                ),
                label: sessionModePickerControl.effectiveModeName,
                isPending: sessionModePickerControl.isPending,
            };
        }
        if (preflightAcpSessionModeOptions) {
            return {
                options: preflightAcpSessionModeOptions,
                selectedId: preflightAcpSessionModeEffective.id,
                label: preflightAcpSessionModeEffective.name,
                isPending: false,
            };
        }
        return null;
    }, [
        agentId,
        canChangeSessionMode,
        preflightAcpSessionModeEffective.id,
        preflightAcpSessionModeEffective.name,
        preflightAcpSessionModeOptions,
        sessionModePickerControl,
    ]);

    const sessionModePickerOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(() => {
        if (!sessionModeChipControl) return [];
        return getSessionModePickerOptions(sessionModeChipControl.options, agentId).map((option) => ({
            id: option.id,
            label: option.name,
            subtitle: option.description,
        }));
    }, [agentId, sessionModeChipControl]);

    const shouldRenderSessionModeChip = React.useMemo(() => {
        return shouldRenderChipForOptions({
            optionCount: sessionModePickerOptions.length,
            showWhenNoOptions: false,
            showWhenSingleOption: false,
        });
    }, [sessionModePickerOptions.length]);

    const sessionModeChipPresentation = React.useMemo(() => {
        return sessionModeChipControl ? resolveSessionModeChipPresentation(sessionModeChipControl) : null;
    }, [sessionModeChipControl]);

    const sessionModeChipInteraction = React.useMemo(() => {
        if (!sessionModeChipControl) return null;
        const selectableOptionIds = sessionModePickerOptions.map((option) => option.id);
        return resolveChipOptionInteraction({
            currentOptionId: sessionModeChipControl.selectedId,
            selectableOptionIds,
            cycleMaxOptions: DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS,
        });
    }, [sessionModeChipControl, sessionModePickerOptions]);

    const acpConfigOptionControls = React.useMemo(() => {
        if (!canChangeConfigOption) return null;
        if (acpConfigOptionsOverride) {
            return computeAcpConfigOptionControlsFromOverride({
                agentId,
                configOptions: acpConfigOptionsOverride,
                overrides: acpConfigOptionOverridesOverride?.overrides ?? null,
            });
        }
        return computeAcpConfigOptionControls({ agentId, metadata });
    }, [
        acpConfigOptionOverridesOverride,
        acpConfigOptionsOverride,
        agentId,
        canChangeConfigOption,
        metadata,
    ]);

    const selectedModelForControls = React.useMemo(() => (
        findModelOptionForEffectiveModelId(modelOptions, effectiveModelPolicy.selectedModelId)
    ), [effectiveModelPolicy.selectedModelId, modelOptions]);

    const selectedModelOptionControls = React.useMemo(() => {
        const baseControls = canChangeConfigOption && selectedModelForControls?.modelOptions?.length
            ? [...(computeAcpConfigOptionControlsFromOverride({
                agentId,
                configOptions: selectedModelForControls.modelOptions,
                overrides: acpConfigOptionOverridesOverride?.overrides ?? resolveSessionConfigOptionOverridesFromMetadata({
                    metadata: composerOptionsInput, configOptions: selectedModelForControls.modelOptions,
                }),
            }) ?? [])]
            : [];
        const extendedContextControl = canChangeModel
            ? buildExtendedContextModelControl({
                model: selectedModelForControls,
                effectiveModelId: effectiveModelPolicy.selectedModelId,
            })
            : null;
        if (extendedContextControl) baseControls.push(extendedContextControl);
        return baseControls.length > 0 ? baseControls : null;
    }, [
        acpConfigOptionOverridesOverride,
        agentId,
        canChangeConfigOption,
        canChangeModel,
        effectiveModelPolicy.selectedModelId,
        selectedModelForControls,
        composerOptionsInput,
    ]);

    return {
        modelOptions,
        permissionModeOptions,
        permissionModeOrder,
        effectivePermissionPolicy,
        effectivePermissionLabel,
        permissionChipLabel,
        effectiveModelPolicy,
        selectedModelLabel,
        appliedModelPresentation,
        modelApplyTiming,
        modelNotes,
        canEnterCustomModel,
        shouldShowModelOptionDescriptions,
        selectedModelForControls,
        selectedModelOptionControls,
        acpConfigOptionControls,
        sessionModeChipControl,
        sessionModePickerOptions,
        shouldRenderSessionModeChip,
        sessionModeChipPresentation,
        sessionModeChipInteraction,
    };
}
