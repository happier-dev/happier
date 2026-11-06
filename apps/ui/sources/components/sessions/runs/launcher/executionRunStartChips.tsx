import { getExecutionRunReportChipPlacement, getExecutionRunStartChipDefinition } from './executionRunStartChipPlacements';
import type { AgentInputControlId, AgentInputControlPlacement } from '@/components/sessions/agentInput/controls/agentInputControlTypes';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
} from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputContentPopoverConfig } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import {
    AGENT_INPUT_CHIP_ICON_SIZE_PX,
    AGENT_INPUT_CHIP_ICON_STYLE,
    AGENT_INPUT_CHIP_REMOVE_TARGET_WIDTH_PX,
    AGENT_INPUT_MENU_ICON_SIZE_PX,
} from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/**
 * The start's own chips (lab `convo-S1`): each decision of a start — who reviews, permissions,
 * scope, Advanced — is one chip in the one composer, opening its question in the composer's
 * content popover; "Report to this session" is a switch in its chip. They are the composer's chip
 * registry, so nothing moves once the conversation starts (S1 over the rejected S1b strip).
 */

export function createExecutionRunStartContentChip(params: Readonly<{
    key: string;
    controlId: AgentInputControlId;
    placementId?: string;
    placementTitle?: string;
    placement?: AgentInputControlPlacement;
    pending?: boolean;
    icon: IconName;
    label: string;
    title: string;
    testID: string;
    disabled?: boolean;
    requirement?: AgentInputExtraActionChip['requirement'];
    /** Shared visible/keyboard/hover/overflow demand signal; never evaluated while closed and untouched. */
    onIntent?: () => void;
    /** The chip draws its glyph alone (the reviewers' "+", the route's glyph beside the start's foot); `title` and `label` still name it. */
    iconOnly?: boolean;
    /** The data the popover content reads, so an open popover redraws when it changes. */
    revision?: string;
    renderContent: AgentInputContentPopoverConfig['renderContent'];
}>): AgentInputExtraActionChip {
    return {
        key: params.key,
        requirement: params.requirement,
        controlId: params.controlId,
        placement: { ...(params.placement ?? { id: params.placementId ?? `${params.controlId}:${params.key}`, title: params.placementTitle ?? params.title, icon: params.icon, defaultPlacement: 'overflow' } satisfies AgentInputControlPlacement), pending: params.pending === true },
        onIntent: params.onIntent,
        stabilityKey: `${params.label}:${params.disabled === true}:${params.requirement?.code ?? ''}:${params.requirement?.fieldPath ?? ''}:${params.revision ?? ''}`,
        collapsedContentPopover: {
            title: params.title,
            label: params.label,
            icon: (tint) => normalizeNodeForView(<Icon name={params.icon} size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            disabled: params.disabled,
            maxWidthCap: 460,
            maxHeightCap: 560,
            keyboardShouldPersistTaps: 'handled',
            // A phone gets the shared sheet, named in its band, rather than a card over the form's own
            // fields (a Run now form is itself a sheet there); the anchored popover leads with its content.
            phonePresentation: 'sheet',
            header: { title: params.title, placement: 'sheet' },
            renderContent: params.renderContent,
        },
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <Pressable
                ref={ctx.chipAnchorRef}
                testID={params.testID}
                accessibilityRole="button"
                accessibilityLabel={params.label === params.title ? params.title : `${params.title}: ${params.label}`}
                accessibilityState={{ disabled: params.disabled === true }}
                disabled={params.disabled}
                onFocus={params.disabled ? undefined : params.onIntent}
                onHoverIn={params.disabled ? undefined : params.onIntent}
                onPress={() => {
                    if (params.disabled) return;
                    params.onIntent?.();
                    ctx.toggleCollapsedPopover?.(params.key);
                }}
                hitSlop={{ top: 8, bottom: 10, left: 4, right: 4 }}
                style={(state) => ctx.chipStyle(state.pressed)}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {normalizeNodeForView(<Icon name={params.icon} size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={ctx.iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                    {ctx.showLabel && !params.iconOnly ? <Text numberOfLines={1} style={ctx.textStyle}>{params.label}</Text> : null}
                </View>
            </Pressable>
        ),
    };
}

/**
 * One chosen reviewer (lab `convo-S1`): its mark and name, and × to take it off the review. The
 * reviewers' "+" chip opens the tiles to add more; there is no "N reviewers" summary chip.
 */
export function createExecutionRunReviewerChip(params: Readonly<{
    targetKey: string;
    label: string;
    mark: React.ReactNode;
    disabled?: boolean;
    onRemove: () => void;
}>): AgentInputExtraActionChip {
    const key = `execution-run-start-reviewer:${params.targetKey}`;
    const removeLabel = t('agentStart.chips.removeReviewer', { name: params.label });
    return {
        key,
        controlId: 'reviewComments',
        placement: { id: `reviewComments:${key}`, title: getExecutionRunStartChipDefinition('reviewersAdd').placement.title, defaultPlacement: 'overflow', pending: true },
        stabilityKey: `${params.label}:${params.disabled === true}`,
        collapsedAction: ({ tint }) => ({
            id: key,
            testID: `${key}:menu-item`,
            label: removeLabel,
            icon: normalizeNodeForView(<Icon name="x" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            disabled: params.disabled,
            onPress: params.onRemove,
        }),
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <View
                ref={ctx.chipAnchorRef}
                testID={key}
                style={[ctx.chipStyle(false), { flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 2 }]}
            >
                {normalizeNodeForView(params.mark)}
                <Text numberOfLines={1} style={ctx.textStyle}>{params.label}</Text>
                <Pressable
                    testID={`${key}:remove`}
                    accessibilityRole="button"
                    accessibilityLabel={removeLabel}
                    accessibilityState={{ disabled: params.disabled === true }}
                    disabled={params.disabled}
                    onPress={params.onRemove}
                    hitSlop={{ top: 8, bottom: 10, left: 2, right: 4 }}
                    style={{ width: AGENT_INPUT_CHIP_REMOVE_TARGET_WIDTH_PX, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' }}
                >
                    {normalizeNodeForView(<Icon name="x" size={AGENT_INPUT_CHIP_ICON_SIZE_PX - 2} color={ctx.iconColor} />)}
                </Pressable>
            </View>
        ),
    };
}

export const EXECUTION_RUN_REPORT_CHIP_KEY = 'execution-run-start-report';

/**
 * "Report to this session": when on, the finished run wakes this session with its result
 * (`notifyParentOnCompletion` on the start). The chip holds the switch; the collapsed menu offers
 * the same toggle as a row.
 */
export function createExecutionRunReportChip(params: Readonly<{
    value: boolean;
    pending?: boolean;
    disabled?: boolean;
    onChange: (next: boolean) => void;
}>): AgentInputExtraActionChip {
    const label = t('agentStart.reportToSession');
    return {
        key: EXECUTION_RUN_REPORT_CHIP_KEY,
        controlId: 'delivery',
        placement: { ...getExecutionRunReportChipPlacement(), pending: params.pending === true },
        stabilityKey: `${params.value}:${params.disabled === true}`,
        collapsedAction: ({ tint }) => ({
            id: EXECUTION_RUN_REPORT_CHIP_KEY,
            testID: 'execution-run-start-report-menu-item',
            label,
            icon: normalizeNodeForView(<Icon name="arrow-elbow-down-right" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            right: <Switch value={params.value} disabled={params.disabled} onValueChange={params.onChange} accessibilityLabel={label} />,
            rightElementOutsidePressable: true,
            disabled: params.disabled,
            onPress: () => params.onChange(!params.value),
        }),
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <View ref={ctx.chipAnchorRef} style={[ctx.chipStyle(false), { flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
                {normalizeNodeForView(<Icon name="arrow-elbow-down-right" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={ctx.iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                {ctx.showLabel ? <Text numberOfLines={1} style={ctx.textStyle}>{label}</Text> : null}
                <Switch
                    testID="execution-run-start-report-switch"
                    compact
                    value={params.value}
                    disabled={params.disabled}
                    onValueChange={params.onChange}
                    accessibilityLabel={label}
                />
            </View>
        ),
    };
}
