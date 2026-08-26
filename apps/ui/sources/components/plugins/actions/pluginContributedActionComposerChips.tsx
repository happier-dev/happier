import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import {
    redactBugReportSensitiveText,
    trimBugReportTextHeadToMaxBytes,
    trimBugReportTextToMaxBytes,
} from '@happier-dev/protocol';
import { PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1 } from '@happier-dev/protocol/plugins/ui';
import type {
    ComposerControlStateV1,
    ComposerOperationV1,
    ComposerScopeKindV1,
    ComposerTransactionResultV1,
    PluginContributionIdentityV1,
    PluginProjectedComposerControlEntryV1,
} from '@happier-dev/protocol';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';

import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipCollapsedPopoverRenderContext,
} from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { AgentInputChipPickerPopover } from '@/components/sessions/agentInput/components/AgentInputChipPickerPopover';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import type { ActionListItem, ActionListItemContent } from '@/components/ui/lists/ActionListSection';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import type { SelectionListStep } from '@/components/ui/selectionList';
import {
    AGENT_INPUT_CHIP_ICON_SIZE_PX,
    AGENT_INPUT_CHIP_ICON_STYLE,
    AGENT_INPUT_MENU_ICON_SIZE_PX,
} from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import type { FocusReturnRef } from '@/keyboard/focusReturn';
import { log } from '@/log';

import type {
    PluginContributedActionController,
    PluginContributedActionDescriptor,
} from './pluginContributedActionController';
import { resolvePluginContributedActionIconName } from './pluginContributedActionPresentation';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';

const COMPOSER_CONTROL_UNKNOWN_CHOICE_ID_SAMPLE_COUNT = 3;
const COMPOSER_CONTROL_UNKNOWN_CHOICE_ID_SAMPLE_MAX_UTF8_BYTES = 96;

function resolveComposerChipPhysicalTargetStyle(): Readonly<{ minWidth: number; minHeight: number }> | undefined {
    const platform = Platform.OS;
    if (platform !== 'ios' && platform !== 'android') return undefined;
    const targetSize = resolveMinimumInteractiveTargetSize(platform);
    return { minWidth: targetSize, minHeight: targetSize };
}

function actionChipKey(action: PluginContributedActionDescriptor): string {
    return `plugin-contributed-action:${action.placement}:${action.qualifiedActionId}`;
}

function actionMenuId(action: PluginContributedActionDescriptor): string {
    return `plugin-contributed-action:${action.placement}:${action.qualifiedActionId}`;
}

function composerControlId(control: PluginProjectedComposerControlEntryV1): `plugin:${string}` {
    return `plugin:${control.id}`;
}

function composerControlKey(control: PluginProjectedComposerControlEntryV1): string {
    return `plugin-composer-control:${control.id}`;
}

function composerControlMenuId(control: PluginProjectedComposerControlEntryV1): string {
    return `plugin-composer-control:${control.id}`;
}

function createComposerActionChip(params: Readonly<{
    action: PluginContributedActionDescriptor;
    openAction: (action: PluginContributedActionDescriptor) => void;
}>): AgentInputExtraActionChip {
    const invoke = () => params.openAction(params.action);
    const isPrimary = params.action.placement === 'composer.primary';
    const iconName = resolvePluginContributedActionIconName(params.action.icon);

    return {
        key: actionChipKey(params.action),
        // `shortcuts` is the incumbent composer Action row/overflow control. It
        // decides responsive collapse and menu order; this adapter only supplies
        // controller-admitted Action descriptors, never a second catalog.
        controlId: 'shortcuts',
        collapsedAction: ({ dismiss, tint }) => ({
            id: actionMenuId(params.action),
            label: params.action.title,
            ...(params.action.description ? { subtitle: params.action.description } : {}),
            icon: <Icon name={iconName} size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />,
            onPress: () => {
                dismiss();
                invoke();
            },
        }),
        render: ({ chipStyle, iconColor, showLabel, textStyle }) => {
            // `composer.more` Actions belong to the overflow menu. Returning
            // no row node preserves the declared semantic placement rather
            // than treating it as a lower-priority primary Action.
            if (!isPrimary) return null;
            return (
                <Pressable
                    testID={`plugin-composer-action:${params.action.qualifiedActionId}`}
                    accessibilityRole="button"
                    accessibilityLabel={params.action.title}
                    onPress={invoke}
                    style={({ pressed }) => [chipStyle(pressed), resolveComposerChipPhysicalTargetStyle()]}
                >
                    <Icon
                        name={iconName}
                        size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
                        color={iconColor}
                        style={AGENT_INPUT_CHIP_ICON_STYLE}
                    />
                    {showLabel ? <Text numberOfLines={1} style={textStyle}>{params.action.title}</Text> : null}
                </Pressable>
            );
        },
    };
}

/** A thin private adapter into the existing PluginSurfaceHost mount arm. */
export type PluginComposerControlSurfacePresentation =
    | Readonly<{
        kind: 'control';
        role: 'compact';
        control: PluginProjectedComposerControlEntryV1;
        state: ComposerControlStateV1;
    }>
    | Readonly<{
        kind: 'control';
        role: 'interaction';
        control: PluginProjectedComposerControlEntryV1;
        state: ComposerControlStateV1;
        presentation: 'popover' | 'dialog';
        layout: 'content' | 'list' | 'split';
    }>
    | Readonly<{
        kind: 'attachmentPicker';
        role: 'interaction';
        control: PluginProjectedComposerControlEntryV1;
        state: ComposerControlStateV1;
        attachmentLocalId: string;
        presentation: 'popover' | 'dialog';
        layout: 'content' | 'list' | 'split';
    }>;

