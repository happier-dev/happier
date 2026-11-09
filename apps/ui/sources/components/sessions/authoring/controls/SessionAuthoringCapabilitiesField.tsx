import * as React from 'react';
import { View } from 'react-native';

import { SessionCapabilitySelectionV1Schema, type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
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

export function SessionAuthoringCapabilitiesField(props: Readonly<{
    agentId: string;
    context: SessionAuthoringMcpContext;
    value: SessionCapabilitySelectionV1 | null | undefined;
    onChange: (value: SessionCapabilitySelectionV1) => void;
    chipRenderContext: AgentInputExtraActionChipRenderContext;
    testID: string;
}>): React.ReactElement {
    const { onChange } = props;
    const selection = props.value ?? AUTOMATIC_SELECTION;
    const selectionRef = React.useRef(selection);
    selectionRef.current = selection;
    // The draft owner's contract is a state setter; a functional update reads the controlled value.
    const setSelection = React.useCallback<React.Dispatch<React.SetStateAction<SessionCapabilitySelectionV1>>>((next) => {
        onChange(typeof next === 'function' ? next(selectionRef.current) : next);
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
        },
        machineName: props.context.machineName ?? '',
    });

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
            {chip.render(renderContext)}
            {popover === undefined ? null : (
                <AgentInputContentPopover
                    open={open}
                    anchorRef={anchorRef}
                    content={popover.renderContent}
                    onRequestClose={() => setOpen(false)}
                    {...(popover.header === undefined ? {} : { header: popover.header })}
                    {...(popover.phonePresentation === undefined ? {} : { phonePresentation: popover.phonePresentation })}
                    {...(popover.keyboardShouldPersistTaps === undefined ? {} : { keyboardShouldPersistTaps: popover.keyboardShouldPersistTaps })}
                    {...(popover.maxHeightCap === undefined ? {} : { maxHeightCap: popover.maxHeightCap })}
                    {...(popover.maxWidthCap === undefined ? {} : { maxWidthCap: popover.maxWidthCap })}
                    {...(popover.scrollEnabled === undefined ? {} : { scrollEnabled: popover.scrollEnabled })}
                />
            )}
        </View>
    );
}
