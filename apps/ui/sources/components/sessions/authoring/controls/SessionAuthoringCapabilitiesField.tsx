import * as React from 'react';
import { View } from 'react-native';

import type { ExistingSessionCapabilityDelta } from '@happier-dev/protocol/sessions/authoring/existingSessionFieldApplication';
import { SessionCapabilitySelectionV1Schema, setSessionCapabilitySelectionItemV1, type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { SessionAuthoringChipDescriptorTrigger } from './SessionAuthoringFieldSelectTrigger';
import { useNewSessionCapabilitiesChip } from '@/components/sessions/capabilities/useSessionCapabilitiesChip';
import { getCapabilitiesActionChipPlacement } from '@/components/sessions/capabilities/createCapabilitiesActionChip';

import type { SessionAuthoringMcpContext } from './sessionAuthoringFieldControls';

/**
 * The controlled "This session gets" selection for an authoring value (workflow default, step override,
 * trigger). The chip, its preview against the exact Machine and folder, and the sheet are the composer's
 * own (`useNewSessionCapabilitiesChip`), so a workflow or trigger edits exactly what New Session edits.
 * This component adapts the controlled value to that draft owner and hosts the chip's content popover,
 * which the composer bar's overlay controller would otherwise own.
 */

/** An omitted or explicit-automatic selection is previewed as the canonical default policy. */
const AUTOMATIC_SELECTION: SessionCapabilitySelectionV1 = SessionCapabilitySelectionV1Schema.parse({});

/**
 * The controlled "This session gets" chip descriptor for an authoring value, through the draft owner. A form hosts
 * it through `SessionAuthoringCapabilitiesField`; a Composer passes it to `AgentInput`, whose overlay owner then
 * hosts its popover.
 */
export function useSessionAuthoringCapabilitiesChip(props: Readonly<{
    agentId: string;
    context: SessionAuthoringMcpContext;
}> & (
    | Readonly<{ value: SessionCapabilitySelectionV1 | null | undefined; onChange: (value: SessionCapabilitySelectionV1) => void; itemEditing?: never }>
    | Readonly<{ value?: never; onChange?: never; itemEditing: Readonly<{
        selections: readonly (SessionCapabilitySelectionV1 | null | undefined)[];
        deltas?: readonly ExistingSessionCapabilityDelta[];
        mixedLabel: string;
        onChange: (delta: ExistingSessionCapabilityDelta) => void;
    }> }>
)) {
    const { onChange, itemEditing } = props;
    const currentSelections = itemEditing?.selections;
    const deltas = itemEditing?.deltas;
    const selections = React.useMemo(() => currentSelections?.map(value => {
        const initial = value ?? AUTOMATIC_SELECTION;
        return deltas?.reduce((selection, delta) =>
            setSessionCapabilitySelectionItemV1(selection, delta.kind, delta.id, delta.state), initial) ?? initial;
    }), [currentSelections, deltas]);
    const selection = selections?.[0] ?? props.value ?? AUTOMATIC_SELECTION;
    const onItemChange = itemEditing?.onChange;
    const setItem = React.useCallback((kind: ExistingSessionCapabilityDelta['kind'], id: string, state: ExistingSessionCapabilityDelta['state']) =>
        onItemChange?.({ kind, id, state }), [onItemChange]);
    const mixedLabel = itemEditing?.mixedLabel;
    const items = React.useMemo(() => selections && mixedLabel !== undefined
        ? { bulk: { selections, mixedLabel }, setItem } : undefined, [selections, mixedLabel, setItem]);
    const selectionRef = React.useRef(selection);
    selectionRef.current = selection;
    // The draft owner's contract is a state setter; a functional update reads the controlled value.
    const setSelection = React.useCallback<React.Dispatch<React.SetStateAction<SessionCapabilitySelectionV1>>>((next) => {
        onChange?.(typeof next === 'function' ? next(selectionRef.current) : next);
    }, [onChange]);

    const { chip } = useNewSessionCapabilitiesChip({
        placementId: getCapabilitiesActionChipPlacement({ scoped: true }).id,
        draft: {
            machineId: props.context.machineId,
            directory: props.context.directory,
            agentId: props.agentId,
            targetServerId: props.context.serverId,
            selection,
            setSelection,
            itemEditing: items,
        },
        machineName: props.context.machineName ?? '',
    });

    return chip;
}

export function SessionAuthoringCapabilitiesField(props: Readonly<{
    agentId: string;
    context: SessionAuthoringMcpContext;
    value: SessionCapabilitySelectionV1 | null | undefined;
    onChange: (value: SessionCapabilitySelectionV1) => void;
    chipRenderContext: AgentInputExtraActionChipRenderContext;
    /** `select`: the bordered field select of the `selects` presentation; the composer chip otherwise. */
    trigger?: 'chip' | 'select';
    testID: string;
}>): React.ReactElement {
    const chip = useSessionAuthoringCapabilitiesChip(props);

    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
    const renderContext = React.useMemo<AgentInputExtraActionChipRenderContext>(() => ({
        ...props.chipRenderContext,
        chipAnchorRef: anchorRef,
        toggleCollapsedPopover: () => setOpen((current) => !current),
    }), [props.chipRenderContext]);

    const popover = chip.collapsedContentPopover;
    return (
        <View testID={props.testID} style={{ alignSelf: 'flex-start' }}>
            <SessionAuthoringChipDescriptorTrigger chip={chip} renderContext={renderContext} trigger={props.trigger}
                anchorRef={anchorRef} open={open} onToggle={() => setOpen((current) => !current)} testID={props.testID} />
            {popover === undefined ? null : (
                <AgentInputContentPopover
                    open={open}
                    anchorRef={anchorRef}
                    content={popover.renderContent}
                    onRequestClose={() => setOpen(false)}
                    {...(popover.header === undefined ? {} : { header: popover.header })}
                    {...(popover.keyboardShouldPersistTaps === undefined ? {} : { keyboardShouldPersistTaps: popover.keyboardShouldPersistTaps })}
                    {...(popover.maxHeightCap === undefined ? {} : { maxHeightCap: popover.maxHeightCap })}
                    {...(popover.maxWidthCap === undefined ? {} : { maxWidthCap: popover.maxWidthCap })}
                    {...(popover.scrollEnabled === undefined ? {} : { scrollEnabled: popover.scrollEnabled })}
                />
            )}
        </View>
    );
}