type PluginComposerControlInteractionSurfacePresentation = Extract<
    PluginComposerControlSurfacePresentation,
    Readonly<{ role: 'interaction' }>
>;

type PluginComposerControlDialogPresentation = PluginComposerControlInteractionSurfacePresentation
    & Readonly<{ presentation: 'dialog' }>;

/**
 * The caller owns every real side effect and every lifecycle source. This
 * adapter only turns an admitted control into incumbent AgentInput chrome.
 */
export type PluginComposerControlHost = Readonly<{
    scope: ComposerScopeKindV1;
    isCurrent: () => boolean;
    /**
     * Resolves the control's declared `PluginLocalizedString` labels for the
     * current locale. The presentation owner supplies the one projection-bound
     * resolver; reading `.fallback` here pinned every admitted control, choice
     * and dialog title to the plugin's authored English.
     */
    localize: PluginLocalizedTextResolver;
    /**
     * The presentation owner supplies the one existing contextual Resource
     * lease. This adapter consumes its validated/LKG state together with the
     * canonical Resource observation only at the control's render boundary;
     * static controls never call it.
     */
    renderControlResourceState: (input: Readonly<{
        control: PluginProjectedComposerControlEntryV1;
        children: (
            state: ComposerControlStateV1 | null,
            resource: PluginUiResourceSnapshot | null,
        ) => React.ReactNode;
    }>) => React.ReactNode;
    openAction: (input: Readonly<{
        control: PluginProjectedComposerControlEntryV1;
        action: PluginContributionIdentityV1;
        input?: unknown;
    }>) => void;
    /**
     * Returns the canonical transaction result so the affordance can retain a
     * conflict or non-editable outcome instead of presenting it as applied.
     */
    applyComposer: (input: Readonly<{
        control: PluginProjectedComposerControlEntryV1;
        operations: readonly ComposerOperationV1[];
    }>) => ComposerTransactionResultV1;
    /**
     * Whether the exact current Composer document would accept a mutation
     * (`ComposerSnapshotV1.state.editable`). A read-only Session or an
     * `editAndSubmit` lock refuses the transaction, so a `composerApply`
     * choice must present as disabled instead of silently no-opping. Action,
     * destination and surface choices are unaffected.
     */
    canMutateComposer: () => boolean;
    openDestination: (input: Readonly<{
        control: PluginProjectedComposerControlEntryV1;
        destination: PluginContributionIdentityV1;
    }>) => void;
    renderSurfaceContent: (presentation: PluginComposerControlSurfacePresentation) => React.ReactNode;
    /**
     * The originating trigger is supplied by whichever affordance opened the
     * dialog — the visible chip or the collapsed action menu — so native
     * dismissal restores focus to it through the incumbent modal owner.
     */
    openSurfaceDialog: (
        presentation: PluginComposerControlDialogPresentation,
        options?: Readonly<{ focusReturnRef?: FocusReturnRef }>,
    ) => void;
}>;

type ResolvedComposerControlState = Readonly<{
    visible: boolean;
    enabled: boolean;
    /**
     * Whether this control has an on/off state at all. A control that never
     * reports one is an ordinary button, and announcing it as an unpressed
     * toggle would be a lie; one that does is a toggle in both states.
     */
    expressesSelection: boolean;
    label: string;
    icon: PluginProjectedComposerControlEntryV1['definition']['icon'];
    count: number | undefined;
    selected: boolean;
    selectedChoiceIds: readonly string[];
    accessibilityLabel: string;
    unavailableReason: string | undefined;
}>;

type ResolvedComposerControlChoiceSelection = Readonly<{
    selectedChoiceIds: readonly string[];
    unknownChoiceIds: readonly string[];
}>;

type ComposerControlUnknownChoiceDiagnosticRecord = {
    reported: boolean;
};

/** Binds the host's projection-backed resolver to one control's plugin. */
function controlTextResolver(
    control: PluginProjectedComposerControlEntryV1,
    localize: PluginLocalizedTextResolver,
): (value: unknown) => string {
    return (value) => localize(control.identity.pluginId, value);
}

function qualifiesForComposerScope(
    control: PluginProjectedComposerControlEntryV1,
    scope: ComposerScopeKindV1,
): boolean {
    return control.definition.scopes === undefined || control.definition.scopes.includes(scope);
}

function qualifyContributionReference(
    control: PluginProjectedComposerControlEntryV1,
    reference: string | PluginContributionIdentityV1,
): PluginContributionIdentityV1 {
    return typeof reference === 'string'
        ? { pluginId: control.identity.pluginId, localId: reference }
        : reference;
}

/** Applies declaration → validated Resource precedence. */
function resolveComposerControlState(
    control: PluginProjectedComposerControlEntryV1,
    resource: ComposerControlStateV1 | null,
    localize: PluginLocalizedTextResolver,
): ResolvedComposerControlState {
    const definition = control.definition;
    const localized = controlTextResolver(control, localize);

    let visible = true;
    let enabled = true;
    let label = localized(definition.label);
    let icon = definition.icon;
    let count: number | undefined;
    let selected = false;
    let selectedChoiceIds: readonly string[] = [];
    let accessibilityLabel: string | undefined;
    let unavailableReason: string | undefined;

    if (resource) {
        visible = resource.visible ?? visible;
        enabled = resource.enabled ?? enabled;
        selectedChoiceIds = resource.selectedChoiceIds ?? selectedChoiceIds;
        accessibilityLabel = resource.accessibilityLabel ?? accessibilityLabel;
        unavailableReason = resource.unavailableReason ?? unavailableReason;
        label = resource.label ?? label;
        icon = resource.icon ?? icon;
        count = resource.count ?? count;
        selected = resource.selected ?? selected;
    }

    return {
        visible,
        enabled,
        expressesSelection: resource?.selected !== undefined,
        label,
        icon,
        count,
        selected,
        selectedChoiceIds,
        accessibilityLabel: accessibilityLabel ?? label,
        unavailableReason,
    };
}

/**
 * Renderer mounts consume the protocol shape, rather than this adapter's
 * readonly working representation. Copy the choice ids so the protocol's
 * mutable-array inference does not leak into the control projection.
 */
function materializeComposerControlSurfaceState(
    state: ResolvedComposerControlState,
    selectedChoiceIds: readonly string[] = state.selectedChoiceIds,
): ComposerControlStateV1 {
    return {
        visible: state.visible,
        enabled: state.enabled,
        label: state.label,
        icon: state.icon,
        ...(state.count === undefined ? {} : { count: state.count }),
        selected: state.selected,
        selectedChoiceIds: [...selectedChoiceIds],
        accessibilityLabel: state.accessibilityLabel,
        ...(state.unavailableReason === undefined ? {} : { unavailableReason: state.unavailableReason }),
    };
}

function resolveSelectedChoiceIds(
    control: PluginProjectedComposerControlEntryV1,
    state: ResolvedComposerControlState,
): ResolvedComposerControlChoiceSelection {
    const interaction = control.definition.interaction;
    if (interaction.kind !== 'choices') {
        return { selectedChoiceIds: [], unknownChoiceIds: [] };
    }

    const declaredIds = new Set(interaction.options.map((option) => option.id));
    const selectedChoiceIds: string[] = [];
    const unknownChoiceIds: string[] = [];
    const seenSelectedIds = new Set<string>();
    const seenUnknownIds = new Set<string>();
    for (const id of state.selectedChoiceIds) {
        if (!declaredIds.has(id)) {
            if (!seenUnknownIds.has(id)) {
                seenUnknownIds.add(id);
                unknownChoiceIds.push(id);
            }
            continue;
        }
        if (seenSelectedIds.has(id)) continue;
        seenSelectedIds.add(id);
        selectedChoiceIds.push(id);
    }
    return {
        selectedChoiceIds: interaction.selection === 'single'
            ? selectedChoiceIds.slice(0, 1)
            : selectedChoiceIds,
        unknownChoiceIds,
    };
}

function resolveOverflowPresentation(
    control: PluginProjectedComposerControlEntryV1,
    state: ResolvedComposerControlState,
    localize: PluginLocalizedTextResolver,
): Readonly<{
    label: string;
    accessibilityLabel: string;
    icon: PluginProjectedComposerControlEntryV1['definition']['icon'];
}> {
    const overflow = control.definition.overflow;
    return {
        label: overflow ? controlTextResolver(control, localize)(overflow.label) : state.label,
        accessibilityLabel: overflow?.accessibilityLabel === undefined
            ? state.accessibilityLabel
            : controlTextResolver(control, localize)(overflow.accessibilityLabel),
        icon: overflow?.icon ?? state.icon,
    };
}

function resolveInteractionSurfacePresentation(
    control: PluginProjectedComposerControlEntryV1,
    state: ResolvedComposerControlState,
    selectedChoiceIds: readonly string[],
): PluginComposerControlInteractionSurfacePresentation | null {
    const interaction = control.definition.interaction;
    const overflowPresentation = control.definition.overflow?.presentation;
    if (interaction.kind === 'surface') {
        return {
            kind: 'control',
            role: 'interaction',
            control,
            state: materializeComposerControlSurfaceState(state, selectedChoiceIds),
            presentation: overflowPresentation?.presentation ?? interaction.presentation,
            layout: overflowPresentation?.layout ?? interaction.layout,
        };
    }
    if (interaction.kind === 'attachmentPicker') {
        return {
            kind: 'attachmentPicker',
            role: 'interaction',
            control,
            state: materializeComposerControlSurfaceState(state, selectedChoiceIds),
            attachmentLocalId: interaction.attachment,
            presentation: overflowPresentation?.presentation ?? interaction.presentation,
            layout: overflowPresentation?.layout ?? interaction.layout,
        };
    }
    return null;
}

function controlMenuIcon(
    icon: PluginProjectedComposerControlEntryV1['definition']['icon'],
    tint: string,
): React.ReactNode {
    return <Icon name={resolvePluginUiIconName(icon)} size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />;
}

function createChoicePopover(params: Readonly<{
    control: PluginProjectedComposerControlEntryV1;
    host: PluginComposerControlHost;
    state: ResolvedComposerControlState;
    selectedChoiceIds: readonly string[];
    canInteract: () => boolean;
    overflowLabel: string;
    overflowAccessibilityLabel: string;
    overflowIcon: PluginProjectedComposerControlEntryV1['definition']['icon'];
}>): NonNullable<AgentInputExtraActionChip['collapsedOptionsPopover']> {
    const interaction = params.control.definition.interaction;
    if (interaction.kind !== 'choices') {
        throw new Error('Composer choice popover requires a choices interaction.');
    }
    const choiceText = controlTextResolver(params.control, params.host.localize);
    const selectedIds = new Set(params.selectedChoiceIds);
    const isChoiceDisabled = (choice: typeof interaction.options[number]): boolean => (
        choice.disabled === true
        || (choice.effect.kind === 'composerApply' && !params.host.canMutateComposer())
    );
    /** `false` means the choice was refused, so its affordance must stay open. */
    const invokeChoice = (choice: typeof interaction.options[number]): boolean => {
        if (!params.canInteract() || isChoiceDisabled(choice)) return false;
        if (choice.effect.kind === 'action') {
            params.host.openAction({
                control: params.control,
                action: qualifyContributionReference(params.control, choice.effect.action),
                ...(choice.effect.input === undefined ? {} : { input: choice.effect.input }),
            });
            return true;
        }
        return params.host.applyComposer({
            control: params.control,
            operations: choice.effect.operations,
        }).status === 'applied';
    };
    const disabled = !params.canInteract();

    if (interaction.selection === 'single') {
        const options: readonly AgentInputChipPickerOption[] = interaction.options.map((choice) => ({
            id: choice.id,
            label: choiceText(choice.label),
            ...(choice.description === undefined ? {} : { subtitle: choiceText(choice.description) }),
            ...(choice.icon === undefined ? {} : { icon: <Icon name={resolvePluginUiIconName(choice.icon)} size={16} /> }),
            ...(isChoiceDisabled(choice) || disabled ? { disabled: true } : {}),
        }));
        return {
            title: params.overflowLabel,
            label: params.overflowLabel,
            accessibilityLabel: params.overflowAccessibilityLabel,
            icon: (tint) => controlMenuIcon(params.overflowIcon, tint),
            disabled,
            isEnabled: params.canInteract,
            selectedOptionId: params.selectedChoiceIds[0] ?? null,
            options,
            onSelect: (id) => {
                const choice = interaction.options.find((candidate) => candidate.id === id);
                return choice ? invokeChoice(choice) : false;
            },
        };
    }

    const rootStep: SelectionListStep = {
        id: `${composerControlKey(params.control)}:choices`,
        title: params.overflowLabel,
        sections: [{
            kind: 'static',
            id: `${composerControlKey(params.control)}:choices`,
            options: interaction.options.map((choice) => ({
                id: choice.id,
                label: choiceText(choice.label),
                ...(choice.description === undefined ? {} : { subtitle: choiceText(choice.description) }),
                ...(choice.icon === undefined ? {} : { icon: <Icon name={resolvePluginUiIconName(choice.icon)} size={16} /> }),
                ...(selectedIds.has(choice.id) ? { rightAccessory: <Icon name="check" size={16} /> } : {}),
                ...(isChoiceDisabled(choice) || disabled ? { disabled: true } : {}),
                onSelect: () => invokeChoice(choice),
            })),
        }],
    };
    return {
        presentation: 'list',
        title: params.overflowLabel,
        label: params.overflowLabel,
        accessibilityLabel: params.overflowAccessibilityLabel,
        icon: (tint) => controlMenuIcon(params.overflowIcon, tint),
        disabled,
        isEnabled: params.canInteract,
        rootStep,
        selectedOptionId: null,
        onSelect: () => {
            // List rows own the immediate effect and the shared wrapper owns
            // close-after-select; the descriptor-level callback is inert.
        },
    };
}

type ResolvedComposerControlInteraction = Readonly<{
    state: ResolvedComposerControlState;
    selected: boolean;
    unknownChoiceIds: readonly string[];
    canInteract: () => boolean;
    overflow: Readonly<{
        label: string;
        accessibilityLabel: string;
        icon: PluginProjectedComposerControlEntryV1['definition']['icon'];
    }>;
    choicePopover: NonNullable<AgentInputExtraActionChip['collapsedOptionsPopover']> | undefined;
    contentPopover: ComposerControlSurfacePopover | undefined;
    opensCollapsedPopover: boolean;
    invokeDirectInteraction: (focusReturnRef?: FocusReturnRef) => void;
    compactPresentation: PluginComposerControlSurfacePresentation | null;
}>;

type ComposerControlSurfacePopover = Readonly<{
    title: string;
    label: string;
    accessibilityLabel: string;
    icon: (tint: string) => React.ReactNode;
    disabled: boolean;
    isEnabled: () => boolean;
    layout: 'content' | 'list' | 'split';
    renderContent: () => React.ReactNode;
}>;

type ComposerCollapsedActionContext = Parameters<NonNullable<AgentInputExtraActionChip['collapsedAction']>>[0];

type ComposerCollapsedItemRenderer = (
    item: ActionListItemContent,
    renderDefaultItem: (item: ActionListItemContent) => React.ReactNode,
) => React.ReactNode;

function resolveComposerControlInteraction(params: Readonly<{
    control: PluginProjectedComposerControlEntryV1;
    host: PluginComposerControlHost;
    state: ResolvedComposerControlState;
}>): ResolvedComposerControlInteraction {
    const { control, host, state } = params;
    const definition = control.definition;
    const interaction = definition.interaction;
    const choiceSelection = resolveSelectedChoiceIds(control, state);
    const selectedChoiceIds = choiceSelection.selectedChoiceIds;
    const materializedSelectedChoiceIds = interaction.kind === 'choices'
        ? selectedChoiceIds
        : state.selectedChoiceIds;
    const selected = state.selected || selectedChoiceIds.length > 0;
    const canInteract = (): boolean => host.isCurrent() && state.enabled;
    const overflow = resolveOverflowPresentation(control, state, host.localize);
    const surfacePresentation = resolveInteractionSurfacePresentation(
        control,
        state,
        materializedSelectedChoiceIds,
    );
    const choicePopover = interaction.kind === 'choices'
        ? createChoicePopover({
            control,
            host,
            state,
            selectedChoiceIds,
            canInteract,
            overflowLabel: overflow.label,
            overflowAccessibilityLabel: overflow.accessibilityLabel,
            overflowIcon: overflow.icon,
        })
        : undefined;
    const contentPopover = surfacePresentation?.presentation === 'popover'
        ? {
            title: overflow.label,
            label: overflow.label,
            accessibilityLabel: overflow.accessibilityLabel,
            icon: (tint: string) => controlMenuIcon(overflow.icon, tint),
            disabled: !canInteract(),
            isEnabled: canInteract,
            layout: surfacePresentation.layout,
            renderContent: () => (
                host.isCurrent() ? host.renderSurfaceContent(surfacePresentation) : null
            ),
        }
        : undefined;
    const invokeDirectInteraction = (focusReturnRef?: FocusReturnRef): void => {
        if (!canInteract()) return;
        if (interaction.kind === 'action') {
            host.openAction({
                control,
                action: qualifyContributionReference(control, interaction.action),
            });
            return;
        }
        if (interaction.kind === 'destination') {
            host.openDestination({
                control,
                destination: qualifyContributionReference(control, interaction.destination),
            });
            return;
        }
        if (surfacePresentation?.presentation === 'dialog') {
            host.openSurfaceDialog(
                surfacePresentation as PluginComposerControlDialogPresentation,
                // The affordance that invoked this interaction — the visible
                // chip or the collapsed action menu — is the exact native
                // focus-return target the host dialog owner restores on
                // dismissal.
                focusReturnRef ? { focusReturnRef } : undefined,
            );
        }
    };

    return {
        state,
        selected,
        unknownChoiceIds: choiceSelection.unknownChoiceIds,
        canInteract,
        overflow,
        choicePopover,
        contentPopover,
        opensCollapsedPopover: choicePopover !== undefined || contentPopover !== undefined,
        invokeDirectInteraction,
        compactPresentation: definition.compactRenderer === undefined
            ? null
            : ({
                kind: 'control',
                role: 'compact',
                control,
                state: materializeComposerControlSurfaceState(state, materializedSelectedChoiceIds),
            } satisfies PluginComposerControlSurfacePresentation),
    };
}

function composerControlUnknownChoiceDiagnosticMessage(input: Readonly<{
    control: PluginProjectedComposerControlEntryV1;
    unknownChoiceIds: readonly string[];
}>): string {
    const pluginId = redactBugReportSensitiveText(input.control.identity.pluginId);
    const contributionId = redactBugReportSensitiveText(input.control.identity.localId);
    const controlId = redactBugReportSensitiveText(input.control.id);
    const unknownChoiceIdSamples = input.unknownChoiceIds
        .slice(0, COMPOSER_CONTROL_UNKNOWN_CHOICE_ID_SAMPLE_COUNT)
        .map((choiceId) => trimBugReportTextHeadToMaxBytes(
            redactBugReportSensitiveText(choiceId),
            COMPOSER_CONTROL_UNKNOWN_CHOICE_ID_SAMPLE_MAX_UTF8_BYTES,
        ));
    const raw = `[plugin-ui-composer-control] ${JSON.stringify({
        code: 'composer_control_unknown_choice_ids',
        pluginId,
        contributionId,
        controlId,
        unknownChoiceIdSamples,
        unknownChoiceIdsOmittedCount: input.unknownChoiceIds.length - unknownChoiceIdSamples.length,
    })}`;
    return trimBugReportTextToMaxBytes(
        raw,
        PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1,
    );
}

/**
 * Choice membership belongs to the declared control projection. A Resource
 * snapshot can be structurally valid yet refer to a choice removed from that
 * declaration, so keep the valid selection usable and emit one bounded,
 * contributor-attributed diagnostic from the mounted, current UI path.
 */
function ComposerControlUnknownChoiceDiagnostic(props: Readonly<{
    control: PluginProjectedComposerControlEntryV1;
    unknownChoiceIds: readonly string[];
    record: ComposerControlUnknownChoiceDiagnosticRecord;
    isCurrent: () => boolean;
}>): null {
    React.useEffect(() => {
        if (!props.isCurrent() || props.unknownChoiceIds.length === 0 || props.record.reported) return;
        props.record.reported = true;
        log.log(composerControlUnknownChoiceDiagnosticMessage({
            control: props.control,
            unknownChoiceIds: props.unknownChoiceIds,
        }));
    }, [props.control, props.isCurrent, props.record, props.unknownChoiceIds]);
    return null;
}

function renderWithUnknownChoiceDiagnostic(input: Readonly<{
    control: PluginProjectedComposerControlEntryV1;
    resolved: ResolvedComposerControlInteraction;
    record: ComposerControlUnknownChoiceDiagnosticRecord;
    isCurrent: () => boolean;
    content: React.ReactNode;
}>): React.ReactNode {
    if (
        input.content === null
        || input.content === undefined
        || input.resolved.unknownChoiceIds.length === 0
    ) {
        return input.content;
    }
    return (
        <>
            <ComposerControlUnknownChoiceDiagnostic
                control={input.control}
                unknownChoiceIds={input.resolved.unknownChoiceIds}
                record={input.record}
                isCurrent={input.isCurrent}
            />
            {input.content}
        </>
    );
}

function renderComposerControlChipNode(params: Readonly<{
    control: PluginProjectedComposerControlEntryV1;
    host: PluginComposerControlHost;
    resolved: ResolvedComposerControlInteraction;
    context: Parameters<AgentInputExtraActionChip['render']>[0];
    diagnosticRecord: ComposerControlUnknownChoiceDiagnosticRecord;
}>): React.ReactNode {
    const { control, host, resolved, context, diagnosticRecord } = params;
    if (!host.isCurrent() || !resolved.state.visible) return null;

    let compactContent: React.ReactNode = null;
    if (resolved.compactPresentation) {
        compactContent = host.renderSurfaceContent(resolved.compactPresentation);
    }

    const controlEnabled = resolved.canInteract();
    return renderWithUnknownChoiceDiagnostic({
        control,
        resolved,
        record: diagnosticRecord,
        isCurrent: host.isCurrent,
        content: (
            <Pressable
                ref={context.chipAnchorRef}
                testID={composerControlKey(control)}
                accessibilityRole="button"
                accessibilityLabel={resolved.state.accessibilityLabel}
                {...(resolved.state.unavailableReason === undefined
                    ? {}
                    : { accessibilityHint: resolved.state.unavailableReason })}
                accessibilityState={controlEnabled
                    ? (resolved.state.expressesSelection && resolved.selected ? { selected: true } : undefined)
                    : {
                        disabled: true,
                        ...(resolved.state.expressesSelection && resolved.selected ? { selected: true } : {}),
                    }}
                // React Native Web does not map `accessibilityState.selected`
                // at all, and `aria-selected` is invalid on `role="button"`, so
                // the browser accessibility tree saw no difference between a
                // selected and an unselected control. `aria-pressed` is the
                // valid toggle-button semantic and is emitted only for a
                // control that actually reports an on/off state.
                {...(resolved.state.expressesSelection
                    ? { 'aria-pressed': resolved.selected }
                    : {})}
                disabled={!controlEnabled}
                onPress={() => {
                    if (!resolved.canInteract()) return;
                    if (resolved.opensCollapsedPopover) {
                        context.toggleCollapsedPopover?.(composerControlKey(control));
                        return;
                    }
                    resolved.invokeDirectInteraction(context.chipAnchorRef);
                }}
                style={({ pressed }) => [context.chipStyle(pressed), resolveComposerChipPhysicalTargetStyle()]}
            >
                {compactContent ?? (
                    <>
                        <Icon
                            name={resolvePluginUiIconName(resolved.state.icon)}
                            size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
                            color={context.iconColor}
                            style={AGENT_INPUT_CHIP_ICON_STYLE}
                        />
                        {context.showLabel ? (
                            <AgentInputChipLabel
                                label={resolved.state.label}
                                count={resolved.state.count}
                                textStyle={context.textStyle}
                                countTextStyle={context.countTextStyle}
                            />
                        ) : null}
                    </>
                )}
            </Pressable>
        ),
    });
}

function createCollapsedComposerControlAction(params: Readonly<{
    control: PluginProjectedComposerControlEntryV1;
    resolved: ResolvedComposerControlInteraction;
    context: ComposerCollapsedActionContext;
}>): ActionListItem {
    const { control, resolved, context } = params;
    return {
        id: composerControlMenuId(control),
        label: resolved.overflow.label,
        accessibilityLabel: resolved.overflow.accessibilityLabel,
        ...(resolved.state.unavailableReason === undefined
            ? {}
            : { subtitle: resolved.state.unavailableReason }),
        icon: controlMenuIcon(resolved.overflow.icon, context.tint),
        disabled: !resolved.canInteract(),
        onPress: () => {
            if (!resolved.canInteract()) return;
            if (resolved.opensCollapsedPopover) {
                context.dismiss();
                context.openCollapsedPopover(composerControlKey(control));
                return;
            }
            context.dismiss();
            resolved.invokeDirectInteraction(context.focusReturnRef);
        },
    };
}

function CloseUnavailableComposerControlPopover(props: Readonly<{
    onRequestClose: () => void;
}>): null {
    React.useEffect(() => {
        props.onRequestClose();
    }, [props.onRequestClose]);
    return null;
}

export type ComposerControlSurfaceLayoutContent = Readonly<{
    surfaceKey: string;
    title?: string;
    label: string;
    accessibilityLabel: string;
    renderContent: () => React.ReactNode;
}>;

/**
 * The protocol's closed layout vocabulary maps only to incumbent presentation
 * primitives. This builds their shared one-row surface input; it owns neither
 * the mounted surface nor any user command.
 */
export function createComposerControlSurfaceListRootStep(
    input: ComposerControlSurfaceLayoutContent,
): SelectionListStep {
    return {
        id: `${input.surfaceKey}:list`,
        ...(input.title === undefined ? {} : { title: input.title }),
        sections: [{
            kind: 'static',
            id: `${input.surfaceKey}:list`,
            options: [{
                id: input.surfaceKey,
                label: input.label,
                accessibilityLabel: input.accessibilityLabel,
                expandedContent: input.renderContent,
            }],
        }],
    };
}

export function createComposerControlSurfaceSplitOptions(
    input: ComposerControlSurfaceLayoutContent,
): readonly AgentInputChipPickerOption[] {
    return [{
        id: input.surfaceKey,
        label: input.label,
        renderDetailContent: () => input.renderContent(),
    }];
}

function renderComposerControlSurfacePopover(input: Readonly<{
    control: PluginProjectedComposerControlEntryV1;
    popover: ComposerControlSurfacePopover;
    context: AgentInputExtraActionChipCollapsedPopoverRenderContext;
}>): React.ReactNode {
    const { control, popover, context } = input;
    const surfaceOptionId = `${composerControlKey(control)}:surface`;
    const layoutContent: ComposerControlSurfaceLayoutContent = {
        surfaceKey: surfaceOptionId,
        title: popover.title,
        label: popover.label,
        accessibilityLabel: popover.accessibilityLabel,
        renderContent: popover.renderContent,
    };

    if (popover.layout === 'list') {
        return (
            <AgentInputSelectionListPopover
                open
                anchorRef={context.anchorRef}
                rootStep={createComposerControlSurfaceListRootStep(layoutContent)}
                selectedOptionId={surfaceOptionId}
                optionsHostInlineControls
                onSelect={() => {
                    // The mounted surface owns its own interaction. The list
                    // shell only supplies incumbent list semantics and scroll.
                }}
                onRequestClose={context.onRequestClose}
            />
        );
    }

    if (popover.layout === 'split') {
        return (
            <AgentInputChipPickerPopover
                open
                anchorRef={context.anchorRef}
                title={popover.title}
                options={createComposerControlSurfaceSplitOptions(layoutContent)}
                selectedOptionId={surfaceOptionId}
                onSelect={() => {
                    // The mounted surface owns its own interaction. Selecting
                    // its presentation rail never invents a second command.
                }}
                onRequestClose={context.onRequestClose}
            />
        );
    }

    return (
        <AgentInputContentPopover
            open
            anchorRef={context.anchorRef}
            content={popover.renderContent}
            onRequestClose={context.onRequestClose}
        />
    );
}

function renderComposerControlCollapsedPopover(params: Readonly<{
    control: PluginProjectedComposerControlEntryV1;
    resolved: ResolvedComposerControlInteraction;
    context: AgentInputExtraActionChipCollapsedPopoverRenderContext;
    diagnosticRecord: ComposerControlUnknownChoiceDiagnosticRecord;
    isCurrent: () => boolean;
}>): React.ReactNode {
    const { control, resolved, context, diagnosticRecord, isCurrent } = params;
    if (!resolved.state.visible || !resolved.canInteract()) {
        return <CloseUnavailableComposerControlPopover onRequestClose={context.onRequestClose} />;
    }

    if (resolved.choicePopover) {
        const popover = resolved.choicePopover;
        if (popover.presentation === 'list') {
            return renderWithUnknownChoiceDiagnostic({
                control,
                resolved,
                record: diagnosticRecord,
                isCurrent,
                content: (
                    <AgentInputSelectionListPopover
                        open
                        anchorRef={context.anchorRef}
                        rootStep={popover.rootStep}
                        selectedOptionId={popover.selectedOptionId ?? null}
                        onSelect={() => {
                            // Each list row carries the canonical choice effect.
                        }}
                        onRequestClose={context.onRequestClose}
                        maxHeightCap={popover.maxHeightCap}
                        maxWidthCap={popover.maxWidthCap}
                        heightBehavior={popover.heightBehavior}
                    />
                ),
            });
        }
        return renderWithUnknownChoiceDiagnostic({
            control,
            resolved,
            record: diagnosticRecord,
            isCurrent,
            content: (
                <AgentInputChipPickerPopover
                    open
                    anchorRef={context.anchorRef}
                    title={popover.title}
                    options={popover.options}
                    selectedOptionId={popover.selectedOptionId ?? null}
                    applyLabel={popover.applyLabel}
                    railWidth={popover.railWidth}
                    railMaxWidth={popover.railMaxWidth}
                    onSelect={(selectedId) => {
                        // A refused Composer transaction is not a successful
                        // selection: keep the picker open so the user can retry
                        // instead of dismissing it as if the choice applied.
                        if (popover.onSelect(selectedId) === false) return;
                        context.onRequestClose();
                    }}
                    onRequestClose={context.onRequestClose}
                    maxHeightCap={popover.maxHeightCap ?? 420}
                    maxWidthCap={popover.maxWidthCap ?? 360}
                />
            ),
        });
    }

    if (resolved.contentPopover) {
        const popover = resolved.contentPopover;
        return renderWithUnknownChoiceDiagnostic({
            control,
            resolved,
            record: diagnosticRecord,
            isCurrent,
            content: renderComposerControlSurfacePopover({ control, popover, context }),
        });
    }

    return <CloseUnavailableComposerControlPopover onRequestClose={context.onRequestClose} />;
}

/**
 * The incumbent AgentInput control row owns placement and responsive overflow.
 * This one adapter only projects already-admitted control semantics; Actions,
 * transactions, navigation, the contextual Resource lease, renderer lifecycle,
 * and dialog chrome remain with their canonical supplied owners.
 */
function createComposerControlChip(params: Readonly<{
    control: PluginProjectedComposerControlEntryV1;
    host: PluginComposerControlHost;
}>): AgentInputExtraActionChip | null {
    const { control, host } = params;
    if (!host.isCurrent() || !qualifiesForComposerScope(control, host.scope)) return null;

    const definition = control.definition;
    const isResourceControl = definition.state?.resource !== undefined;
    const fallbackResolved = resolveComposerControlInteraction({
        control,
        host,
        state: resolveComposerControlState(control, null, host.localize),
    });
    const resolveResourceInteraction = (resourceState: ComposerControlStateV1 | null) => (
        resolveComposerControlInteraction({
            control,
            host,
            state: resolveComposerControlState(control, resourceState, host.localize),
        })
    );
    const unknownChoiceDiagnosticRecord: ComposerControlUnknownChoiceDiagnosticRecord = { reported: false };

    const baseChip = {
        key: composerControlKey(control),
        controlId: composerControlId(control),
        ...(definition.labelPolicy === undefined ? {} : { labelPolicy: definition.labelPolicy }),
    };
    const usesStaticContentPopover = fallbackResolved.contentPopover?.layout === 'content';
    const usesDynamicSurfacePopover = fallbackResolved.contentPopover !== undefined
        && !usesStaticContentPopover;

    if (!isResourceControl) {
        return {
            ...baseChip,
            ...(fallbackResolved.choicePopover === undefined
                ? {}
                : { collapsedOptionsPopover: fallbackResolved.choicePopover }),
            ...(usesStaticContentPopover
                ? { collapsedContentPopover: fallbackResolved.contentPopover }
                : {}),
            ...(usesDynamicSurfacePopover
                ? {
                    collapsedAction: (context) => createCollapsedComposerControlAction({
                        control,
                        resolved: fallbackResolved,
                        context,
                    }),
                    renderCollapsedPopover: (context) => renderComposerControlCollapsedPopover({
                        control,
                        resolved: fallbackResolved,
                        context,
                        diagnosticRecord: unknownChoiceDiagnosticRecord,
                        isCurrent: host.isCurrent,
                    }),
                }
                : fallbackResolved.opensCollapsedPopover
                    ? {}
                    : {
                    collapsedAction: (context) => createCollapsedComposerControlAction({
                        control,
                        resolved: fallbackResolved,
                        context,
                    }),
                }),
            render: (context) => renderComposerControlChipNode({
                control,
                host,
                resolved: fallbackResolved,
                context,
                diagnosticRecord: unknownChoiceDiagnosticRecord,
            }),
        };
    }

    const resourceChip: AgentInputExtraActionChip = {
        ...baseChip,
        collapsedAction: (context: ComposerCollapsedActionContext) => {
            const fallbackAction = createCollapsedComposerControlAction({
                control,
                resolved: fallbackResolved,
                context,
            });
            const renderItem: ComposerCollapsedItemRenderer = (item, renderDefaultItem) => (
                host.renderControlResourceState({
                    control,
                    children: (resourceState) => {
                        const resolved = resolveResourceInteraction(resourceState);
                        if (!host.isCurrent() || !resolved.state.visible) return null;
                        const rendered = renderDefaultItem({
                            ...item,
                            ...createCollapsedComposerControlAction({
                                control,
                                resolved,
                                context,
                            }),
                        });
                        return renderWithUnknownChoiceDiagnostic({
                            control,
                            resolved,
                            record: unknownChoiceDiagnosticRecord,
                            isCurrent: host.isCurrent,
                            content: rendered,
                        });
                    },
                })
            );
            return { ...fallbackAction, renderItem };
        },
        render: (context: Parameters<AgentInputExtraActionChip['render']>[0]) => (
            host.renderControlResourceState({
                control,
                children: (resourceState) => renderComposerControlChipNode({
                    control,
                    host,
                    resolved: resolveResourceInteraction(resourceState),
                    context,
                    diagnosticRecord: unknownChoiceDiagnosticRecord,
                }),
            })
        ),
        ...(fallbackResolved.opensCollapsedPopover
            ? {
                renderCollapsedPopover: (context) => (
                    host.renderControlResourceState({
                        control,
                        children: (resourceState) => renderComposerControlCollapsedPopover({
                            control,
                            resolved: resolveResourceInteraction(resourceState),
                            context,
                            diagnosticRecord: unknownChoiceDiagnosticRecord,
                            isCurrent: host.isCurrent,
                        }),
                    })
                ),
            }
            : {}),
    };
    return resourceChip;
}

type PluginComposerControlProjectionInput =
    | Readonly<{
        composerControls?: undefined;
        composerControlHost?: undefined;
    }>
    | Readonly<{
        composerControls: readonly PluginProjectedComposerControlEntryV1[];
        composerControlHost: PluginComposerControlHost;
    }>;

/**
 * Projects the controller's canonical current Action list and admitted
 * Composer controls onto the incumbent composer row and responsive overflow.
 * It deliberately has no registration, execution, Resource, or form state:
 * those remain with the controller and supplied host owners.
 */
export function createPluginContributedActionComposerChips(params: Readonly<{
    controller: PluginContributedActionController;
    openAction: (action: PluginContributedActionDescriptor) => void;
    /** Non-session Composer scopes project controls only, never Session Action rows. */
    includeSessionActions?: boolean;
}> & PluginComposerControlProjectionInput): readonly AgentInputExtraActionChip[] {
    const primary = params.includeSessionActions === false
        ? []
        : params.controller.list({ placement: 'composer.primary', scope: 'session' });
    const more = params.includeSessionActions === false
        ? []
        : params.controller.list({ placement: 'composer.more', scope: 'session' });
    const composerControls = params.composerControls === undefined
        ? []
        : params.composerControls.flatMap((control) => {
            const chip = createComposerControlChip({
                control,
                host: params.composerControlHost,
            });
            return chip === null ? [] : [chip];
        });
    return [
        ...primary.map((action) => createComposerActionChip({ action, openAction: params.openAction })),
        ...more.map((action) => createComposerActionChip({ action, openAction: params.openAction })),
        ...composerControls,
    ];
}
